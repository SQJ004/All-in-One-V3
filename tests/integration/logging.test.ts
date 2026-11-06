import { AuditLogEvent as A, PermissionFlagsBits as P } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getConfig, updateConfig } from '../../src/core/configService.js';
import { InteractionRouter } from '../../src/core/interactions.js';
import { Cooldown } from '../../src/core/rateLimit.js';
import { MODULES } from '../../src/core/registry.js';
import { permissionNames, readableLogEmbed, renderChange } from '../../src/modules/logging/index.js';
import { baseEmbed } from '../../src/ui/theme.js';
import { sendLog } from '../../src/modules/logging/service.js';
import { useDatabase } from '../helpers/db.js';
import { fakeChannel, fakeMember } from '../helpers/fakes.js';
import { commandInteraction, setupGuild } from '../helpers/interaction.js';

/** Real commands and real sending logic. Only Discord itself is faked. */
useDatabase();

const router = new InteractionRouter(MODULES);
beforeAll(() => { vi.spyOn(Cooldown.prototype, 'allow').mockReturnValue(0); });
afterAll(() => { vi.restoreAllMocks(); });
const LOGS = '600000000000000091';
const OTHER = '600000000000000092';

function world() {
  const guild = setupGuild();
  fakeChannel(guild, '600000000000000001');
  const logs = fakeChannel(guild, LOGS, { name: 'logs' });
  const other = fakeChannel(guild, OTHER, { name: 'other' });
  const owner = fakeMember(guild, guild.ownerId, { position: 40, perms: [P.Administrator] });
  guild.members.me = fakeMember(guild, guild.client.user.id, { position: 30, bot: true, perms: [P.Administrator] });
  return { guild, logs, other, owner };
}
type World = ReturnType<typeof world>;

async function logs(w: World, sub: string, options: Record<string, unknown> = {}) {
  const i = commandInteraction(w.guild, 'logs', sub, options, { member: w.owner });
  i.options.getChannel = (name: string) => (options[name] as object | undefined) ?? null;
  await router.handle(i);
  return JSON.stringify(i.reply.mock.calls.at(-1)?.[0] ?? i.followUp.mock.calls.at(-1)?.[0]);
}
const send = (w: World, category: 'message' | 'role' | 'voice') => sendLog(w.guild, category, baseEmbed().setTitle('Test event'));

describe('permission changes in logs', () => {
  it('turns the number from your screenshot into names', () => {
    expect(renderChange({ key: 'permissions', old: '0', new: '268436496' })).toBe('**Permissions added**: Manage Channels, View Channels, Manage Roles');
  });
  it('shows what was added and what was removed', () => {
    const before = String(P.ViewChannel | P.KickMembers);
    const after = String(P.ViewChannel | P.BanMembers);
    expect(renderChange({ key: 'permissions', old: before, new: after })).toBe('**Permissions added**: Ban Members\n**Permissions removed**: Kick Members');
  });
  it('names channel overrides too, and handles new roles with no old value', () => {
    expect(renderChange({ key: 'allow', new: String(P.SendMessages) })).toBe('**Allowed permissions added**: Send Messages');
    expect(renderChange({ key: 'deny', old: String(P.ViewChannel), new: '0' })).toBe('**Denied permissions removed**: View Channels');
  });
  it("uses Discord's own names", () => {
    expect(permissionNames(P.ManageGuild | P.ModerateMembers | P.CreateInstantInvite)).toEqual(['Create Invite', 'Manage Server', 'Timeout Members']);
    expect(permissionNames(P.ManageMessages | P.Administrator)).toEqual(['Administrator', 'Manage Messages']);
  });
  it('says nothing when permissions did not change, and survives odd or future values', () => {
    expect(renderChange({ key: 'permissions', old: '8', new: '8' })).toBe('');
    expect(renderChange({ key: 'permissions', old: '0', new: 'garbage' })).toContain('garbage');
    expect(renderChange({ key: 'permissions', old: '0', new: String(1n << 62n) })).toContain('newer than this bot');
  });
  it('leaves other changes as they were', () => {
    expect(renderChange({ key: 'name', old: 'old role', new: 'new role' })).toBe('**name**: old role › new role');
  });
});

describe('role and channel logs', () => {
  const guild: any = { id: '100000000000000001', name: 'SNAKES', iconURL: () => 'https://cdn.example/snakes.png', roles: { cache: new Map([['400000000000000001', {}]]) }, client: { users: { cache: new Map() } } };
  const entry = (changes: unknown[], over: object = {}): any => ({ action: A.RoleUpdate, target: { name: 'new role' }, extra: null, executorId: '700000000000000001', executor: { username: 'trascovitsh', displayAvatarURL: () => 'https://cdn.example/me.png' }, reason: null, changes, ...over });
  const view = (e: any) => readableLogEmbed(e, guild).toJSON();

  it('matches the requested layout, with a tick for each added permission', () => {
    const data = view(entry([{ key: 'permissions', old: '0', new: '268436496' }]));
    expect(data.author?.name).toBe('SNAKES');
    expect(data.author?.icon_url).toBe('https://cdn.example/snakes.png');
    expect(data.description).toContain('`new role`');
    expect(data.description).toContain('role has been updated.');
    expect(data.fields).toEqual([
      { name: 'New permissions', value: '✅ Manage Channels\n✅ View Channels\n✅ Manage Roles' },
      { name: 'Responsible Moderator', value: '<@700000000000000001>', inline: false },
    ]);
    expect(data.footer?.text).toBe('trascovitsh');
    expect(data.footer?.icon_url).toBe('https://cdn.example/me.png');
    expect(data.timestamp).toBeTruthy();
  });

  it('marks removed permissions with a stop sign', () => {
    const data = view(entry([{ key: 'permissions', old: String(P.ViewChannel | P.KickMembers), new: String(P.ViewChannel | P.BanMembers) }]));
    expect(data.fields![0]).toEqual({ name: 'New permissions', value: '✅ Ban Members\n⛔ Kick Members' });
  });

  it('shows other changes, and leaves out the permissions section when they did not change', () => {
    const data = view(entry([{ key: 'name', old: 'old role', new: 'new role' }], { reason: 'Tidying up' }));
    expect(data.fields!.map((f) => f.name)).toEqual(['Other changes', 'Reason', 'Responsible Moderator']);
    expect(data.fields![0]!.value).toBe('**name**: old role › new role');
  });

  it('copes with a deleted role, an unknown moderator, and backticks in a name', () => {
    const data = view(entry([{ key: 'name', old: 'gone', new: 'a`b' }], { target: null, executorId: null, executor: null }));
    expect(data.description).toContain('a\'b');
    expect(data.fields!.at(-1)).toEqual({ name: 'Responsible Moderator', value: 'Unknown', inline: false });
    expect(data.footer?.text).toContain('ZYTHERON');
  });

  it('role created and deleted say so, without noise', () => {
    const created = view(entry([{ key: 'name', new: 'fresh' }, { key: 'color', new: 0 }, { key: 'permissions', new: String(P.ViewChannel) }], { action: A.RoleCreate, target: { name: 'fresh' } }));
    expect(created.description).toContain('`fresh`');
    expect(created.description).toContain('role has been created.');
    expect(created.fields!.map((f) => f.name)).toEqual(['New permissions', 'Responsible Moderator']);
    const deleted = view(entry([{ key: 'name', old: 'gone' }, { key: 'permissions', old: '8' }], { action: A.RoleDelete, target: null }));
    expect(deleted.description).toContain('`gone`');
    expect(deleted.description).toContain('role has been deleted.');
    expect(deleted.fields!.map((f) => f.name)).toEqual(['Responsible Moderator']);
  });

  it('channels use the same layout, with a # in front', () => {
    const made = view(entry([{ key: 'name', new: 'general' }, { key: 'type', new: 0 }, { key: 'permission_overwrites', new: [] }], { action: A.ChannelCreate, target: { name: 'general' } }));
    expect(made.author?.name).toBe('SNAKES');
    expect(made.description).toContain('`#general`');
    expect(made.description).toContain('channel has been created.');
    expect(made.fields!.map((f) => f.name)).toEqual(['Responsible Moderator']);
    const renamed = view(entry([{ key: 'name', old: 'chat', new: 'general' }, { key: 'nsfw', old: false, new: true }], { action: A.ChannelUpdate, target: { name: 'general' } }));
    expect(renamed.description).toContain('channel has been updated.');
    expect(renamed.fields![0]!.name).toBe('Other changes');
    expect(renamed.fields![0]!.value).toContain('**name**: chat › general');
    const removed = view(entry([{ key: 'name', old: 'old-chat' }], { action: A.ChannelDelete, target: null }));
    expect(removed.description).toContain('`#old-chat`');
    expect(removed.description).toContain('channel has been deleted.');
  });

  it('channel permissions show the role they apply to, with what each now does', () => {
    const data = view(entry([
      { key: 'allow', old: String(P.ViewChannel), new: String(P.SendMessages) },
      { key: 'deny', old: String(P.AttachFiles), new: String(P.ManageMessages) },
    ], { action: A.ChannelOverwriteUpdate, target: { name: 'general' }, targetId: '600000000000000005', extra: { id: '400000000000000001' } }));
    expect(data.description).toBe('🏠 **Channel Permissions Updated:** <#600000000000000005>');
    expect(data.fields![0]).toEqual({ name: 'Permissions', value: '↘️ <@&400000000000000001>\n✅ Send Messages\n⛔ Manage Messages\n➖ View Channels\n➖ Attach Files' });
    expect(data.fields![1]!.name).toBe('Responsible Moderator');
  });

  it('a permission moving from allowed to denied shows only once', () => {
    const data = view(entry([{ key: 'allow', old: String(P.ViewChannel), new: '0' }, { key: 'deny', old: '0', new: String(P.ViewChannel) }], { action: A.ChannelOverwriteUpdate, target: { name: 'general' }, extra: { id: '400000000000000001' } }));
    expect(data.fields![0]!.value).toBe('↘️ <@&400000000000000001>\n⛔ View Channels');
  });

  it('names @everyone and members correctly in channel permissions', () => {
    const all = view(entry([{ key: 'deny', new: String(P.ViewChannel) }], { action: A.ChannelOverwriteCreate, target: { name: 'staff' }, extra: { id: guild.id } }));
    expect(all.description).toContain('Channel Permissions Added');
    expect(all.fields![0]!.value).toBe('↘️ @everyone\n⛔ View Channels');
    const member = view(entry([{ key: 'allow', old: String(P.ViewChannel), new: '0' }], { action: A.ChannelOverwriteDelete, target: { name: 'staff' }, extra: { id: '700000000000000005' } }));
    expect(member.description).toContain('Channel Permissions Removed');
    expect(member.fields![0]!.value).toBe('↘️ <@700000000000000005>\n➖ View Channels');
  });

  it('matches the screenshot for one role getting one permission', () => {
    const data = view(entry([{ key: 'allow', old: '0', new: '1024' }], { action: A.ChannelOverwriteUpdate, target: { name: 'AFK' }, targetId: '600000000000000005', extra: { id: '400000000000000001' } }));
    expect(data.fields![0]).toEqual({ name: 'Permissions', value: '↘️ <@&400000000000000001>\n✅ View Channels' });
  });

  it('role creation hides colour settings and raw numbers', () => {
    const data = view(entry([{ key: 'permissions', new: '1024' }, { key: 'colors', new: { primary_color: 0 } }, { key: 'hoist', new: false }], { action: A.RoleCreate }));
    const text = JSON.stringify(data);
    expect(text).not.toContain('primary_color');
    expect(text).not.toContain('1024');
    expect(text).toContain('✅ View Channels');
  });

  it('shows a colour change side by side, like the screenshot', () => {
    const data = view(entry([{ key: 'color', old: 0, new: 0x206694 }, { key: 'colors', old: { primary_color: 0 }, new: { primary_color: 0x206694 } }]));
    expect(data.fields).toEqual([
      { name: 'Old color', value: '#99AAB5', inline: true },
      { name: 'New color', value: '#206694', inline: true },
      { name: 'Responsible Moderator', value: '<@700000000000000001>', inline: true },
    ]);
    expect(JSON.stringify(data)).not.toContain('primary_color');
  });

  it('reads a colour change from either format, and from colour to no colour', () => {
    const fromColors = view(entry([{ key: 'colors', old: { primary_color: 0xef4444 }, new: { primary_color: 0 } }]));
    expect(fromColors.fields!.slice(0, 2).map((f) => f.value)).toEqual(['#EF4444', '#99AAB5']);
  });

  it('shows no colours when the colour did not really change', () => {
    const data = view(entry([{ key: 'colors', old: { primary_color: 5, secondary_color: 1 }, new: { primary_color: 5, secondary_color: 2 } }]));
    expect(data.fields!.map((f) => f.name)).toEqual(['Responsible Moderator']);
  });

  it('shows colour and permission changes together', () => {
    const data = view(entry([{ key: 'color', old: 0, new: 255 }, { key: 'permissions', old: '0', new: '1024' }]));
    expect(data.fields!.map((f) => f.name)).toEqual(['New permissions', 'Old color', 'New color', 'Responsible Moderator']);
    expect(data.fields![2]!.value).toBe('#0000FF');
  });

  it('shows colours as colours', () => {
    expect(renderChange({ key: 'color', old: 0, new: 15680580 })).toBe('**color**: none › #ef4444');
  });

  it('works for a server with no icon, and a moderator known only by ID', () => {
    const plain: any = { id: '1', name: 'Plain', iconURL: () => null, roles: { cache: new Map() }, client: { users: { cache: new Map([['700000000000000001', { username: 'cached', displayAvatarURL: () => 'https://cdn.example/c.png' }]]) } } };
    const data = readableLogEmbed(entry([], { executor: null }), plain).toJSON();
    expect(data.author?.icon_url).toBeUndefined();
    expect(data.footer?.text).toBe('cached');
  });
});

describe('logging posts where it should', () => {
  it('posts nothing while the main switch is off, even with a channel set', async () => {
    const w = world();
    await updateConfig(w.guild.id, 'logging', { enabled: false, channels: { message: LOGS } });
    await send(w, 'message');
    expect(w.logs.send).not.toHaveBeenCalled();
  });

  it('/logs setup turns it on, and events reach the channel', async () => {
    const w = world();
    expect(await logs(w, 'setup', { channel: w.logs })).toMatch(/Logging is on/);
    await send(w, 'voice');
    expect(w.logs.send).toHaveBeenCalledOnce();
  });

  it('/logs route also turns logging on, because a chosen channel means logs are wanted', async () => {
    const w = world();
    expect((await getConfig(w.guild.id)).logging.enabled).toBe(false);
    const reply = await logs(w, 'route', { category: 'message', channel: w.other });
    expect(reply).toMatch(/now go to/);
    expect(reply).toMatch(/Logging is now on/);
    expect((await getConfig(w.guild.id)).logging.enabled).toBe(true);
    await send(w, 'message');
    expect(w.other.send).toHaveBeenCalledOnce();
  });

  it('/logs route warns about other categories having nowhere to go', async () => {
    const w = world();
    expect(await logs(w, 'route', { category: 'message', channel: w.other })).toMatch(/Other events have no channel.*\/logs setup/);
    await logs(w, 'setup', { channel: w.logs });
    expect(await logs(w, 'route', { category: 'role', channel: w.other })).not.toMatch(/Other events have no channel/);
  });

  it('/logs status says plainly when nothing will be posted', async () => {
    const w = world();
    expect(await logs(w, 'status')).toMatch(/Logging is off, so nothing is being posted.*\/logs setup/);
    await logs(w, 'route', { category: 'message', channel: w.other });
    const partial = await logs(w, 'status');
    expect(partial).not.toMatch(/Logging is off/);
    expect(partial).toMatch(/Events without a channel are not posted/);
    await logs(w, 'setup', { channel: w.logs });
    const full = await logs(w, 'status');
    expect(full).not.toMatch(/nothing is being posted|without a channel/);
  });

  it('/logs off stays off until someone chooses a channel again', async () => {
    const w = world();
    await logs(w, 'setup', { channel: w.logs });
    await logs(w, 'off');
    await send(w, 'voice');
    expect(w.logs.send).not.toHaveBeenCalled();
    await logs(w, 'toggle', { category: 'voice', enabled: true });
    expect((await getConfig(w.guild.id)).logging.enabled).toBe(false);
  });

  it('a turned-off category posts nothing, and a failed send never throws', async () => {
    const w = world();
    await logs(w, 'setup', { channel: w.logs });
    await logs(w, 'toggle', { category: 'voice', enabled: false });
    await send(w, 'voice');
    expect(w.logs.send).not.toHaveBeenCalled();
    w.logs.send = vi.fn(async () => { throw new Error('Missing Access'); });
    await expect(send(w, 'message')).resolves.toBeUndefined();
  });
});
