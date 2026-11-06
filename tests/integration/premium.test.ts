import { Collection, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateConfig } from '../../src/core/configService.js';
import { Meta } from '../../src/db/models.js';
import { onStickyMessage, onVoiceLink, repostSticky, runAutoPurge } from '../../src/modules/premium/index.js';
import { useDatabase } from '../helpers/db.js';
import { fakeChannel, fakeMember, fakeRole } from '../helpers/fakes.js';
import { setupGuild } from '../helpers/interaction.js';

/** The real feature code. Only Discord itself is faked. */
useDatabase();

const TEXT = '600000000000000001';
const VOICE = '600000000000000002';
const VOICE2 = '600000000000000003';
const ROLE = '400000000000000011';
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function world() {
  const guild = setupGuild();
  const text = fakeChannel(guild, TEXT, { name: 'chat' });
  text.isTextBased = () => true;
  let id = 0;
  text.send = vi.fn(async () => ({ id: `sent-${++id}` }));
  text.messages = { delete: vi.fn(async () => undefined), fetch: vi.fn() };
  text.bulkDelete = vi.fn(async () => undefined);
  guild.members.me = fakeMember(guild, guild.client.user.id, { position: 30, bot: true, perms: [P.Administrator, P.ManageRoles] });
  const member = fakeMember(guild, '700000000000000021', { position: 1 });
  const role = fakeRole(ROLE, 5, { name: 'In voice', guild });
  guild.roles.cache.set(role.id, role);
  member.roles.add = vi.fn(async () => undefined);
  member.roles.remove = vi.fn(async () => undefined);
  guild.client.guilds.cache.set(guild.id, guild);
  return { guild, text, member, role };
}
type World = ReturnType<typeof world>;

describe('sticky messages', () => {
  afterEach(() => { vi.useRealTimers(); });
  const incoming = (w: World, over: object = {}): any => ({ inGuild: () => true, author: { id: w.member.id }, client: w.guild.client, guild: w.guild, channelId: TEXT, ...over });

  it('posts the message without pinging anyone, then replaces the old copy', async () => {
    const w = world();
    await updateConfig(w.guild.id, 'sticky', { items: [{ channelId: TEXT, content: 'Read the rules @everyone' }] });
    await repostSticky(w.guild, TEXT);
    const first = w.text.send.mock.calls[0][0];
    expect(first.allowedMentions).toEqual({ parse: [] });
    expect(JSON.stringify(first.embeds)).toContain('Read the rules');
    expect(w.text.messages.delete).not.toHaveBeenCalled();
    await repostSticky(w.guild, TEXT);
    expect(w.text.messages.delete).toHaveBeenCalledWith('sent-1');
    expect((await Meta.findById(`sticky:${TEXT}`))?.value).toBe('sent-2');
  });

  it('waits for a quiet moment, so a busy channel only moves it once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world();
    await updateConfig(w.guild.id, 'sticky', { items: [{ channelId: TEXT, content: 'Hello' }] });
    for (let n = 0; n < 3; n++) await onStickyMessage(incoming(w));
    await vi.advanceTimersByTimeAsync(4900);
    expect(w.text.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(w.text.send).toHaveBeenCalledOnce();
  });

  it('ignores its own messages, and channels with no sticky', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world();
    await updateConfig(w.guild.id, 'sticky', { items: [{ channelId: TEXT, content: 'Hello' }] });
    await onStickyMessage(incoming(w, { author: { id: w.guild.client.user.id } }));
    await onStickyMessage(incoming(w, { channelId: VOICE }));
    await vi.advanceTimersByTimeAsync(6000);
    expect(w.text.send).not.toHaveBeenCalled();
  });
});

describe('auto purge', () => {
  const message = (id: string, ageMinutes: number, pinned = false) => [id, { id, pinned, createdTimestamp: NOW - ageMinutes * MINUTE }] as const;

  it('deletes only old messages that are not pinned, and only in chosen channels', async () => {
    const w = world();
    await updateConfig(w.guild.id, 'autoPurge', { items: [{ channelId: TEXT, afterMinutes: 60 }] });
    w.text.messages.fetch.mockResolvedValue(new Collection([message('new', 10), message('old', 120), message('pinned', 120, true), message('ancient', 20 * 24 * 60)]));
    await runAutoPurge(w.guild.client, NOW);
    expect(w.text.messages.fetch).toHaveBeenCalledWith({ limit: 100 });
    const deleted = w.text.bulkDelete.mock.calls[0][0];
    expect([...deleted.keys()]).toEqual(['old']);
  });

  it('does nothing with no rules, or nothing old enough', async () => {
    const w = world();
    await runAutoPurge(w.guild.client, NOW);
    expect(w.text.messages.fetch).not.toHaveBeenCalled();
    await updateConfig(w.guild.id, 'autoPurge', { items: [{ channelId: TEXT, afterMinutes: 60 }] });
    w.text.messages.fetch.mockResolvedValue(new Collection([message('new', 10)]));
    await runAutoPurge(w.guild.client, NOW);
    expect(w.text.bulkDelete).not.toHaveBeenCalled();
  });

  it('skips channels it may not clean, and survives errors', async () => {
    const w = world();
    await updateConfig(w.guild.id, 'autoPurge', { items: [{ channelId: TEXT, afterMinutes: 60 }, { channelId: '600000000000000099', afterMinutes: 60 }] });
    w.text.permissionsFor = () => new PermissionsBitField([P.ViewChannel]);
    await expect(runAutoPurge(w.guild.client, NOW)).resolves.toBeUndefined();
    expect(w.text.messages.fetch).not.toHaveBeenCalled();
    w.text.permissionsFor = () => new PermissionsBitField(PermissionsBitField.All);
    w.text.messages.fetch.mockRejectedValue(new Error('Missing Access'));
    await expect(runAutoPurge(w.guild.client, NOW)).resolves.toBeUndefined();
  });
});

describe('voice link', () => {
  const state = (w: World, channelId: string | null, member: any = w.member): any => ({ channelId, member, guild: w.guild });
  const link = (w: World, items = [{ channelId: VOICE, roleId: ROLE }]) => updateConfig(w.guild.id, 'voiceLink', { items });

  it('gives the role on joining and removes it on leaving', async () => {
    const w = world();
    await link(w);
    await onVoiceLink(state(w, null), state(w, VOICE));
    expect(w.member.roles.add).toHaveBeenCalledOnce();
    await onVoiceLink(state(w, VOICE), state(w, null));
    expect(w.member.roles.remove).toHaveBeenCalledOnce();
  });

  it('keeps the role when moving between two channels linked to it', async () => {
    const w = world();
    await link(w, [{ channelId: VOICE, roleId: ROLE }, { channelId: VOICE2, roleId: ROLE }]);
    await onVoiceLink(state(w, VOICE), state(w, VOICE2));
    expect(w.member.roles.remove).not.toHaveBeenCalled();
    expect(w.member.roles.add).toHaveBeenCalledOnce();
  });

  it('ignores bots, mute changes and unlinked channels', async () => {
    const w = world();
    await link(w);
    await onVoiceLink(state(w, VOICE), state(w, VOICE));
    await onVoiceLink(state(w, null), state(w, VOICE2));
    const bot = fakeMember(w.guild, '700000000000000022', { position: 1, bot: true });
    bot.roles.add = vi.fn();
    await onVoiceLink(state(w, null, bot), state(w, VOICE, bot));
    expect(bot.roles.add).not.toHaveBeenCalled();
    expect(w.member.roles.add).not.toHaveBeenCalled();
  });

  it('refuses a role that became dangerous, or one above the bot', async () => {
    const w = world();
    await link(w);
    w.role.permissions = new PermissionsBitField([P.Administrator]);
    await onVoiceLink(state(w, null), state(w, VOICE));
    expect(w.member.roles.add).not.toHaveBeenCalled();
    w.role.permissions = new PermissionsBitField([]);
    w.role.position = 99;
    await onVoiceLink(state(w, null), state(w, VOICE));
    expect(w.member.roles.add).not.toHaveBeenCalled();
  });

  it('survives a failed role change', async () => {
    const w = world();
    await link(w);
    w.member.roles.add = vi.fn(async () => { throw new Error('Missing Permissions'); });
    await expect(onVoiceLink(state(w, null), state(w, VOICE))).resolves.toBeUndefined();
  });
});
