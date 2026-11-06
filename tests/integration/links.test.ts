import { ChannelType, Collection, PermissionsBitField } from 'discord.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractionRouter } from '../../src/core/interactions.js';
import { Cooldown } from '../../src/core/rateLimit.js';
import { MODULES } from '../../src/core/registry.js';
import { closeAllMusic, runtime } from '../../src/modules/music/index.js';
import { forgetSpotifyToken, parseLink, resolveLinked, resolvePlayable, spotifyConfig } from '../../src/modules/music/links.js';
import type { VoiceLink } from '../../src/modules/music/player.js';
import { cleanSongTitle, isConfidentMatch, readVideoTitle } from '../../src/modules/music/sources.js';
import { parseIsoDuration, youtubeConfig } from '../../src/modules/music/youtube.js';
import { useDatabase } from '../helpers/db.js';
import { fakeChannel, fakeMember } from '../helpers/fakes.js';
import { commandInteraction, setupGuild } from '../helpers/interaction.js';
import { PassThrough } from 'node:stream';

/** YouTube, Spotify and Audius are faked here. Real requests with real keys still need testing. */
useDatabase();

const YT_KEY = 'yt-secret-key-never-show';
const SP_SECRET = 'spotify-secret-never-show';
const SPOTIFY_ID = '4uLU6hMCjMI75M1A2tKUQC';
const originalKey = youtubeConfig.key;
const originalSpotify = spotifyConfig.credentials;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const audius = (title: string, artist: string, duration = 200, over: object = {}) => ({ id: words(title), title, duration, permalink: `/a/${words(title)}`, user: { name: artist }, artwork: null, is_streamable: true, is_available: true, is_delete: false, is_stream_gated: false, stream_conditions: null, ...over });
const words = (s: string) => s.toLowerCase().replace(/\W+/g, '-');

interface Routes { videos?: unknown; playlists?: unknown; playlistItems?: unknown; audius?: unknown[]; token?: Response; track?: Response }
function stub(routes: Routes) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/youtube/v3/videos')) return json(routes.videos ?? { items: [] });
    if (url.includes('/youtube/v3/playlists')) return json(routes.playlists ?? { items: [] });
    if (url.includes('/youtube/v3/playlistItems')) return json(routes.playlistItems ?? { items: [] });
    if (url.includes('accounts.spotify.com')) return routes.token ?? json({ access_token: 'tok', expires_in: 3600 });
    if (url.includes('api.spotify.com')) return routes.track ?? json({ name: 'Night Drive', artists: [{ name: 'Nova' }], duration_ms: 200_000, external_urls: { spotify: `https://open.spotify.com/track/${SPOTIFY_ID}` } });
    if (url.includes('audius.co')) return json({ data: routes.audius ?? [] });
    throw new Error(`Unexpected request ${url}`);
  }));
  return calls;
}
const THUMB = 'https://i.ytimg.com/vi/x/hqdefault.jpg';
const video = (title: string, channel = 'Nova', duration = 'PT3M20S') => ({ items: [{ snippet: { title, channelTitle: channel, thumbnails: { high: { url: THUMB } } }, contentDetails: { duration } }] });

beforeAll(() => { vi.spyOn(Cooldown.prototype, 'allow').mockReturnValue(0); });
afterAll(() => { vi.restoreAllMocks(); });
beforeEach(() => {
  youtubeConfig.key = () => YT_KEY;
  spotifyConfig.credentials = () => ({ id: 'client', secret: SP_SECRET });
  forgetSpotifyToken();
});
afterEach(() => {
  closeAllMusic();
  youtubeConfig.key = originalKey;
  spotifyConfig.credentials = originalSpotify;
  runtime.deps = {};
  vi.unstubAllGlobals();
});

describe('recognising links', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube-video'], ['https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s', 'youtube-video'], ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube-video'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=x', 'youtube-video'], ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'youtube-video'], ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'youtube-video'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'youtube-video'], ['https://www.youtube.com/live/dQw4w9WgXcQ', 'youtube-video'], ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghij', 'youtube-video'],
  ])('reads %s as a video', (link, kind) => expect(parseLink(link)).toEqual({ kind, id: 'dQw4w9WgXcQ' }));

  it('reads playlists and Spotify tracks', () => {
    expect(parseLink('https://www.youtube.com/playlist?list=PLabcdefghij')).toEqual({ kind: 'youtube-playlist', id: 'PLabcdefghij' });
    expect(parseLink(`https://open.spotify.com/track/${SPOTIFY_ID}?si=abc`)).toEqual({ kind: 'spotify-track', id: SPOTIFY_ID });
    expect(parseLink(`https://open.spotify.com/intl-fr/track/${SPOTIFY_ID}`)).toEqual({ kind: 'spotify-track', id: SPOTIFY_ID });
    expect(parseLink(`spotify:track:${SPOTIFY_ID}`)).toEqual({ kind: 'spotify-track', id: SPOTIFY_ID });
    expect(parseLink(`https://open.spotify.com/album/${SPOTIFY_ID}`)).toEqual({ kind: 'spotify-album', id: SPOTIFY_ID });
    expect(parseLink(`https://open.spotify.com/intl-de/playlist/${SPOTIFY_ID}?si=x`)).toEqual({ kind: 'spotify-playlist', id: SPOTIFY_ID });
    expect(parseLink(`spotify:album:${SPOTIFY_ID}`)).toEqual({ kind: 'spotify-album', id: SPOTIFY_ID });
  });

  it('leaves everything else alone', () => {
    for (const input of ['lofi beats', 'https://example.com/a.mp3', 'https://audius.co/a/b', 'https://notyoutube.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ']) expect(parseLink(input), input).toBeNull();
  });

  it.each([
    ['https://www.youtube.com/watch?v=short', /valid video/], ['https://www.youtube.com/watch', /valid video/], ['https://youtu.be/', /valid video/], ['https://www.youtube.com/playlist', /valid playlist/], ['https://www.youtube.com/@channel', /video or playlist/],
    [`https://open.spotify.com/artist/${SPOTIFY_ID}`, /track, album and playlist/], ['https://open.spotify.com/track/bad', /valid track/], ['https://open.spotify.com/album/bad', /valid album/], ['https://open.spotify.com/playlist/bad', /valid playlist/], ['https://spotify.link/abc', /full/],
  ])('explains what is wrong with %s', (link, message) => expect(() => parseLink(link)).toThrow(message));
});

describe('reading song details', () => {
  it('tidies video titles and finds the artist', () => {
    expect(readVideoTitle('Nova - Night Drive (Official Music Video)', 'NovaVEVO')).toEqual({ artist: 'Nova', title: 'Night Drive' });
    expect(readVideoTitle('Night Drive [Lyrics]', 'Nova - Topic')).toEqual({ artist: 'Nova', title: 'Night Drive' });
    expect(readVideoTitle('Night Drive', 'NovaVEVO').artist).toBe('Nova');
    expect(cleanSongTitle('Song ft. Someone')).toBe('Song');
    expect(cleanSongTitle('Song (feat. Someone) [4K]')).toBe('Song');
    expect(cleanSongTitle('Song (Remix)')).toBe('Song (Remix)');
  });
  it.each([['PT3M20S', 200], ['PT1H2M3S', 3723], ['PT45S', 45], ['P1DT1S', 86_401], ['P0D', null], ['', null]])('reads length %s', (text, seconds) => expect(parseIsoDuration(text)).toBe(seconds));
});

describe('only a confident match plays', () => {
  const song = { title: 'Night Drive', artist: 'Nova', durationSec: 200, url: 'x' };
  const c = (title: string, artist = 'Nova', durationSec: number | null = 200) => ({ title, artist, durationSec });
  it('accepts the same song', () => {
    for (const candidate of [c('Night Drive'), c('NIGHT DRIVE!'), c('Night Drive (Official Audio)'), c('Nova - Night Drive'), c('Night Drive', 'nova'), c('Night Drive', 'Nova', null), c('Night Drive', 'Nova', 210), c('Night Drive', 'DJ Nova')]) expect(isConfidentMatch(song, candidate), JSON.stringify(candidate)).toBe(true);
  });
  it('rejects anything that could be a different recording', () => {
    for (const candidate of [c('Night Drive', 'Someone Else'), c('Morning Drive'), c('Night Drive Remix'), c('Night Drive (Live)'), c('Night Drive Cover'), c('Night Drive Type Beat'), c('Night Drive Instrumental'), c('Night Drive Slowed'), c('Night Drive Mix Vol 2'), c('Night'), c('Night Drive', 'Nova', 400)]) expect(isConfidentMatch(song, candidate), JSON.stringify(candidate)).toBe(false);
    expect(isConfidentMatch({ ...song, artist: null }, c('Night Drive'))).toBe(false);
  });
  it('keeps a remix when a remix is what was asked for', () => {
    expect(isConfidentMatch({ ...song, title: 'Night Drive (Remix)' }, c('Night Drive Remix'))).toBe(true);
  });
});

describe('resolving links', () => {
  it('YouTube: reads details from the API, and plays a match from the permitted source', async () => {
    const calls = stub({ videos: video('Nova - Night Drive (Official Video)'), audius: [audius('Unrelated Song', 'Nova'), audius('Night Drive', 'Nova')] });
    const result = await resolveLinked('https://youtu.be/dQw4w9WgXcQ', 'u1');
    expect(result).toMatchObject({ service: 'YouTube', label: 'Night Drive by Nova', total: 1, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(result!.tracks[0]).toMatchObject({ source: 'audius', title: 'Night Drive', artist: 'Nova', requestedById: 'u1' });
    expect(result!.tracks[0]!.url).toContain('api.audius.co');
    expect(calls.join(' ')).not.toContain('googlevideo');
  });

  it('never accepts a track the owner gated', async () => {
    stub({ videos: video('Nova - Night Drive'), audius: [audius('Night Drive', 'Nova', 200, { is_stream_gated: true })] });
    expect((await resolveLinked('https://youtu.be/dQw4w9WgXcQ', 'u1'))!.tracks).toEqual([]);
  });

  it('reports no match rather than playing something else', async () => {
    stub({ videos: video('Famous Artist - Big Hit'), audius: [audius('Big Hit', 'Random Uploader'), audius('Big Hit Cover', 'Famous Artist')] });
    expect(await resolveLinked('https://youtu.be/dQw4w9WgXcQ', 'u1')).toMatchObject({ label: 'Big Hit by Famous Artist', tracks: [], total: 1 });
  });

  it('reports a video that has gone', async () => {
    stub({ videos: { items: [] } });
    await expect(resolveLinked('https://youtu.be/dQw4w9WgXcQ', 'u1')).rejects.toThrow(/unavailable/);
  });

  it('treats a bare ID as a video only if YouTube knows it, otherwise as a song name', async () => {
    stub({ videos: video('Nova - Night Drive'), audius: [audius('Night Drive', 'Nova')] });
    expect((await resolveLinked('dQw4w9WgXcQ', 'u1'))!.service).toBe('YouTube');
    stub({ videos: { items: [] } });
    expect(await resolveLinked('Imagination', 'u1')).toBeNull();
    stub({});
    expect(await resolveLinked('two words', 'u1')).toBeNull();
    youtubeConfig.key = () => undefined;
    const calls = stub({});
    expect(await resolveLinked('dQw4w9WgXcQ', 'u1')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('YouTube playlists: matches each song, skipping hidden ones and those with no source', async () => {
    const entry = (id: string, title: string) => ({ snippet: { title, videoOwnerChannelTitle: 'Nova', resourceId: { videoId: id } } });
    stub({
      playlists: { items: [{ snippet: { title: 'Road Trip &amp; More' } }] },
      playlistItems: { pageInfo: { totalResults: 40 }, items: [entry('aaaaaaaaaaa', 'Night Drive'), entry('bbbbbbbbbbb', 'Private video'), entry('ccccccccccc', 'Unknown Hit')] },
      videos: { items: [{ id: 'aaaaaaaaaaa', contentDetails: { duration: 'PT3M20S' } }, { id: 'ccccccccccc', contentDetails: { duration: 'PT3M' } }] },
      audius: [audius('Night Drive', 'Nova')],
    });
    const result = await resolveLinked('https://www.youtube.com/playlist?list=PLabcdefghij', 'u1');
    expect(result).toMatchObject({ label: 'Road Trip & More', total: 2, beyondLimit: 38 });
    expect(result!.tracks.map((t) => t.title)).toEqual(['Night Drive']);
  });

  it('explains an empty or private playlist', async () => {
    stub({ playlistItems: { items: [] } });
    await expect(resolveLinked('https://www.youtube.com/playlist?list=PLabcdefghij', 'u1')).rejects.toThrow(/empty or unavailable/);
  });

  it('Spotify: reads the title and artist, then plays a match', async () => {
    const calls = stub({ audius: [audius('Night Drive', 'Nova')] });
    const result = await resolveLinked(`https://open.spotify.com/track/${SPOTIFY_ID}`, 'u1');
    expect(result).toMatchObject({ service: 'Spotify', label: 'Night Drive by Nova', total: 1 });
    expect(result!.tracks[0]!.source).toBe('audius');
    // The login is reused rather than repeated.
    await resolveLinked(`https://open.spotify.com/track/${SPOTIFY_ID}`, 'u1');
    expect(calls.filter((u) => u.includes('accounts.spotify.com'))).toHaveLength(1);
  });

  const spotifyRoutes = (routes: Record<string, () => Response>, tracks: unknown[] = []) => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('accounts.spotify.com')) return json({ access_token: 'tok', expires_in: 3600 });
      if (url.includes('audius.co')) return json({ data: tracks });
      const path = url.split('/v1/')[1]!.split('?')[0]!;
      return routes[path]?.() ?? json({}, 404);
    }));
    return calls;
  };
  const sp = (name: string, ms = 200_000, type = 'track') => ({ type, name, artists: [{ name: 'Nova' }], duration_ms: ms, id: words(name), external_urls: { spotify: `https://open.spotify.com/track/${words(name)}` } });

  it('Spotify albums: reads each song and adds those with a match, with the cover', async () => {
    const calls = spotifyRoutes({
      [`albums/${SPOTIFY_ID}`]: () => json({ name: 'Road Album', images: [{ url: 'https://i.scdn.co/album.jpg' }] }),
      [`albums/${SPOTIFY_ID}/tracks`]: () => json({ total: 30, items: [sp('Night Drive'), sp('Unknown Hit')] }),
    }, [audius('Night Drive', 'Nova')]);
    const result = await resolveLinked(`https://open.spotify.com/album/${SPOTIFY_ID}`, 'u1');
    expect(result).toMatchObject({ service: 'Spotify', label: 'Road Album', thumbnail: 'https://i.scdn.co/album.jpg', total: 2, beyondLimit: 28 });
    expect(result!.tracks.map((t) => t.title)).toEqual(['Night Drive']);
    expect(calls.find((c) => c.includes('/tracks?'))).toContain('limit=25');
  });

  it('Spotify playlists: reads the new item format, the old one, and skips podcasts', async () => {
    for (const items of [[{ item: sp('Night Drive') }, { item: sp('A Podcast', 100, 'episode') }, { item: null }], [{ track: sp('Night Drive') }]]) {
      forgetSpotifyToken();
      spotifyRoutes({ [`playlists/${SPOTIFY_ID}`]: () => json({ name: 'My Mix', images: [] }), [`playlists/${SPOTIFY_ID}/items`]: () => json({ total: items.length, items }) }, [audius('Night Drive', 'Nova')]);
      const result = await resolveLinked(`https://open.spotify.com/playlist/${SPOTIFY_ID}`, 'u1');
      expect(result).toMatchObject({ label: 'My Mix', total: 1 });
      expect(result!.tracks.map((t) => t.title)).toEqual(['Night Drive']);
    }
  });

  it("Spotify playlists: explains when Spotify won't share the songs", async () => {
    for (const items of [() => json({}, 403), () => json({ items: [] })]) {
      forgetSpotifyToken();
      spotifyRoutes({ [`playlists/${SPOTIFY_ID}`]: () => json({ name: 'Top Hits' }), [`playlists/${SPOTIFY_ID}/items`]: items });
      await expect(resolveLinked(`https://open.spotify.com/playlist/${SPOTIFY_ID}`, 'u1')).rejects.toThrow(/won't share the songs in \*\*Top Hits\*\*/);
    }
  });

  it('Spotify: names the Premium requirement when Spotify gives it as the reason', async () => {
    const refusal = () => new Response('Active premium subscription required for the owner of the app.', { status: 403 });
    for (const path of ['track', 'album', 'playlist']) {
      forgetSpotifyToken();
      spotifyRoutes({ [`tracks/${SPOTIFY_ID}`]: refusal, [`albums/${SPOTIFY_ID}`]: refusal, [`playlists/${SPOTIFY_ID}`]: refusal });
      await expect(resolveLinked(`https://open.spotify.com/${path}/${SPOTIFY_ID}`, 'u1')).rejects.toThrow(/needs an active Premium subscription/);
    }
  });

  it('Spotify: explains every kind of failure without showing secrets', async () => {
    const link = `https://open.spotify.com/track/${SPOTIFY_ID}`;
    spotifyConfig.credentials = () => null;
    await expect(resolveLinked(link, 'u1')).rejects.toThrow(/SPOTIFY_CLIENT_ID/);
    spotifyConfig.credentials = () => ({ id: 'client', secret: SP_SECRET });
    for (const [routes, message] of [
      [{ token: json({}, 400) }, /rejected/], [{ token: json({}, 503) }, /not responding/],
      [{ track: json({}, 404) }, /could not be found/], [{ track: json({}, 403) }, /does not allow/], [{ track: json({}, 429) }, /limiting/], [{ track: json({}, 500) }, /not responding/],
    ] as Array<[Routes, RegExp]>) {
      forgetSpotifyToken();
      stub(routes);
      const error: Error = await resolveLinked(link, 'u1').then(() => { throw new Error('should fail'); }, (e) => e);
      expect(error.message).toMatch(message);
      expect(error.message).not.toContain(SP_SECRET);
    }
  });

  it('never shows the YouTube key when YouTube fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { errors: [{ reason: 'keyInvalid' }] } }, 400)));
    const error: Error = await resolveLinked('https://youtu.be/dQw4w9WgXcQ', 'u1').catch((e) => e) as Error;
    expect(error.message).toMatch(/rejected/);
    expect(error.message).not.toContain(YT_KEY);
  });
});

describe('song names', () => {
  const search = (items: unknown[]) => ({ items });
  const hit = (id: string, title: string, channelTitle: string) => ({ id: { videoId: id }, snippet: { title, channelTitle, thumbnails: { medium: { url: 'https://i.ytimg.com/t.jpg' } } } });
  const withSearch = (items: unknown[], tracks: unknown[]) => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = String(input);
      calls.push(url);
      return url.includes('/youtube/v3/search') ? json(search(items)) : json({ data: tracks });
    }));
    return calls;
  };

  it('uses YouTube to find the exact song, then plays it from the permitted source', async () => {
    const calls = withSearch([hit('aaaaaaaaaaa', 'Nova - Night Drive (Official Video)', 'NovaVEVO')], [audius('Night Drive Slowed', 'Nova'), audius('Night Drive', 'Nova')]);
    const track = await resolvePlayable('night drive', 'u1');
    expect(track).toMatchObject({ title: 'Night Drive', artist: 'Nova', requestedById: 'u1' });
    expect(track.note).toBeUndefined();
    expect(calls[0]).toContain('q=night+drive');
  });

  it('says so when it can only offer the closest result', async () => {
    withSearch([hit('aaaaaaaaaaa', 'Famous Artist - Big Hit', 'Famous Artist')], [audius('Big Hit Cover', 'Someone')]);
    const track = await resolvePlayable('big hit', 'u1');
    expect(track.title).toBe('Big Hit Cover');
    expect(track.note).toMatch(/may not be the song you meant/);
  });

  it('still plays when YouTube search fails or has no key', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => (String(input).includes('googleapis') ? json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403) : json({ data: [audius('Lofi Night', 'Someone')] }))));
    expect((await resolvePlayable('lofi', 'u1')).title).toBe('Lofi Night');
    youtubeConfig.key = () => undefined;
    const calls = stub({ audius: [audius('Lofi Night', 'Someone')] });
    expect((await resolvePlayable('lofi', 'u1')).title).toBe('Lofi Night');
    expect(calls.join(' ')).not.toContain('googleapis');
  });

  it('does not search YouTube for direct audio links', async () => {
    const calls = stub({});
    await expect(resolvePlayable('https://www.youtube.com/watch?v=x', 'u1')).rejects.toThrow(/not supported/);
    expect(calls).toEqual([]);
  });
});

describe('/play with links, through the real router', () => {
  const router = new InteractionRouter(MODULES);
  const VOICE = '600000000000000081';
  function world() {
    const guild = setupGuild();
    const text = fakeChannel(guild, '600000000000000001');
    text.send = vi.fn(async () => ({ id: 'm', edit: vi.fn(async () => undefined) }));
    const owner = fakeMember(guild, guild.ownerId, { position: 40 });
    guild.members.me = fakeMember(guild, guild.client.user.id, { position: 30, bot: true });
    owner.voice = { channelId: VOICE, channel: { id: VOICE, type: ChannelType.GuildVoice, joinable: true, members: new Collection(), permissionsFor: () => new PermissionsBitField(PermissionsBitField.All) } };
    return { guild, owner };
  }
  const silent = () => ({ pcm: new PassThrough(), failed: () => false, failure: () => null, closed: new Promise<void>(() => {}), onInfo: () => {}, kill: () => {} });
  const useFakes = () => {
    const join = vi.fn(async (channelId: string): Promise<VoiceLink> => ({ channelId, subscribe: vi.fn(), move: vi.fn(), destroy: vi.fn() }));
    runtime.deps = { join, open: silent, playWithoutListeners: true } as any;
    return join;
  };
  const play = async (w: ReturnType<typeof world>, song: string) => {
    const i = commandInteraction(w.guild, 'play', null, { song }, { member: w.owner });
    await router.handle(i);
    return JSON.stringify(i.editReply.mock.calls.at(-1)?.[0] ?? i.reply.mock.calls.at(-1)?.[0] ?? i.followUp.mock.calls.at(-1)?.[0]);
  };

  it('plays a match and says where the link came from', async () => {
    const join = useFakes();
    stub({ videos: video('Nova - Night Drive'), audius: [audius('Night Drive', 'Nova')] });
    const reply = await play(world(), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(reply).toContain('Night Drive');
    expect(reply).toMatch(/Matched from your YouTube link/);
    expect(reply).toContain(THUMB);
    expect(reply).toContain('3:20');
    expect(join).toHaveBeenCalledOnce();
  });

  it('with no match, stays out of voice and explains, with no Watch Together or link', async () => {
    const join = useFakes();
    stub({ videos: video('Famous Artist - Big Hit') });
    const reply = await play(world(), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(reply).toContain('Big Hit by Famous Artist');
    expect(reply).toMatch(/can't be played.*doesn't allow bots to play its audio.*Nothing was added/);
    expect(reply).not.toContain('youtube:together');
    expect(reply).not.toContain('Watch Together');
    expect(reply).not.toContain('youtube.com/watch');
    expect(reply).not.toContain('"components"');
    expect(reply).toContain(THUMB);
    expect(reply).toContain('3:20');
    expect(join).not.toHaveBeenCalled();
  });

  it('adds what it can from a playlist and reports the rest', async () => {
    useFakes();
    const entry = (id: string, title: string) => ({ snippet: { title, videoOwnerChannelTitle: 'Nova', resourceId: { videoId: id } } });
    stub({ playlists: { items: [{ snippet: { title: 'Trip' } }] }, playlistItems: { pageInfo: { totalResults: 2 }, items: [entry('aaaaaaaaaaa', 'Night Drive'), entry('ccccccccccc', 'Unknown Hit')] }, videos: { items: [] }, audius: [audius('Night Drive', 'Nova')] });
    const reply = await play(world(), 'https://www.youtube.com/playlist?list=PLabcdefghij');
    expect(reply).toMatch(/1 of 2/);
    expect(reply).toContain('Trip');
  });

  it('needs a voice channel before reading any link', async () => {
    useFakes();
    const calls = stub({ videos: video('Nova - Night Drive') });
    const w = world();
    w.owner.voice = { channelId: null, channel: null };
    expect(await play(w, 'https://youtu.be/dQw4w9WgXcQ')).toMatch(/Join a voice channel first/);
    expect(calls).toEqual([]);
  });

  it('reports a removed video clearly', async () => {
    const join = useFakes();
    stub({ videos: { items: [] } });
    expect(await play(world(), 'https://youtu.be/dQw4w9WgXcQ')).toMatch(/unavailable/);
    expect(join).not.toHaveBeenCalled();
  });

  it('shows a clear error for a bad link, without joining voice', async () => {
    const join = useFakes();
    expect(await play(world(), 'https://www.youtube.com/watch?v=nope')).toMatch(/valid video/);
    expect(join).not.toHaveBeenCalled();
  });
});
