import { Collection, PermissionFlagsBits as P } from 'discord.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { aliasListener } from '../../src/core/aliasCommands.js';
import { updateConfig } from '../../src/core/configService.js';
import { InteractionRouter } from '../../src/core/interactions.js';
import { logger } from '../../src/core/logger.js';
import { Cooldown } from '../../src/core/rateLimit.js';
import { MODULES } from '../../src/core/registry.js';
import { useDatabase } from '../helpers/db.js';
import { fakeChannel, fakeMember, fakeRole } from '../helpers/fakes.js';
import { setupGuild } from '../helpers/interaction.js';

/** Runs aliases through the real router and command code. Only Discord itself is faked. */
useDatabase();

const router = new InteractionRouter(MODULES);
const listen = aliasListener(router);
const STAFF = '700000000000000061';
const MEMBER = '700000000000000062';
const TEXT = '600000000000000001';

beforeAll(() => { vi.spyOn(Cooldown.prototype, 'allow').mockReturnValue(0); });
afterAll(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

function world() {
  const guild = setupGuild();
  const channel = fakeChannel(guild, TEXT, { name: 'general' });
  channel.sendTyping = vi.fn(async () => undefined);
  channel.isTextBased = () => true;
  const owner = fakeMember(guild, guild.ownerId, { position: 40, perms: [P.Administrator] });
  const staff = fakeMember(guild, STAFF, { position: 20, perms: [P.ManageGuild, P.ManageMessages, P.ModerateMembers, P.KickMembers, P.BanMembers] });
  const member = fakeMember(guild, MEMBER, { position: 2 });
  guild.members.me = fakeMember(guild, guild.client.user.id, { position: 30, bot: true, perms: [P.Administrator] });
  const role = fakeRole('400000000000000009', 5, { name: 'Gamer', guild });
  guild.roles.cache.set(role.id, role);
  guild.client.users.fetch = vi.fn(async (id: string) => { const m = guild.members.cache.get(id); if (!m) throw new Error('Unknown'); return m.user; });
  guild.members.fetch = vi.fn(async (id?: string) => { if (!id) return guild.members.cache; const m = guild.members.cache.get(id); if (!m) throw new Error('Unknown'); return m; });
  return { guild, channel, owner, staff, member, role };
}
type World = ReturnType<typeof world>;

async function say(w: World, content: string, member: any = w.staff, extra: object = {}) {
  const sent = { id: 'reply', delete: vi.fn(async () => undefined), edit: vi.fn(async () => undefined), url: 'https://discord.com/x' };
  const message: any = { id: `m${Math.random()}`, content, inGuild: () => true, author: member.user, webhookId: null, guild: w.guild, member, channel: w.channel, channelId: TEXT, client: w.guild.client, createdTimestamp: Date.now(), attachments: new Collection(), reply: vi.fn(async () => sent), delete: vi.fn(async () => undefined), ...extra };
  await listen(message);
  return { message, sent, answer: message.reply.mock.calls.length ? JSON.stringify(message.reply.mock.calls.at(-1)[0]) : null };
}
const aliases = (w: World, rules: Record<string, string[]>) => updateConfig(w.guild.id, 'commands', { rules: Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, { aliases: v }])) });

describe('aliases on slash-only commands', () => {
  it('runs a simple command with any prefix, and stays quiet otherwise', async () => {
    const w = world();
    await aliases(w, { ping: ['#ping', 'pong', '!health'] });
    for (const content of ['#ping', 'pong', '!HEALTH', 'v!pong']) expect((await say(w, content, w.member)).answer, content).toContain('Gateway');
    for (const content of ['ping', '#pings', 'hello #ping', 'v!', '']) expect((await say(w, content, w.member)).answer, content).toBeNull();
  });

  it('ignores bots, webhooks and direct messages', async () => {
    const w = world();
    await aliases(w, { ping: ['pong'] });
    expect((await say(w, 'pong', w.member, { author: { id: '1', bot: true } })).answer).toBeNull();
    expect((await say(w, 'pong', w.member, { webhookId: '5' })).answer).toBeNull();
    expect((await say(w, 'pong', w.member, { inGuild: () => false })).answer).toBeNull();
  });

  it('reads subcommands and options, and explains mistakes', async () => {
    const w = world();
    await aliases(w, { moderation: ['#mod'], invites: ['#inv'] });
    expect((await say(w, '#mod')).answer).toContain('`#mod ban`');
    expect((await say(w, '#mod dance')).answer).toContain('Choose one');
    expect((await say(w, '#mod warn')).answer).toContain('`#mod warn <user>');
    expect((await say(w, '#mod warn bob spam')).answer).toMatch(/\*\*user\*\* must be a mention or a user ID/);
    expect((await say(w, `#mod warn <@${MEMBER}> being rude in chat`)).answer).toMatch(/warn|Case/i);
  });

  it('keeps every permission check: the router, and what Discord would have enforced', async () => {
    const w = world();
    await aliases(w, { moderation: ['#mod'], setup: [], logs: ['#logs'] });
    const denied = await say(w, `#mod warn <@${STAFF}> nope`, w.member);
    expect(denied.answer).toMatch(/don't have permission/);
    const noLogs = await say(w, '#logs status', w.member);
    expect(noLogs.answer).toMatch(/don't have permission/);
    expect((await say(w, '#logs status')).answer).not.toMatch(/don't have permission/);
  });

  it('follows the dashboard: turned off, roles and channels', async () => {
    const w = world();
    await aliases(w, { ping: ['pong'] });
    await updateConfig(w.guild.id, 'commands', { disabled: ['ping'] });
    expect((await say(w, 'pong', w.member)).answer).toMatch(/turned off/);
    await updateConfig(w.guild.id, 'commands', { disabled: [], rules: { ping: { aliases: ['pong'], disabledRoleIds: [w.role.id] } } });
    w.member.roles.cache.set(w.role.id, w.role);
    expect((await say(w, 'pong', w.member)).answer).toMatch(/not available to one of your roles/);
    await updateConfig(w.guild.id, 'commands', { rules: { ping: { aliases: ['pong'], disabledRoleIds: [], disabledChannelIds: [TEXT] } } });
    expect((await say(w, 'pong', w.staff)).answer).toMatch(/can't be used in this channel/);
  });

  it('follows the auto-delete settings', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world();
    await updateConfig(w.guild.id, 'commands', { rules: { ping: { aliases: ['pong'], deleteInvocation: true, deleteReplyAfter5s: true } } });
    const { message, sent } = await say(w, 'pong', w.member);
    expect(message.delete).toHaveBeenCalledOnce();
    expect(sent.delete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5100);
    expect(sent.delete).toHaveBeenCalled();
  });

  it('removes what would have been a private reply after 30 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world();
    await aliases(w, { help: ['#help'] });
    const { sent, message } = await say(w, '#help', w.member);
    const payload = message.reply.mock.calls[0][0];
    expect(payload.flags).toBeUndefined();
    expect(payload.embeds).toBeDefined();
    expect(sent.delete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_100);
    expect(sent.delete).toHaveBeenCalledOnce();
  });

  it('never pings anyone through its replies', async () => {
    const w = world();
    await aliases(w, { help: ['#help'] });
    const { message } = await say(w, '#help', w.member);
    expect(message.reply.mock.calls[0][0].allowedMentions).toEqual({ parse: [], repliedUser: false });
  });

  it('points to the slash command when a form is needed', async () => {
    const w = world();
    await aliases(w, { profile: ['#p'] });
    expect((await say(w, '#p edit', w.member)).answer).toMatch(/forms only work from the slash command.*\/profile/);
  });

  it('every command answers through an alias, without an unexpected error', async () => {
    const errors = vi.spyOn(logger, 'error').mockImplementation((() => undefined) as never);
    const commands = MODULES.flatMap((m) => m.commands ?? []);
    expect(commands.length).toBeGreaterThan(50);
    for (const command of commands) {
      const w = world();
      const name = command.data.name;
      const alias = `#${name}`;
      await aliases(w, { [name]: [alias] });
      // Commands with their own v! version are handled by their module, not this listener.
      const { answer } = await say(w, alias, w.owner);
      const dual = (await import('../../src/core/textCommands.js')).hasTextCommand(name);
      if (dual) expect(answer, name).toBeNull();
      else expect(answer, name).toBeTruthy();
    }
    expect(errors.mock.calls.map((c) => JSON.stringify((c[0] as any)?.command ?? c[0])).filter(Boolean)).toEqual([]);
    errors.mockRestore();
  }, 60_000);

  it('tells people how to use a command when its options are missing', async () => {
    const w = world();
    await aliases(w, { poll: ['#poll'] });
    const { answer } = await say(w, '#poll close');
    expect(answer).toContain('#poll close');
  });
});
