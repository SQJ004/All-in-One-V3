import { MessageFlags } from 'discord.js';
import {
  ActionRowBuilder, AuditLogEvent, ButtonBuilder, ButtonStyle, ChannelType, GuildVerificationLevel, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder,
  type ButtonInteraction, type Client, type EmbedBuilder, type Guild, type GuildAuditLogsEntry, type GuildMember, type GuildTextBasedChannel, type Message, type TextChannel,
} from 'discord.js';
import { getEnv } from '../../config/env.js';
import { postableChannel } from '../../core/channels.js';
import { getConfig, updateConfig } from '../../core/configService.js';
import { logger } from '../../core/logger.js';
import { hasDangerousPermissions, isTrusted } from '../../core/permissions.js';
import { Cooldown } from '../../core/rateLimit.js';
import { on, UserError, type ComponentInteraction, type GuildCommand, type SlashCommand, type VortexModule } from '../../core/types.js';
import { discordTime, truncate } from '../../core/util.js';
import { SecurityEvent } from '../../db/models.js';
import { baseEmbed, COLORS, ICONS, panelEmbed, replyEmbed, replyOk, replyWarn } from '../../ui/theme.js';
import { banUser, jailMember, kickMember, timeoutMember, type Actor } from '../moderation/service.js';
import { AUDIT_TO_ACTION, isSecurityExempt, ladderAction, MessageGuard, NukeTracker, RaidDetector, scoreAccount, StrikeLedger, violationWeight, type NukeAction, type SecurityConfig, type Violation } from './engine.js';
import { logSecurity } from './events.js';
import { parseFeed, setFeedDomains } from './linkScanner.js';
import { engageLockdown, isLockedDown, liftLockdown } from './lockdown.js';
import { recoveryPriority, snapshotChannel, snapshotRole, undoBan, undoEntry } from './recovery.js';

const nuke = new NukeTracker();
const raid = new RaidDetector();
const guard = new MessageGuard();
const strikes = new StrikeLedger();
const noticeThrottle = new Cooldown();
const webhookHits = new Map<string, number[]>();

const botActor = (client: Client<true>): Actor => ({ id: client.user.id, tag: client.user.tag });

// ---------- Anti-nuke ----------
const pending = new Map<string, GuildAuditLogsEntry[]>();

function bufferEntry(key: string, entry: GuildAuditLogsEntry): void {
  const cutoff = Date.now() - 5 * 60_000;
  const list = (pending.get(key) ?? []).filter((e) => e.createdTimestamp > cutoff);
  list.push(entry);
  pending.set(key, list);
}

/** Maps an entry to a counted action, including grants that hand out dangerous permissions. */
function classify(entry: GuildAuditLogsEntry, guild: Guild): NukeAction | null {
  const direct = AUDIT_TO_ACTION[entry.action];
  if (direct) return direct;
  if (entry.action === AuditLogEvent.RoleUpdate) {
    const change = entry.changes.find((c) => c.key === 'permissions');
    if (change && hasDangerousPermissions(BigInt((change.new as string) ?? 0) & ~BigInt((change.old as string) ?? 0))) return 'dangerousRoleGrant';
  }
  if (entry.action === AuditLogEvent.MemberRoleUpdate) {
    const added = entry.changes.find((c) => c.key === '$add')?.new as Array<{ id: string }> | undefined;
    if (added?.some((r) => { const role = guild.roles.cache.get(r.id); return role && hasDangerousPermissions(role.permissions.bitfield); })) return 'dangerousRoleGrant';
  }
  if (entry.action === AuditLogEvent.RoleUpdate && entry.changes.some((c) => c.key === 'permissions')) return 'permissionChange';
  return null;
}

export async function punishActor(guild: Guild, actorId: string, punishment: SecurityConfig['antiNuke']['punishment'], reason: string): Promise<string> {
  const actor = botActor(guild.client);
  const member = await guild.members.fetch(actorId).catch(() => null);
  if (!member) return 'Actor has already left the server';
  const me = guild.members.me!;
  if (member.roles.highest.position >= me.roles.highest.position) return `Could not punish: their highest role is above mine. Move the ZYTHERON role to the top of the role list`;
  // Bots cannot be meaningfully timed out, and a stripped bot can be re-granted: remove them outright.
  const action = member.user.bot && (punishment === 'strip_roles' || punishment === 'timeout' || punishment === 'quarantine') ? 'kick' : punishment;
  if (action === 'ban') { await banUser(guild, actor, member.user, reason); return 'Banned'; }
  if (action === 'kick') { await kickMember(guild, actor, member, reason); return 'Kicked'; }
  if (action === 'timeout') { await timeoutMember(guild, actor, member, 28 * 86_400_000 - 60_000, reason); return 'Timed out for 28 days'; }
  if (action === 'quarantine') {
    const { moderation } = await getConfig(guild.id);
    if (moderation.jailRoleId && guild.roles.cache.has(moderation.jailRoleId)) { await jailMember(guild, actor, member, reason); return 'Quarantined with the jail role'; }
    await member.roles.set(member.roles.cache.filter((r) => r.managed).map((r) => r.id), reason.slice(0, 512));
    return 'No jail role is set, so all roles were stripped instead';
  }
  await member.roles.set(member.roles.cache.filter((r) => r.managed).map((r) => r.id), reason.slice(0, 512));
  return 'Stripped all roles';
}

export async function handleAuditEntry(entry: GuildAuditLogsEntry, guild: Guild): Promise<void> {
  const { security } = await getConfig(guild.id);
  if (!security.enabled) return;
  const executorId = entry.executorId;
  if (!executorId) return;
  const executor = await guild.members.fetch(executorId).catch(() => null);
  const exempt = isSecurityExempt(security, { actorId: executorId, ownerId: guild.ownerId, botId: guild.client.user.id, roleIds: executor ? [...executor.roles.cache.keys()] : [] });

  if (entry.action === AuditLogEvent.BotAdd) return handleBotAdd(entry, guild, security, executorId, exempt);
  await handleWebhookAudit(entry, guild, security, executorId, exempt);
  if (exempt || !security.antiNuke.enabled) return;

  const key = `${guild.id}:${executorId}`;
  const action = classify(entry, guild);
  // A switched-off check neither counts nor gets reverted.
  if (action && security.antiNuke.disabled.includes(action)) return;
  bufferEntry(key, entry);
  const reversible = entry.action === AuditLogEvent.GuildUpdate;
  if (!action && !reversible) return;

  const verdict = action ? nuke.record(guild.id, executorId, action, security.antiNuke.limits[action]) : { count: 0, trip: false, alreadyTripped: false };
  const enforce = security.mode === 'enforce';

  if (verdict.trip) {
    const reason = `Anti-nuke: ${action} limit reached (${verdict.count} in ${security.antiNuke.limits[action!].windowSec}s)`;
    if (!enforce) {
      await logSecurity(guild, { type: 'anti_nuke', severity: 'critical', actorId: executorId, summary: reason, action: `${security.antiNuke.punishment} the actor and revert ${pending.get(key)?.length ?? 0} recent actions`, monitorOnly: true });
      return;
    }
    const outcome = await punishActor(guild, executorId, security.antiNuke.punishment, reason).catch((err) => `Punishment failed: ${(err as Error).message}`);
    const undone = security.antiNuke.recover ? await recoverAll(guild, key) : [];
    await logSecurity(guild, { type: 'anti_nuke', severity: 'critical', actorId: executorId, summary: reason, action: truncate([outcome, ...undone].join('\n'), 1000) });
  } else if (verdict.alreadyTripped && enforce && security.antiNuke.recover) {
    const undone = await recoverAll(guild, key); // actions that were already in flight when the actor was punished
    if (undone.length) await logSecurity(guild, { type: 'anti_nuke_recovery', severity: 'warning', actorId: executorId, summary: 'Reverted further actions from a punished actor', action: truncate(undone.join('\n'), 1000) });
  }
}

/** Reports webhooks being made or removed, and can remove ones made by people who are not trusted. Tokens are never read or logged. */
async function handleWebhookAudit(entry: GuildAuditLogsEntry, guild: Guild, security: SecurityConfig, executorId: string, exempt: boolean): Promise<void> {
  const cfg = security.antiWebhook;
  const created = entry.action === AuditLogEvent.WebhookCreate;
  if (!cfg.enabled || (!created && entry.action !== AuditLogEvent.WebhookDelete)) return;
  const hookId = entry.targetId;
  const enforce = security.mode === 'enforce';
  if (!created) {
    if (cfg.alertDelete) await logSecurity(guild, { type: 'webhook_deleted', severity: 'info', actorId: executorId, summary: `A webhook was deleted (${hookId ?? 'unknown'})` });
    return;
  }
  const unauthorized = !exempt && !(hookId && cfg.trustedWebhooks.includes(hookId));
  const remove = unauthorized && cfg.removeUnauthorized;
  if (remove && enforce && hookId) {
    const hook = (await guild.fetchWebhooks().catch(() => null))?.get(hookId);
    await hook?.delete('ZYTHERON: created by someone who is not trusted').catch((err) => logger.warn({ err }, 'Could not remove an unauthorized webhook'));
  }
  if (cfg.alertCreate || remove) await logSecurity(guild, { type: unauthorized ? 'webhook_unauthorized' : 'webhook_created', severity: unauthorized ? 'warning' : 'info', actorId: executorId, summary: `A webhook was created (${hookId ?? 'unknown'})${unauthorized ? ' by someone who is not trusted' : ''}`, action: remove ? 'Removed the webhook' : 'Reported only', monitorOnly: remove && !enforce });
}

async function recoverAll(guild: Guild, key: string): Promise<string[]> {
  const entries = pending.get(key) ?? [];
  pending.delete(key);
  const lines: string[] = [];
  const ordered = [...entries].sort((a, b) => recoveryPriority(a) - recoveryPriority(b));
  for (const entry of ordered) {
    try {
      const line = entry.action === AuditLogEvent.MemberBanAdd && entry.targetId ? await undoBan(guild, entry.targetId) : await undoEntry(guild, entry);
      if (line) lines.push(line);
    } catch (err) {
      lines.push(`Could not revert ${AuditLogEvent[entry.action]}: ${(err as Error).message}`);
    }
  }
  return lines;
}

async function handleBotAdd(entry: GuildAuditLogsEntry, guild: Guild, security: SecurityConfig, executorId: string, exempt: boolean): Promise<void> {
  const botId = entry.targetId;
  if (!botId || !security.antiBot.enabled || exempt || security.antiBot.allowedBots.includes(botId)) return;
  const member = await guild.members.fetch(botId).catch(() => null);
  const verb = security.antiBot.action;
  const enforce = security.mode === 'enforce' && verb !== 'log';
  if (enforce && member) {
    if (verb === 'ban') await banUser(guild, botActor(guild.client), member.user, `Anti-bot: added by ${executorId} without approval`);
    else await kickMember(guild, botActor(guild.client), member, `Anti-bot: added by ${executorId} without approval`);
    if (security.antiBot.punishAdder) await punishActor(guild, executorId, security.antiNuke.punishment, 'Anti-bot: added an unapproved bot').catch((err) => logger.warn({ err }, 'Could not punish bot adder'));
  }
  await logSecurity(guild, { type: 'anti_bot', severity: 'warning', actorId: executorId, targetId: botId, summary: `An unapproved bot was added: ${member?.user.tag ?? botId}`, action: verb === 'log' ? 'Logged only' : verb, monitorOnly: security.mode === 'monitor' });
}

// ---------- Join protection ----------
const RAID_VERIFICATION = { off: null, low: GuildVerificationLevel.Low, medium: GuildVerificationLevel.Medium, high: GuildVerificationLevel.High, very_high: GuildVerificationLevel.VeryHigh } as const;

async function applyJoin(member: GuildMember, action: 'log' | 'timeout' | 'kick' | 'ban', reason: string): Promise<void> {
  const actor = botActor(member.client);
  if (action === 'ban') await banUser(member.guild, actor, member.user, reason);
  else if (action === 'kick') await kickMember(member.guild, actor, member, reason);
  else if (action === 'timeout') await timeoutMember(member.guild, actor, member, 3_600_000, reason);
}

export async function handleJoin(member: GuildMember): Promise<void> {
  const guild = member.guild;
  const { security } = await getConfig(guild.id);
  if (!security.enabled || member.user.bot || security.whitelistUsers.includes(member.id)) return;
  const enforce = security.mode === 'enforce';

  if (security.antiRaid.enabled) {
    const state = raid.join(guild.id, member.id, security.antiRaid);
    if (state.started) {
      await logSecurity(guild, { type: 'anti_raid', severity: 'critical', summary: `Raid detected: ${state.recent.length} joins within ${security.antiRaid.windowSec}s. Raid mode is on for ${security.antiRaid.raidModeMinutes} minutes.`, action: `${security.antiRaid.action} every new joiner${security.antiRaid.autoLockdown ? ' and engage lockdown' : ''}`, monitorOnly: !enforce });
      if (enforce) {
        const level = RAID_VERIFICATION[security.antiRaid.raiseVerification];
        if (level !== null) await guild.setVerificationLevel(level, 'ZYTHERON: raid detected').catch((err) => logger.warn({ err }, 'Could not raise the verification level'));
        if (security.antiRaid.autoLockdown) await engageLockdown(guild, guild.client.user.id, 'Automatic: raid detected').catch((err) => logger.warn({ err }, 'Auto-lockdown failed'));
        for (const id of state.recent) {
          if (id === member.id) continue;
          const m = guild.members.cache.get(id);
          if (m) await applyJoin(m, security.antiRaid.action, 'Anti-raid: joined during a raid').catch((err) => logger.debug({ err }, 'Raid action failed'));
        }
      }
    }
    if (state.raid) {
      if (enforce) await applyJoin(member, security.antiRaid.action, 'Anti-raid: joined during a raid').catch((err) => logger.debug({ err }, 'Raid action failed'));
      return;
    }
  }

  if (security.suspicious.enabled) {
    const ageDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
    const { score, reasons } = scoreAccount({ ageDays, hasAvatar: Boolean(member.user.avatar), username: `${member.user.username} ${member.displayName}`, bot: member.user.bot }, security.suspicious.minAccountAgeDays);
    if (score >= security.suspicious.scoreThreshold) {
      const action = security.suspicious.action;
      await logSecurity(guild, { type: 'suspicious_account', severity: 'warning', targetId: member.id, summary: `Suspicious account joined (risk ${score}/100): ${reasons.join(', ')}. Created ${discordTime(member.user.createdAt)}.`, action, monitorOnly: !enforce });
      if (enforce && action !== 'log') await applyJoin(member, action, `Suspicious account: ${reasons[0]}`).catch((err) => logger.debug({ err }, 'Suspicious action failed'));
    }
  }
}

// ---------- Message protection ----------
async function handleWebhookMessage(message: Message<true>, security: SecurityConfig): Promise<void> {
  const cfg = security.antiWebhook;
  if (!cfg.enabled || !message.webhookId || cfg.trustedWebhooks.includes(message.webhookId) || security.exemptChannels.includes(message.channelId)) return;
  const now = Date.now();
  const key = message.webhookId;
  const hits = (webhookHits.get(key) ?? []).filter((t) => t > now - cfg.windowSec * 1000);
  hits.push(now);
  webhookHits.set(key, hits);
  const flood = hits.length >= cfg.maxMessages;
  const massPing = cfg.blockEveryone && message.mentions.everyone;
  if (!flood && !massPing) return;
  const summary = massPing ? 'A webhook pinged everyone' : `A webhook sent ${hits.length} messages in ${cfg.windowSec}s`;
  const enforce = security.mode === 'enforce';
  await logSecurity(message.guild, { type: 'anti_webhook', severity: 'critical', summary: `${summary} in <#${message.channelId}>`, action: cfg.deleteWebhook ? 'Deleted the message and the webhook' : 'Deleted the message', monitorOnly: !enforce });
  if (!enforce) return;
  await message.delete().catch(() => undefined);
  if (cfg.deleteWebhook) {
    const hook = await message.fetchWebhook().catch(() => null);
    await hook?.delete('ZYTHERON anti-webhook abuse').catch((err) => logger.debug({ err }, 'Could not delete webhook'));
    webhookHits.delete(key);
  }
}

export async function handleMessage(message: Message): Promise<void> {
  if (!message.inGuild()) return;
  const { security } = await getConfig(message.guildId);
  if (!security.enabled) return;
  if (message.webhookId) return handleWebhookMessage(message, security);
  if (message.author.bot || message.system || security.exemptChannels.includes(message.channelId)) return;
  const member = message.member;
  if (!member) return;
  if (isSecurityExempt(security, { actorId: member.id, ownerId: message.guild.ownerId, botId: message.client.user.id, roleIds: [...member.roles.cache.keys()] })) return;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return;

  const violations = guard.evaluate(security, {
    guildId: message.guildId, authorId: member.id, channelId: message.channelId, messageId: message.id, content: message.content,
    userMentions: message.mentions.users.size, roleMentions: message.mentions.roles.size,
    everyoneAttempt: /@(everyone|here)\b/.test(message.content), canMentionEveryone: member.permissions.has(PermissionFlagsBits.MentionEveryone),
  });
  if (violations.length) await enforceViolations(message, member, security, violations);
}

async function enforceViolations(message: Message<true>, member: GuildMember, security: SecurityConfig, violations: Violation[]): Promise<void> {
  const guild = message.guild;
  const enforce = security.mode === 'enforce';
  const summary = violations.map((v) => v.detail).join('; ');
  const count = strikes.add(guild.id, member.id, security.strikeDecayMinutes, violations.reduce((n, v) => n + violationWeight(v), 0));
  const rung = ladderAction(security.ladder, count);
  const actionLabel = rung ? (rung.action === 'timeout' ? `timeout ${rung.durationMinutes}m` : rung.action) : 'delete';

  if (noticeThrottle.allow(`${guild.id}:${member.id}:log`, 10_000) === 0) {
    await logSecurity(guild, { type: violations[0]!.type === 'link' ? 'scam_link' : `auto_${violations[0]!.type}`, severity: violations.some((v) => v.type === 'link') ? 'critical' : 'warning', actorId: member.id, summary: `${summary} in <#${message.channelId}> (strike ${count})\n>>> ${truncate(message.content || '(no text)', 500)}`, action: actionLabel, monitorOnly: !enforce });
  }
  if (!enforce) return;

  const channel = message.channel as GuildTextBasedChannel;
  const bulk = [...new Set(violations.flatMap((v) => v.deleteIds ?? []))];
  if (bulk.length > 1 && 'bulkDelete' in channel) {
    await (channel as TextChannel).bulkDelete(bulk, true).catch((err: unknown) => logger.debug({ err }, 'Bulk delete failed'));
    guard.forget(guild.id, member.id);
  } else {
    await message.delete().catch(() => undefined);
  }

  const reason = `AutoMod: ${truncate(summary, 300)} (${count} strikes)`;
  const actor = botActor(message.client);
  try {
    if (rung?.action === 'timeout') await timeoutMember(guild, actor, member, rung.durationMinutes * 60_000, reason);
    else if (rung?.action === 'kick') await kickMember(guild, actor, member, reason);
    else if (rung?.action === 'ban') await banUser(guild, actor, member.user, reason);
  } catch (err) {
    logger.debug({ err }, 'AutoMod punishment failed');
  }

  if (noticeThrottle.allow(`${guild.id}:${member.id}:notice`, 15_000) === 0 && 'send' in channel) {
    const notice = await channel.send({ content: `<@${member.id}>`, embeds: [baseEmbed(COLORS.warning).setDescription(`**${ICONS.warn}**  Your message was removed: ${violations[0]!.detail}.`)], allowedMentions: { users: [member.id] } }).catch(() => null);
    if (notice) setTimeout(() => void notice.delete().catch(() => undefined), 6000).unref();
  }
}

// ---------- Panels ----------
const flag = (on: boolean): string => (on ? '`ON ` ' : '`OFF` ');

export function statusEmbed(s: SecurityConfig, locked: boolean): EmbedBuilder {
  const l = s.antiNuke.limits;
  return panelEmbed('Security Center', s.enabled ? (s.mode === 'enforce' ? `${ICONS.shield} **Armed.** Threats are being stopped automatically.` : `${ICONS.shield} **Monitor mode.** Threats are logged, nothing is punished. Review the log, then switch to Enforce.`) : `${ICONS.warn} **Disabled.** Run \`/security setup\` to arm ZYTHERON.`, s.enabled && s.mode === 'enforce' ? COLORS.success : s.enabled ? COLORS.accent : COLORS.warning)
    .addFields(
      { name: 'Protection', value: [`${flag(s.antiNuke.enabled)}Anti-nuke`, `${flag(s.antiRaid.enabled)}Anti-raid`, `${flag(s.suspicious.enabled)}Suspicious accounts`, `${flag(s.antiBot.enabled)}Anti-bot join`].join('\n'), inline: true },
      { name: 'Messages', value: [`${flag(s.antiSpam.enabled)}Anti-spam`, `${flag(s.antiMention.enabled)}Anti-mass mention`, `${flag(s.antiLinks.scam || s.antiLinks.phishing)}Scam and phishing`, `${flag(s.antiWebhook.enabled)}Anti-webhook abuse`].join('\n'), inline: true },
      { name: 'Anti-nuke limits', value: `Channel delete ${l.channelDelete.count}/${l.channelDelete.windowSec}s ${ICONS.dot} Role delete ${l.roleDelete.count}/${l.roleDelete.windowSec}s\nBan ${l.ban.count}/${l.ban.windowSec}s ${ICONS.dot} Kick ${l.kick.count}/${l.kick.windowSec}s ${ICONS.dot} Webhook ${l.webhookCreate.count}/${l.webhookCreate.windowSec}s\nPunishment **${s.antiNuke.punishment}** ${ICONS.dot} Recovery **${s.antiNuke.recover ? 'on' : 'off'}**` },
      { name: 'Join limiter', value: `${s.antiRaid.joinThreshold} joins in ${s.antiRaid.windowSec}s triggers **${s.antiRaid.action}** for ${s.antiRaid.raidModeMinutes}m`, inline: true },
      { name: 'Access', value: `${s.trustedAdmins.length} trusted ${ICONS.dot} ${s.whitelistUsers.length + s.whitelistRoles.length} whitelisted\nLog: ${s.logChannelId ? `<#${s.logChannelId}>` : 'not set'}\nLockdown: **${locked ? 'ACTIVE' : 'off'}**`, inline: true },
    );
}

const TOGGLES = [
  { value: 'antiNuke', label: 'Anti-nuke', description: 'Mass channel, role, ban, kick and webhook actions' },
  { value: 'antiRaid', label: 'Anti-raid', description: 'Join rate limiter and raid mode' },
  { value: 'suspicious', label: 'Suspicious accounts', description: 'Risk score for new accounts' },
  { value: 'antiBot', label: 'Anti-bot join', description: 'Unapproved bots added by non-trusted staff' },
  { value: 'antiSpam', label: 'Anti-spam', description: 'Message flood and duplicates' },
  { value: 'antiMention', label: 'Anti-mass mention', description: 'Mention floods and @everyone attempts' },
  { value: 'links', label: 'Scam and phishing links', description: 'Lookalike domains, scam scripts and lists' },
  { value: 'antiWebhook', label: 'Anti-webhook abuse', description: 'Webhook floods and mass pings' },
] as const;

function panelComponents(s: SecurityConfig) {
  const enabled: Record<string, boolean> = { antiNuke: s.antiNuke.enabled, antiRaid: s.antiRaid.enabled, suspicious: s.suspicious.enabled, antiBot: s.antiBot.enabled, antiSpam: s.antiSpam.enabled, antiMention: s.antiMention.enabled, links: s.antiLinks.scam || s.antiLinks.phishing, antiWebhook: s.antiWebhook.enabled };
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId('sec:toggle').setPlaceholder('Choose the active protections').setMinValues(0).setMaxValues(TOGGLES.length)
        .addOptions(TOGGLES.map((t) => ({ ...t, default: enabled[t.value] }))),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sec:enabled').setLabel(s.enabled ? 'Disable ZYTHERON Security' : 'Enable ZYTHERON Security').setStyle(s.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('sec:mode').setLabel(s.mode === 'enforce' ? 'Switch to Monitor' : 'Switch to Enforce').setStyle(s.mode === 'enforce' ? ButtonStyle.Secondary : ButtonStyle.Danger),
    ),
  ];
}

async function assertTrusted(guild: Guild, userId: string): Promise<SecurityConfig> {
  const { security } = await getConfig(guild.id);
  if (!isTrusted(guild, userId, security.trustedAdmins)) throw new UserError('Only the server owner or a trusted admin can change security settings. The owner can add you with `/security trusted add`.');
  return security;
}

async function panelUpdate(i: ComponentInteraction): Promise<void> {
  if (!i.inCachedGuild() || !('update' in i)) return;
  const s = (await getConfig(i.guildId)).security;
  await (i as ButtonInteraction).update({ embeds: [statusEmbed(s, await isLockedDown(i.guildId))], components: panelComponents(s) });
}

// ---------- Commands ----------
const securityCommand: SlashCommand = {
  cooldownSec: 2,
  perms: { '*': [PermissionFlagsBits.ManageGuild] },
  botPerms: { setup: [PermissionFlagsBits.ViewAuditLog], 'lockdown.on': [PermissionFlagsBits.ManageChannels], 'lockdown.off': [PermissionFlagsBits.ManageChannels] },
  data: new SlashCommandBuilder().setName('security').setDescription('ZYTHERON protection system')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('setup').setDescription('Arm ZYTHERON. Starts in monitor mode so nothing is punished yet.')
      .addChannelOption((o) => o.setName('log_channel').setDescription('Where security events are posted').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((s) => s.setName('config').setDescription('Open the interactive security panel'))
    .addSubcommand((s) => s.setName('events').setDescription('Show recent security events'))
    .addSubcommand((s) => s.setName('limit').setDescription('Set an anti-nuke limit')
      .addStringOption((o) => o.setName('action').setDescription('Action to limit').setRequired(true).addChoices(
        { name: 'Channel delete', value: 'channelDelete' }, { name: 'Channel create', value: 'channelCreate' }, { name: 'Role delete', value: 'roleDelete' }, { name: 'Role create', value: 'roleCreate' },
        { name: 'Ban', value: 'ban' }, { name: 'Kick', value: 'kick' }, { name: 'Webhook create', value: 'webhookCreate' }, { name: 'Dangerous role grant', value: 'dangerousRoleGrant' }))
      .addIntegerOption((o) => o.setName('count').setDescription('Actions allowed before ZYTHERON responds').setMinValue(1).setMaxValue(100).setRequired(true))
      .addIntegerOption((o) => o.setName('window').setDescription('Window in seconds').setMinValue(1).setMaxValue(3600).setRequired(true)))
    .addSubcommand((s) => s.setName('punishment').setDescription('What happens to someone who trips anti-nuke')
      .addStringOption((o) => o.setName('action').setDescription('Punishment').setRequired(true).addChoices({ name: 'Strip all roles', value: 'strip_roles' }, { name: 'Timeout', value: 'timeout' }, { name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' }))
      .addBooleanOption((o) => o.setName('recover').setDescription('Automatically undo what they did')))
    .addSubcommand((s) => s.setName('raid').setDescription('Configure the join rate limiter')
      .addIntegerOption((o) => o.setName('joins').setDescription('Joins that trigger raid mode').setMinValue(2).setMaxValue(200).setRequired(true))
      .addIntegerOption((o) => o.setName('window').setDescription('Window in seconds').setMinValue(1).setMaxValue(600).setRequired(true))
      .addStringOption((o) => o.setName('action').setDescription('Applied to joiners during a raid').addChoices({ name: 'Timeout', value: 'timeout' }, { name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' }))
      .addBooleanOption((o) => o.setName('auto_lockdown').setDescription('Engage lockdown automatically')))
    .addSubcommand((s) => s.setName('accounts').setDescription('Configure suspicious account detection')
      .addIntegerOption((o) => o.setName('min_age_days').setDescription('Accounts younger than this add risk').setMinValue(0).setMaxValue(365).setRequired(true))
      .addStringOption((o) => o.setName('action').setDescription('Response').setRequired(true).addChoices({ name: 'Log only', value: 'log' }, { name: 'Timeout', value: 'timeout' }, { name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' })))
    .addSubcommandGroup((g) => g.setName('whitelist').setDescription('People and roles anti-nuke and automod ignore')
      .addSubcommand((s) => s.setName('add').setDescription('Whitelist a user or role').addMentionableOption((o) => o.setName('target').setDescription('User or role').setRequired(true)))
      .addSubcommand((s) => s.setName('remove').setDescription('Remove from the whitelist').addMentionableOption((o) => o.setName('target').setDescription('User or role').setRequired(true)))
      .addSubcommand((s) => s.setName('list').setDescription('Show the whitelist')))
    .addSubcommandGroup((g) => g.setName('trusted').setDescription('Administrators allowed to change security settings')
      .addSubcommand((s) => s.setName('add').setDescription('Add a trusted admin (owner only)').addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)))
      .addSubcommand((s) => s.setName('remove').setDescription('Remove a trusted admin (owner only)').addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)))
      .addSubcommand((s) => s.setName('list').setDescription('Show trusted admins')))
    .addSubcommandGroup((g) => g.setName('lockdown').setDescription('Emergency lockdown')
      .addSubcommand((s) => s.setName('on').setDescription('Lock every channel and pause invites').addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true)))
      .addSubcommand((s) => s.setName('off').setDescription('Lift lockdown and restore channels'))
      .addSubcommand((s) => s.setName('raid-end').setDescription('End raid mode early')))
    .toJSON(),

  async execute(i: GuildCommand) {
    const group = i.options.getSubcommandGroup(false);
    const sub = i.options.getSubcommand();
    const guild = i.guild;

    if (group === 'whitelist') {
      if (sub === 'list') {
        const s = (await getConfig(guild.id)).security;
        return replyEmbed(i, panelEmbed('Whitelist', `**Users**\n${s.whitelistUsers.map((id) => `<@${id}>`).join(' ') || 'None'}\n\n**Roles**\n${s.whitelistRoles.map((id) => `<@&${id}>`).join(' ') || 'None'}`));
      }
      const s = await assertTrusted(guild, i.user.id);
      const target = i.options.getMentionable('target', true) as { id: string };
      const isRole = guild.roles.cache.has(target.id);
      const key = isRole ? 'whitelistRoles' : 'whitelistUsers';
      const next = sub === 'add' ? [...new Set([...s[key], target.id])] : s[key].filter((x) => x !== target.id);
      await updateConfig(guild.id, 'security', { [key]: next });
      return replyOk(i, `${isRole ? `<@&${target.id}>` : `<@${target.id}>`} ${sub === 'add' ? 'added to' : 'removed from'} the whitelist.`);
    }

    if (group === 'trusted') {
      const s = (await getConfig(guild.id)).security;
      if (sub === 'list') return replyEmbed(i, panelEmbed('Trusted Administrators', [guild.ownerId, ...s.trustedAdmins].map((id) => `<@${id}>${id === guild.ownerId ? ' (owner)' : ''}`).join('\n')));
      if (i.user.id !== guild.ownerId) throw new UserError('Only the server owner can manage trusted admins.');
      const user = i.options.getUser('user', true);
      const next = sub === 'add' ? [...new Set([...s.trustedAdmins, user.id])] : s.trustedAdmins.filter((x) => x !== user.id);
      await updateConfig(guild.id, 'security', { trustedAdmins: next });
      return replyOk(i, `${user} ${sub === 'add' ? 'is now a trusted admin' : 'is no longer a trusted admin'}.`);
    }

    if (group === 'lockdown') {
      await assertTrusted(guild, i.user.id);
      if (sub === 'raid-end') {
        raid.end(guild.id);
        await logSecurity(guild, { type: 'raid_ended', severity: 'info', actorId: i.user.id, summary: 'Raid mode ended manually' });
        return replyOk(i, 'Raid mode ended.');
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      if (sub === 'on') {
        const r = await engageLockdown(guild, i.user.id, i.options.getString('reason', true));
        await i.editReply({ embeds: [baseEmbed(COLORS.danger).setTitle(`${ICONS.lock}  Lockdown engaged`).setDescription(`${r.locked} channels locked${r.failed ? `, ${r.failed} failed` : ''}. Invites paused.\nLift with \`/security lockdown off\`.`)] });
      } else {
        const r = await liftLockdown(guild, i.user.id);
        await i.editReply({ embeds: [baseEmbed(COLORS.success).setTitle(`${ICONS.ok}  Lockdown lifted`).setDescription(`${r.restored} channels restored${r.failed ? `, ${r.failed} failed` : ''}.`)] });
      }
      return;
    }

    if (sub === 'config') {
      const s = (await getConfig(guild.id)).security;
      return replyEmbed(i, statusEmbed(s, await isLockedDown(guild.id)), { components: panelComponents(s) });
    }
    if (sub === 'events') {
      const events = await SecurityEvent.find({ guildId: guild.id }).sort({ createdAt: -1 }).limit(10);
      return replyEmbed(i, panelEmbed('Recent Security Events', events.length ? events.map((e) => `${discordTime(e.createdAt)} **${e.type.replace(/_/g, ' ')}**${e.monitorOnly ? ' (monitor)' : ''}\n${truncate(e.summary.split('\n')[0]!, 150)}`).join('\n\n') : 'Nothing to report.'));
    }

    await assertTrusted(guild, i.user.id);
    if (sub === 'setup') {
      const channel = i.options.getChannel('log_channel', true);
      postableChannel(guild, channel.id);
      const s = await updateConfig(guild.id, 'security', { enabled: true, logChannelId: channel.id });
      const warnings: string[] = [];
      const me = guild.members.me!;
      const top = guild.roles.cache.filter((r) => !r.managed).sort((a, b) => b.position - a.position).first();
      if (top && me.roles.highest.position < top.position) warnings.push(`My role is below **${top.name}**. I cannot act on anyone above me, so move the ZYTHERON role to the top.`);
      if (!me.permissions.has(PermissionFlagsBits.Administrator)) warnings.push('For full recovery I need Manage Channels, Manage Roles, Manage Webhooks, Ban Members, Kick Members and Moderate Members.');
      await replyEmbed(i, statusEmbed(s, false), { components: panelComponents(s) });
      if (warnings.length) await replyWarn(i, warnings.join('\n'));
      return;
    }
    if (sub === 'limit') {
      const action = i.options.getString('action', true);
      await updateConfig(guild.id, 'security', { antiNuke: { limits: { [action]: { count: i.options.getInteger('count', true), windowSec: i.options.getInteger('window', true) } } } });
      return replyOk(i, `Limit updated: **${action}** ${i.options.getInteger('count', true)} per ${i.options.getInteger('window', true)}s.`);
    }
    if (sub === 'punishment') {
      const recover = i.options.getBoolean('recover');
      await updateConfig(guild.id, 'security', { antiNuke: { punishment: i.options.getString('action', true), ...(recover === null ? {} : { recover }) } });
      return replyOk(i, 'Anti-nuke response updated.');
    }
    if (sub === 'raid') {
      const action = i.options.getString('action');
      const auto = i.options.getBoolean('auto_lockdown');
      await updateConfig(guild.id, 'security', { antiRaid: { joinThreshold: i.options.getInteger('joins', true), windowSec: i.options.getInteger('window', true), ...(action ? { action } : {}), ...(auto === null ? {} : { autoLockdown: auto }) } });
      return replyOk(i, 'Join limiter updated.');
    }
    if (sub === 'accounts') {
      await updateConfig(guild.id, 'security', { suspicious: { minAccountAgeDays: i.options.getInteger('min_age_days', true), action: i.options.getString('action', true) } });
      return replyOk(i, 'Suspicious account detection updated.');
    }
  },
};

const automodCommand: SlashCommand = {
  perms: { '*': [PermissionFlagsBits.ManageGuild] },
  data: new SlashCommandBuilder().setName('automod').setDescription('Automatic moderation rules')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('status').setDescription('Show automod rules and the strike ladder'))
    .addSubcommand((s) => s.setName('word-add').setDescription('Add a banned word').addStringOption((o) => o.setName('word').setDescription('Word or phrase').setRequired(true).setMaxLength(100)))
    .addSubcommand((s) => s.setName('word-remove').setDescription('Remove a banned word').addStringOption((o) => o.setName('word').setDescription('Word or phrase').setRequired(true)))
    .addSubcommand((s) => s.setName('caps').setDescription('Limit capital letters').addIntegerOption((o) => o.setName('percent').setDescription('0 disables').setMinValue(0).setMaxValue(100).setRequired(true)))
    .addSubcommand((s) => s.setName('invites').setDescription('Block server invites').addBooleanOption((o) => o.setName('block').setDescription('Block invites').setRequired(true)))
    .addSubcommand((s) => s.setName('domain').setDescription('Allow or block a domain')
      .addStringOption((o) => o.setName('list').setDescription('List').setRequired(true).addChoices({ name: 'Allow', value: 'allowedDomains' }, { name: 'Block', value: 'blockedDomains' }))
      .addStringOption((o) => o.setName('domain').setDescription('example.com').setRequired(true).setMaxLength(253))
      .addBooleanOption((o) => o.setName('remove').setDescription('Remove instead of add')))
    .addSubcommand((s) => s.setName('exempt').setDescription('Exempt a channel').addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText)).addBooleanOption((o) => o.setName('remove').setDescription('Remove the exemption')))
    .toJSON(),

  async execute(i) {
    const sub = i.options.getSubcommand();
    const s = (await getConfig(i.guildId)).security;
    if (sub === 'status') {
      return replyEmbed(i, panelEmbed('AutoMod').addFields(
        { name: 'Banned words', value: s.automod.bannedWords.length ? `||${truncate(s.automod.bannedWords.join(', '), 900)}||` : 'None' },
        { name: 'Caps limit', value: s.automod.maxCapsPercent ? `${s.automod.maxCapsPercent}%` : 'Off', inline: true },
        { name: 'Invites', value: s.antiLinks.invites ? 'Blocked' : 'Allowed', inline: true },
        { name: 'Strike ladder', value: s.ladder.map((r) => `${r.strikes} ${ICONS.arrow} ${r.action}${r.action === 'timeout' ? ` ${r.durationMinutes}m` : ''}`).join('\n') || 'Not set' },
        { name: 'Blocked domains', value: truncate(s.antiLinks.blockedDomains.join(', ') || 'None', 500) },
        { name: 'Allowed domains', value: truncate(s.antiLinks.allowedDomains.join(', ') || 'None', 500) },
      ));
    }
    await assertTrusted(i.guild, i.user.id);
    if (sub === 'word-add' || sub === 'word-remove') {
      const word = i.options.getString('word', true).toLowerCase();
      const next = sub === 'word-add' ? [...new Set([...s.automod.bannedWords, word])] : s.automod.bannedWords.filter((w) => w !== word);
      await updateConfig(i.guildId, 'security', { automod: { bannedWords: next } });
      return replyOk(i, sub === 'word-add' ? 'Banned word added.' : 'Banned word removed.');
    }
    if (sub === 'caps') {
      await updateConfig(i.guildId, 'security', { automod: { maxCapsPercent: i.options.getInteger('percent', true) } });
      return replyOk(i, 'Caps limit updated.');
    }
    if (sub === 'invites') {
      await updateConfig(i.guildId, 'security', { antiLinks: { invites: i.options.getBoolean('block', true) } });
      return replyOk(i, 'Invite blocking updated.');
    }
    if (sub === 'domain') {
      const list = i.options.getString('list', true) as 'allowedDomains' | 'blockedDomains';
      const domain = i.options.getString('domain', true).toLowerCase().replace(/^https?:\/\//, '').split('/')[0]!;
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new UserError('That does not look like a domain. Use the form `example.com`.');
      const next = i.options.getBoolean('remove') ? s.antiLinks[list].filter((d) => d !== domain) : [...new Set([...s.antiLinks[list], domain])];
      await updateConfig(i.guildId, 'security', { antiLinks: { [list]: next } });
      return replyOk(i, `Domain list updated: \`${domain}\`.`);
    }
    if (sub === 'exempt') {
      const channel = i.options.getChannel('channel', true);
      const next = i.options.getBoolean('remove') ? s.exemptChannels.filter((c) => c !== channel.id) : [...new Set([...s.exemptChannels, channel.id])];
      await updateConfig(i.guildId, 'security', { exemptChannels: next });
      return replyOk(i, `Exemptions updated for <#${channel.id}>.`);
    }
  },
};

async function refreshFeed(): Promise<void> {
  const url = getEnv().PHISHING_FEED_URL;
  if (!url) return;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Feed responded ${res.status}`);
  const text = await res.text();
  if (text.length > 20_000_000) throw new Error('Feed too large');
  const domains = parseFeed(text);
  setFeedDomains(domains);
  logger.info({ domains: domains.length }, 'Scam domain feed refreshed');
}

export const securityModule: VortexModule = {
  name: 'security',
  commands: [securityCommand, automodCommand],
  components: [
    {
      prefix: 'sec:toggle',
      async run(i) {
        if (!i.inCachedGuild() || !i.isStringSelectMenu()) return;
        await assertTrusted(i.guild, i.user.id);
        const v = new Set(i.values);
        await updateConfig(i.guildId, 'security', {
          antiNuke: { enabled: v.has('antiNuke') }, antiRaid: { enabled: v.has('antiRaid') }, suspicious: { enabled: v.has('suspicious') }, antiBot: { enabled: v.has('antiBot') },
          antiSpam: { enabled: v.has('antiSpam') }, antiMention: { enabled: v.has('antiMention') }, antiLinks: { scam: v.has('links'), phishing: v.has('links') }, antiWebhook: { enabled: v.has('antiWebhook') },
        });
        await panelUpdate(i);
      },
    },
    {
      prefix: 'sec:mode',
      async run(i) {
        if (!i.inCachedGuild()) return;
        const s = await assertTrusted(i.guild, i.user.id);
        await updateConfig(i.guildId, 'security', { mode: s.mode === 'enforce' ? 'monitor' : 'enforce' });
        await panelUpdate(i);
      },
    },
    {
      prefix: 'sec:enabled',
      async run(i) {
        if (!i.inCachedGuild()) return;
        const s = await assertTrusted(i.guild, i.user.id);
        await updateConfig(i.guildId, 'security', { enabled: !s.enabled });
        await panelUpdate(i);
      },
    },
  ],
  events: [
    on('guildAuditLogEntryCreate', (entry, guild) => handleAuditEntry(entry, guild)),
    on('guildMemberAdd', (member) => handleJoin(member)),
    on('messageCreate', (message) => handleMessage(message)),
    on('channelDelete', (channel) => { if ('guild' in channel) snapshotChannel(channel); }),
    on('roleDelete', (role) => snapshotRole(role)),
  ],
  intervals: [{ name: 'scam-feed', everyMs: 6 * 3_600_000, run: refreshFeed }],
  onReady: async () => { await refreshFeed().catch((err) => logger.warn({ err }, 'Could not load scam domain feed')); },
};
