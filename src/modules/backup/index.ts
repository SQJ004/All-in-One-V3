import { randomUUID } from 'node:crypto';
import { ChannelType, OverwriteType, PermissionFlagsBits as P, type Client, type Guild, type GuildBasedChannel, type GuildChannelCreateOptions, type NonThreadGuildBasedChannel } from 'discord.js';
import { getConfig } from '../../core/configService.js';
import { logger } from '../../core/logger.js';
import { UserError, type VortexModule } from '../../core/types.js';
import { ServerBackup, type IRestoreReport, type IServerBackup } from '../../db/models.js';
import type { Doc } from '../../db/store.js';

interface OverwriteData { id: string; type: 'role' | 'member'; allow: string; deny: string }
interface RoleData { id: string; name: string; color: number; hoist: boolean; mentionable: boolean; permissions: string; position: number }
interface ChannelData { id: string; name: string; type: number; parentId: string | null; position: number; topic: string | null; nsfw: boolean; rateLimitPerUser: number; bitrate: number | null; userLimit: number | null; overwrites: OverwriteData[] }
export interface BackupData {
  name: string;
  settings: { verificationLevel: number; explicitContentFilter: number; defaultMessageNotifications: number; afkTimeout: number; afkChannelId: string | null; systemChannelId: string | null; rulesChannelId: string | null };
  everyonePermissions: string;
  roles: RoleData[];
  categories: ChannelData[];
  channels: ChannelData[];
  emojis: Array<{ name: string; url: string }>;
}

export interface RestoreOptions { roles: boolean; channels: boolean; permissions: boolean; settings: boolean; emojis: boolean }

const RESTORABLE = new Set<number>([ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildCategory]);
const RESTORE_REASON = 'ZYTHERON: restoring a backup';
const restoring = new Set<string>();

function channelData(channel: NonThreadGuildBasedChannel): ChannelData {
  const c = channel as NonThreadGuildBasedChannel & { topic?: string | null; nsfw?: boolean; rateLimitPerUser?: number | null; bitrate?: number; userLimit?: number; rawPosition?: number };
  return {
    id: c.id, name: c.name, type: c.type, parentId: c.parentId, position: c.rawPosition ?? 0,
    topic: c.topic ?? null, nsfw: Boolean(c.nsfw), rateLimitPerUser: c.rateLimitPerUser ?? 0, bitrate: c.bitrate ?? null, userLimit: c.userLimit ?? null,
    overwrites: [...c.permissionOverwrites.cache.values()].map((o) => ({ id: o.id, type: o.type === OverwriteType.Role ? 'role' : 'member', allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() })),
  };
}

/** Reads what Discord lets a bot read. Messages and member lists are never included. */
export function captureGuild(guild: Guild): BackupData {
  const all = [...guild.channels.cache.values()].filter((c): c is NonThreadGuildBasedChannel => !c.isThread() && RESTORABLE.has(c.type)).map(channelData);
  return {
    name: guild.name,
    settings: { verificationLevel: guild.verificationLevel, explicitContentFilter: guild.explicitContentFilter, defaultMessageNotifications: guild.defaultMessageNotifications, afkTimeout: guild.afkTimeout, afkChannelId: guild.afkChannelId, systemChannelId: guild.systemChannelId, rulesChannelId: guild.rulesChannelId },
    everyonePermissions: guild.roles.everyone.permissions.bitfield.toString(),
    roles: [...guild.roles.cache.values()].filter((r) => !r.managed && r.id !== guild.id).sort((a, b) => a.position - b.position).map((r) => ({ id: r.id, name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions.bitfield.toString(), position: r.position })),
    categories: all.filter((c) => c.type === ChannelType.GuildCategory),
    channels: all.filter((c) => c.type !== ChannelType.GuildCategory),
    emojis: [...guild.emojis.cache.values()].flatMap((e) => (e.name ? [{ name: e.name, url: e.imageURL() }] : [])),
  };
}

export function backupSummary(b: IServerBackup) {
  return { backupId: b.backupId, kind: b.kind, createdBy: b.createdBy, status: b.status, sizeBytes: b.sizeBytes, counts: b.counts, createdAt: b.createdAt, lastRestore: b.lastRestore ?? null };
}

async function prune(guildId: string, kind: 'manual' | 'auto', keep: number): Promise<void> {
  const extra = await ServerBackup.find({ guildId, kind, status: 'ready' }).sort({ createdAt: -1 }).skip(keep);
  await Promise.all(extra.map((b) => ServerBackup.deleteOne({ _id: b._id })));
}

export async function createBackup(guild: Guild, createdBy: string, kind: 'manual' | 'auto' = 'manual'): Promise<IServerBackup> {
  const data = captureGuild(guild);
  const { backup } = await getConfig(guild.id);
  const doc = await ServerBackup.create({
    guildId: guild.id, backupId: randomUUID().replace(/-/g, '').slice(0, 12), kind, createdBy,
    sizeBytes: Buffer.byteLength(JSON.stringify(data)),
    counts: { roles: data.roles.length, categories: data.categories.length, channels: data.channels.length, emojis: data.emojis.length },
    data: data as unknown as Record<string, unknown>,
  });
  await prune(guild.id, kind, backup.keep);
  return doc;
}

/** Discord sends the same data back only for things that still exist, so a target is matched by ID, then by name. */
function findChannel(guild: Guild, saved: ChannelData): GuildBasedChannel | undefined {
  return guild.channels.cache.get(saved.id) ?? guild.channels.cache.find((c) => c.name === saved.name && c.type === saved.type);
}

/**
 * Puts missing things back and resets what was chosen. It never deletes anything,
 * and never changes who has which role, because Discord backups cannot know that.
 */
export async function runRestore(guild: Guild, data: BackupData, options: RestoreOptions, by: string): Promise<IRestoreReport> {
  const me = guild.members.me;
  if (!me) throw new UserError('ZYTHERON is not ready in that server yet.');
  const report: IRestoreReport = { at: new Date(), by, created: 0, updated: 0, failed: 0, notes: [] };
  const fail = (what: string, err: unknown) => {
    report.failed += 1;
    if (report.notes.length < 25) report.notes.push(`${what}: ${(err as Error).message}`.slice(0, 200));
  };
  const roleIds = new Map<string, string>([[guild.id, guild.id]]);

  if (options.roles || options.permissions) {
    for (const saved of data.roles) {
      const role = guild.roles.cache.get(saved.id) ?? guild.roles.cache.find((r) => r.name === saved.name && !r.managed);
      try {
        if (role) {
          roleIds.set(saved.id, role.id);
          if (options.permissions && role.position < me.roles.highest.position && role.permissions.bitfield.toString() !== saved.permissions) {
            await role.setPermissions(BigInt(saved.permissions), RESTORE_REASON);
            report.updated += 1;
          }
        } else if (options.roles) {
          const made = await guild.roles.create({ name: saved.name, colors: { primaryColor: saved.color }, hoist: saved.hoist, mentionable: saved.mentionable, permissions: BigInt(saved.permissions), reason: RESTORE_REASON });
          roleIds.set(saved.id, made.id);
          report.created += 1;
        }
      } catch (err) {
        fail(`Role ${saved.name}`, err);
      }
    }
    if (options.permissions && guild.roles.everyone.permissions.bitfield.toString() !== data.everyonePermissions) {
      await guild.roles.everyone.setPermissions(BigInt(data.everyonePermissions), RESTORE_REASON).then(() => { report.updated += 1; }, (err) => fail('@everyone', err));
    }
  }

  const mapOverwrites = (list: OverwriteData[]) => list.flatMap((o) => {
    const id = o.type === 'role' ? roleIds.get(o.id) ?? (guild.roles.cache.has(o.id) ? o.id : null) : guild.members.cache.has(o.id) ? o.id : null;
    return id ? [{ id, type: o.type === 'role' ? OverwriteType.Role : OverwriteType.Member, allow: BigInt(o.allow), deny: BigInt(o.deny) }] : [];
  });

  const channelIds = new Map<string, string>();
  const restoreChannels = async (list: ChannelData[]) => {
    for (const saved of list) {
      const existing = findChannel(guild, saved);
      try {
        if (existing) {
          channelIds.set(saved.id, existing.id);
          if (options.permissions && 'permissionOverwrites' in existing) {
            await existing.permissionOverwrites.set(mapOverwrites(saved.overwrites), RESTORE_REASON);
            report.updated += 1;
          }
        } else if (options.channels) {
          const made = await guild.channels.create({
            name: saved.name, type: saved.type, topic: saved.topic ?? undefined, nsfw: saved.nsfw, rateLimitPerUser: saved.rateLimitPerUser || undefined, bitrate: saved.bitrate ?? undefined, userLimit: saved.userLimit ?? undefined, position: saved.position,
            parent: saved.parentId ? channelIds.get(saved.parentId) ?? guild.channels.cache.get(saved.parentId)?.id : undefined,
            permissionOverwrites: mapOverwrites(saved.overwrites), reason: RESTORE_REASON,
          } as GuildChannelCreateOptions);
          channelIds.set(saved.id, made.id);
          report.created += 1;
        }
      } catch (err) {
        fail(`Channel ${saved.name}`, err);
      }
    }
  };
  if (options.channels || options.permissions) {
    await restoreChannels(data.categories);
    await restoreChannels(data.channels);
  }

  if (options.settings) {
    const pick = (id: string | null) => (id ? channelIds.get(id) ?? (guild.channels.cache.has(id) ? id : undefined) : undefined);
    await guild.edit({
      verificationLevel: data.settings.verificationLevel, explicitContentFilter: data.settings.explicitContentFilter, defaultMessageNotifications: data.settings.defaultMessageNotifications, afkTimeout: data.settings.afkTimeout,
      afkChannel: pick(data.settings.afkChannelId), systemChannel: pick(data.settings.systemChannelId), reason: RESTORE_REASON,
    }).then(() => { report.updated += 1; }, (err) => fail('Server settings', err));
  }

  if (options.emojis) {
    for (const emoji of data.emojis) {
      if (guild.emojis.cache.some((e) => e.name === emoji.name)) continue;
      // Discord deletes a removed emoji's image over time, so an old one may no longer be available.
      await guild.emojis.create({ attachment: emoji.url, name: emoji.name, reason: RESTORE_REASON }).then(() => { report.created += 1; }, (err) => fail(`Emoji ${emoji.name}`, err));
    }
  }
  return report;
}

/** Checks everything first, then restores in the background. The page follows along using the backup's status. */
export async function startRestore(guild: Guild, doc: Doc<IServerBackup>, options: RestoreOptions, by: string): Promise<void> {
  const me = guild.members.me;
  if (!me?.permissions.has(P.ManageRoles) || !me.permissions.has(P.ManageChannels)) throw new UserError('ZYTHERON needs Manage Roles and Manage Channels to restore a backup.');
  if (options.emojis && !me.permissions.has(P.ManageGuildExpressions)) throw new UserError('ZYTHERON needs Manage Expressions to restore emojis.');
  if (options.settings && !me.permissions.has(P.ManageGuild)) throw new UserError('ZYTHERON needs Manage Server to restore server settings.');
  if (restoring.has(guild.id)) throw new UserError('A restore is already running in this server.');
  restoring.add(guild.id);
  await ServerBackup.updateOne({ _id: doc._id }, { $set: { status: 'restoring' } });
  void runRestore(guild, doc.data as unknown as BackupData, options, by)
    .then((lastRestore) => ServerBackup.updateOne({ _id: doc._id }, { $set: { status: 'ready', lastRestore } }))
    .catch(async (err) => {
      logger.error({ err, guild: guild.id }, 'A backup restore failed');
      await ServerBackup.updateOne({ _id: doc._id }, { $set: { status: 'ready', lastRestore: { at: new Date(), by, created: 0, updated: 0, failed: 1, notes: [(err as Error).message.slice(0, 200)] } } });
    })
    .finally(() => restoring.delete(guild.id));
}

/** Makes scheduled backups that are due. */
export async function runScheduledBackups(client: Client, now = Date.now()): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    const { backup } = await getConfig(guild.id);
    if (!backup.autoEnabled) continue;
    const [latest] = await ServerBackup.find({ guildId: guild.id, kind: 'auto' }).sort({ createdAt: -1 }).limit(1);
    if (latest && now - new Date(latest.createdAt).getTime() < backup.everyHours * 3_600_000) continue;
    await createBackup(guild, 'Schedule', 'auto').catch((err) => logger.warn({ err, guild: guild.id }, 'A scheduled backup failed'));
  }
}

export const backupModule: VortexModule = {
  name: 'backup',
  intervals: [{ name: 'scheduled-backups', everyMs: 10 * 60_000, run: runScheduledBackups }],
};
