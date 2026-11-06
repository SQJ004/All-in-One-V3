import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { AudioPlayerStatus, VoiceConnectionDisconnectReason, VoiceConnectionStatus } from '@discordjs/voice';
import { ChannelType, Collection, PermissionsBitField } from 'discord.js';
import ffmpegStatic from 'ffmpeg-static';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getConfig, updateConfig } from '../../src/core/configService.js';
import { InteractionRouter } from '../../src/core/interactions.js';
import { Cooldown } from '../../src/core/rateLimit.js';
import { UserError } from '../../src/core/types.js';
import { MODULES } from '../../src/core/registry.js';
import { isPrivateAddress, openStream } from '../../src/modules/music/http.js';
import { closeAllMusic, musicModule, playerPayload, runtime } from '../../src/modules/music/index.js';
import { openAudio } from '../../src/modules/music/pipeline.js';
import { formatTime, GuildPlayer, parseTime, type PlayerDeps, type VoiceLink } from '../../src/modules/music/player.js';
import { MAX_QUEUE, MusicQueue, type Track } from '../../src/modules/music/queue.js';
import { findLyrics, resolveTrack } from '../../src/modules/music/sources.js';
import { superviseConnection } from '../../src/modules/music/voice.js';
import { useDatabase } from '../helpers/db.js';
import { fakeChannel, fakeMember } from '../helpers/fakes.js';
import { commandInteraction, componentInteraction, setupGuild } from '../helpers/interaction.js';

/**
 * Real audio goes through the real decoder and the real @discordjs/voice player, served from a
 * local web server. Only Discord's voice servers are missing, so nothing here proves sound
 * reached a voice channel: see docs/COMMAND_CHECKLIST.md.
 */
useDatabase();

/** ffmpeg cannot go back to fill in a WAV's sizes when writing to a pipe, so they are set here, as in a normal file. */
const tone = (seconds: number) => {
  const wav = execFileSync(ffmpegStatic as unknown as string, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-bitexact', '-f', 'wav', 'pipe:1'], { maxBuffer: 1 << 26 });
  const data = wav.indexOf('data');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.writeUInt32LE(wav.length - data - 8, data + 4);
  return wav;
};

let server: Server;
let base: string;
const hits = new Map<string, number>();
const seconds1 = tone(1);
const seconds30 = tone(30);

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url!.split('?')[0]!;
    const count = (hits.get(path) ?? 0) + 1;
    hits.set(path, count);
    const audio = { 'content-type': 'audio/wav' };
    if (path === '/missing') { res.writeHead(404); return res.end(); }
    if (path === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html></html>'); }
    if (path === '/moved') { res.writeHead(302, { location: '/short' }); return res.end(); }
    if (path === '/long') { res.writeHead(200, { ...audio, 'content-length': String(seconds30.length) }); return res.end(seconds30); }
    if (path === '/radio') { res.writeHead(200, audio); return res.end(seconds30); }
    if (path === '/always-breaks' || (path === '/breaks-once' && count === 1)) {
      res.writeHead(200, { ...audio, 'content-length': String(seconds1.length) });
      res.write(seconds1.subarray(0, 40_000));
      setTimeout(() => res.destroy(), 30);
      return;
    }
    res.writeHead(200, audio);
    res.end(seconds1);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

let made: GuildPlayer[] = [];
afterEach(() => {
  closeAllMusic();
  runtime.deps = {};
  for (const p of made) p.close();
  made = [];
  hits.clear();
  vi.unstubAllGlobals();
});

const track = (key: string, path = '/short', durationSec: number | null = 1): Track => ({ key, title: `Song ${key}`, artist: `Artist ${key}`, url: `${base}${path}`, durationSec, artwork: null, pageUrl: null, source: 'audius', requestedById: '700000000000000001' });

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${check}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const fakeLink = (channelId = 'voice-1'): VoiceLink => ({ channelId, subscribe: vi.fn(), move: vi.fn(function (this: VoiceLink, next: string) { this.channelId = next; }), destroy: vi.fn() });

function makePlayer(overrides: Partial<PlayerDeps> = {}, volume = 60, guildId = 'guild-a') {
  const deps = {
    join: vi.fn(async (channelId: string) => fakeLink(channelId)), open: (t: Track, offset: number) => openAudio(t, offset, { allowPrivate: true }),
    changed: vi.fn(), notify: vi.fn(), closed: vi.fn(), idleMs: 60_000, retryDelayMs: 30, playWithoutListeners: true, ...overrides,
  };
  const player = new GuildPlayer(guildId, deps, volume);
  made.push(player);
  return { player, deps };
}

const playing = (p: GuildPlayer) => p.audio.state.status === AudioPlayerStatus.Playing;

describe('playback through the real decoder and audio player', () => {
  it('plays a song, plays the next automatically, then empties the queue', async () => {
    const { player } = makePlayer();
    expect(player.enqueue(track('a'))).toBe(0);
    expect(player.enqueue(track('b'))).toBe(1);
    await waitFor(() => playing(player));
    expect(player.queue.current?.key).toBe('a');
    await waitFor(() => player.queue.current?.key === 'b');
    expect(player.queue.upcoming).toEqual([]);
    expect(player.queue.history.map((t) => t.key)).toEqual(['a']);
    await waitFor(() => player.queue.current === null);
    expect(player.audio.state.status).toBe(AudioPlayerStatus.Idle);
  }, 20_000);

  it('pauses, holding its position, and resumes', async () => {
    const { player } = makePlayer();
    player.enqueue(track('a', '/long', 30));
    await waitFor(() => player.positionSec >= 1);
    player.pause();
    expect(player.paused).toBe(true);
    const held = player.positionSec;
    await new Promise((r) => setTimeout(r, 1200));
    expect(player.positionSec).toBe(held);
    expect(() => player.pause()).toThrow(/already paused/);
    player.resume();
    expect(player.paused).toBe(false);
    await waitFor(() => player.positionSec > held);
    expect(() => player.resume()).toThrow(/not paused/);
  }, 20_000);

  it('says so if pause is pressed while a song is loading, rather than claiming it paused', () => {
    const { player } = makePlayer();
    player.enqueue(track('a', '/long', 30));
    expect(player.audio.state.status).toBe(AudioPlayerStatus.Buffering);
    expect(() => player.pause()).toThrow(/still loading/);
    expect(player.paused).toBe(false);
  });

  it('skips to the next song, and stops playing when none is left', async () => {
    const { player } = makePlayer();
    player.enqueue(track('a', '/long', 30));
    player.enqueue(track('b', '/long', 30));
    await waitFor(() => playing(player));
    expect(player.skip().key).toBe('a');
    expect(player.queue.current?.key).toBe('b');
    await waitFor(() => playing(player));
    player.skip();
    expect(player.queue.current).toBeNull();
    expect(() => player.skip()).toThrow(/Nothing is playing/);
  }, 20_000);

  it('stop clears everything and does not start another song', async () => {
    const { player } = makePlayer();
    player.enqueue(track('a', '/long', 30));
    player.enqueue(track('b'));
    await waitFor(() => playing(player));
    player.stop();
    expect(player.queue.current).toBeNull();
    expect(player.queue.upcoming).toEqual([]);
    await new Promise((r) => setTimeout(r, 300));
    expect(player.audio.state.status).toBe(AudioPlayerStatus.Idle);
    expect(hits.get('/short')).toBeUndefined();
  }, 20_000);

  it('goes back to the previous song, keeping the current one next', async () => {
    const { player } = makePlayer();
    expect(() => player.previous()).toThrow(/no previous/);
    player.enqueue(track('a', '/long', 30));
    player.enqueue(track('b', '/long', 30));
    await waitFor(() => playing(player));
    player.skip();
    expect(player.previous().key).toBe('a');
    expect(player.queue.current?.key).toBe('a');
    expect(player.queue.upcoming[0]?.key).toBe('b');
    await waitFor(() => playing(player));
  }, 20_000);

  it('seeks within a song, and refuses when it cannot', async () => {
    const { player } = makePlayer();
    player.enqueue(track('a', '/long', 30));
    await waitFor(() => playing(player));
    player.seek(20);
    expect(player.positionSec).toBeGreaterThanOrEqual(20);
    await waitFor(() => playing(player) && player.positionSec >= 21);
    expect(() => player.seek(30)).toThrow(/within the song/);
    player.queue.current!.durationSec = null;
    expect(() => player.seek(5)).toThrow(/no known length/);
  }, 20_000);

  it('changes the volume of the song playing, and uses it for the next', async () => {
    const { player } = makePlayer({}, 40);
    player.enqueue(track('a', '/long', 30));
    player.enqueue(track('b', '/long', 30));
    await waitFor(() => playing(player));
    const active = () => (player.audio.state as any).resource.volume.volume;
    expect(active()).toBeCloseTo(0.4);
    player.setVolume(25);
    expect(active()).toBeCloseTo(0.25);
    player.skip();
    await waitFor(() => playing(player));
    expect(active()).toBeCloseTo(0.25);
  }, 20_000);

  it('loops one song until loop is turned off', async () => {
    const { player } = makePlayer();
    player.enqueue(track('a'));
    player.enqueue(track('b', '/other'));
    expect(player.toggleLoop()).toBe(true);
    await waitFor(() => (hits.get('/short') ?? 0) >= 2);
    expect(player.queue.current?.key).toBe('a');
    expect(hits.get('/other')).toBeUndefined();
    expect(player.toggleLoop()).toBe(false);
    await waitFor(() => player.queue.current?.key === 'b');
  }, 20_000);

  it('works out the length of a direct file, so it can be seeked', async () => {
    const { player } = makePlayer();
    player.enqueue({ ...track('a', '/long', null), source: 'direct' });
    await waitFor(() => player.queue.current?.durationSec !== null);
    expect(player.queue.current!.durationSec).toBeGreaterThanOrEqual(29);
    expect(player.queue.current!.durationSec).toBeLessThanOrEqual(31);
    await waitFor(() => playing(player));
    player.seek(15);
    expect(player.positionSec).toBeGreaterThanOrEqual(15);
  }, 20_000);

  it('leaves a stream with no size as unknown length, and refuses to seek it', async () => {
    const { player } = makePlayer();
    player.enqueue({ ...track('a', '/radio', null), source: 'direct' });
    await waitFor(() => player.positionSec >= 1);
    expect(player.queue.current!.durationSec).toBeNull();
    expect(() => player.seek(5)).toThrow(/no known length/);
  }, 20_000);
});

describe('playback failures', () => {
  it('recovers from a dropped connection by retrying', async () => {
    const { player, deps } = makePlayer();
    player.enqueue(track('a', '/breaks-once'));
    player.enqueue(track('b'));
    await waitFor(() => player.queue.current?.key === 'b');
    expect(hits.get('/breaks-once')).toBe(2);
    expect(deps.notify).not.toHaveBeenCalled();
  }, 20_000);

  it('moves on with a clear message when a song has gone', async () => {
    const { player, deps } = makePlayer();
    player.enqueue(track('a', '/missing'));
    player.enqueue(track('b'));
    await waitFor(() => player.queue.current?.key === 'b');
    expect(hits.get('/missing')).toBe(3); // the first try and two retries
    expect(deps.notify.mock.calls[0]![0]).toMatch(/could not keep playing \*\*Song a\*\*.*no longer available.*Moving on/);
  }, 20_000);

  it('does not loop a song that keeps failing', async () => {
    const { player, deps } = makePlayer();
    player.enqueue(track('a', '/always-breaks'));
    player.enqueue(track('b'));
    player.toggleLoop();
    await waitFor(() => player.queue.current?.key === 'b');
    expect(deps.notify).toHaveBeenCalledOnce();
  }, 20_000);

  it('ends cleanly when the only song cannot play', async () => {
    const { player, deps } = makePlayer();
    player.enqueue(track('a', '/missing'));
    await waitFor(() => player.queue.current === null);
    expect(deps.notify).toHaveBeenCalledOnce();
    expect(player.audio.state.status).toBe(AudioPlayerStatus.Idle);
  }, 20_000);
});

describe('servers stay independent', () => {
  it('two servers play at once without affecting each other', async () => {
    const a = makePlayer({}, 30, 'guild-a').player;
    const b = makePlayer({}, 90, 'guild-b').player;
    a.enqueue(track('a1', '/long', 30));
    a.enqueue(track('a2', '/long', 30));
    b.enqueue(track('b1', '/long', 30));
    b.enqueue(track('b2', '/long', 30));
    await waitFor(() => playing(a) && playing(b));

    a.pause();
    expect(a.paused).toBe(true);
    expect(b.paused).toBe(false);
    a.setVolume(10);
    expect(b.volume).toBe(90);
    a.toggleLoop();
    expect(b.queue.loop).toBe(false);
    b.skip();
    expect(a.queue.current?.key).toBe('a1');
    expect(b.queue.current?.key).toBe('b2');
    expect(a.queue.upcoming.map((t) => t.key)).toEqual(['a2']);
    a.stop();
    expect(a.queue.current).toBeNull();
    expect(b.queue.current?.key).toBe('b2');
    await waitFor(() => playing(b));
    const before = b.positionSec;
    await waitFor(() => b.positionSec > before);
  }, 30_000);

  it('the same song can be queued in two servers', () => {
    const a = new MusicQueue();
    const b = new MusicQueue();
    a.add(track('same'));
    expect(() => b.add(track('same'))).not.toThrow();
  });
});

describe('queue rules', () => {
  it('refuses a song already queued or playing, and a full queue', () => {
    const q = new MusicQueue();
    q.add(track('a'));
    expect(() => q.add(track('a'))).toThrow(/already in the queue/);
    q.skip();
    expect(() => q.add(track('a'))).toThrow(/already in the queue/);
    for (let n = 0; n < MAX_QUEUE; n++) q.add(track(`t${n}`));
    expect(() => q.add(track('one-more'))).toThrow(/queue is full/);
  });

  it('removes by the number shown, and rejects numbers out of range', () => {
    const q = new MusicQueue();
    expect(() => q.remove(1)).toThrow(/no upcoming songs/);
    ['a', 'b', 'c'].forEach((k) => q.add(track(k)));
    expect(q.remove(2).key).toBe('b');
    expect(q.upcoming.map((t) => t.key)).toEqual(['a', 'c']);
    expect(() => q.remove(5)).toThrow(/from 1 to 2/);
    expect(() => q.remove(0)).toThrow(/from 1 to 2/);
    expect(q.clearUpcoming()).toBe(2);
  });

  it('shuffle keeps every song and leaves the current one alone', () => {
    const q = new MusicQueue();
    q.add(track('now'));
    q.skip();
    const keys = Array.from({ length: 30 }, (_, n) => `t${n}`);
    keys.forEach((k) => q.add(track(k)));
    q.shuffle();
    expect(q.current?.key).toBe('now');
    expect(q.upcoming.map((t) => t.key)).not.toEqual(keys);
    expect(q.upcoming.map((t) => t.key).sort()).toEqual([...keys].sort());
  });

  it('remembers who asked for each song', () => {
    const q = new MusicQueue();
    q.add({ ...track('a'), requestedById: 'u1' });
    q.add({ ...track('b'), requestedById: 'u2' });
    expect(q.upcoming.map((t) => t.requestedById)).toEqual(['u1', 'u2']);
  });
});

describe('voice connection', () => {
  it('leaves after the idle timeout, and stays while music plays', async () => {
    const link = fakeLink();
    const { player, deps } = makePlayer({ idleMs: 150, join: vi.fn(async () => link) });
    await player.connect('voice-1');
    player.enqueue(track('a', '/long', 30));
    await waitFor(() => playing(player));
    await new Promise((r) => setTimeout(r, 400));
    expect(deps.closed).not.toHaveBeenCalled();
    player.stop();
    await waitFor(() => deps.closed.mock.calls.length === 1, 2000);
    expect(link.destroy).toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith(expect.stringMatching(/left voice/));
  }, 15_000);

  it('leaves an empty channel, unless someone comes back in time', async () => {
    const { player, deps } = makePlayer({ idleMs: 300 });
    await player.connect('voice-1');
    player.enqueue(track('a', '/long', 30));
    await waitFor(() => playing(player));
    player.setAlone(true);
    await new Promise((r) => setTimeout(r, 100));
    player.setAlone(false);
    await new Promise((r) => setTimeout(r, 400));
    expect(deps.closed).not.toHaveBeenCalled();
    player.setAlone(true);
    await waitFor(() => deps.closed.mock.calls.length === 1, 2000);
  }, 15_000);

  it('stops and tells people if voice is lost for good', async () => {
    let lost = () => {};
    const { player, deps } = makePlayer({ join: vi.fn(async (id: string, onLost: () => void) => { lost = onLost; return fakeLink(id); }) });
    await player.connect('voice-1');
    player.enqueue(track('a', '/long', 30));
    await waitFor(() => playing(player));
    lost();
    expect(player.queue.current).toBeNull();
    expect(deps.notify).toHaveBeenCalledWith(expect.stringMatching(/disconnected/));
    expect(deps.closed).toHaveBeenCalledOnce();
  }, 15_000);

  it('joins once when two people use /play together, and passes on join failures', async () => {
    const { player, deps } = makePlayer();
    await Promise.all([player.connect('voice-1'), player.connect('voice-1')]);
    expect(deps.join).toHaveBeenCalledOnce();
    const failing = makePlayer({ join: vi.fn(async () => { throw new UserError('I could not connect'); }) }).player;
    await expect(failing.connect('voice-1')).rejects.toThrow('I could not connect');
    expect(failing.channelId).toBeNull();
  });

  it('moves channels only when nothing is playing', async () => {
    const { player } = makePlayer();
    await player.connect('voice-1');
    await player.connect('voice-2');
    expect(player.channelId).toBe('voice-2');
    player.enqueue(track('a', '/long', 30));
    await expect(player.connect('voice-3')).rejects.toThrow(/already playing in <#voice-2>/);
  });

  const fakeConnection = () => {
    const c: any = new EventEmitter();
    c.state = { status: VoiceConnectionStatus.Ready };
    c.rejoinAttempts = 0;
    c.setStatus = (status: string, extra: object = {}) => { const before = c.state; c.state = { status, ...extra }; c.emit('stateChange', before, c.state); c.emit(status, before, c.state); };
    c.rejoin = vi.fn(() => { c.rejoinAttempts += 1; c.setStatus(VoiceConnectionStatus.Signalling); });
    c.destroy = vi.fn(() => c.setStatus(VoiceConnectionStatus.Destroyed));
    return c;
  };
  const timings = { rejoinDelayMs: 5, waitMs: 40, readyMs: 60 };

  it('rejoins after a network drop and carries on', async () => {
    const c = fakeConnection();
    const lost = vi.fn();
    superviseConnection(c, lost, timings);
    c.setStatus(VoiceConnectionStatus.Disconnected, { reason: VoiceConnectionDisconnectReason.WebSocketClose, closeCode: 4000 });
    await waitFor(() => c.rejoin.mock.calls.length === 1);
    c.setStatus(VoiceConnectionStatus.Ready);
    await new Promise((r) => setTimeout(r, 100));
    expect(c.destroy).not.toHaveBeenCalled();
    expect(lost).not.toHaveBeenCalled();
  });

  it('gives up after repeated drops', async () => {
    const c = fakeConnection();
    const lost = vi.fn();
    superviseConnection(c, lost, timings);
    c.rejoinAttempts = 5;
    c.setStatus(VoiceConnectionStatus.Disconnected, { reason: VoiceConnectionDisconnectReason.WebSocketClose, closeCode: 4000 });
    await waitFor(() => lost.mock.calls.length === 1);
    expect(c.destroy).toHaveBeenCalled();
  });

  it('treats being removed from the channel as final, but a move as fine', async () => {
    const removed = fakeConnection();
    const lost = vi.fn();
    superviseConnection(removed, lost, timings);
    removed.setStatus(VoiceConnectionStatus.Disconnected, { reason: VoiceConnectionDisconnectReason.WebSocketClose, closeCode: 4014 });
    await waitFor(() => lost.mock.calls.length === 1, 1000);
    expect(removed.rejoin).not.toHaveBeenCalled();

    const moved = fakeConnection();
    const stay = vi.fn();
    superviseConnection(moved, stay, timings);
    moved.setStatus(VoiceConnectionStatus.Disconnected, { reason: VoiceConnectionDisconnectReason.WebSocketClose, closeCode: 4014 });
    moved.setStatus(VoiceConnectionStatus.Connecting);
    moved.setStatus(VoiceConnectionStatus.Ready);
    await new Promise((r) => setTimeout(r, 120));
    expect(stay).not.toHaveBeenCalled();
  });

  it('gives up on a connection that never finishes connecting', async () => {
    const c = fakeConnection();
    const lost = vi.fn();
    superviseConnection(c, lost, timings);
    c.setStatus(VoiceConnectionStatus.Connecting);
    await waitFor(() => lost.mock.calls.length === 1, 1000);
  });
});

describe('music sources', () => {
  const audius = (over: object = {}) => ({ id: 'abc', title: 'Night Drive', duration: 200, permalink: '/nova/night-drive', user: { name: 'Nova' }, artwork: { '480x480': 'https://img/a.jpg' }, is_streamable: true, is_available: true, is_delete: false, is_stream_gated: false, stream_conditions: null, ...over });
  const stubFetch = (handler: (url: string) => Response | Promise<Response>) => { const f = vi.fn(async (url: string) => handler(String(url))); vi.stubGlobal('fetch', f); return f; };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('finds a song by name on Audius', async () => {
    const f = stubFetch(() => json({ data: [audius()] }));
    expect(await resolveTrack('night drive', 'u1')).toMatchObject({ key: 'audius:abc', title: 'Night Drive', artist: 'Nova', durationSec: 200, artwork: 'https://img/a.jpg', pageUrl: 'https://audius.co/nova/night-drive', requestedById: 'u1', url: 'https://api.audius.co/v1/tracks/abc/stream?app_name=ZYTHERON' });
    expect(f.mock.calls[0]![0]).toContain('query=night%20drive');
  });

  it('never plays tracks that are gated, removed or not streamable', async () => {
    stubFetch(() => json({ data: [audius({ id: 'gated', is_stream_gated: true }), audius({ id: 'cond', stream_conditions: { usdc_purchase: {} } }), audius({ id: 'gone', is_delete: true }), audius({ id: 'off', is_streamable: false }), audius({ id: 'open' })] }));
    expect((await resolveTrack('song', 'u1')).key).toBe('audius:open');
    stubFetch(() => json({ data: [audius({ is_stream_gated: true })] }));
    await expect(resolveTrack('song', 'u1')).rejects.toThrow(/found nothing playable/);
  });

  it('explains when a song is not found or search is down', async () => {
    stubFetch(() => json({ data: [] }));
    await expect(resolveTrack('zzzz', 'u1')).rejects.toThrow(/found nothing playable for \*\*zzzz\*\*/);
    stubFetch(() => json({}, 500));
    await expect(resolveTrack('zzzz', 'u1')).rejects.toThrow(/not responding/);
    stubFetch(() => { throw new TypeError('network down'); });
    await expect(resolveTrack('zzzz', 'u1')).rejects.toThrow(/not responding/);
  });

  it.each([
    ['https://www.youtube.com/watch?v=abc', 'YouTube'], ['https://youtu.be/abc', 'YouTube'], ['https://music.youtube.com/watch?v=abc', 'YouTube'],
    ['https://open.spotify.com/track/abc', 'Spotify'], ['https://soundcloud.com/a/b', 'SoundCloud'], ['https://music.apple.com/us/album/x', 'Apple Music'], ['https://www.deezer.com/track/1', 'Deezer'], ['https://tidal.com/track/1', 'Tidal'],
  ])('refuses %s without contacting it', async (link, name) => {
    const f = stubFetch(() => json({}));
    await expect(resolveTrack(link, 'u1')).rejects.toThrow(new RegExp(`${name}.*not supported`));
    expect(f).not.toHaveBeenCalled();
  });

  it('plays single Audius tracks by link, and refuses restricted ones', async () => {
    const f = stubFetch(() => json({ data: [audius()] }));
    expect((await resolveTrack('https://audius.co/nova/night-drive', 'u1')).key).toBe('audius:abc');
    expect(f.mock.calls[0]![0]).toContain('permalink=nova%2Fnight-drive');
    await expect(resolveTrack('https://audius.co/nova/playlist/mix', 'u1')).rejects.toThrow(/single track/);
    stubFetch(() => json({ data: [audius({ is_stream_gated: true })] }));
    await expect(resolveTrack('https://audius.co/nova/night-drive', 'u1')).rejects.toThrow(/not available to stream/);
    stubFetch(() => json({}, 404));
    await expect(resolveTrack('https://audius.co/nova/gone', 'u1')).rejects.toThrow(/could not be found/);
  });

  it('accepts direct audio links, following redirects', async () => {
    const opts = { allowPrivate: true };
    expect(await resolveTrack(`${base}/short?x=1`, 'u1', opts)).toMatchObject({ source: 'direct', title: 'short', artist: 'Direct link', durationSec: null });
    expect((await resolveTrack(`${base}/moved`, 'u1', opts)).source).toBe('direct');
  });

  it('rejects links that are not audio or do not work', async () => {
    const opts = { allowPrivate: true };
    await expect(resolveTrack(`${base}/page`, 'u1', opts)).rejects.toThrow(/not an audio file/);
    await expect(resolveTrack(`${base}/missing`, 'u1', opts)).rejects.toThrow(/no longer available/);
    await expect(resolveTrack('http://bad url', 'u1')).rejects.toThrow();
    await expect(resolveTrack('ftp://example.com/a.mp3', 'u1')).rejects.toThrow(/Only http and https/);
    await expect(resolveTrack('https://user:pw@example.com/a.mp3', 'u1')).rejects.toThrow(/username or password/);
    await expect(resolveTrack('   ', 'u1')).rejects.toThrow(/which song/);
  });

  it('will not open private addresses, by number or by name', async () => {
    for (const link of [`${base}/short`, 'http://10.0.0.5/a.mp3', 'http://192.168.1.1/a.mp3', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/a.mp3', 'http://[::ffff:127.0.0.1]/a.mp3', 'http://0.0.0.0/a.mp3']) {
      await expect(openStream(link), link).rejects.toThrow(/private address/);
    }
    await expect(openStream('http://localhost:9/a.mp3')).rejects.toThrow(/private address/);
    expect(hits.get('/short')).toBeUndefined();
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
  });

  it('finds lyrics, and reports when there are none', async () => {
    stubFetch(() => json([{ trackName: 'Instrumental', plainLyrics: null }, { trackName: 'Song', artistName: 'Band', plainLyrics: ' words \n' }]));
    expect(await findLyrics('song')).toEqual({ title: 'Song', artist: 'Band', text: 'words' });
    stubFetch(() => json([]));
    expect(await findLyrics('song')).toBeNull();
    stubFetch(() => { throw new TypeError('down'); });
    await expect(findLyrics('song')).rejects.toThrow(/lyrics service/);
  });
});

describe('times', () => {
  it.each([['90', 90], ['1:30', 90], ['0:05', 5], ['1:02:03', 3723]])('reads %s', (text, seconds) => expect(parseTime(text)).toBe(seconds));
  it.each(['abc', '1:99', '-5', '1:2:3:4', ''])('rejects "%s"', (text) => expect(parseTime(text)).toBeNull());
  it.each([[5, '0:05'], [90, '1:30'], [3723, '1:02:03']])('shows %d', (seconds, text) => expect(formatTime(seconds)).toBe(text));
});

describe('the player embed', () => {
  it('shows every detail and all five buttons', () => {
    const { player } = makePlayer({ open: () => ({ pcm: new PassThrough(), failed: () => false, failure: () => null, closed: new Promise(() => {}), onInfo: () => {}, kill: () => {} }) } as any, 45);
    player.enqueue({ ...track('a', '/x', 200), artwork: 'https://img/a.jpg', pageUrl: 'https://audius.co/a' });
    player.enqueue(track('b'));
    const { embeds, components } = playerPayload(player);
    const data = (embeds[0] as any).toJSON();
    expect(data.title).toBe('Song a');
    expect(data.description).toContain('by **Artist a**');
    expect(data.description).toContain('0:00 / 3:20');
    expect(data.thumbnail.url).toBe('https://img/a.jpg');
    const fields = Object.fromEntries(data.fields.map((f: any) => [f.name, f.value]));
    expect(fields['Requested by']).toBe('<@700000000000000001>');
    expect(fields.Volume).toBe('45%');
    expect(fields.Queue).toContain('1 upcoming');
    expect(fields.Queue).toContain('Song b');
    const buttons = (components[0] as any).toJSON().components;
    expect(buttons.map((b: any) => b.custom_id)).toEqual(['music:toggle', 'music:skip', 'music:stop', 'music:loop', 'music:shuffle']);
    expect(buttons.map((b: any) => b.emoji.name)).toEqual(['⏯️', '⏭️', '⏹️', '🔁', '🔀']);
    player.queue.loop = true;
    expect((playerPayload(player).components[0] as any).toJSON().components[3].style).toBe(3);
  });

  it('shows a finished state with no buttons when the queue is empty', () => {
    const { player } = makePlayer();
    const { embeds, components } = playerPayload(player);
    expect((embeds[0] as any).toJSON().description).toContain('queue is finished');
    expect(components).toEqual([]);
  });
});

describe('commands through the real router', () => {
  const router = new InteractionRouter(MODULES);
  // Cooldowns have their own tests, and a whole session here happens within a second.
  beforeAll(() => { vi.spyOn(Cooldown.prototype, 'allow').mockReturnValue(0); });
  afterAll(() => { vi.restoreAllMocks(); });
  const VOICE = '600000000000000050';
  const CHANNEL = '600000000000000001';

  function world(guildId?: string) {
    const guild = setupGuild();
    if (guildId) guild.id = guildId;
    const text = fakeChannel(guild, CHANNEL);
    text.send = vi.fn(async (payload: any) => ({ id: 'player-message', edit: vi.fn(async () => undefined), payload }));
    const owner = fakeMember(guild, guild.ownerId, { position: 40 });
    fakeMember(guild, guild.client.user.id, { position: 30, bot: true });
    guild.members.me = guild.members.cache.get(guild.client.user.id);
    guild.voiceAdapterCreator = () => ({ sendPayload: () => true, destroy: () => {} });
    const voiceChannel: any = { id: VOICE, type: ChannelType.GuildVoice, joinable: true, members: new Collection(), permissionsFor: () => new PermissionsBitField(PermissionsBitField.All) };
    const listener = fakeMember(guild, '700000000000000099', { position: 2 });
    for (const m of [owner, listener]) m.voice = { channelId: VOICE, channel: voiceChannel };
    const outsider = fakeMember(guild, '700000000000000098', { position: 2 });
    outsider.voice = { channelId: null, channel: null };
    return { guild, text, owner, listener, outsider, voiceChannel };
  }

  const useFakes = (join = vi.fn(async (id: string) => fakeLink(id))) => {
    runtime.deps = { join, open: (t: Track, offset: number) => openAudio(t, offset, { allowPrivate: true }), playWithoutListeners: true, retryDelayMs: 30 } as any;
    runtime.resolve = vi.fn(async (input: string, requestedById: string) => track(input, '/long', 30) && { ...track(input, '/long', 30), requestedById }) as any;
    return join;
  };
  afterEach(() => { runtime.resolve = resolveTrack; });

  const run = async (w: ReturnType<typeof world>, command: string, options: Record<string, unknown> = {}, member = w.owner) => {
    const i = commandInteraction(w.guild, command, null, options, { member });
    await router.handle(i);
    return i;
  };
  const text = (call: any) => JSON.stringify(call?.calls?.at?.(-1)?.[0] ?? call);
  const lastReply = (i: any) => JSON.stringify(i.editReply.mock.calls.at(-1)?.[0] ?? i.reply.mock.calls.at(-1)?.[0] ?? i.followUp.mock.calls.at(-1)?.[0]);

  it('/play needs a voice channel, and says what is missing', async () => {
    useFakes();
    const w = world();
    const i = await run(w, 'play', { song: 'x' }, w.outsider);
    expect(lastReply(i)).toMatch(/Join a voice channel first/);
    expect(i.deferReply).not.toHaveBeenCalled();

    w.voiceChannel.permissionsFor = () => new PermissionsBitField([PermissionsBitField.Flags.ViewChannel]);
    const j = await run(w, 'play', { song: 'x' });
    expect(lastReply(j)).toMatch(/missing \*\*Connect, Speak\*\*/);

    w.voiceChannel.permissionsFor = () => new PermissionsBitField(PermissionsBitField.All);
    w.voiceChannel.joinable = false;
    expect(lastReply(await run(w, 'play', { song: 'x' }))).toMatch(/is full/);

    w.voiceChannel.type = ChannelType.GuildStageVoice;
    expect(lastReply(await run(w, 'play', { song: 'x' }))).toMatch(/Stage channels/);
  });

  it('reports a song that cannot be found, without joining voice', async () => {
    const join = useFakes();
    runtime.resolve = vi.fn(async () => { throw new UserError('I found nothing playable'); }) as any;
    const w = world();
    const i = await run(w, 'play', { song: 'zzzz' });
    expect(lastReply(i)).toMatch(/found nothing playable/);
    expect(join).not.toHaveBeenCalled();
  });

  it('reports a voice failure and leaves nothing behind', async () => {
    useFakes(vi.fn(async () => { throw new UserError('I could not connect to your voice channel.'); }));
    const w = world();
    const i = await run(w, 'play', { song: 'a' });
    expect(lastReply(i)).toMatch(/could not connect/);
    expect(lastReply(await run(w, 'nowplaying'))).toMatch(/Nothing is playing/);
  });

  it('runs a whole session: queueing from two people, controls, buttons and stop', async () => {
    const join = useFakes();
    const w = world();
    expect(lastReply(await run(w, 'play', { song: 'one' }))).toMatch(/Starting/);
    expect(join).toHaveBeenCalledOnce();
    expect(lastReply(await run(w, 'play', { song: 'two' }, w.listener))).toMatch(/position \*\*1\*\*/);
    expect(lastReply(await run(w, 'play', { song: 'three' }, w.listener))).toMatch(/position \*\*2\*\*/);
    expect(join).toHaveBeenCalledOnce();
    expect(lastReply(await run(w, 'play', { song: 'two' }))).toMatch(/already in the queue/);
    await waitFor(() => w.text.send.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 500)); // let the song finish loading

    const queue = lastReply(await run(w, 'queue'));
    expect(queue).toContain('Song one');
    expect(queue).toContain('Song three');
    expect(queue).toContain('<@700000000000000099>');
    expect(lastReply(await run(w, 'nowplaying'))).toContain('Song one');

    expect(lastReply(await run(w, 'pause'))).toMatch(/Paused/);
    expect(lastReply(await run(w, 'pause', {}, w.listener))).toMatch(/already paused/);
    expect(lastReply(await run(w, 'resume'))).toMatch(/Resumed/);
    expect(lastReply(await run(w, 'volume', { level: 35 }))).toMatch(/35%/);
    expect((await getConfig(w.guild.id)).music.volume).toBe(35);
    expect(lastReply(await run(w, 'loop'))).toMatch(/\*\*on\*\*/);
    expect(lastReply(await run(w, 'loop'))).toMatch(/\*\*off\*\*/);
    expect(lastReply(await run(w, 'shuffle'))).toMatch(/Shuffled/);
    expect(lastReply(await run(w, 'seek', { time: '0:10' }))).toMatch(/0:10/);
    expect(lastReply(await run(w, 'seek', { time: 'soon' }))).toMatch(/Use a time like/);
    expect(lastReply(await run(w, 'seek', { time: '9:00' }))).toMatch(/within the song/);
    expect(lastReply(await run(w, 'skip'))).toMatch(/Skipped/);
    expect(lastReply(await run(w, 'previous'))).toMatch(/Going back/);
    expect(lastReply(await run(w, 'remove', { position: 9 }))).toMatch(/Pick a position/);
    expect(lastReply(await run(w, 'remove', { position: 1 }))).toMatch(/Removed/);

    // Controls refuse anyone not listening, but looking is allowed.
    for (const command of ['pause', 'resume', 'skip', 'stop', 'loop', 'shuffle', 'clearqueue', 'previous']) {
      expect(lastReply(await run(w, command, {}, w.outsider)), command).toMatch(/to control the music/);
    }
    expect(lastReply(await run(w, 'queue', {}, w.outsider))).toContain('Music Queue');

    const press = async (id: string, member = w.owner) => {
      const i = componentInteraction(w.guild, 'button', `music:${id}`, { member });
      Object.assign(i, { isAutocomplete: () => false, isChatInputCommand: () => false });
      i.message = { id: 'player-message' };
      await router.handle(i);
      return i;
    };
    await new Promise((r) => setTimeout(r, 500)); // let the song from /previous finish loading
    const paused = await press('toggle');
    expect(text(paused.update.mock)).toContain('Resume');
    expect(text((await press('toggle')).update.mock)).toContain('Pause');
    expect(text((await press('loop')).update.mock)).toContain('On');
    const denied = await press('skip', w.outsider);
    expect(denied.update).not.toHaveBeenCalled();
    expect(JSON.stringify(denied.reply.mock.calls[0]![0])).toMatch(/to control the music/);

    expect(lastReply(await run(w, 'clearqueue', {}, w.listener))).toMatch(/Cleared|no upcoming/);
    const stopped = await press('stop');
    expect(text(stopped.update.mock)).toContain('queue is finished');
    expect(lastReply(await run(w, 'stop'))).toMatch(/Nothing is playing/);
    expect(lastReply(await run(w, 'queue'))).toMatch(/queue is empty/);
  }, 40_000);

  const say = async (w: ReturnType<typeof world>, content: string, member = w.owner, extra: object = {}) => {
    const message: any = { content, inGuild: () => true, author: { id: member.id, bot: false }, webhookId: null, guild: w.guild, member, channel: { ...w.text, sendTyping: vi.fn(async () => undefined) }, reply: vi.fn(async () => undefined), ...extra };
    await (musicModule.events!.find((e) => e.event === 'messageCreate')!.run as any)(message);
    return message;
  };
  const answer = (message: any) => JSON.stringify(message.reply.mock.calls.at(-1)?.[0]);

  it('/leave stops the music and leaves, and only for people listening', async () => {
    const link = fakeLink(VOICE);
    useFakes(vi.fn(async () => link));
    const w = world();
    expect(lastReply(await run(w, 'leave'))).toMatch(/not in a voice channel/);
    await run(w, 'play', { song: 'one' });
    await run(w, 'play', { song: 'two' });
    expect(lastReply(await run(w, 'leave', {}, w.outsider))).toMatch(/to control the music/);
    expect(link.destroy).not.toHaveBeenCalled();
    expect(lastReply(await run(w, 'leave'))).toMatch(/Left the voice channel/);
    expect(link.destroy).toHaveBeenCalledOnce();
    expect(lastReply(await run(w, 'queue'))).toMatch(/queue is empty/);
    expect(lastReply(await run(w, 'leave'))).toMatch(/not in a voice channel/);
    // The next /play starts cleanly with a new connection.
    expect(lastReply(await run(w, 'play', { song: 'three' }))).toMatch(/Starting/);
  }, 20_000);

  it('runs a session with v! commands, including short forms and capitals', async () => {
    const join = useFakes();
    const w = world();
    expect(answer(await say(w, 'v!play song one'))).toMatch(/Starting.*Song song one/);
    expect(join).toHaveBeenCalledOnce();
    expect(answer(await say(w, 'V!P two', w.listener))).toMatch(/position \*\*1\*\*/);
    expect(answer(await say(w, 'v!q'))).toContain('Song two');
    expect(answer(await say(w, 'v!np'))).toContain('Song song one');
    await new Promise((r) => setTimeout(r, 500)); // let the song finish loading
    expect(answer(await say(w, 'v!pause'))).toMatch(/Paused/);
    expect(answer(await say(w, 'v!resume'))).toMatch(/Resumed/);
    expect(answer(await say(w, 'v!vol 42'))).toMatch(/42%/);
    expect((await getConfig(w.guild.id)).music.volume).toBe(42);
    expect(answer(await say(w, 'v!loop'))).toMatch(/\*\*on\*\*/);
    expect(answer(await say(w, 'v!seek 0:05'))).toMatch(/0:05/);
    expect(answer(await say(w, 'v!s'))).toMatch(/Skipped/);
    expect(answer(await say(w, 'v!prev'))).toMatch(/Going back/);
    expect(answer(await say(w, 'v!rm 1'))).toMatch(/Removed/);
    expect(answer(await say(w, 'v!stop'))).toMatch(/Stopped/);
    expect(answer(await say(w, 'v!dc'))).toMatch(/Left the voice channel/);
  }, 20_000);

  it('v! commands give the same clear errors, and catch bad numbers', async () => {
    useFakes();
    const w = world();
    expect(answer(await say(w, 'v!play'))).toContain('v!play <song or link>');
    expect(answer(await say(w, 'v!play x', w.outsider))).toMatch(/Join a voice channel first/);
    expect(answer(await say(w, 'v!skip'))).toMatch(/Nothing is playing/);
    await say(w, 'v!p one');
    for (const bad of ['v!vol loud', 'v!vol 0', 'v!vol 101', 'v!vol 1.5']) expect(answer(await say(w, bad)), bad).toMatch(/from 1 to 100/);
    expect(answer(await say(w, 'v!vol'))).toContain('v!volume <1-100>');
    expect(answer(await say(w, 'v!rm abc'))).toMatch(/number from the queue/);
    expect(answer(await say(w, 'v!seek soon'))).toMatch(/Use a time like/);
    expect(answer(await say(w, 'v!pause', w.outsider))).toMatch(/to control the music/);
    // A reply can never ping anyone, even when the song name is a mention.
    expect((await say(w, 'v!np')).reply.mock.calls[0][0].allowedMentions.parse).toEqual([]);
  }, 20_000);

  it('v! ignores normal chat, bots, webhooks and unknown words', async () => {
    const join = useFakes();
    const w = world();
    const quiet = [await say(w, 'play lofi'), await say(w, 'hello v!play lofi'), await say(w, 'v!'), await say(w, 'v!banana split'), await say(w, 'v!play lofi', w.owner, { author: { id: '1', bot: true } }), await say(w, 'v!play lofi', w.owner, { webhookId: '123' }), await say(w, 'v!play lofi', w.owner, { inGuild: () => false })];
    for (const message of quiet) expect(message.reply).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });

  it('obeys the dashboard switches and limits, for both / and v!', async () => {
    const join = useFakes();
    const w = world();
    await updateConfig(w.guild.id, 'commands', { disabled: ['play'] });
    expect(lastReply(await run(w, 'play', { song: 'x' }))).toMatch(/turned off/);
    expect(answer(await say(w, 'v!p x'))).toMatch(/turned off/);
    expect(join).not.toHaveBeenCalled();

    const ROLE = '400000000000000077';
    const OTHER = '600000000000000077';
    await updateConfig(w.guild.id, 'commands', { disabled: [], rules: { play: { allowedRoleIds: [ROLE], allowedChannelIds: [] }, lyrics: { allowedRoleIds: [], allowedChannelIds: [OTHER] } } });
    expect(lastReply(await run(w, 'play', { song: 'x' }, w.listener))).toContain(`<@&${ROLE}>`);
    expect(answer(await say(w, 'v!play x', w.listener))).toContain(`<@&${ROLE}>`);
    expect(lastReply(await run(w, 'lyrics', { song: 'x' }, w.listener))).toContain(`<#${OTHER}>`);
    // A member with the role gets through, and so does the owner without it.
    w.listener.roles.cache.set(ROLE, { id: ROLE });
    expect(lastReply(await run(w, 'play', { song: 'allowed' }, w.listener))).toMatch(/Starting/);
    expect(lastReply(await run(w, 'play', { song: 'owner' }))).toMatch(/position/);
    // Always-on commands ignore stored settings, even if they were somehow saved.
    await updateConfig(w.guild.id, 'commands', { disabled: ['help', 'security', 'setup'], rules: {} });
    expect(lastReply(await run(w, 'help', {}, w.listener))).not.toMatch(/turned off/);
  }, 20_000);

  it('keeps two servers apart through the commands too', async () => {
    useFakes();
    const a = world('100000000000000011');
    const b = world('100000000000000022');
    await run(a, 'play', { song: 'from-a' });
    await run(b, 'play', { song: 'from-b' });
    await run(a, 'volume', { level: 11 });
    await run(b, 'volume', { level: 99 });
    expect((await getConfig(a.guild.id)).music.volume).toBe(11);
    expect((await getConfig(b.guild.id)).music.volume).toBe(99);
    await run(a, 'stop');
    expect(lastReply(await run(a, 'nowplaying'))).toMatch(/Nothing is playing|queue is finished/);
    expect(lastReply(await run(b, 'nowplaying'))).toContain('Song from-b');
  }, 20_000);

  it('/lyrics uses the current song, a given name, or explains what it needs', async () => {
    useFakes();
    const f = vi.fn(async () => new Response(JSON.stringify([{ trackName: 'Song', artistName: 'Band', plainLyrics: 'la la' }])));
    vi.stubGlobal('fetch', f);
    const w = world();
    expect(lastReply(await run(w, 'lyrics'))).toMatch(/tell me which song/);
    expect(lastReply(await run(w, 'lyrics', { song: 'my song' }))).toContain('la la');
    await run(w, 'play', { song: 'one' });
    await run(w, 'lyrics');
    expect(String((f.mock.calls.at(-1) as any)[0])).toContain(encodeURIComponent('Artist one Song one'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
    expect(lastReply(await run(w, 'lyrics', { song: 'nothing' }))).toMatch(/could not find lyrics/);
  }, 20_000);
});
