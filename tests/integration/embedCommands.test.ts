import { DiscordAPIError, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { postableChannel } from '../../src/core/channels.js';
import { InteractionRouter } from '../../src/core/interactions.js';
import { MODULES } from '../../src/core/registry.js';
import { EmbedTemplate, PostedEmbed } from '../../src/db/models.js';
import { useDatabase } from '../helpers/db.js';
import { fakeChannel, fakeMember } from '../helpers/fakes.js';
import { commandInteraction, serialize, setupGuild } from '../helpers/interaction.js';

useDatabase();

const HERE = '600000000000000001';
const WELCOME = '600000000000000002';
const router = new InteractionRouter(MODULES);
let seq = 0;

function world() {
  const guild = setupGuild();
  const ownerId = `76000000000${String(++seq).padStart(7, '0')}`;
  guild.ownerId = ownerId;
  const owner = fakeMember(guild, ownerId, { position: 50, perms: [PermissionFlagsBits.Administrator] });
  const here = fakeChannel(guild, HERE, { name: 'general' });
  const welcome = fakeChannel(guild, WELCOME, { name: 'welcome' });
  const posted: any = { id: '730000000000000001', channelId: WELCOME, content: '', url: 'https://discord.com/channels/x', author: { id: guild.client.user.id }, embeds: [], edit: vi.fn(async () => posted), delete: vi.fn(async () => undefined) };
  for (const c of [here, welcome]) {
    c.send = vi.fn(async () => posted);
    c.messages = { fetch: vi.fn(async () => posted) };
  }
  return { guild, owner, here, welcome, posted };
}

const embed = async (w: ReturnType<typeof world>, sub: string, options: Record<string, unknown> = {}, opts: { group?: string; member?: any } = {}) => {
  // A new admin each call, because a real person would hit the 2 second cooldown.
  const member = opts.member ?? fakeMember(w.guild, `77000000000${String(++seq).padStart(7, '0')}`, { position: 50, perms: [PermissionFlagsBits.Administrator] });
  const i = commandInteraction(w.guild, 'embed', sub, options, { ...opts, member });
  await router.handle(i);
  return i;
};
const shown = (i: any) => JSON.stringify([...i.reply.mock.calls, ...i.followUp.mock.calls, ...i.editReply.mock.calls].map((c: any[]) => serialize(c[0])));
const link = (w: ReturnType<typeof world>, id = '730000000000000001') => `https://discord.com/channels/${w.guild.id}/${WELCOME}/${id}`;

describe('/embed create', () => {
  it('really publishes to the chosen channel, and says so privately', async () => {
    const w = world();
    const i = await embed(w, 'create', { title: 'Welcome!', description: 'Welcome to our Discord server!', channel: w.welcome, color: '#8B5CF6' });
    expect(w.welcome.send).toHaveBeenCalledTimes(1);
    expect(w.here.send).not.toHaveBeenCalled();
    const sent = serialize(w.welcome.send.mock.calls[0][0]);
    expect(sent.embeds).toHaveLength(1);
    expect(sent.embeds[0]).toMatchObject({ title: 'Welcome!', description: 'Welcome to our Discord server!', color: 0x8b5cf6 });
    expect(sent.allowedMentions).toEqual({ parse: [] });
    expect(i.deferReply.mock.calls[0][0].flags).toBeTruthy(); // private acknowledgement
    expect(shown(i)).toMatch(/Embed published/);
    expect(shown(i)).toContain(`<#${WELCOME}>`);
    expect(await PostedEmbed.countDocuments({ messageId: w.posted.id })).toBe(1);
  });
  it('supports every property', async () => {
    const w = world();
    await embed(w, 'create', { title: 'T', description: 'one\\ntwo', channel: w.welcome, color: '8b5cf6', image: 'https://x.y/i.png', thumbnail: 'https://x.y/t.png', footer: 'F', footer_icon: 'https://x.y/f.png', author: 'A', author_icon: 'https://x.y/a.png', url: 'https://x.y', timestamp: true });
    const e = serialize(w.welcome.send.mock.calls[0][0]).embeds[0];
    expect(e).toMatchObject({ title: 'T', description: 'one\ntwo', url: 'https://x.y', color: 0x8b5cf6, image: { url: 'https://x.y/i.png' }, thumbnail: { url: 'https://x.y/t.png' }, footer: { text: 'F', icon_url: 'https://x.y/f.png' }, author: { name: 'A', icon_url: 'https://x.y/a.png' } });
    expect(e.timestamp).toBeTruthy();
  });
  it('publishes in the current channel when none is chosen', async () => {
    const w = world();
    await embed(w, 'create', { title: 'Here' });
    expect(w.here.send).toHaveBeenCalledTimes(1);
  });
  it('opens the builder when there is nothing to publish', async () => {
    const w = world();
    const i = await embed(w, 'create', { channel: w.welcome });
    expect(w.welcome.send).not.toHaveBeenCalled();
    expect(serialize(i.reply.mock.calls[0][0]).components.length).toBeGreaterThan(0);
  });
  it.each([
    [{ title: 'T', color: 'purple' }, /hex color/],
    [{ title: 'T', image: 'javascript:alert(1)' }, /image/],
    [{ title: 'T', thumbnail: 'not a url' }, /thumbnail/],
    [{ title: 'T', footer_icon: 'ftp://x' }, /footerIcon/],
  ])('refuses invalid input %j without sending anything', async (options, message) => {
    const w = world();
    const i = await embed(w, 'create', { channel: w.welcome, ...options });
    expect(w.welcome.send).not.toHaveBeenCalled();
    expect(shown(i)).toMatch(message);
    expect(shown(i)).not.toMatch(/published/);
  });
  it.each([
    ['ViewChannel', [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]],
    ['SendMessages', [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks]],
    ['EmbedLinks', [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]],
  ])('explains when the bot lacks %s in that channel', async (name, bits) => {
    const w = world();
    w.welcome.permissionsFor = () => new PermissionsBitField(bits as bigint[]);
    const i = await embed(w, 'create', { title: 'T', channel: w.welcome });
    expect(w.welcome.send).not.toHaveBeenCalled();
    expect(shown(i)).toContain(name);
  });
  it('refuses a channel the person cannot post in themselves', async () => {
    const w = world();
    const mod = fakeMember(w.guild, '760000000000099001', { position: 5, perms: [PermissionFlagsBits.ManageMessages] });
    w.welcome.permissionsFor = (m: any) => new PermissionsBitField(m.id === mod.id ? [] : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
    const i = await embed(w, 'create', { title: 'T', channel: w.welcome }, { member: mod });
    expect(w.welcome.send).not.toHaveBeenCalled();
    expect(shown(i)).toMatch(/cannot post in/);
  });
  it('handles a deleted channel', async () => {
    const w = world();
    const i = await embed(w, 'create', { title: 'T', channel: { id: '699999999999999999' } });
    expect(shown(i)).toMatch(/no longer exists/);
  });
  it('never claims success when Discord refuses the send', async () => {
    const w = world();
    w.welcome.send = vi.fn(async () => { throw new DiscordAPIError({ code: 50013, message: 'Missing Permissions' }, 50013, 403, 'POST', '/x', {}); });
    const i = await embed(w, 'create', { title: 'T', channel: w.welcome });
    expect(shown(i)).toMatch(/missing the Discord permissions/);
    expect(shown(i)).not.toMatch(/published/);
    expect(await PostedEmbed.countDocuments()).toBe(0);
  });
  it('requires Manage Messages', async () => {
    const w = world();
    const pleb = fakeMember(w.guild, '760000000000099002', { position: 1 });
    const i = await embed(w, 'create', { title: 'T', channel: w.welcome }, { member: pleb });
    expect(w.welcome.send).not.toHaveBeenCalled();
    expect(shown(i)).toMatch(/ManageMessages/);
  });
});

describe('/embed preview', () => {
  it('shows it privately and publishes nothing', async () => {
    const w = world();
    const i = await embed(w, 'preview', { title: 'Peek', color: '#ff0000' });
    expect(w.here.send).not.toHaveBeenCalled();
    const p = serialize(i.reply.mock.calls[0][0]);
    expect(p.embeds[0]).toMatchObject({ title: 'Peek', color: 0xff0000 });
    expect(p.flags).toBeTruthy();
    expect(p.content).toMatch(/Preview only/);
  });
  it('previews templates, and explains when there is nothing to show', async () => {
    const w = world();
    await EmbedTemplate.create({ guildId: w.guild.id, name: 'rules', spec: { embeds: [{ title: 'Rules' }] }, createdBy: 'x' });
    expect(shown(await embed(w, 'preview', { template: 'rules' }))).toContain('Rules');
    expect(shown(await embed(w, 'preview', { template: 'missing' }))).toMatch(/does not exist/);
    expect(shown(await embed(w, 'preview', {}))).toMatch(/something to preview/);
  });
});

describe('/embed edit', () => {
  const seed = async (w: ReturnType<typeof world>) => {
    await embed(w, 'create', { title: 'Old', description: 'Keep me', channel: w.welcome });
    vi.mocked(w.welcome.send).mockClear();
  };
  it('changes only what was given, on the real message', async () => {
    const w = world();
    await seed(w);
    const i = await embed(w, 'edit', { message_link: link(w), title: 'New' });
    const edited = serialize(w.posted.edit.mock.calls[0][0]);
    expect(edited.embeds[0]).toMatchObject({ title: 'New', description: 'Keep me' });
    expect(w.welcome.send).not.toHaveBeenCalled();
    expect(shown(i)).toMatch(/Embed updated/);
    expect((await PostedEmbed.findOne({ messageId: w.posted.id }))?.spec).toMatchObject({ embeds: [{ title: 'New' }] });
  });
  it('opens the builder when no change was given', async () => {
    const w = world();
    await seed(w);
    const i = await embed(w, 'edit', { message_link: link(w) });
    expect(w.posted.edit).not.toHaveBeenCalled();
    expect(serialize(i.editReply.mock.calls[0][0]).components.length).toBeGreaterThan(0);
  });
  it('edits published embeds ZYTHERON has no record of', async () => {
    const w = world();
    w.posted.embeds = [{ toJSON: () => ({ title: 'Untracked', description: 'From before', color: 255 }) }];
    await embed(w, 'edit', { message_link: link(w), description: 'Changed' });
    expect(serialize(w.posted.edit.mock.calls[0][0]).embeds[0]).toMatchObject({ title: 'Untracked', description: 'Changed' });
  });
  it('refuses messages from anyone else, other servers and bad links', async () => {
    const w = world();
    w.posted.author = { id: 'someone-else' };
    expect(shown(await embed(w, 'edit', { message_link: link(w), title: 'X' }))).toMatch(/I can only edit messages I posted/);
    expect(w.posted.edit).not.toHaveBeenCalled();
    expect(shown(await embed(w, 'edit', { message_link: `https://discord.com/channels/999999999999999999/${WELCOME}/1` }))).toMatch(/from this server/);
    expect(shown(await embed(w, 'edit', { message_link: 'nonsense' }))).toMatch(/message link/);
  });
});

describe('/embed delete', () => {
  it('deletes bot messages and forgets them', async () => {
    const w = world();
    await embed(w, 'create', { title: 'Bye', channel: w.welcome });
    const i = await embed(w, 'delete', { message_link: link(w) });
    expect(w.posted.delete).toHaveBeenCalled();
    expect(await PostedEmbed.countDocuments()).toBe(0);
    expect(shown(i)).toMatch(/deleted/);
  });
  it('never deletes other people\x27s messages', async () => {
    const w = world();
    w.posted.author = { id: 'someone-else' };
    expect(shown(await embed(w, 'delete', { message_link: link(w) }))).toMatch(/I can only delete messages I posted/);
    expect(w.posted.delete).not.toHaveBeenCalled();
  });
});

describe('/embed duplicate', () => {
  it('reposts a published embed to another channel', async () => {
    const w = world();
    await embed(w, 'create', { title: 'Copy me', channel: w.welcome });
    const i = await embed(w, 'duplicate', { message_link: link(w), channel: w.here });
    expect(serialize(w.here.send.mock.calls[0][0]).embeds[0].title).toBe('Copy me');
    expect(shown(i)).toMatch(/duplicated/);
  });
  it('copies templates, and explains what it needs', async () => {
    const w = world();
    await EmbedTemplate.create({ guildId: w.guild.id, name: 'rules', spec: { embeds: [{ title: 'Rules' }] }, createdBy: 'x' });
    await embed(w, 'duplicate', { template: 'rules', new_name: 'Rules 2' });
    expect(await EmbedTemplate.exists({ guildId: w.guild.id, name: 'rules-2' })).toBe(true);
    expect(shown(await embed(w, 'duplicate', { template: 'rules', new_name: 'rules-2' }))).toMatch(/already exists/);
    expect(shown(await embed(w, 'duplicate', { template: 'rules' }))).toMatch(/new_name/);
    expect(shown(await embed(w, 'duplicate', {}))).toMatch(/message_link/);
  });
});

describe('/embed list and templates', () => {
  it('lists templates and published embeds', async () => {
    const w = world();
    await EmbedTemplate.create({ guildId: w.guild.id, name: 'rules', spec: { embeds: [{ title: 'R' }] }, createdBy: 'x' });
    await embed(w, 'create', { title: 'T', channel: w.welcome });
    const out = shown(await embed(w, 'list'));
    expect(out).toContain('rules');
    expect(out).toContain(`<#${WELCOME}>`);
    expect(out).toContain(w.posted.id);
  });
  it('saves a published message as a template, then publishes it', async () => {
    const w = world();
    await embed(w, 'create', { title: 'Keep', channel: w.welcome });
    await embed(w, 'save', { name: 'Keep This', message_link: link(w) }, { group: 'template' });
    expect((await EmbedTemplate.findOne({ name: 'keep-this' }))?.spec).toMatchObject({ embeds: [{ title: 'Keep' }] });
    vi.mocked(w.here.send).mockClear();
    const i = await embed(w, 'load', { name: 'keep-this', channel: w.here, publish: true }, { group: 'template' });
    expect(serialize(w.here.send.mock.calls[0][0]).embeds[0].title).toBe('Keep');
    expect(shown(i)).toMatch(/Template published/);
  });
  it('opens a template in the builder by default, lists and deletes', async () => {
    const w = world();
    await EmbedTemplate.create({ guildId: w.guild.id, name: 'rules', spec: { embeds: [{ title: 'Rules' }] }, createdBy: 'x' });
    const i = await embed(w, 'load', { name: 'rules' }, { group: 'template' });
    expect(w.here.send).not.toHaveBeenCalled();
    expect(serialize(i.reply.mock.calls[0][0]).embeds[0].title).toBe('Rules');
    expect(shown(await embed(w, 'list', {}, { group: 'template' }))).toContain('rules');
    await embed(w, 'delete', { name: 'rules' }, { group: 'template' });
    expect(await EmbedTemplate.countDocuments()).toBe(0);
    expect(shown(await embed(w, 'delete', { name: 'rules' }, { group: 'template' }))).toMatch(/does not exist/);
    expect(shown(await embed(w, 'save', { name: 'x' }, { group: 'template' }))).toMatch(/expired/);
  });
  it('keeps templates inside their server', async () => {
    const w = world();
    await EmbedTemplate.create({ guildId: '100000000000000099', name: 'theirs', spec: { embeds: [{ title: 'Secret' }] }, createdBy: 'x' });
    expect(shown(await embed(w, 'preview', { template: 'theirs' }))).toMatch(/does not exist/);
    expect(shown(await embed(w, 'list'))).not.toContain('theirs');
  });
});

describe('channel validation', () => {
  it('accepts threads using the thread permission', () => {
    const w = world();
    const thread = fakeChannel(w.guild, '600000000000000003', { type: 11 });
    thread.isThread = () => true;
    thread.permissionsFor = () => new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks]);
    expect(() => postableChannel(w.guild, thread.id)).toThrow(/SendMessagesInThreads/);
    thread.permissionsFor = () => new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.SendMessagesInThreads]);
    expect(postableChannel(w.guild, thread.id)).toBe(thread);
  });
  it('refuses categories and missing channels', () => {
    const w = world();
    const category = fakeChannel(w.guild, '600000000000000004', { type: 4 });
    expect(() => postableChannel(w.guild, category.id)).toThrow(/not a channel I can post/);
    expect(() => postableChannel(w.guild, null)).toThrow(/no longer exists/);
  });
});
