import { Client, Collection, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { getConfig, updateConfig } from '../../src/core/configService.js';
import { wireModules } from '../../src/core/client.js';
import { syncCommands } from '../../src/core/commands.js';
import { InteractionRouter } from '../../src/core/interactions.js';
import { MODULES } from '../../src/core/registry.js';
import { on } from '../../src/core/types.js';
import { AutoResponse, Case, CustomCommand, EmbedDraft, EmbedTemplate, Giveaway, Meta, Poll, PostedEmbed, RolePanel, Ticket, TicketPanel } from '../../src/db/models.js';
import { fakeChannel, fakeMember, fakeRole } from '../helpers/fakes.js';
import { useDatabase } from '../helpers/db.js';
import { commandInteraction, componentInteraction, serialize, setupGuild } from '../helpers/interaction.js';

useDatabase();

const router = new InteractionRouter(MODULES);
const CHANNEL = '600000000000000001';

const run = async (i: any) => { await router.commands.get(i.commandName)!.execute(i); return i; };
const component = async (i: any) => {
  const r = router.resolveComponent(i.customId);
  if (!r) throw new Error(`No handler for ${i.customId}`);
  await r.handler.run(i, r.args);
  return i;
};
const lastPayload = (i: any) => serialize((i.followUp.mock.lastCall ?? i.update?.mock.lastCall ?? i.editReply.mock.lastCall ?? i.reply.mock.lastCall)[0]);

function assertValidMessage(p: any): void {
  const embeds = p.embeds ?? [];
  expect(embeds.length).toBeLessThanOrEqual(10);
  let total = 0;
  for (const e of embeds) {
    if (e.title) expect(e.title.length).toBeLessThanOrEqual(256);
    if (e.description) expect(e.description.length).toBeLessThanOrEqual(4096);
    expect((e.fields ?? []).length).toBeLessThanOrEqual(25);
    for (const f of e.fields ?? []) { expect(f.name.length).toBeGreaterThan(0); expect(f.value.length).toBeGreaterThan(0); expect(f.value.length).toBeLessThanOrEqual(1024); }
    total += JSON.stringify(e).length;
  }
  expect(total).toBeLessThan(9000);
  const rows = p.components ?? [];
  expect(rows.length).toBeLessThanOrEqual(5);
  const ids: string[] = [];
  for (const row of rows) {
    expect(row.components.length).toBeLessThanOrEqual(5);
    for (const c of row.components) {
      if (c.custom_id) { ids.push(c.custom_id); expect(c.custom_id.length).toBeLessThanOrEqual(100); expect(router.resolveComponent(c.custom_id), `no handler for ${c.custom_id}`).not.toBeNull(); }
      if (c.options) { expect(c.options.length).toBeGreaterThan(0); expect(c.options.length).toBeLessThanOrEqual(25); }
    }
  }
  expect(new Set(ids).size).toBe(ids.length);
}

function assertValidModal(m: any): void {
  const j = serialize(m);
  expect(j.title.length).toBeLessThanOrEqual(45);
  expect(j.components.length).toBeLessThanOrEqual(5);
  expect(router.resolveComponent(j.custom_id), `no handler for ${j.custom_id}`).not.toBeNull();
  for (const row of j.components) for (const c of row.components) {
    expect(c.label.length, c.label).toBeLessThanOrEqual(45);
    if (c.placeholder) expect(c.placeholder.length).toBeLessThanOrEqual(100);
    if (c.value !== undefined) expect(c.value.length).toBeLessThanOrEqual(c.max_length ?? 4000);
  }
}

describe('every informational command produces a valid Discord payload', () => {
  const user = { id: '700000000000000001', tag: 'someone', displayName: 'Someone', displayAvatarURL: () => 'https://cdn.example/a.png' };
  const cases: Array<[string, string | null, Record<string, unknown>?, string?]> = [
    ['security', 'config'], ['security', 'events'], ['security', 'list', {}, 'whitelist'], ['security', 'list', {}, 'trusted'],
    ['automod', 'status'], ['welcome', 'status'], ['embed', 'list'], ['embed', 'library'], ['embed', 'builder'], ['embed', 'create'],
    ['logs', 'status'], ['autorole', 'list'], ['rolepanel', 'list'], ['selfrole', 'list'], ['ticket', 'stats'],
    ['cc', 'list'], ['autoresponse', 'list'], ['schedule', 'list'], ['rule', 'list'], ['level', 'leaderboard'], ['level', 'rank', { user }],
    ['giveaway', 'list'], ['invites', 'leaderboard'], ['invites', 'user', { user }], ['serverstats', 'view'], ['birthday', 'upcoming'], ['profile', 'view', { user }],
    ['help', null], ['ping', null], ['setup', null],
    ['moderation', 'warnings', { user }], ['moderation', 'history', { user }], ['moderation', 'notes', { user }],
  ];
  it.each(cases)('/%s %s', async (cmd, sub, options, group) => {
    const guild = setupGuild();
    fakeChannel(guild, CHANNEL);
    const i = await run(commandInteraction(guild, cmd, sub, options, { group }));
    expect(i.reply.mock.calls.length + i.editReply.mock.calls.length + i.followUp.mock.calls.length).toBeGreaterThan(0);
    assertValidMessage(lastPayload(i));
  });
});

describe('every modal is valid', () => {
  it.each([['welcome', 'edit', { template: 'a'.repeat(32) }], ['welcome', 'edit-goodbye', {}], ['profile', 'edit', {}], ['cc', 'create', { name: 'hello' }]] as const)('/%s %s', async (cmd, sub, options) => {
    const guild = setupGuild();
    const i = await run(commandInteraction(guild, cmd, sub, options));
    expect(i.showModal).toHaveBeenCalled();
    assertValidModal(i.showModal.mock.calls[0][0]);
  });
});

describe('embed editor flow', () => {
  const start = async () => {
    const guild = setupGuild();
    const channel = fakeChannel(guild, CHANNEL);
    channel.send = vi.fn(async (p: any) => ({ id: '800000000000000001', url: 'https://discord.com/m', payload: p }));
    const i = await run(commandInteraction(guild, 'embed', 'builder', {}));
    assertValidMessage(serialize(i.reply.mock.calls[0][0]));
    return { guild, channel };
  };
  const draft = () => EmbedDraft.findOne();
  const modalIn = async (guild: any, kind: string, fields: Record<string, string>) => { const i = await component(componentInteraction(guild, 'modal', `embed:md:${kind}`, { fields })); assertValidMessage(lastPayload(i)); return i; };

  it('opens a valid modal for every section', async () => {
    const { guild } = await start();
    await modalIn(guild, 'field_add', { name: 'n', value: 'v', inline: 'yes' });
    for (const section of ['body', 'color', 'author', 'footer', 'images', 'field_add', 'field_edit', 'field_remove', 'content']) {
      const i = await component(componentInteraction(guild, 'select', 'embed:ed:section', { values: [section] }));
      assertValidModal(i.showModal.mock.calls[0][0]);
    }
    for (const button of ['btnlink', 'btnrole', 'menu', 'import', 'save']) {
      const i = await component(componentInteraction(guild, 'button', `embed:ed:${button}`));
      assertValidModal(i.showModal.mock.calls[0][0]);
    }
  });
  it('edits every embed property, with a live preview on each change', async () => {
    const { guild } = await start();
    await modalIn(guild, 'body', { title: 'Hello', url: 'https://x.y', description: 'World' });
    await modalIn(guild, 'color', { color: '#FF0000' });
    await modalIn(guild, 'author', { authorName: 'Me', authorIcon: 'https://x.y/a.png' });
    await modalIn(guild, 'footer', { footerText: 'Foot', footerIcon: '' });
    await modalIn(guild, 'images', { thumbnail: 'https://x.y/t.png', image: 'https://x.y/i.png' });
    await modalIn(guild, 'field_add', { name: 'A', value: '1', inline: 'yes' });
    await modalIn(guild, 'field_add', { name: 'B', value: '2', inline: 'no' });
    await modalIn(guild, 'field_edit', { number: '2', name: 'B2', value: '', inline: '' });
    await modalIn(guild, 'field_remove', { number: '1' });
    const i = await modalIn(guild, 'content', { content: 'Top text' });
    const e = ((await draft())!.spec as any).embeds[0];
    expect(e).toMatchObject({ title: 'Hello', color: '#ff0000', authorName: 'Me', footerText: 'Foot', thumbnail: 'https://x.y/t.png', image: 'https://x.y/i.png' });
    expect(e.fields).toEqual([{ name: 'B2', value: '2', inline: false }]);
    expect(lastPayload(i).embeds[0].title).toBe('Hello');
  });
  it('rejects bad input without losing the draft', async () => {
    const { guild } = await start();
    const r = router;
    await expect(r.resolveComponent('embed:md:color')!.handler.run(componentInteraction(guild, 'modal', 'embed:md:color', { fields: { color: 'purple' } }), ['color'])).rejects.toThrow();
    await expect(r.resolveComponent('embed:md:images')!.handler.run(componentInteraction(guild, 'modal', 'embed:md:images', { fields: { thumbnail: 'javascript:alert(1)', image: '' } }), ['images'])).rejects.toThrow();
    await expect(r.resolveComponent('embed:md:field_remove')!.handler.run(componentInteraction(guild, 'modal', 'embed:md:field_remove', { fields: { number: '9' } }), ['field_remove'])).rejects.toThrow(/no field/);
    expect(((await draft())!.spec as any).embeds[0].color).toBe('#7c3aed');
  });
  it('supports multiple embeds: add, duplicate, select and remove', async () => {
    const { guild } = await start();
    await component(componentInteraction(guild, 'button', 'embed:ed:add'));
    await component(componentInteraction(guild, 'button', 'embed:ed:dup'));
    expect(((await draft())!.spec as any).embeds.length).toBe(3);
    expect((await draft())!.activeIndex).toBe(2);
    const pick = await component(componentInteraction(guild, 'select', 'embed:ed:pick', { values: ['0'] }));
    assertValidMessage(lastPayload(pick));
    await modalIn(guild, 'body', { title: 'First', url: '', description: 'x' });
    await component(componentInteraction(guild, 'button', 'embed:ed:del'));
    expect(((await draft())!.spec as any).embeds.length).toBe(2);
  });
  it('blocks an 11th embed from a crafted request', async () => {
    const { guild } = await start();
    for (let n = 0; n < 9; n++) await component(componentInteraction(guild, 'button', 'embed:ed:add'));
    await expect(component(componentInteraction(guild, 'button', 'embed:ed:add'))).rejects.toThrow();
  });
  it('toggles the timestamp', async () => {
    const { guild } = await start();
    await component(componentInteraction(guild, 'button', 'embed:ed:time'));
    expect(((await draft())!.spec as any).embeds[0].timestamp).toBe(true);
  });
  it('adds buttons and menus, but refuses roles the editor may not grant', async () => {
    const { guild } = await start();
    const safe = fakeRole('900000000000000001', 3, { name: 'Gamer', guild: { id: guild.id } });
    const admin = fakeRole('900000000000000002', 3, { name: 'Boss', perms: [PermissionFlagsBits.Administrator], guild: { id: guild.id } });
    guild.roles.cache.set(safe.id, safe);
    guild.roles.cache.set(admin.id, admin);
    await modalIn(guild, 'btnlink', { label: 'Site', url: 'https://x.y', emoji: '🔥' });
    await modalIn(guild, 'btnrole', { label: 'Join', role: 'gamer', style: 'success', emoji: '' });
    await modalIn(guild, 'menu', { placeholder: 'Pick', roles: `${safe.id}` });
    const spec = (await draft())!.spec as any;
    expect(spec.buttons.map((b: any) => b.kind)).toEqual(['link', 'role']);
    expect(spec.roleMenu.options[0].roleId).toBe(safe.id);
    const h = router.resolveComponent('embed:md:btnrole')!.handler;
    await expect(h.run(componentInteraction(guild, 'modal', 'embed:md:btnrole', { fields: { label: 'x', role: admin.id, style: 'primary' } }), ['btnrole'])).rejects.toThrow(/moderator or admin/);
    await expect(h.run(componentInteraction(guild, 'modal', 'embed:md:btnrole', { fields: { label: 'x', role: 'no such role', style: 'primary' } }), ['btnrole'])).rejects.toThrow(/cannot find/);
    await component(componentInteraction(guild, 'button', 'embed:ed:clear'));
    expect(((await draft())!.spec as any).buttons).toEqual([]);
  });
  it('saves templates, then loads and duplicates them', async () => {
    const { guild } = await start();
    await modalIn(guild, 'body', { title: 'Saved title', url: '', description: 'd' });
    await component(componentInteraction(guild, 'modal', 'embed:md:save', { fields: { name: 'My Template' } }));
    expect((await EmbedTemplate.findOne())?.name).toBe('my-template');
    const load = await run(commandInteraction(guild, 'embed', 'load', { name: 'my-template' }, { group: 'template' }));
    expect(serialize(load.reply.mock.calls[0][0]).embeds[0].title).toBe('Saved title');
    await run(commandInteraction(guild, 'embed', 'duplicate', { template: 'my-template', new_name: 'copy' }));
    expect(await EmbedTemplate.countDocuments()).toBe(2);
    await expect(run(commandInteraction(guild, 'embed', 'duplicate', { template: 'my-template', new_name: 'copy' }))).rejects.toThrow(/already exists/);
    await run(commandInteraction(guild, 'embed', 'delete', { name: 'copy' }, { group: 'template' }));
    expect(await EmbedTemplate.countDocuments()).toBe(1);
  });
  it('imports and exports JSON', async () => {
    const { guild } = await start();
    await modalIn(guild, 'import', { json: JSON.stringify({ embeds: [{ title: 'Imported', color: 0x00ff00, footer: { text: 'f' } }] }) });
    expect(((await draft())!.spec as any).embeds[0]).toMatchObject({ title: 'Imported', color: '#00ff00' });
    const i = await component(componentInteraction(guild, 'button', 'embed:ed:json'));
    expect(i.reply.mock.calls[0][0].files[0].name).toBe('embed.json');
    await expect(router.resolveComponent('embed:md:import')!.handler.run(componentInteraction(guild, 'modal', 'embed:md:import', { fields: { json: '{oops' } }), ['import'])).rejects.toThrow(/valid JSON/);
  });
  it('posts the message without pings, tracks it, and clears the draft', async () => {
    const { guild, channel } = await start();
    await modalIn(guild, 'body', { title: 'Announcement', url: '', description: '@everyone hello' });
    await component(componentInteraction(guild, 'button', 'embed:ed:post'));
    const sent = channel.send.mock.calls[0][0];
    expect(sent.embeds[0].title).toBe('Announcement');
    expect(sent.allowedMentions).toEqual({ parse: [] });
    expect((await PostedEmbed.findOne())?.messageId).toBe('800000000000000001');
    expect(await EmbedDraft.countDocuments()).toBe(0);
  });
  it('refuses to post an empty embed', async () => {
    const { guild } = await start();
    await modalIn(guild, 'body', { title: '', url: '', description: '' });
    await expect(component(componentInteraction(guild, 'button', 'embed:ed:post'))).rejects.toThrow(/empty/);
  });
  it('edits an existing posted message rather than sending a new one', async () => {
    const { guild, channel } = await start();
    const existing = { id: '800000000000000002', channelId: CHANNEL, content: '', author: { id: guild.client.user.id }, embeds: [{ toJSON: () => ({ title: 'Old', color: 255, footer: { text: 'f' } }) }], edit: vi.fn(async () => ({ id: '800000000000000002', url: 'https://discord.com/m2' })), delete: vi.fn(async () => undefined) };
    channel.messages = { fetch: vi.fn(async () => existing) };
    const link = `https://discord.com/channels/${guild.id}/${CHANNEL}/${existing.id}`;
    const i = await run(commandInteraction(guild, 'embed', 'edit', { message_link: link }));
    expect(serialize(i.editReply.mock.calls[0][0]).embeds[0].title).toBe('Old');
    channel.send.mockClear();
    await component(componentInteraction(guild, 'button', 'embed:ed:post'));
    expect(existing.edit).toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    await run(commandInteraction(guild, 'embed', 'delete', { message_link: link }));
    expect(existing.delete).toHaveBeenCalled();
  });
  it('refuses to edit messages from other authors or other servers', async () => {
    const { guild, channel } = await start();
    channel.messages = { fetch: vi.fn(async () => ({ id: '1', author: { id: 'someone-else' } })) };
    await expect(run(commandInteraction(guild, 'embed', 'edit', { message_link: `https://discord.com/channels/${guild.id}/${CHANNEL}/800000000000000003` }))).rejects.toThrow(/I posted/);
    await expect(run(commandInteraction(guild, 'embed', 'edit', { message_link: `https://discord.com/channels/999999999999999999/${CHANNEL}/800000000000000003` }))).rejects.toThrow(/from this server/);
  });
  it('needs Manage Messages for editor components', async () => {
    const { guild } = await start();
    const pleb = fakeMember(guild, '700000000000000002', { position: 1 });
    await expect(component(componentInteraction(guild, 'button', 'embed:ed:post', { member: pleb }))).rejects.toThrow(/Manage Messages/);
  });
  it('explains when the session has expired', async () => {
    const { guild } = await start();
    await EmbedDraft.deleteMany({});
    await expect(component(componentInteraction(guild, 'button', 'embed:ed:post'))).rejects.toThrow(/expired/);
  });
  it('toggles roles from posted buttons, and rechecks safety at click time', async () => {
    const guild = setupGuild();
    fakeChannel(guild, CHANNEL);
    const role = fakeRole('900000000000000003', 3, { guild: { id: guild.id } });
    guild.roles.cache.set(role.id, role);
    const m = fakeMember(guild, '700000000000000003', { position: 1 });
    await component(componentInteraction(guild, 'button', `embed:role:${role.id}:0`, { member: m }));
    expect(m.roles.add).toHaveBeenCalled();
    role.permissions = { bitfield: PermissionFlagsBits.Administrator }; // role was escalated after posting
    await expect(component(componentInteraction(guild, 'button', `embed:role:${role.id}:0`, { member: m }))).rejects.toThrow(/moderator or admin/);
  });
});

describe('moderation commands', () => {
  const target = (guild: any) => fakeMember(guild, '700000000000000010', { position: 1 });
  it('warn records a case, counts actives and clears', async () => {
    const guild = setupGuild();
    const m = target(guild);
    await run(commandInteraction(guild, 'moderation', 'warn', { user: m.user, reason: 'spam' }));
    await run(commandInteraction(guild, 'moderation', 'warn', { user: m.user, reason: 'more spam' }));
    const i = await run(commandInteraction(guild, 'moderation', 'warnings', { user: m.user }));
    expect(lastPayload(i).embeds[0].description).toMatch(/more spam/);
    await run(commandInteraction(guild, 'moderation', 'clearwarnings', { user: m.user }));
    expect(await Case.countDocuments({ type: 'warn', active: true })).toBe(0);
  });
  it('mass ban needs confirmation from the same moderator', async () => {
    const guild = setupGuild();
    const a = target(guild);
    guild.client.users.fetch = vi.fn(async () => a.user);
    const i = await run(commandInteraction(guild, 'moderation', 'massban', { users: `<@${a.id}> 700000000000000011`, reason: 'raid' }));
    expect(guild.members.ban).not.toHaveBeenCalled();
    const confirmId = lastPayload(i).components[0].components[0].custom_id;
    const other = fakeMember(guild, '700000000000000012', { position: 60, perms: [PermissionFlagsBits.BanMembers] });
    const wrong = await component(componentInteraction(guild, 'button', confirmId, { member: other }));
    expect(guild.members.ban).not.toHaveBeenCalled();
    expect(lastPayload(wrong).embeds[0].description).toMatch(/Only the moderator/);
    const owner = guild.members.cache.get(guild.ownerId);
    owner.user = { ...owner.user, id: guild.ownerId };
    await component(componentInteraction(guild, 'button', confirmId, { member: owner }));
    expect(guild.members.ban).toHaveBeenCalledTimes(2);
  });
  it('cancelled mass actions change nothing', async () => {
    const guild = setupGuild();
    const a = target(guild);
    const i = await run(commandInteraction(guild, 'moderation', 'masskick', { users: a.id }));
    const cancelId = lastPayload(i).components[0].components[1].custom_id;
    await component(componentInteraction(guild, 'button', cancelId));
    expect(a.kick).not.toHaveBeenCalled();
  });
  it('refuses invalid durations with a helpful message', async () => {
    const guild = setupGuild();
    await expect(run(commandInteraction(guild, 'moderation', 'timeout', { user: target(guild).user, duration: 'soon' }))).rejects.toThrow(/Invalid duration/);
  });
  it('locks and hides through permission overwrites', async () => {
    const guild = setupGuild();
    const channel = fakeChannel(guild, CHANNEL);
    channel.permissionOverwrites.edit = vi.fn(async () => undefined);
    await run(commandInteraction(guild, 'moderation', 'lock', {}));
    expect(channel.permissionOverwrites.edit.mock.calls[0][1]).toMatchObject({ SendMessages: false });
    await run(commandInteraction(guild, 'moderation', 'unhide', {}));
    expect(channel.permissionOverwrites.edit.mock.calls[1][1]).toEqual({ ViewChannel: null });
  });
  it('purge filters by user, skips pinned messages and reports what it could not delete', async () => {
    const guild = setupGuild();
    const channel = fakeChannel(guild, CHANNEL);
    const msg = (id: string, author: string, pinned = false) => ({ id, author: { id: author, bot: false }, content: 'x', pinned });
    channel.messages = { fetch: vi.fn(async () => new Map([['1', msg('1', 'a')], ['2', msg('2', 'b')], ['3', msg('3', 'a', true)]])) };
    channel.bulkDelete = vi.fn(async (list: any[]) => ({ size: list.length }));
    const i = await run(commandInteraction(guild, 'moderation', 'purge', { amount: 10, user: { id: 'a', tag: 'a' } }));
    expect(channel.bulkDelete.mock.calls[0][0].map((m: any) => m.id)).toEqual(['1']);
    expect(lastPayload(i).embeds[0].description).toMatch(/\*\*1\*\*/);
  });
});

describe('moderation replies', () => {
  it('acknowledges Discord before doing slow work', async () => {
    const guild = setupGuild();
    const m = fakeMember(guild, '700000000000000015', { position: 1 });
    const order: string[] = [];
    m.send = vi.fn(async () => { order.push('dm'); });
    const i = commandInteraction(guild, 'moderation', 'kick', { user: m.user });
    i.deferReply = vi.fn(async () => { order.push('defer'); i.deferred = true; });
    await run(i);
    expect(order).toEqual(['defer', 'dm']);
    expect(i.followUp).toHaveBeenCalled();
    expect(i.reply).not.toHaveBeenCalled();
  });
});

describe('security commands', () => {
  const admin = (guild: any) => fakeMember(guild, '700000000000000020', { position: 40, perms: [PermissionFlagsBits.ManageGuild] });
  it('stops ordinary admins, but lets the owner manage trust', async () => {
    const guild = setupGuild();
    const a = admin(guild);
    const logCh = fakeChannel(guild, CHANNEL);
    await expect(run(commandInteraction(guild, 'security', 'setup', { log_channel: logCh }, { member: a }))).rejects.toThrow(/owner or a trusted admin/);
    await expect(run(commandInteraction(guild, 'security', 'add', { user: a.user }, { group: 'trusted', member: a }))).rejects.toThrow(/Only the server owner/);
    await run(commandInteraction(guild, 'security', 'add', { user: a.user }, { group: 'trusted' }));
    expect((await getConfig(guild.id)).security.trustedAdmins).toContain(a.id);
    await run(commandInteraction(guild, 'security', 'setup', { log_channel: logCh }, { member: a }));
    const cfg = (await getConfig(guild.id)).security;
    expect(cfg).toMatchObject({ enabled: true, mode: 'monitor', logChannelId: CHANNEL });
  });
  it('the panel buttons switch mode and protections', async () => {
    const guild = setupGuild();
    await component(componentInteraction(guild, 'button', 'sec:mode'));
    expect((await getConfig(guild.id)).security.mode).toBe('enforce');
    const i = await component(componentInteraction(guild, 'select', 'sec:toggle', { values: ['antiNuke', 'links'] }));
    const s = (await getConfig(guild.id)).security;
    expect(s.antiNuke.enabled).toBe(true);
    expect(s.antiRaid.enabled).toBe(false);
    expect(s.antiLinks.scam).toBe(true);
    assertValidMessage(lastPayload(i));
    const a = admin(guild);
    await expect(component(componentInteraction(guild, 'button', 'sec:mode', { member: a }))).rejects.toThrow(/owner or a trusted/);
  });
  it('whitelists both users and roles', async () => {
    const guild = setupGuild();
    const role = fakeRole('900000000000000010', 2);
    guild.roles.cache.set(role.id, role);
    await run(commandInteraction(guild, 'security', 'add', { target: { id: role.id } }, { group: 'whitelist' }));
    await run(commandInteraction(guild, 'security', 'add', { target: { id: '700000000000000021' } }, { group: 'whitelist' }));
    const s = (await getConfig(guild.id)).security;
    expect(s.whitelistRoles).toEqual([role.id]);
    expect(s.whitelistUsers).toEqual(['700000000000000021']);
  });
  it('automod rejects bad domains, and normalises good ones', async () => {
    const guild = setupGuild();
    await expect(run(commandInteraction(guild, 'automod', 'domain', { list: 'blockedDomains', domain: 'not a domain' }))).rejects.toThrow(/domain/);
    await run(commandInteraction(guild, 'automod', 'domain', { list: 'blockedDomains', domain: 'https://Bad.Example/path' }));
    expect((await getConfig(guild.id)).security.antiLinks.blockedDomains).toEqual(['bad.example']);
  });
});

describe('role panels', () => {
  const setup = async (kind = 'button', behavior = 'toggle') => {
    const guild = setupGuild();
    const channel = fakeChannel(guild, CHANNEL);
    channel.messages = { fetch: vi.fn(async () => null) };
    const sent = { id: '800000000000000010', url: 'u', react: vi.fn(async () => undefined), edit: vi.fn() };
    channel.send = vi.fn(async () => sent);
    const r1 = fakeRole('900000000000000021', 3, { name: 'Red', guild: { id: guild.id } });
    const r2 = fakeRole('900000000000000022', 3, { name: 'Blue', guild: { id: guild.id } });
    guild.roles.cache.set(r1.id, r1); guild.roles.cache.set(r2.id, r2);
    await run(commandInteraction(guild, 'rolepanel', 'create', { name: 'colors', kind, title: 'Colors', behavior }));
    await run(commandInteraction(guild, 'rolepanel', 'add', { panel: 'colors', role: r1, emoji: '🔴' }));
    await run(commandInteraction(guild, 'rolepanel', 'add', { panel: 'colors', role: r2, emoji: '🔵' }));
    await run(commandInteraction(guild, 'rolepanel', 'publish', { panel: 'colors' }));
    return { guild, channel, sent, r1, r2 };
  };
  it('publishes valid button panels and applies clicks', async () => {
    const { guild, channel, r1 } = await setup();
    const payload = serialize(channel.send.mock.calls[0][0]);
    assertValidMessage(payload);
    const m = fakeMember(guild, '700000000000000030', { position: 1 });
    await component(componentInteraction(guild, 'button', payload.components[0].components[0].custom_id, { member: m }));
    expect(m.roles.add).toHaveBeenCalledWith([r1.id], expect.any(String));
  });
  it('publishes valid select panels', async () => {
    const { guild, channel, r2 } = await setup('select');
    const payload = serialize(channel.send.mock.calls[0][0]);
    assertValidMessage(payload);
    const m = fakeMember(guild, '700000000000000031', { position: 1 });
    await component(componentInteraction(guild, 'select', payload.components[0].components[0].custom_id, { values: [r2.id], member: m }));
    expect(m.roles.add).toHaveBeenCalledWith([r2.id], expect.any(String));
  });
  it('adds reactions for reaction panels, and requires an emoji', async () => {
    const { guild, sent } = await setup('reaction');
    expect(sent.react).toHaveBeenCalledTimes(2);
    const r3 = fakeRole('900000000000000023', 3, { guild: { id: guild.id } });
    guild.roles.cache.set(r3.id, r3);
    await expect(run(commandInteraction(guild, 'rolepanel', 'add', { panel: 'colors', role: r3 }))).rejects.toThrow(/emoji/);
    expect((await RolePanel.findOne())?.messageId).toBe(sent.id);
  });
  it('refuses dangerous roles on panels', async () => {
    const { guild } = await setup();
    const admin = fakeRole('900000000000000024', 3, { perms: [PermissionFlagsBits.BanMembers], guild: { id: guild.id } });
    guild.roles.cache.set(admin.id, admin);
    await expect(run(commandInteraction(guild, 'rolepanel', 'add', { panel: 'colors', role: admin }))).rejects.toThrow(/moderator or admin/);
  });
});

describe('tickets', () => {
  const setup = async () => {
    const guild = setupGuild();
    const panelCh = fakeChannel(guild, CHANNEL);
    panelCh.messages = { fetch: vi.fn(async () => null) };
    panelCh.send = vi.fn(async () => ({ id: '800000000000000020', url: 'u' }));
    const staff = fakeRole('900000000000000030', 3, { guild: { id: guild.id } });
    guild.roles.cache.set(staff.id, staff);
    await run(commandInteraction(guild, 'ticket', 'setup', { staff }));
    await run(commandInteraction(guild, 'ticket', 'panel-create', { name: 'support', title: 'Need help?' }));
    await run(commandInteraction(guild, 'ticket', 'panel-category', { panel: 'support', label: 'Billing' }));
    await run(commandInteraction(guild, 'ticket', 'panel-publish', { panel: 'support' }));
    const payload = serialize(panelCh.send.mock.calls[0][0]);
    assertValidMessage(payload);
    const panel = await TicketPanel.findOne();
    return { guild, staff, payload, panel: panel!, category: panel!.categories[0]! };
  };
  const open = async (ctx: any, member: any) => {
    const modalId = `ticket:create:${ctx.panel._id}:${ctx.category.id}`;
    const click = await component(componentInteraction(ctx.guild, 'button', ctx.payload.components[0].components[0].custom_id, { member }));
    assertValidModal(click.showModal.mock.calls[0][0]);
    await component(componentInteraction(ctx.guild, 'modal', modalId, { fields: { subject: 'I need help' }, member }));
  };

  it('opens a private ticket, limits per user, claims, closes with a transcript, and reopens', async () => {
    const ctx = await setup();
    const { guild } = ctx;
    const owner = fakeMember(guild, '700000000000000040', { position: 1 });
    await open(ctx, owner);
    const t = await Ticket.findOne();
    expect(t).toMatchObject({ number: 1, ownerId: owner.id, status: 'open', subject: 'I need help', categoryLabel: 'Billing' });
    const create = guild.channels.create.mock.calls[0][0];
    const everyone = create.permissionOverwrites.find((o: any) => o.id === guild.id);
    expect(everyone.deny).toContain(PermissionFlagsBits.ViewChannel);
    expect(create.permissionOverwrites.some((o: any) => o.id === owner.id)).toBe(true);
    expect(create.permissionOverwrites.some((o: any) => o.id === ctx.staff.id)).toBe(true);

    // second ticket refused
    await expect(component(componentInteraction(guild, 'modal', `ticket:create:${ctx.panel._id}:${ctx.category.id}`, { fields: { subject: 'again' }, member: owner }))).rejects.toThrow(/already have/);

    const channel = guild.channels.cache.get(t!.channelId);
    Object.assign(channel, { setName: vi.fn(async () => undefined), messages: { fetch: vi.fn(async () => new Collection()) } });
    channel.permissionOverwrites.edit = vi.fn(async () => undefined);
    const inTicket = (kind: any, id: string, data: any = {}) => { const i = componentInteraction(guild, kind, id, data); i.channelId = channel.id; i.channel = channel; return i; };

    // members cannot claim, staff can, once
    await expect(component(inTicket('button', 'ticket:claim', { member: owner }))).rejects.toThrow(/staff/);
    const staffer = fakeMember(guild, '700000000000000041', { position: 5, roles: [ctx.staff] });
    await component(inTicket('button', 'ticket:claim', { member: staffer }));
    expect((await Ticket.findOne())?.claimedBy).toBe(staffer.id);
    const other = fakeMember(guild, '700000000000000042', { position: 5, roles: [ctx.staff] });
    await expect(component(inTicket('button', 'ticket:claim', { member: other }))).rejects.toThrow(/already been claimed/);

    // close needs confirmation, then saves, DMs a transcript and asks for a rating
    const confirm = await component(inTicket('button', 'ticket:close', { member: owner }));
    expect(lastPayload(confirm).components[0].components[0].custom_id).toBe('ticket:close:yes');
    expect((await Ticket.findOne())?.status).toBe('open');
    await component(inTicket('button', 'ticket:close:yes', { member: owner }));
    expect((await Ticket.findOne())?.status).toBe('closed');
    const dm = serialize(owner.send.mock.lastCall[0]);
    assertValidMessage(dm);
    expect(owner.send.mock.lastCall[0].files[0].name).toBe('ticket-1.html');
    const rateId = dm.components[0].components[4].custom_id;

    // rating is bound to the owner, and only counts once
    const r = router.resolveComponent(rateId)!;
    expect(r.handler.dm).toBe(true);
    const stranger = fakeMember(guild, '700000000000000043', { position: 1 });
    const bad = await component(componentInteraction(guild, 'button', rateId, { member: stranger }));
    expect((await Ticket.findOne())?.rating ?? null).toBeNull();
    expect(bad.reply).toHaveBeenCalled();
    await component(componentInteraction(guild, 'button', rateId, { member: owner }));
    expect((await Ticket.findOne())?.rating).toBe(5);
    await component(componentInteraction(guild, 'button', rateId, { member: owner }));
    expect((await Ticket.findOne())?.rating).toBe(5);

    // reopen is staff-only
    await expect(component(inTicket('button', 'ticket:reopen', { member: owner }))).rejects.toThrow(/staff/);
    await component(inTicket('button', 'ticket:reopen', { member: staffer }));
    expect((await Ticket.findOne())?.status).toBe('open');
  });
  it('does not run ticket actions outside a ticket channel', async () => {
    const ctx = await setup();
    await expect(component(componentInteraction(ctx.guild, 'button', 'ticket:claim'))).rejects.toThrow(/not a ticket/);
  });
  it('refuses when tickets are off', async () => {
    const ctx = await setup();
    await updateConfig(ctx.guild.id, 'tickets', { enabled: false });
    const m = fakeMember(ctx.guild, '700000000000000044', { position: 1 });
    await expect(component(componentInteraction(ctx.guild, 'modal', `ticket:create:${ctx.panel._id}:${ctx.category.id}`, { fields: { subject: 'x' }, member: m }))).rejects.toThrow(/turned off/);
  });
});

describe('giveaways and polls through commands', () => {
  const setup = () => {
    const guild = setupGuild();
    const channel = fakeChannel(guild, CHANNEL);
    const posted: any = { id: '800000000000000030', edit: vi.fn(async () => undefined) };
    channel.send = vi.fn(async () => posted);
    channel.messages = { fetch: vi.fn(async () => posted) };
    return { guild, channel, posted };
  };
  it('runs a giveaway end to end', async () => {
    const { guild, channel, posted } = setup();
    await run(commandInteraction(guild, 'giveaway', 'create', { prize: 'Nitro', duration: '1h', winners: 1 }));
    assertValidMessage(serialize(channel.send.mock.calls[0][0]));
    const g = (await Giveaway.findOne())!;
    const enter = `gw:enter:${g._id}`;
    const m = fakeMember(guild, '700000000000000050', { position: 1 });
    await component(componentInteraction(guild, 'button', enter, { member: m }));
    expect((await Giveaway.findOne())?.entrants).toEqual([m.id]);
    await run(commandInteraction(guild, 'giveaway', 'end', { giveaway: g._id.toString() }));
    const ended = (await Giveaway.findOne())!;
    expect(ended).toMatchObject({ ended: true, winners: [m.id] });
    expect(posted.edit).toHaveBeenCalled();
    const late = await component(componentInteraction(guild, 'button', enter, { member: fakeMember(guild, '700000000000000051', { position: 1 }) }));
    expect(lastPayload(late).embeds[0].description).toMatch(/ended/);
    await expect(run(commandInteraction(guild, 'giveaway', 'reroll', { giveaway: g._id.toString() }))).rejects.toThrow(/nobody left/);
  });
  it('enforces the required role', async () => {
    const { guild } = setup();
    await run(commandInteraction(guild, 'giveaway', 'create', { prize: 'P', duration: '1h', required_role: { id: '900000000000000040' } }));
    const g = (await Giveaway.findOne())!;
    await component(componentInteraction(guild, 'button', `gw:enter:${g._id}`, { member: fakeMember(guild, '700000000000000052', { position: 1 }) }));
    expect((await Giveaway.findOne())?.entrants).toEqual([]);
  });
  it('a member cannot leave entries under someone else, and re-pressing withdraws', async () => {
    const { guild } = setup();
    await run(commandInteraction(guild, 'giveaway', 'create', { prize: 'P', duration: '1h' }));
    const g = (await Giveaway.findOne())!;
    const m = fakeMember(guild, '700000000000000053', { position: 1 });
    await component(componentInteraction(guild, 'button', `gw:enter:${g._id}`, { member: m }));
    await component(componentInteraction(guild, 'button', `gw:enter:${g._id}`, { member: m }));
    expect((await Giveaway.findOne())?.entrants).toEqual([]);
  });
  it('polls count one vote per member, or several when allowed', async () => {
    const { guild, channel } = setup();
    const i = commandInteraction(guild, 'poll', 'create', { question: 'Best?', options: 'A | B | C' });
    await run(i);
    assertValidMessage(serialize(channel.send.mock.calls[0][0]));
    const p = (await Poll.findOne())!;
    const m = fakeMember(guild, '700000000000000054', { position: 1 });
    await component(componentInteraction(guild, 'button', `poll:vote:${p._id}:0`, { member: m }));
    await component(componentInteraction(guild, 'button', `poll:vote:${p._id}:1`, { member: m }));
    expect((await Poll.findOne())?.votes).toEqual([{ userId: m.id, option: 1 }]);
    await component(componentInteraction(guild, 'button', `poll:vote:${p._id}:1`, { member: m }));
    expect((await Poll.findOne())?.votes).toEqual([]);
    await expect(run(commandInteraction(guild, 'poll', 'create', { question: 'Q', options: 'only one' }))).rejects.toThrow(/2 to 10/);
    await expect(run(commandInteraction(guild, 'poll', 'create', { question: 'Q', options: 'a|a' }))).rejects.toThrow(/different/);
  });
});

describe('automation commands', () => {
  it('custom commands respond through /cc run and enforce role limits', async () => {
    const guild = setupGuild();
    fakeChannel(guild, CHANNEL);
    await component(componentInteraction(guild, 'modal', 'cc:save:hi:0', { fields: { response: 'Hello {user}' } }));
    expect(await CustomCommand.countDocuments()).toBe(1);
    const i = await run(commandInteraction(guild, 'cc', 'run', { name: 'hi' }));
    expect(i.reply.mock.calls[0][0].content).toBe(`Hello <@${guild.ownerId}>`);
    expect(i.reply.mock.calls[0][0].allowedMentions).toEqual({ parse: ['users'] });
    await CustomCommand.updateOne({}, { $set: { allowedRoles: ['900000000000000050'] } });
    const member = fakeMember(guild, '700000000000000060', { position: 1 });
    await expect(run(commandInteraction(guild, 'cc', 'run', { name: 'hi' }, { member }))).rejects.toThrow(/cannot use/);
  });
  it('auto responses refuse dangerous regexes', async () => {
    const guild = setupGuild();
    await expect(run(commandInteraction(guild, 'autoresponse', 'add', { trigger: '(a+)+$', response: 'x', match: 'regex' }))).rejects.toThrow(/slowly/);
    await run(commandInteraction(guild, 'autoresponse', 'add', { trigger: 'hello', response: 'hi' }));
    expect(await AutoResponse.countDocuments()).toBe(1);
  });
  it('rules validate their parts, and refuse dangerous roles', async () => {
    const guild = setupGuild();
    await expect(run(commandInteraction(guild, 'rule', 'create', { name: 'r', trigger: 'keyword', action: 'reply', text: 't' }))).rejects.toThrow(/keyword/);
    await expect(run(commandInteraction(guild, 'rule', 'create', { name: 'r', trigger: 'member_join', action: 'reply', text: 't' }))).rejects.toThrow(/message triggers/);
    const admin = fakeRole('900000000000000051', 3, { perms: [PermissionFlagsBits.Administrator], guild: { id: guild.id } });
    guild.roles.cache.set(admin.id, admin);
    await expect(run(commandInteraction(guild, 'rule', 'create', { name: 'r', trigger: 'member_join', action: 'add_role', role: admin }))).rejects.toThrow(/moderator or admin/);
  });
});

describe('slash command registration', () => {
  const app = (existing: string[] = []) => {
    let names = existing;
    const set = vi.fn(async (body: Array<{ name: string }>) => { names = body.map((c) => c.name); });
    const fetch = vi.fn(async (_o?: { guildId?: string }) => new Collection(names.map((name, n) => [String(n), { name }])));
    return { client: { application: { id: '500000000000000009', commands: { set, fetch } } } as any, set, fetch };
  };
  it('never overwrites commands it did not register', async () => {
    const { client, set } = app(['8ball', 'hug', 'ban']);
    expect(await syncCommands(client)).toBe('blocked');
    expect(set).not.toHaveBeenCalled();
    expect(await syncCommands(client, { devGuildId: '100000000000000001' })).toBe('blocked');
    expect(set).not.toHaveBeenCalled();
  });
  it('refuses a test server too when the application has global commands from another bot', async () => {
    const { client, set, fetch } = app();
    fetch.mockImplementation(async (o?: { guildId?: string }) => new Collection(o?.guildId ? [] : [['0', { name: '8ball' }]]) as never);
    expect(await syncCommands(client, { devGuildId: '100000000000000001' })).toBe('blocked');
    expect(set).not.toHaveBeenCalled();
  });
  it('replaces them only when told to', async () => {
    const { client, set } = app(['8ball']);
    expect(await syncCommands(client, { replaceForeign: true })).toBe('registered');
    expect(set).toHaveBeenCalledTimes(1);
  });
  it('registers on an empty application, then only when something changed', async () => {
    const { client, set } = app();
    expect(await syncCommands(client)).toBe('registered');
    expect(await syncCommands(client)).toBe('up-to-date');
    expect(set).toHaveBeenCalledTimes(1);
  });
  it('can update its own commands after an earlier registration', async () => {
    const { client, set } = app(['removed-vortex-command']);
    await Meta.create({ _id: `commands:500000000000000009:global`, value: 'an older version' });
    expect(await syncCommands(client)).toBe('registered');
    expect(set).toHaveBeenCalledTimes(1);
  });
  it('checks the test server separately from global commands', async () => {
    const { client, set, fetch } = app();
    await syncCommands(client, { devGuildId: '100000000000000001' });
    expect(fetch).toHaveBeenCalledWith({ guildId: '100000000000000001' });
    expect(set).toHaveBeenCalledWith(expect.anything(), '100000000000000001');
  });
  it('registers again when commands disappeared from Discord', async () => {
    const { client, set, fetch } = app();
    await syncCommands(client, { devGuildId: '100000000000000001' });
    fetch.mockImplementation(async () => new Collection() as never);
    expect(await syncCommands(client, { devGuildId: '100000000000000001' })).toBe('registered');
    expect(set).toHaveBeenCalledTimes(2);
  });
  it('points old commands to their replacement, with no crash', async () => {
    const guild = setupGuild();
    const old = commandInteraction(guild, 'embed', null);
    old.options.getSubcommand = (required: boolean) => { if (required !== false) throw new Error('No subcommand specified'); return null; };
    await router.handle(old);
    expect(JSON.stringify(serialize(old.reply.mock.calls[0][0]))).toContain('/embed create');
    const missing = commandInteraction(guild, '8ball', null);
    await router.handle(missing);
    expect(JSON.stringify(serialize(missing.reply.mock.calls[0][0]))).toContain('no replacement');
  });
  it('treats global commands as old when ZYTHERON owns only the test server', async () => {
    const guild = setupGuild();
    const owned = new InteractionRouter(MODULES, { ownedGuildId: guild.id });
    const old = commandInteraction(guild, 'ticket', 'setup', {});
    old.commandGuildId = null;
    await owned.handle(old);
    expect(JSON.stringify(serialize(old.reply.mock.calls[0][0]))).toContain('old command');
    expect(old.deferReply).not.toHaveBeenCalled();
    const ours = commandInteraction(guild, 'ping', null);
    ours.commandGuildId = guild.id;
    await owned.handle(ours);
    expect(JSON.stringify(serialize(ours.reply.mock.calls[0][0]))).toContain('Gateway');
  });
  it('stays silent on old commands when told another bot answers them', async () => {
    const guild = setupGuild();
    const i = commandInteraction(guild, '8ball', null);
    await new InteractionRouter(MODULES, { ignoreForeign: true }).handle(i);
    expect(i.reply).not.toHaveBeenCalled();
  });
  it('answers when a handler returns without responding', async () => {
    const guild = setupGuild();
    const silent = new InteractionRouter([{ name: 't', commands: [{ data: { name: 'quiet', description: 'x' }, execute: async () => undefined }] }]);
    const i = commandInteraction(guild, 'quiet', null);
    await silent.handle(i);
    expect(i.reply).toHaveBeenCalledTimes(1);
  });
  it('does not try to answer an expired interaction', async () => {
    const guild = setupGuild();
    const expired = new InteractionRouter([{ name: 't', commands: [{ data: { name: 'slow', description: 'x' }, execute: async () => { throw Object.assign(new Error('Unknown interaction'), { code: 10062 }); } }] }]);
    const i = commandInteraction(guild, 'slow', null);
    await expired.handle(i);
    expect(i.reply).not.toHaveBeenCalled();
  });
});

describe('module wiring', () => {
  it('isolates a failing listener and starts jobs and intervals when ready', async () => {
    const client = new Client({ intents: [] });
    const good = vi.fn();
    const ready = vi.fn(async () => undefined);
    const tick = vi.fn(async () => undefined);
    const { shutdown } = wireModules(client, [
      { name: 'bad', events: [on('guildCreate', () => { throw new Error('boom'); })] },
      { name: 'good', events: [on('guildCreate', good)], onReady: ready, intervals: [{ name: 't', everyMs: 5, run: tick }] },
    ]);
    client.emit('guildCreate', {} as never);
    await new Promise((r) => setTimeout(r, 5));
    expect(good).toHaveBeenCalled();
    client.emit('clientReady', Object.assign(client, { user: { tag: 'x' }, guilds: { cache: new Map() } }) as never);
    await new Promise((r) => setTimeout(r, 30));
    expect(ready).toHaveBeenCalled();
    expect(tick).toHaveBeenCalled();
    shutdown();
    await client.destroy();
  });
  it('wires every real module onto a real client', async () => {
    const client = new Client({ intents: [] });
    const { router: r, shutdown } = wireModules(client, MODULES);
    expect(r.commands.size).toBeGreaterThanOrEqual(25);
    for (const event of ['guildMemberAdd', 'messageCreate', 'guildAuditLogEntryCreate', 'voiceStateUpdate', 'messageReactionAdd', 'interactionCreate']) expect(client.listenerCount(event), event).toBeGreaterThan(0);
    shutdown();
    await client.destroy();
  });
});

