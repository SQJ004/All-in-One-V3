import { Events, PermissionFlagsBits as P, type Guild, type GuildMember, type Message } from 'discord.js';
import { getConfig } from '../../core/configService.js';
import { logger } from '../../core/logger.js';
import { SlidingWindow } from '../../core/rateLimit.js';
import { on, UserError, type VortexModule } from '../../core/types.js';
import { truncate, utcDate } from '../../core/util.js';
import { AiFlag, AiStat, type IAiFlag, type IAiStat } from '../../db/models.js';
import { baseEmbed, COLORS } from '../../ui/theme.js';
import { sendLog } from '../logging/service.js';
import { notifyUser, recordCase, timeoutMember, type Actor } from '../moderation/service.js';
import { scanContent } from '../security/linkScanner.js';
import { aiConnected, classifyMessage, decide, type Verdict } from './classifier.js';

const MIN_LENGTH = 6;
const PER_MINUTE = 30;
const window = new SlidingWindow();

const bump = (guildId: string, field: keyof Pick<IAiStat, 'analyzed' | 'flagged' | 'warned' | 'timedOut' | 'falsePositive'>) =>
  AiStat.updateOne({ guildId, date: utcDate(new Date()) }, { $inc: { [field]: 1 } }, { upsert: true });

export const botActor = (guild: Guild): Actor => ({ id: guild.client.user.id, tag: guild.client.user.tag });

/** Known bad links are recognised on this computer. Nothing is sent anywhere for this check. */
export function linkVerdict(content: string, allowedDomains: string[]): Verdict | null {
  const [hit] = scanContent(content, { scam: true, phishing: true, invites: false, allowedDomains, blockedDomains: [] });
  if (!hit || (hit.category !== 'phishing' && hit.category !== 'scam')) return null;
  return { category: hit.category, confidence: hit.category === 'phishing' ? 95 : 85, reason: hit.reason };
}

async function warnMember(guild: Guild, actor: Actor, member: GuildMember, reason: string): Promise<void> {
  // The warn ladder is skipped on purpose, so AI alone can never lead to a kick or ban.
  await recordCase({ guild, type: 'warn', targetId: member.id, targetTag: member.user.tag, moderatorId: actor.id, moderatorTag: actor.tag, reason, meta: { source: 'ai_moderation' } });
  await notifyUser(guild, member, 'warning', reason);
}

export async function handleAiMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || message.webhookId || message.system || message.content.length < MIN_LENGTH) return;
  const { aiModeration: cfg, security } = await getConfig(message.guildId);
  const member = message.member;
  if (!cfg.enabled || !member || cfg.exemptChannels.includes(message.channelId) || member.id === message.guild.ownerId) return;
  if (member.permissions.has(P.ManageGuild) || member.roles.cache.some((r) => cfg.exemptRoles.includes(r.id))) return;

  let verdict = cfg.linkProtection ? linkVerdict(message.content, security.antiLinks.allowedDomains) : null;
  const source: IAiFlag['source'] = verdict ? 'link_scanner' : 'ai';
  if (!verdict) {
    if (!aiConnected() || window.hit(`ai:${message.guildId}`, 60_000) > PER_MINUTE) return;
    const today = await AiStat.findOne({ guildId: message.guildId, date: utcDate(new Date()) });
    if ((today?.analyzed ?? 0) >= cfg.dailyLimit) return;
    await bump(message.guildId, 'analyzed');
    verdict = await classifyMessage(message.content, cfg);
  }
  if (!verdict) return;
  const outcome = decide(verdict, cfg);
  if (outcome === 'ignore') return;

  const done: string[] = [];
  if (outcome === 'act') {
    const actor = botActor(message.guild);
    const why = `AI moderation (${verdict.confidence}% sure): ${verdict.reason}`;
    if (cfg.autoDelete) await message.delete().then(() => done.push('Message deleted'), () => undefined);
    if (cfg.autoWarn) await warnMember(message.guild, actor, member, why).then(async () => { done.push('Warned'); await bump(message.guildId, 'warned'); }, (err) => logger.debug({ err }, 'AI warn failed'));
    if (cfg.autoTimeout) await timeoutMember(message.guild, actor, member, cfg.timeoutMinutes * 60_000, why).then(async () => { done.push(`Timed out for ${cfg.timeoutMinutes} minutes`); await bump(message.guildId, 'timedOut'); }, (err) => logger.debug({ err }, 'AI timeout failed'));
  }
  await AiFlag.create({ guildId: message.guildId, messageId: message.id, channelId: message.channelId, authorId: member.id, authorTag: member.user.tag, category: verdict.category, confidence: verdict.confidence, reason: verdict.reason, excerpt: truncate(message.content, 300), source, status: done.length ? 'actioned' : 'pending', action: done.join(', ') || null });
  await bump(message.guildId, 'flagged');
  await sendLog(message.guild, 'security', baseEmbed(outcome === 'act' ? COLORS.danger : COLORS.warning).setTitle(`AI moderation · ${verdict.category}`).setDescription(`${verdict.reason}\nConfidence: **${verdict.confidence}%**`).addFields(
    { name: 'Author', value: `<@${member.id}>`, inline: true },
    { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
    { name: 'Response', value: done.join(', ') || 'Waiting for a moderator on the dashboard' },
  ), cfg.logChannelId);
}

export type ReviewDecision = 'dismiss' | 'false_positive' | 'warn' | 'timeout';

/** A moderator's decision on a flagged message. */
export async function reviewFlag(guild: Guild, flagId: string, decision: ReviewDecision, reviewer: GuildMember): Promise<void> {
  const flag = await AiFlag.findOne({ _id: flagId, guildId: guild.id });
  if (!flag) throw new UserError('That flag no longer exists.');
  if (flag.status !== 'pending') throw new UserError('Someone has already reviewed this.');
  const reviewedBy = reviewer.user.tag;
  if (decision === 'dismiss' || decision === 'false_positive') {
    await AiFlag.updateOne({ _id: flag._id }, { $set: { status: decision === 'dismiss' ? 'dismissed' : 'false_positive', reviewedBy } });
    if (decision === 'false_positive') await bump(guild.id, 'falsePositive');
    return;
  }
  if (!reviewer.permissions.has(P.ModerateMembers)) throw new UserError('You need the Timeout Members permission to do that.');
  const member = await guild.members.fetch(flag.authorId).catch(() => null);
  if (!member) throw new UserError('That member has left the server.');
  const actor: Actor = { id: reviewer.id, tag: reviewedBy, member: reviewer };
  const why = `Reviewed AI flag: ${flag.reason}`;
  const { aiModeration } = await getConfig(guild.id);
  if (decision === 'warn') {
    await warnMember(guild, actor, member, why);
    await bump(guild.id, 'warned');
  } else {
    await timeoutMember(guild, actor, member, aiModeration.timeoutMinutes * 60_000, why);
    await bump(guild.id, 'timedOut');
  }
  await AiFlag.updateOne({ _id: flag._id }, { $set: { status: 'actioned', action: decision === 'warn' ? 'Warned' : `Timed out for ${aiModeration.timeoutMinutes} minutes`, reviewedBy } });
}

export const aiModerationModule: VortexModule = {
  name: 'ai-moderation',
  events: [on(Events.MessageCreate, handleAiMessage)],
};
