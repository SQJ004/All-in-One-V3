import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { vi } from 'vitest';

/** Minimal stand-ins for discord.js objects, recording every call the bot makes to Discord. */
export const GUILD_ID = '100000000000000001';
export const OWNER_ID = '200000000000000001';
export const BOT_ID = '200000000000000002';

export function fakeRole(id: string, position: number, opts: { managed?: boolean; perms?: bigint[]; name?: string; guild?: any } = {}): any {
  return {
    id, position, name: opts.name ?? `role-${id}`, managed: opts.managed ?? false, hoist: false, mentionable: false, color: 0, colors: { primaryColor: 0 },
    permissions: new PermissionsBitField(opts.perms ?? []), members: new Collection(), guild: opts.guild ?? { id: GUILD_ID },
    setPermissions: vi.fn(async () => undefined), delete: vi.fn(async () => undefined), setPosition: vi.fn(async () => undefined),
  };
}

export function fakeMember(guild: any, id: string, opts: { position?: number; roles?: any[]; bot?: boolean; perms?: bigint[]; tag?: string; createdDaysAgo?: number; avatar?: string | null } = {}): any {
  const roles = new Collection<string, any>((opts.roles ?? []).map((r) => [r.id, r]));
  const highest = { position: opts.position ?? 1 };
  const member: any = {
    id, guild, client: guild.client, displayName: opts.tag ?? `user-${id}`, nickname: null, joinedTimestamp: Date.now(), moderatable: true, kickable: true,
    user: { id, tag: opts.tag ?? `user-${id}`, username: opts.tag ?? `user-${id}`, displayName: opts.tag ?? `user-${id}`, bot: opts.bot ?? false, avatar: opts.avatar === undefined ? 'abc' : opts.avatar, createdAt: new Date(Date.now() - (opts.createdDaysAgo ?? 400) * 86_400_000), createdTimestamp: Date.now() - (opts.createdDaysAgo ?? 400) * 86_400_000, send: vi.fn(async () => undefined), displayAvatarURL: () => 'https://cdn.example/a.png' },
    roles: { highest, cache: roles, set: vi.fn(async (ids: string[]) => { roles.clear(); for (const rid of ids) roles.set(rid, guild.roles.cache.get(rid) ?? { id: rid, managed: false }); }), add: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
    permissions: new PermissionsBitField(opts.perms ?? []),
    kick: vi.fn(async () => undefined), timeout: vi.fn(async () => undefined), setNickname: vi.fn(async () => undefined), send: vi.fn(async () => undefined), displayAvatarURL: () => 'https://cdn.example/a.png',
  };
  guild.members.cache.set(id, member);
  return member;
}

export function fakeChannel(guild: any, id: string, opts: { type?: ChannelType; name?: string; overwrites?: Array<{ id: string; allow: bigint; deny: bigint; type?: number }> } = {}): any {
  const overwrites = new Collection<string, any>((opts.overwrites ?? []).map((o) => [o.id, { id: o.id, type: o.type ?? 0, allow: { bitfield: o.allow }, deny: { bitfield: o.deny } }]));
  const channel: any = {
    id, guild, name: opts.name ?? `channel-${id}`, type: opts.type ?? ChannelType.GuildText, parentId: null, rawPosition: 1,
    send: vi.fn(async () => ({ id: `m-${id}`, url: 'https://discord.com/x', delete: vi.fn(async () => undefined) })),
    delete: vi.fn(async () => undefined), setPosition: vi.fn(async () => undefined),
    isThread: () => false,
    permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
    permissionOverwrites: {
      cache: overwrites,
      delete: vi.fn(async (roleId: string) => { overwrites.delete(roleId); }),
    },
    // Applies the overwrite list like Discord does, so tests can compare state before and after.
    edit: vi.fn(async ({ permissionOverwrites }: any) => {
      overwrites.clear();
      for (const o of permissionOverwrites ?? []) overwrites.set(o.id, { id: o.id, type: o.type, allow: { bitfield: o.allow }, deny: { bitfield: o.deny } });
    }),
  };
  guild.channels.cache.set(id, channel);
  return channel;
}

export function fakeGuild(opts: { id?: string } = {}): any {
  const guild: any = {
    id: opts.id ?? GUILD_ID, name: 'Test Guild', ownerId: OWNER_ID, memberCount: 100,
    client: { user: { id: BOT_ID, tag: 'ZYTHERON#0001' }, users: { fetch: vi.fn() }, guilds: { cache: new Collection<string, any>() } },
    roles: { cache: new Collection<string, any>(), create: vi.fn(async (o: any) => fakeRole(`9${Date.now()}`.padEnd(18, '0'), 1, { name: o.name })), everyone: { id: opts.id ?? GUILD_ID } },
    channels: { cache: new Collection<string, any>(), create: vi.fn(async (o: any) => { const c = fakeChannel(guild, `8${guild.channels.cache.size}`.padEnd(18, '0'), { name: o.name, type: o.type }); return c; }) },
    bans: { fetch: vi.fn(async () => { throw new Error('not banned'); }) },
    disableInvites: vi.fn(async () => undefined), setName: vi.fn(async () => undefined), fetchWebhooks: vi.fn(async () => new Collection()),
  };
  guild.members = {
    cache: new Collection<string, any>(),
    fetch: vi.fn(async (id: string) => {
      const m = guild.members.cache.get(id);
      if (!m) throw new Error('Unknown member');
      return m;
    }),
    ban: vi.fn(async () => undefined), unban: vi.fn(async () => undefined), me: undefined,
  };
  guild.client.guilds.cache.set(guild.id, guild);
  guild.roles.everyone = { id: guild.id };
  guild.members.me = fakeMember(guild, BOT_ID, { position: 50, perms: [PermissionFlagsBits.Administrator], bot: true });
  // Discord gives the owner every permission implicitly.
  fakeMember(guild, OWNER_ID, { position: 100, perms: [PermissionFlagsBits.Administrator] });
  return guild;
}

export const auditEntry = (o: { action: number; executorId: string; targetId?: string; targetType?: string; actionType?: string; changes?: any[] }): any => ({
  action: o.action, executorId: o.executorId, targetId: o.targetId ?? '300000000000000000', targetType: o.targetType ?? 'Channel', actionType: o.actionType ?? 'Delete', changes: o.changes ?? [], createdTimestamp: Date.now(), reason: null, target: null,
});
