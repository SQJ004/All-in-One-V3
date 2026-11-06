import { PermissionFlagsBits, type Guild, type GuildMember, type User } from 'discord.js';
import { getConfig } from '../../core/configService.js';
import { logger } from '../../core/logger.js';
import { moderationBlock } from '../../core/permissions.js';
import { scheduleJob, cancelJobs } from '../../core/scheduler.js';
import { UserError } from '../../core/types.js';
import { discordTime, formatDuration } from '../../core/util.js';
import { Case, Jail, nextSequence, type CaseType, type ICase } from '../../db/models.js';
import { baseEmbed, COLORS } from '../../ui/theme.js';
import { getTextChannel, sendLog } from '../logging/service.js';

export const CASE_COLORS: Partial<Record<CaseType, number>> = {
  ban: COLORS.danger, tempban: COLORS.danger, kick: COLORS.danger, automod: COLORS.warning, warn: COLORS.warning,
  timeout: COLORS.warning, jail: COLORS.warning, unban: COLORS.success, untimeout: COLORS.success, unjail: COLORS.success,
};

export interface CaseInput {
  guild: Guild;
  type: CaseType;
  targetId: string;
  targetTag: string;
  moderatorId: string;
  moderatorTag: string;
  reason?: string | null;
  durationMs?: number | null;
  meta?: Record<string, unknown>;
}

/** Writes the case and posts it to the moderation log. Notes stay private to the database. */
export async function recordCase(input: CaseInput): Promise<ICase> {
  const number = await nextSequence(input.guild.id, 'case');
  const doc = await Case.create({
    guildId: input.guild.id, number, type: input.type, targetId: input.targetId, targetTag: input.targetTag,
    moderatorId: input.moderatorId, moderatorTag: input.moderatorTag, reason: input.reason || 'No reason provided',
    durationMs: input.durationMs ?? null, expiresAt: input.durationMs ? new Date(Date.now() + input.durationMs) : null, meta: input.meta,
  });
  if (input.type !== 'note') {
    const { moderation } = await getConfig(input.guild.id);
    await sendLog(input.guild, 'moderation', caseEmbed(doc), moderation.modLogChannelId);
  }
  return doc;
}

export function caseEmbed(c: Pick<ICase, 'number' | 'type' | 'targetId' | 'targetTag' | 'moderatorId' | 'reason' | 'durationMs' | 'expiresAt'>) {
  const embed = baseEmbed(CASE_COLORS[c.type] ?? COLORS.accent)
    .setTitle(`Case #${c.number} ${'·'} ${c.type.toUpperCase()}`)
    .addFields(
      { name: 'Target', value: `<@${c.targetId}>\n\`${c.targetTag}\` (${c.targetId})`, inline: true },
      { name: 'Moderator', value: `<@${c.moderatorId}>`, inline: true },
      { name: 'Reason', value: c.reason || 'No reason provided' },
    );
  if (c.durationMs) embed.addFields({ name: 'Duration', value: `${formatDuration(c.durationMs)}${c.expiresAt ? ` (ends ${discordTime(c.expiresAt)})` : ''}`, inline: true });
  return embed;
}

/** Best-effort DM. Members with DMs closed are normal, not an error. */
export async function notifyUser(guild: Guild, user: User | GuildMember, action: string, reason: string, durationMs?: number | null): Promise<boolean> {
  const { moderation } = await getConfig(guild.id);
  if (!moderation.dmOnAction) return false;
  try {
    const embed = baseEmbed(COLORS.warning)
      .setTitle(`You received a ${action} in ${guild.name}`)
      .addFields({ name: 'Reason', value: reason || 'No reason provided' });
    if (durationMs) embed.addFields({ name: 'Duration', value: formatDuration(durationMs) });
    await user.send({ embeds: [embed] });
    return true;
  } catch {
    return false;
  }
}

export interface Actor { id: string; tag: string; member?: GuildMember }

function assertCan(guild: Guild, actor: Actor, target: GuildMember): void {
  const me = guild.members.me;
  if (!me) throw new UserError('I could not resolve my own member in this server.');
  if (actor.member) {
    const block = moderationBlock(actor.member, target, me);
    if (block) throw new UserError(block);
  } else if (target.roles.highest.position >= me.roles.highest.position || target.id === guild.ownerId) {
    throw new UserError(`${target.user.tag} is above my role.`);
  }
}

const MAX_TIMEOUT_MS = 28 * 86_400_000;

// Each action verifies hierarchy, DMs first (a kicked user can no longer be messaged
// once no mutual server remains), performs the action, then records the case.
export async function banUser(guild: Guild, actor: Actor, user: User, reason: string, opts: { durationMs?: number | null; deleteMessageDays?: number } = {}): Promise<ICase> {
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (member) assertCan(guild, actor, member);
  await notifyUser(guild, user, opts.durationMs ? 'temporary ban' : 'ban', reason, opts.durationMs);
  await guild.members.ban(user.id, { reason: `${actor.tag}: ${reason}`.slice(0, 512), deleteMessageSeconds: (opts.deleteMessageDays ?? 0) * 86400 });
  if (opts.durationMs) await scheduleJob('mod.unban', guild.id, new Date(Date.now() + opts.durationMs), { userId: user.id }, `unban:${guild.id}:${user.id}`);
  else await cancelJobs(`unban:${guild.id}:${user.id}`);
  return recordCase({ guild, type: opts.durationMs ? 'tempban' : 'ban', targetId: user.id, targetTag: user.tag, moderatorId: actor.id, moderatorTag: actor.tag, reason, durationMs: opts.durationMs });
}

export async function unbanUser(guild: Guild, actor: Actor, userId: string, reason: string): Promise<ICase> {
  const ban = await guild.bans.fetch(userId).catch(() => null);
  if (!ban) throw new UserError('That user is not banned.');
  await guild.members.unban(userId, `${actor.tag}: ${reason}`.slice(0, 512));
  await cancelJobs(`unban:${guild.id}:${userId}`);
  return recordCase({ guild, type: 'unban', targetId: userId, targetTag: ban.user.tag, moderatorId: actor.id, moderatorTag: actor.tag, reason });
}

export async function kickMember(guild: Guild, actor: Actor, member: GuildMember, reason: string): Promise<ICase> {
  assertCan(guild, actor, member);
  await notifyUser(guild, member, 'kick', reason);
  await member.kick(`${actor.tag}: ${reason}`.slice(0, 512));
  return recordCase({ guild, type: 'kick', targetId: member.id, targetTag: member.user.tag, moderatorId: actor.id, moderatorTag: actor.tag, reason });
}

export async function timeoutMember(guild: Guild, actor: Actor, member: GuildMember, durationMs: number, reason: string): Promise<ICase> {
  assertCan(guild, actor, member);
  if (member.permissions.has(PermissionFlagsBits.Administrator)) throw new UserError('Discord does not allow timing out administrators.');
  if (durationMs > MAX_TIMEOUT_MS) throw new UserError('Discord limits timeouts to 28 days.');
  await member.timeout(durationMs, `${actor.tag}: ${reason}`.slice(0, 512));
  await notifyUser(guild, member, 'timeout', reason, durationMs);
  return recordCase({ guild, type: 'timeout', targetId: member.id, targetTag: member.user.tag, moderatorId: actor.id, moderatorTag: actor.tag, reason, durationMs });
}

export async function jailMember(guild: Guild, actor: Actor, member: GuildMember, reason: string, durationMs?: number | null): Promise<ICase> {
  assertCan(guild, actor, member);
  const { moderation } = await getConfig(guild.id);
  if (!moderation.jailRoleId || !guild.roles.cache.has(moderation.jailRoleId)) throw new UserError('No jail role is set up yet. Run `/modconfig jail-setup` first.');
  const existing = await Jail.findOne({ guildId: guild.id, userId: member.id, active: true });
  if (existing) throw new UserError('That member is already jailed.');
  const previous = member.roles.cache.filter((r) => r.id !== guild.id && !r.managed && r.id !== moderation.jailRoleId).map((r) => r.id);
  // Managed roles cannot be removed, so they are kept alongside the jail role.
  const kept = member.roles.cache.filter((r) => r.managed).map((r) => r.id);
  await member.roles.set([...kept, moderation.jailRoleId], `${actor.tag}: ${reason}`.slice(0, 512));
  await Jail.updateOne({ guildId: guild.id, userId: member.id }, { $set: { previousRoles: previous, active: true } }, { upsert: true });
  if (durationMs) await scheduleJob('mod.unjail', guild.id, new Date(Date.now() + durationMs), { userId: member.id }, `unjail:${guild.id}:${member.id}`);
  await notifyUser(guild, member, 'jail', reason, durationMs);
  return recordCase({ guild, type: 'jail', targetId: member.id, targetTag: member.user.tag, moderatorId: actor.id, moderatorTag: actor.tag, reason, durationMs });
}

export async function unjailMember(guild: Guild, actor: Actor, userId: string, reason: string): Promise<ICase> {
  const jail = await Jail.findOne({ guildId: guild.id, userId, active: true });
  if (!jail) throw new UserError('That member is not jailed.');
  const member = await guild.members.fetch(userId).catch(() => null);
  if (member) {
    const restorable = jail.previousRoles.filter((id) => {
      const role = guild.roles.cache.get(id);
      return role && guild.members.me && role.position < guild.members.me.roles.highest.position;
    });
    const kept = member.roles.cache.filter((r) => r.managed).map((r) => r.id);
    await member.roles.set([...kept, ...restorable], `${actor.tag}: ${reason}`.slice(0, 512));
  }
  await Jail.updateOne({ _id: jail._id }, { $set: { active: false } });
  await cancelJobs(`unjail:${guild.id}:${userId}`);
  return recordCase({ guild, type: 'unjail', targetId: userId, targetTag: member?.user.tag ?? userId, moderatorId: actor.id, moderatorTag: actor.tag, reason });
}

/** Applies the highest configured threshold reached by the active warning count. */
export async function applyWarnThresholds(guild: Guild, actor: Actor, member: GuildMember, activeWarnings: number): Promise<string | null> {
  const { moderation } = await getConfig(guild.id);
  const rung = moderation.warnThresholds.filter((t) => t.warnings === activeWarnings).sort((a, b) => b.warnings - a.warnings)[0];
  if (!rung) return null;
  const botActor: Actor = { id: guild.client.user.id, tag: guild.client.user.tag };
  const reason = `Automatic: reached ${rung.warnings} warnings (triggered by ${actor.tag})`;
  const duration = rung.durationMinutes * 60_000;
  try {
    if (rung.action === 'timeout') await timeoutMember(guild, botActor, member, duration, reason);
    else if (rung.action === 'kick') await kickMember(guild, botActor, member, reason);
    else if (rung.action === 'ban') await banUser(guild, botActor, member.user, reason);
    else await jailMember(guild, botActor, member, reason, duration);
    return rung.action;
  } catch (err) {
    logger.warn({ err, guild: guild.id }, 'Warn threshold action failed');
    return null;
  }
}

export const modJobs = {
  'mod.unban': async (client: import('discord.js').Client<true>, guildId: string, payload: Record<string, any>) => {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const actor = { id: client.user.id, tag: client.user.tag };
    await unbanUser(guild, actor, payload.userId, 'Temporary ban expired').catch((err) => {
      if (!(err instanceof UserError)) throw err; // already unbanned by a human is fine
    });
  },
  'mod.unjail': async (client: import('discord.js').Client<true>, guildId: string, payload: Record<string, any>) => {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const actor = { id: client.user.id, tag: client.user.tag };
    await unjailMember(guild, actor, payload.userId, 'Jail time expired').catch((err) => {
      if (!(err instanceof UserError)) throw err;
    });
  },
};

export { getTextChannel };
