import { AuditLogEvent, ChannelType, type Guild, type GuildAuditLogsEntry, type GuildBasedChannel, type Role } from 'discord.js';
import { logger } from '../../core/logger.js';
import { hasDangerousPermissions } from '../../core/permissions.js';

/**
 * Discord does not let a bot undo a deletion, but a channel or role can be rebuilt
 * from what the gateway told us before it vanished. Message history cannot be restored.
 */
export interface ChannelSnapshot { id: string; name: string; type: ChannelType; parentId: string | null; position: number; topic?: string | null; nsfw?: boolean; rateLimitPerUser?: number; bitrate?: number; userLimit?: number; overwrites: Array<{ id: string; type: number; allow: bigint; deny: bigint }> }
export interface RoleSnapshot { id: string; name: string; color: number; hoist: boolean; mentionable: boolean; permissions: bigint; position: number; memberIds: string[] }

const SNAPSHOT_GRACE_MS = 1200;

/** Rebuild order: roles first (overwrites refer to them), then categories (channels live in them), then the rest. */
export function recoveryPriority(entry: Pick<GuildAuditLogsEntry, 'action' | 'targetId'>): number {
  if (entry.action === AuditLogEvent.RoleDelete) return 0;
  if (entry.action === AuditLogEvent.ChannelDelete) return channelSnaps.get(entry.targetId ?? '')?.type === ChannelType.GuildCategory ? 1 : 2;
  return 3;
}

const channelSnaps = new Map<string, ChannelSnapshot>();
const roleSnaps = new Map<string, RoleSnapshot>();
const remap = new Map<string, string>(); // deleted id -> recreated id (so children land in rebuilt categories)

function remember<T>(store: Map<string, T>, id: string, value: T): void {
  store.set(id, value);
  setTimeout(() => store.delete(id), 10 * 60_000).unref();
}

export function snapshotChannel(c: GuildBasedChannel): void {
  const anyC = c as GuildBasedChannel & { topic?: string | null; nsfw?: boolean; rateLimitPerUser?: number; bitrate?: number; userLimit?: number; permissionOverwrites?: { cache: Map<string, { id: string; type: number; allow: { bitfield: bigint }; deny: { bitfield: bigint } }> }; rawPosition?: number };
  remember(channelSnaps, c.id, {
    id: c.id, name: c.name, type: c.type, parentId: c.parentId, position: anyC.rawPosition ?? 0, topic: anyC.topic, nsfw: anyC.nsfw, rateLimitPerUser: anyC.rateLimitPerUser, bitrate: anyC.bitrate, userLimit: anyC.userLimit,
    overwrites: anyC.permissionOverwrites ? [...anyC.permissionOverwrites.cache.values()].map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield })) : [],
  });
}

export function snapshotRole(r: Role): void {
  remember(roleSnaps, r.id, { id: r.id, name: r.name, color: r.colors?.primaryColor ?? r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions.bitfield, position: r.position, memberIds: [...r.members.keys()] });
}

export const getChannelSnapshot = (id: string) => channelSnaps.get(id);
export const getRoleSnapshot = (id: string) => roleSnaps.get(id);

const REBUILDABLE = new Set([ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum]);

export async function restoreChannel(guild: Guild, snap: ChannelSnapshot): Promise<string | null> {
  if (!REBUILDABLE.has(snap.type)) return null;
  const parent = snap.parentId ? (remap.get(snap.parentId) ?? snap.parentId) : null;
  const created = await guild.channels.create({
    name: snap.name,
    type: snap.type as ChannelType.GuildText,
    parent: parent && guild.channels.cache.has(parent) ? parent : null,
    topic: snap.topic ?? undefined,
    nsfw: snap.nsfw,
    rateLimitPerUser: snap.rateLimitPerUser,
    bitrate: snap.bitrate,
    userLimit: snap.userLimit,
    // Overwrites for roles that were deleted in the same attack point at IDs that no longer exist.
    permissionOverwrites: snap.overwrites
      .map((o) => ({ ...o, id: remap.get(o.id) ?? o.id }))
      .filter((o) => o.type !== 0 || guild.roles.cache.has(o.id))
      .map((o) => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny })),
    reason: 'ZYTHERON anti-nuke recovery',
  });
  remap.set(snap.id, created.id);
  await created.setPosition(snap.position, { reason: 'ZYTHERON anti-nuke recovery' }).catch(() => undefined);
  return created.id;
}

export async function restoreRole(guild: Guild, snap: RoleSnapshot): Promise<{ id: string; reassigned: number }> {
  const role = await guild.roles.create({
    name: snap.name, colors: { primaryColor: snap.color }, hoist: snap.hoist, mentionable: snap.mentionable, permissions: snap.permissions, reason: 'ZYTHERON anti-nuke recovery',
  });
  remap.set(snap.id, role.id);
  const me = guild.members.me;
  await role.setPosition(Math.min(snap.position, (me?.roles.highest.position ?? 1) - 1), { reason: 'ZYTHERON anti-nuke recovery' }).catch(() => undefined);
  let reassigned = 0;
  for (const id of snap.memberIds.slice(0, 500)) {
    const member = guild.members.cache.get(id);
    if (!member) continue;
    try {
      await member.roles.add(role, 'ZYTHERON anti-nuke recovery');
      reassigned++;
    } catch (err) {
      logger.debug({ err, id }, 'Could not re-assign recovered role');
    }
  }
  return { id: role.id, reassigned };
}

/** Undoes one audit-logged action. Returns a human-readable line, or null when nothing applies. */
export async function undoEntry(guild: Guild, entry: GuildAuditLogsEntry): Promise<string | null> {
  const targetId = entry.targetId;
  if (!targetId) return null;
  switch (entry.actionType === 'Delete' ? entry.targetType : `${entry.targetType}:${entry.actionType}`) {
    case 'Channel': {
      // The channelDelete event can arrive just after the audit entry.
      if (!channelSnaps.has(targetId)) await new Promise((r) => setTimeout(r, SNAPSHOT_GRACE_MS));
      const snap = channelSnaps.get(targetId);
      if (!snap) return `Channel ${targetId}: no snapshot, not restored`;
      const id = await restoreChannel(guild, snap);
      return id ? `Rebuilt channel #${snap.name}` : `Channel #${snap.name} cannot be rebuilt`;
    }
    case 'Role': {
      if (!roleSnaps.has(targetId)) await new Promise((r) => setTimeout(r, SNAPSHOT_GRACE_MS));
      const snap = roleSnaps.get(targetId);
      if (!snap) return `Role ${targetId}: no snapshot, not restored`;
      const { reassigned } = await restoreRole(guild, snap);
      return `Rebuilt role @${snap.name} (${reassigned} members re-assigned)`;
    }
    case 'Channel:Create': {
      const c = guild.channels.cache.get(targetId);
      if (c) await c.delete('ZYTHERON anti-nuke recovery');
      return c ? `Removed channel #${c.name}` : null;
    }
    case 'Role:Create': {
      const r = guild.roles.cache.get(targetId);
      if (r) await r.delete('ZYTHERON anti-nuke recovery');
      return r ? `Removed role @${r.name}` : null;
    }
    case 'Webhook:Create': {
      const hooks = await guild.fetchWebhooks();
      const hook = hooks.get(targetId);
      if (hook) await hook.delete('ZYTHERON anti-nuke recovery');
      return hook ? `Removed webhook ${hook.name}` : null;
    }
    case 'Role:Update': {
      const r = guild.roles.cache.get(targetId);
      const change = entry.changes.find((c) => c.key === 'permissions');
      if (r && change?.old !== undefined) {
        await r.setPermissions(BigInt(change.old as string), 'ZYTHERON anti-nuke recovery');
        return `Reverted permissions on @${r.name}`;
      }
      return null;
    }
    case 'User:Update': {
      // A dangerous role handed to a member during the attack.
      const added = entry.changes.find((c) => c.key === '$add')?.new as Array<{ id: string; name?: string }> | undefined;
      const member = await guild.members.fetch(targetId).catch(() => null);
      const dangerous = (added ?? []).filter((r) => {
        const role = guild.roles.cache.get(r.id);
        return role && hasDangerousPermissions(role.permissions.bitfield);
      });
      if (!member || !dangerous.length) return null;
      await member.roles.remove(dangerous.map((r) => r.id), 'ZYTHERON anti-nuke recovery');
      return `Removed ${dangerous.map((r) => `@${r.name ?? r.id}`).join(', ')} from ${targetId}`;
    }
    case 'Guild:Update': {
      const nameChange = entry.changes.find((c) => c.key === 'name');
      const iconChange = entry.changes.find((c) => c.key === 'icon_hash');
      if (nameChange?.old) await guild.setName(String(nameChange.old), 'ZYTHERON anti-nuke recovery');
      if (iconChange) logger.info({ guild: guild.id }, 'Guild icon changed by attacker; the old image is no longer retrievable');
      return nameChange?.old ? `Restored server name to ${String(nameChange.old)}` : null;
    }
    default:
      return null;
  }
}

/** Reverses a ban made by a confirmed attacker. Kicks have no equivalent. */
export async function undoBan(guild: Guild, userId: string): Promise<string> {
  await guild.members.unban(userId, 'ZYTHERON anti-nuke recovery');
  return `Unbanned ${userId}`;
}
