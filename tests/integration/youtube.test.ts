import { ChannelType, InviteTargetType, PermissionsBitField } from 'discord.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateConfig } from '../../src/core/configService.js';
import { InteractionRouter } from '../../src/core/interactions.js';
import { Cooldown } from '../../src/core/rateLimit.js';
import { MODULES } from '../../src/core/registry.js';
import { musicModule } from '../../src/modules/music/index.js';
import { resolveTrack } from '../../src/modules/music/sources.js';
import { searchYoutube, youtubeConfig } from '../../src/modules/music/youtube.js';
import { useDatabase } from '../helpers/db.js';
import { fakeChannel, fakeMember } from '../helpers/fakes.js';
import { commandInteraction, componentInteraction, setupGuild } from '../helpers/interaction.js';

/** Google and Discord are faked here. A real search and a real activity still need testing. */
useDatabase();

const KEY = 'test-key-that-must-never-appear';
const VOICE = '600000000000000071';
const router = new InteractionRouter(MODULES);
const originalKey = youtubeConfig.key;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const item = (id: string, title: string) => ({ id: { videoId: id }, snippet: { title, channelTitle: 'Some &amp; Channel', thumbnails: { medium: { url: `https://i.ytimg.com/${id}.jpg` } } } });
const failure = (status: number, reason: string) => json({ error: { errors: [{ reason }] } }, status);

beforeAll(() => { vi.spyOn(Cooldown.prototype, 'allow').mockReturnValue(0); });
afterAll(() => { vi.restoreAllMocks(); });
beforeEach(() => { youtubeConfig.key = () => KEY; });
afterEach(() => { youtubeConfig.key = originalKey; vi.unstubAllGlobals(); });

function world() {
  const guild = setupGuild();
  fakeChannel(guild, '600000000000000001');
  const owner = fakeMember(guild, guild.ownerId, { position: 40 });
  const me = fakeMember(guild, guild.client.user.id, { position: 30, bot: true });
  guild.members.me = me;
  const voice: any = fakeChannel(guild, VOICE, { type: ChannelType.GuildVoice, name: 'Lounge' });
  voice.createInvite = vi.fn(async () => ({ url: 'https://discord.gg/activity-code' }));
  owner.voice = { channel: voice, channelId: VOICE };
  return { guild, owner, voice };
}
type World = ReturnType<typeof world>;

const slash = async (w: World, options: Record<string, unknown> = {}) => {
  const i = commandInteraction(w.guild, 'youtube', null, options, { member: w.owner });
  await router.handle(i);
  return JSON.stringify(i.editReply.mock.calls.at(-1)?.[0] ?? i.reply.mock.calls.at(-1)?.[0] ?? i.followUp.mock.calls.at(-1)?.[0]);
};
const typed = async (w: World, content: string) => {
  const message: any = { content, inGuild: () => true, author: { id: w.owner.id, bot: false }, webhookId: null, guild: w.guild, member: w.owner, channel: { id: '600000000000000001', sendTyping: vi.fn(async () => undefined) }, reply: vi.fn(async () => undefined) };
  await (musicModule.events!.find((e) => e.event === 'messageCreate')!.run as any)(message);
  return JSON.stringify(message.reply.mock.calls[0]?.[0]);
};
const press = async (w: World, member: any = w.owner) => {
  const i = componentInteraction(w.guild, 'button', 'youtube:together', { member });
  Object.assign(i, { isAutocomplete: () => false, isChatInputCommand: () => false });
  await router.handle(i);
  return JSON.stringify(i.reply.mock.calls.at(-1)?.[0]);
};

describe('YouTube search', () => {
  it('searches with / and v!, with links, tidy titles and the Watch Together button', async () => {
    const f = vi.fn(async () => json({ items: [item('abc123', 'Rock &amp; Roll &#39;Live&#39;'), item('def456', 'Second')] }));
    vi.stubGlobal('fetch', f);
    const w = world();
    for (const reply of [await slash(w, { search: 'rock music' }), await typed(w, 'v!youtube rock music'), await typed(w, 'v!yt rock music')]) {
      expect(reply).toContain('https://www.youtube.com/watch?v=abc123');
      expect(reply).toContain("Rock & Roll 'Live'");
      expect(reply).toContain('Some & Channel');
      expect(reply).toContain('https://i.ytimg.com/abc123.jpg');
      expect(reply).toContain('youtube:together');
      expect(reply).not.toContain(KEY);
    }
    const url = new URL(String((f.mock.calls[0] as any)[0]));
    expect(url.hostname).toBe('www.googleapis.com');
    expect(url.searchParams.get('q')).toBe('rock music');
    expect(url.searchParams.get('type')).toBe('video');
    expect(url.searchParams.get('key')).toBe(KEY);
  });

  it('explains a missing key, and asks nothing of Google', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    youtubeConfig.key = () => undefined;
    expect(await slash(world(), { search: 'x' })).toMatch(/YOUTUBE_API_KEY/);
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'quotaExceeded', /daily limit/], [400, 'keyInvalid', /rejected the search key/], [403, 'accessNotConfigured', /rejected the search key/], [500, 'backendError', /not responding/],
  ])('explains error %i %s without showing the key', async (status, reason, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => failure(status, reason)));
    const reply = await slash(world(), { search: 'x' });
    expect(reply).toMatch(expected);
    expect(reply).not.toContain(KEY);
  });

  it('handles a network failure, and no results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(`failed: key=${KEY}`); }));
    const down = await slash(world(), { search: 'x' });
    expect(down).toMatch(/not responding/);
    expect(down).not.toContain(KEY);
    await expect(searchYoutube('x')).rejects.toThrow(/not responding/);
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [] })));
    expect(await slash(world(), { search: 'nothing here' })).toMatch(/found nothing/);
  });

  it('with no search, just offers Watch Together and needs no key', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    youtubeConfig.key = () => undefined;
    const reply = await slash(world());
    expect(reply).toContain('youtube:together');
    expect(f).not.toHaveBeenCalled();
  });

  it('direct audio handling still refuses YouTube, so its audio can never be opened', async () => {
    await expect(resolveTrack('https://youtu.be/abc', 'u1')).rejects.toThrow(/YouTube.*not supported.*\/youtube/);
  });
});

describe('Watch Together button', () => {
  it("creates Discord's activity invite in your voice channel", async () => {
    const w = world();
    const reply = await press(w);
    expect(reply).toContain('https://discord.gg/activity-code');
    expect(reply).toContain('Join Watch Together');
    expect(w.voice.createInvite).toHaveBeenCalledWith({ targetType: InviteTargetType.EmbeddedApplication, targetApplication: '880218394199220334', maxAge: 3600 });
  });

  it('needs a regular voice channel and the permission to invite', async () => {
    const w = world();
    w.owner.voice = { channel: null, channelId: null };
    expect(await press(w)).toMatch(/Join a voice channel first/);
    const stage = world();
    stage.voice.type = ChannelType.GuildStageVoice;
    expect(await press(stage)).toMatch(/regular voice channel/);
    const noPerms = world();
    noPerms.voice.permissionsFor = () => new PermissionsBitField([PermissionsBitField.Flags.ViewChannel]);
    expect(await press(noPerms)).toMatch(/Create Invite/);
    expect(noPerms.voice.createInvite).not.toHaveBeenCalled();
  });

  it('gives a clean message if Discord refuses', async () => {
    const w = world();
    w.voice.createInvite = vi.fn(async () => { throw Object.assign(new Error('Unknown Application'), { code: 10002 }); });
    expect(await press(w)).toMatch(/would not start Watch Together/);
  });

  it('follows the dashboard switch for /youtube, including old buttons', async () => {
    const w = world();
    await updateConfig(w.guild.id, 'commands', { disabled: ['youtube'] });
    expect(await slash(w, { search: 'x' })).toMatch(/turned off/);
    expect(await typed(w, 'v!yt x')).toMatch(/turned off/);
    expect(await press(w)).toMatch(/turned off/);
    expect(w.voice.createInvite).not.toHaveBeenCalled();
  });
});
