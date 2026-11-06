import { ChannelType, OverwriteType, PermissionFlagsBits, type Guild, type GuildChannel } from 'discord.js';
import { logger } from '../../core/logger.js';
import { UserError } from '../../core/types.js';
import { Lockdown } from '../../db/models.js';
import { logSecurity } from './events.js';

const LOCK_BITS = [PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads, PermissionFlagsBits.AddReactions, PermissionFlagsBits.Connect];
const LOCKABLE = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildForum]);

export const isLockedDown = async (guildId: string): Promise<boolean> => Boolean((await Lockdown.findOne({ guildId }))?.active);

/**
 * Snapshots then denies @everyone in every channel. The exact previous overwrite is
 * stored, and is saved before any change, so a crash mid-way can still be undone.
 */
export async function engageLockdown(guild: Guild, by: string, reason: string): Promise<{ locked: number; failed: number }> {
  if (await isLockedDown(guild.id)) throw new UserError('The server is already in lockdown.');
  const channels = guild.channels.cache.filter((c) => LOCKABLE.has(c.type)).map((c) => c as GuildChannel);
  const everyone = guild.roles.everyone.id;
  const snapshot = channels.map((c) => {
    const ow = c.permissionOverwrites.cache.get(everyone);
    return { channelId: c.id, allow: (ow?.allow.bitfield ?? 0n).toString(), deny: (ow?.deny.bitfield ?? 0n).toString(), existed: Boolean(ow) };
  });
  await Lockdown.updateOne({ guildId: guild.id }, { $set: { active: true, reason, by, snapshot } }, { upsert: true });

  let locked = 0;
  let failed = 0;
  const lockMask = LOCK_BITS.reduce((acc, bit) => acc | bit, 0n);
  for (const c of channels) {
    try {
      const ow = c.permissionOverwrites.cache.get(everyone);
      const denyBits = (ow?.deny.bitfield ?? 0n) | lockMask;
      const allowBits = (ow?.allow.bitfield ?? 0n) & ~lockMask;
      await c.edit({
        permissionOverwrites: [
          ...c.permissionOverwrites.cache.filter((o) => o.id !== everyone).map((o) => ({ id: o.id, allow: o.allow.bitfield, deny: o.deny.bitfield, type: o.type })),
          { id: everyone, allow: allowBits, deny: denyBits, type: OverwriteType.Role },
        ],
        reason: `Lockdown: ${reason}`.slice(0, 512),
      });
      locked++;
    } catch (err) {
      failed++;
      logger.warn({ err, channel: c.id }, 'Lockdown failed on channel');
    }
  }
  await guild.disableInvites(true).catch((err: unknown) => logger.debug({ err }, 'Could not pause invites'));
  await logSecurity(guild, { type: 'lockdown', severity: 'critical', actorId: by, summary: `Emergency lockdown engaged: ${reason}`, action: `${locked} channels locked, ${failed} failed` });
  return { locked, failed };
}

/** Restores each channel's @everyone overwrite exactly as it was before lockdown. */
export async function liftLockdown(guild: Guild, by: string): Promise<{ restored: number; failed: number }> {
  const doc = await Lockdown.findOne({ guildId: guild.id });
  if (!doc?.active) throw new UserError('The server is not in lockdown.');
  const everyone = guild.roles.everyone.id;
  let restored = 0;
  let failed = 0;
  for (const snap of doc.snapshot) {
    const channel = guild.channels.cache.get(snap.channelId) as GuildChannel | undefined;
    if (!channel) continue;
    try {
      const reason = 'Lockdown lifted';
      if (snap.existed) {
        await channel.edit({
          permissionOverwrites: [
            ...channel.permissionOverwrites.cache.filter((o) => o.id !== everyone).map((o) => ({ id: o.id, allow: o.allow.bitfield, deny: o.deny.bitfield, type: o.type })),
            { id: everyone, allow: BigInt(snap.allow), deny: BigInt(snap.deny), type: OverwriteType.Role },
          ],
          reason,
        });
      } else {
        await channel.permissionOverwrites.delete(everyone, reason);
      }
      restored++;
    } catch (err) {
      failed++;
      logger.warn({ err, channel: snap.channelId }, 'Could not restore channel after lockdown');
    }
  }
  await Lockdown.updateOne({ guildId: guild.id }, { $set: { active: false, snapshot: [] } });
  await guild.disableInvites(false).catch((err: unknown) => logger.debug({ err }, 'Could not resume invites'));
  await logSecurity(guild, { type: 'lockdown_lifted', severity: 'info', actorId: by, summary: 'Lockdown lifted', action: `${restored} channels restored, ${failed} failed` });
  return { restored, failed };
}
