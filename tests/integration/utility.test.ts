import { ChannelType, Collection, PermissionsBitField } from 'discord.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateConfig } from '../../src/core/configService.js';
import { InteractionRouter } from '../../src/core/interactions.js';
import { Cooldown } from '../../src/core/rateLimit.js';
import { MODULES } from '../../src/core/registry.js';
import { parseDice, utilityModule } from '../../src/modules/utility/index.js';
import { useDatabase } from '../helpers/db.js';
import { fakeChannel, fakeMember, fakeRole } from '../helpers/fakes.js';
import { commandInteraction, setupGuild } from '../helpers/interaction.js';

useDatabase();

const router = new InteractionRouter(MODULES);
const OTHER_ID = '700000000000000050';
const VOICE_A = '600000000000000061';
const VOICE_B = '600000000000000062';
const LOCKED = '600000000000000063';
const FULL = '600000000000000064';

beforeAll(() => { vi.spyOn(Cooldown.prototype, 'allow').mockReturnValue(0); });
afterAll(() => { vi.restoreAllMocks(); });

const asUser = (id: string, name: string, bot = false) => ({ id, username: name, tag: name, bot, createdAt: new Date('2021-03-04'), displayAvatarURL: () => `https://cdn.example/${id}.png` });

function world() {
  const guild = setupGuild();
  fakeChannel(guild, '600000000000000001');
  const owner = fakeMember(guild, guild.ownerId, { position: 40 });
  const other = fakeMember(guild, OTHER_ID, { position: 2 });
  const botMember = fakeMember(guild, guild.client.user.id, { position: 30, bot: true });
  guild.members.me = botMember;
  for (const m of [owner, other]) { m.user = asUser(m.id, `name-${m.id.slice(-2)}`); m.joinedAt = new Date('2022-05-06'); }
  guild.members.fetch = vi.fn(async (id?: string) => {
    if (!id) return guild.members.cache;
    const m = guild.members.cache.get(id);
    if (!m) throw new Error('Unknown member');
    return m;
  });
  guild.client.users.fetch = vi.fn(async (id: string) => { if (id === '700000000000000051') return asUser(id, 'left-server'); throw new Error('Unknown user'); });
  const role = fakeRole('400000000000000005', 5, { name: 'Gamer', guild });
  role.members.set(OTHER_ID, other);
  guild.roles.cache.set(role.id, role);
  guild.roles.cache.set(guild.id, fakeRole(guild.id, 0, { name: '@everyone', guild }));
  other.roles.cache.set(role.id, role);

  const voice = (id: string, name: string, extra: object = {}) => {
    const c = fakeChannel(guild, id, { type: ChannelType.GuildVoice, name });
    Object.assign(c, { userLimit: 0, members: new Collection(), permissionsFor: () => new PermissionsBitField(PermissionsBitField.All), ...extra });
    return c;
  };
  const a = voice(VOICE_A, 'Lounge');
  const b = voice(VOICE_B, 'Music Room');
  voice(LOCKED, 'Staff', { permissionsFor: (who: any) => new PermissionsBitField(who.id === OTHER_ID ? [] : PermissionsBitField.All) });
  voice(FULL, 'Duo', { userLimit: 1, members: new Collection([['x', {}]]), permissionsFor: (who: any) => new PermissionsBitField(who.id === OTHER_ID ? [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] : PermissionsBitField.All) });
  const setChannel = vi.fn(async () => undefined);
  other.voice = { channel: a, channelId: a.id, setChannel };
  return { guild, owner, other, a, b, setChannel };
}

type World = ReturnType<typeof world>;
const slash = async (w: World, command: string, options: Record<string, unknown> = {}, member: any = w.other) => {
  const i = commandInteraction(w.guild, command, null, options, { member });
  await router.handle(i);
  return JSON.stringify(i.editReply.mock.calls.at(-1)?.[0] ?? i.reply.mock.calls.at(-1)?.[0]);
};
const text = async (w: World, content: string, member: any = w.other) => {
  const message: any = { content, inGuild: () => true, author: { id: member.id, bot: false }, webhookId: null, guild: w.guild, member, channel: { id: '600000000000000001', sendTyping: vi.fn(async () => undefined) }, reply: vi.fn(async () => undefined) };
  await (utilityModule.events![0]!.run as any)(message);
  return message.reply.mock.calls.length ? JSON.stringify(message.reply.mock.calls[0][0]) : null;
};

describe('every command works with / and v!', () => {
  it('/user and v!user show the same details, for yourself or someone else', async () => {
    const w = world();
    for (const reply of [await slash(w, 'user'), await text(w, 'v!user'), await text(w, 'v!whois'), await text(w, `v!ui <@${OTHER_ID}>`), await text(w, `v!user ${OTHER_ID}`), await slash(w, 'user', { user: { id: OTHER_ID } }, w.owner)]) {
      expect(reply).toContain(OTHER_ID);
      expect(reply).toContain('Roles (1)');
      expect(reply).toContain('<@&400000000000000005>');
      expect(reply).toContain('Joined this server');
    }
    expect(await slash(w, 'user', {}, w.owner)).toContain('Roles (0)');
  });

  it('/user handles people who left, and bad input', async () => {
    const w = world();
    expect(await text(w, 'v!user 700000000000000051')).toContain('Not in this server');
    expect(await text(w, 'v!user 700000000000000052')).toMatch(/could not find that user/);
    expect(await text(w, 'v!user bob')).toMatch(/Mention someone/);
  });

  it('/avatar and v!avatar return the image and a link', async () => {
    const w = world();
    for (const reply of [await slash(w, 'avatar'), await text(w, 'v!av')]) {
      expect(reply).toContain(`https://cdn.example/${OTHER_ID}.png`);
      expect(reply).toContain('Open full size');
    }
  });

  it('/server and v!server describe the server', async () => {
    const w = world();
    for (const reply of [await slash(w, 'server'), await text(w, 'v!si')]) {
      expect(reply).toContain('Test Guild');
      expect(reply).toContain(`<@${w.guild.ownerId}>`);
      expect(reply).toContain('100'); // members
      expect(reply).toContain('1 text, 4 voice');
    }
  });

  it('/roles and v!roles list roles with counts, without @everyone or pings', async () => {
    const w = world();
    for (const reply of [await slash(w, 'roles'), await text(w, 'v!roles')]) {
      expect(reply).toContain('<@&400000000000000005> 1');
      expect(reply).not.toContain(`<@&${w.guild.id}>`);
      expect(JSON.parse(reply!).allowedMentions.parse).toEqual([]);
    }
  });

  it('/roll and v!roll roll within range', async () => {
    const w = world();
    expect(await slash(w, 'roll')).toMatch(/6-sided die: \*\*[1-6]\*\*/);
    expect(await text(w, 'v!roll 20')).toMatch(/20-sided die/);
    expect(await text(w, 'v!dice 2d6')).toMatch(/Rolled 2d6: \d \+ \d = \*\*\d+\*\*/);
    expect(await text(w, 'v!roll banana')).toMatch(/Use dice like/);
    expect(await slash(w, 'roll', { dice: '99d6' })).toMatch(/1 to 20 dice/);
    expect(await text(w, 'v!roll 1')).toMatch(/2 to 1000 sides/);
    expect(parseDice('D8')).toEqual({ dice: 1, sides: 8 });
    expect(parseDice(null)).toEqual({ dice: 1, sides: 6 });
  });

  it('/moveme and v!moveme move you, by picker, mention or name', async () => {
    const w = world();
    expect(await slash(w, 'moveme', { channel: { id: VOICE_B } })).toContain(`Moved you to <#${VOICE_B}>`);
    expect(await text(w, `v!moveme <#${VOICE_B}>`)).toContain('Moved you');
    expect(await text(w, 'v!move music room')).toContain('Moved you');
    expect(w.setChannel).toHaveBeenCalledTimes(3);
    expect(w.setChannel.mock.calls[0]).toEqual([w.b, 'Used /moveme']);
  });

  it('/moveme never gets anyone in where they could not go themselves', async () => {
    const w = world();
    expect(await text(w, `v!moveme ${LOCKED}`)).toMatch(/do not have access/);
    expect(await text(w, `v!moveme ${FULL}`)).toMatch(/is full/);
    expect(await text(w, 'v!moveme lounge')).toMatch(/already in that channel/);
    expect(await text(w, 'v!moveme nowhere')).toMatch(/could not find that voice channel/);
    expect(await text(w, 'v!moveme')).toContain('v!moveme <channel name>');
    expect(await text(w, 'v!moveme music room', w.owner)).toMatch(/Join a voice channel first/);
    w.guild.members.me = fakeMember(w.guild, w.guild.client.user.id, { position: 30, bot: true });
    w.b.permissionsFor = (who: any) => new PermissionsBitField(who.id === OTHER_ID ? PermissionsBitField.All : []);
    expect(await text(w, 'v!moveme music room')).toMatch(/Move Members/);
    expect(w.setChannel).not.toHaveBeenCalled();
  });

  it('follow the dashboard switches for both / and v!', async () => {
    const w = world();
    await updateConfig(w.guild.id, 'commands', { disabled: ['roll'] });
    expect(await slash(w, 'roll')).toMatch(/turned off/);
    expect(await text(w, 'v!roll')).toMatch(/turned off/);
  });

  const typed = async (w: World, content: string, member: any = w.other) => {
    const message: any = { id: `${Math.random()}`, content, inGuild: () => true, author: { id: member.id, bot: false }, webhookId: null, guild: w.guild, member, channel: { id: '600000000000000001', sendTyping: vi.fn(async () => undefined) }, delete: vi.fn(async () => undefined) };
    const reply = { delete: vi.fn(async () => undefined) };
    message.reply = vi.fn(async () => reply);
    await (utilityModule.events![0]!.run as any)(message);
    return { message, reply };
  };
  const deleted = (id: string) => (utilityModule.events!.find((e) => e.event === 'messageDelete')!.run as any)({ id });

  it('runs a command by a server alias, only on that server', async () => {
    const w = world();
    await updateConfig(w.guild.id, 'commands', { rules: { roll: { aliases: ['dado'] } } });
    expect(JSON.stringify((await typed(w, 'v!dado 20')).message.reply.mock.calls[0][0])).toMatch(/20-sided die/);
    expect(JSON.stringify((await typed(w, 'V!DADO')).message.reply.mock.calls[0][0])).toMatch(/6-sided die/);
    const other = world();
    other.guild.id = '100000000000000099';
    expect((await typed(other, 'v!dado')).message.reply).not.toHaveBeenCalled();
    await updateConfig(w.guild.id, 'commands', { disabled: ['roll'] });
    expect(JSON.stringify((await typed(w, 'v!dado')).message.reply.mock.calls[0][0])).toMatch(/turned off/);
  });

  it('runs aliases exactly as typed, with any prefix, and passes the rest along', async () => {
    const w = world();
    await updateConfig(w.guild.id, 'commands', { rules: { roll: { aliases: ['r', '#r', '!dice', 'dado'] } } });
    const answer = async (content: string) => { const { message } = await typed(w, content); return message.reply.mock.calls[0]?.[0] ? JSON.stringify(message.reply.mock.calls[0][0]) : null; };
    for (const content of ['r 20', '#r 20', '!dice 20', '#R 20', '  r   20', 'dado 20', 'v!dado 20', 'v!r 20']) expect(await answer(content), content).toMatch(/20-sided die/);
    expect(await answer('#r')).toMatch(/6-sided die/);
    // Anything else stays out of the conversation.
    for (const content of ['hello r', 'rr', '#rr 20', '!r', 'r-20', 'dado.', 'nothing']) expect(await answer(content), content).toBeNull();
  });

  it('with no aliases, ordinary chat is left alone', async () => {
    const w = world();
    for (const content of ['p', '#p', 'hello', 'roll', 'user']) expect((await typed(w, content)).message.reply, content).not.toHaveBeenCalled();
  });

  it('follows the prefixes a server chooses', async () => {
    const w = world();
    await updateConfig(w.guild.id, 'commands', { prefixes: ['?', '!!'] });
    const replied = async (content: string) => Boolean((await typed(w, content)).message.reply.mock.calls.length);
    for (const content of ['?roll', '!!roll', '? roll', '!!ROLL 20']) expect(await replied(content), content).toBe(true);
    for (const content of ['v!roll', '!roll', 'roll']) expect(await replied(content), content).toBe(false);
    expect(JSON.stringify((await typed(w, '?moveme')).message.reply.mock.calls[0][0])).toContain('?moveme <channel name>');
  });

  it('obeys disabled roles and channels, and never limits the owner', async () => {
    const w = world();
    await updateConfig(w.guild.id, 'commands', { rules: { roll: { disabledRoleIds: ['400000000000000005'] } } });
    expect(await slash(w, 'roll')).toMatch(/not available to one of your roles/);
    expect(await text(w, 'v!roll')).toMatch(/not available to one of your roles/);
    w.owner.roles.cache.set('400000000000000005', {});
    expect(await slash(w, 'roll', {}, w.owner)).toMatch(/Rolled/);
    await updateConfig(w.guild.id, 'commands', { rules: { roll: { disabledRoleIds: [], disabledChannelIds: ['600000000000000001'] } } });
    expect(await slash(w, 'roll')).toMatch(/can't be used in this channel/);
    expect(await text(w, 'v!roll')).toMatch(/can't be used in this channel/);
  });

  it('deletes the v! message when asked, and carries on if it cannot', async () => {
    const w = world();
    expect((await typed(w, 'v!roll')).message.delete).not.toHaveBeenCalled();
    await updateConfig(w.guild.id, 'commands', { rules: { roll: { deleteInvocation: true } } });
    const { message } = await typed(w, 'v!roll');
    expect(message.reply).toHaveBeenCalled();
    expect(message.delete).toHaveBeenCalledOnce();
    message.delete = vi.fn(async () => { throw new Error('Missing permissions'); });
    await expect((utilityModule.events![0]!.run as any)(message)).resolves.toBeUndefined();
  });

  it('deletes the reply together with the v! message, only when asked', async () => {
    const w = world();
    const off = await typed(w, 'v!roll');
    await deleted(off.message.id);
    expect(off.reply.delete).not.toHaveBeenCalled();
    await updateConfig(w.guild.id, 'commands', { rules: { roll: { deleteWithMessage: true } } });
    const on = await typed(w, 'v!roll');
    expect(on.reply.delete).not.toHaveBeenCalled();
    await deleted(on.message.id);
    expect(on.reply.delete).toHaveBeenCalledOnce();
    await deleted('some-other-message');
  });

  describe('deleting replies after 5 seconds', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
    afterEach(() => { vi.useRealTimers(); });

    it('works for v! and slash commands, and only when on', async () => {
      const w = world();
      const off = await typed(w, 'v!roll');
      const offSlash = commandInteraction(w.guild, 'roll', null, {}, { member: w.other });
      offSlash.deleteReply = vi.fn(async () => undefined);
      await router.handle(offSlash);
      await vi.advanceTimersByTimeAsync(6000);
      expect(off.reply.delete).not.toHaveBeenCalled();
      expect(offSlash.deleteReply).not.toHaveBeenCalled();

      await updateConfig(w.guild.id, 'commands', { rules: { roll: { deleteReplyAfter5s: true } } });
      const on = await typed(w, 'v!roll');
      const onSlash = commandInteraction(w.guild, 'roll', null, {}, { member: w.other });
      onSlash.deleteReply = vi.fn(async () => undefined);
      await router.handle(onSlash);
      await vi.advanceTimersByTimeAsync(4900);
      expect(on.reply.delete).not.toHaveBeenCalled();
      expect(onSlash.deleteReply).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(on.reply.delete).toHaveBeenCalledOnce();
      expect(onSlash.deleteReply).toHaveBeenCalledOnce();
    });
  });

  it('stay quiet for words that are not theirs', async () => {
    const w = world();
    for (const content of ['user', 'v!play lofi', 'v!', 'hello v!user']) expect(await text(w, content), content).toBeNull();
  });
});
