import { getEnv } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import { UserError } from '../../core/types.js';
import type { Track } from './queue.js';
import { findMatch, readVideoTitle, resolveTrack, type SongInfo } from './sources.js';
import { getYoutubePlaylist, getYoutubeVideo, searchYoutube, youtubeConfig } from './youtube.js';

/**
 * YouTube and Spotify links, read for their song details only. Neither service's audio is ever
 * played: the song is looked up on a source that permits streaming, and plays only on a confident match.
 */
const PLAYLIST_LIMIT = 25;
const MATCHES_AT_ONCE = 4;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export type ParsedLink = { kind: 'youtube-video' | 'youtube-playlist' | 'spotify-track' | 'spotify-album' | 'spotify-playlist'; id: string };

/** Returns null when the input is not a YouTube or Spotify link. Throws if it is one but is unusable. */
export function parseLink(input: string): ParsedLink | null {
  const text = input.trim();
  const spotifyUri = /^spotify:(track|album|playlist|artist|episode|show):([A-Za-z0-9]+)$/i.exec(text);
  if (spotifyUri) return spotifyPath(spotifyUri[1]!.toLowerCase(), spotifyUri[2]!);
  if (!/^https?:\/\//i.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'open.spotify.com') {
    const path = parts[0]?.startsWith('intl-') ? parts.slice(1) : parts;
    return spotifyPath(path[0] ?? '', path[1] ?? '');
  }
  if (host === 'spotify.link' || host === 'spotify.app.link') throw new UserError('Short Spotify links cannot be read. Open it, then copy the full `open.spotify.com` link.');

  const video = (id: string | null | undefined): ParsedLink => {
    if (!id || !VIDEO_ID.test(id)) throw new UserError('That YouTube link does not point to a valid video.');
    return { kind: 'youtube-video', id };
  };
  if (host === 'youtu.be') return video(parts[0]);
  if (!['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)) return null;
  if (parts[0] === 'watch') return video(url.searchParams.get('v'));
  if (['shorts', 'embed', 'live', 'v'].includes(parts[0] ?? '')) return video(parts[1]);
  if (parts[0] === 'playlist') {
    const id = url.searchParams.get('list');
    if (!id || !/^[A-Za-z0-9_-]{10,64}$/.test(id)) throw new UserError('That YouTube link does not point to a valid playlist.');
    return { kind: 'youtube-playlist', id };
  }
  throw new UserError('Use a YouTube link to a video or playlist.');
}

function spotifyPath(type: string, id: string): ParsedLink {
  if (type !== 'track' && type !== 'album' && type !== 'playlist') throw new UserError('Only Spotify track, album and playlist links are supported.');
  if (!/^[A-Za-z0-9]{22}$/.test(id)) throw new UserError(`That Spotify link does not point to a valid ${type}.`);
  return { kind: `spotify-${type}`, id };
}

/** Replaced by automated tests. */
export const spotifyConfig = {
  credentials: (): { id: string; secret: string } | null => {
    const { SPOTIFY_CLIENT_ID: id, SPOTIFY_CLIENT_SECRET: secret } = getEnv();
    return id && secret ? { id, secret } : null;
  },
};

let spotifyToken: { value: string; expiresAt: number } | null = null;
export const forgetSpotifyToken = () => { spotifyToken = null; };

const SPOTIFY_REJECTED = 'Spotify rejected the bot\'s credentials or does not allow this for its app. Site owner: check `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`, and the app\'s access in the Spotify developer dashboard.';
const SPOTIFY_DOWN = 'Spotify is not responding right now. Please try again in a moment.';

async function spotifyAccessToken(): Promise<string> {
  if (spotifyToken && spotifyToken.expiresAt > Date.now()) return spotifyToken.value;
  const credentials = spotifyConfig.credentials();
  if (!credentials) throw new UserError('Spotify links are not set up yet. Site owner: put your app\'s details in `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in the .env file, then restart.');
  let res: Response;
  try {
    res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Basic ${Buffer.from(`${credentials.id}:${credentials.secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
  } catch {
    throw new UserError(SPOTIFY_DOWN);
  }
  if (!res.ok) {
    logger.warn({ status: res.status }, 'Spotify login failed');
    throw new UserError(res.status >= 500 ? SPOTIFY_DOWN : SPOTIFY_REJECTED);
  }
  const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!body?.access_token) throw new UserError(SPOTIFY_DOWN);
  spotifyToken = { value: body.access_token, expiresAt: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 };
  return spotifyToken.value;
}

/** One Spotify request, turning each kind of failure into a clear message. */
async function spotifyGet<T>(path: string): Promise<T> {
  const token = await spotifyAccessToken();
  let res: Response;
  try {
    res = await fetch(`https://api.spotify.com/v1/${path}`, { signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${token}` } });
  } catch {
    throw new UserError(SPOTIFY_DOWN);
  }
  if (res.status === 404 || res.status === 400) throw new UserError('That Spotify link could not be found. It may be private or removed.');
  if (res.status === 401) forgetSpotifyToken();
  if (res.status === 429) throw new UserError('Spotify is limiting requests right now. Please try again in a minute.');
  if (!res.ok) {
    const reason = await res.text().catch(() => '');
    logger.warn({ status: res.status, reason: reason.slice(0, 200) }, 'Spotify request failed');
    if (/premium/i.test(reason)) throw new UserError('Spotify is refusing the request because the owner of the Spotify developer app needs an active Premium subscription. After subscribing, it can take a few hours to start working.');
    throw new UserError(res.status >= 500 ? SPOTIFY_DOWN : SPOTIFY_REJECTED);
  }
  const body = (await res.json().catch(() => null)) as T | null;
  if (!body) throw new UserError(SPOTIFY_DOWN);
  return body;
}

interface SpotifyTrack { type?: string; name?: string; duration_ms?: number; artists?: Array<{ name?: string }>; external_urls?: { spotify?: string }; id?: string; album?: { images?: Array<{ url?: string }> } }

const songFromSpotify = (t: SpotifyTrack, fallbackThumbnail: string | null = null): SongInfo => ({
  title: t.name!, artist: t.artists?.[0]?.name ?? null, durationSec: t.duration_ms ? Math.round(t.duration_ms / 1000) : null,
  url: t.external_urls?.spotify ?? `https://open.spotify.com/track/${t.id}`, thumbnail: t.album?.images?.[0]?.url ?? fallbackThumbnail,
});

async function getSpotifyTrack(id: string): Promise<SongInfo> {
  const track = await spotifyGet<SpotifyTrack>(`tracks/${id}`);
  if (!track.name) throw new UserError(SPOTIFY_DOWN);
  return songFromSpotify({ ...track, id });
}

interface SpotifyCollection { label: string; url: string; thumbnail: string | null; songs: SongInfo[]; totalItems: number }

async function getSpotifyAlbum(id: string): Promise<SpotifyCollection> {
  const album = await spotifyGet<{ name?: string; images?: Array<{ url?: string }> }>(`albums/${id}`);
  const list = await spotifyGet<{ items?: SpotifyTrack[]; total?: number }>(`albums/${id}/tracks?limit=${PLAYLIST_LIMIT}`);
  const thumbnail = album.images?.[0]?.url ?? null;
  const songs = (list.items ?? []).filter((t) => t.name).map((t) => songFromSpotify(t, thumbnail));
  return { label: album.name ?? 'Spotify album', url: `https://open.spotify.com/album/${id}`, thumbnail, songs, totalItems: list.total ?? songs.length };
}

interface PlaylistEntry { item?: SpotifyTrack | null; track?: SpotifyTrack | null }

async function getSpotifyPlaylist(id: string): Promise<SpotifyCollection> {
  const playlist = await spotifyGet<{ name?: string; images?: Array<{ url?: string }> }>(`playlists/${id}`);
  // Spotify only shares a playlist's songs with the account that owns it or collaborates on it.
  const list = await spotifyGet<{ items?: PlaylistEntry[]; total?: number }>(`playlists/${id}/items?limit=${PLAYLIST_LIMIT}`).catch((err: Error) => {
    logger.warn({ err: err.message }, 'Spotify would not share the songs in a playlist');
    return null;
  });
  const songs = (list?.items ?? []).map((entry) => entry.item ?? entry.track).filter((t): t is SpotifyTrack => Boolean(t?.name) && (!t?.type || t.type === 'track')).map((t) => songFromSpotify(t));
  if (!songs.length) throw new UserError(`Spotify won't share the songs in **${playlist.name ?? 'that playlist'}**. It only shares songs from playlists owned by the account that made this bot's Spotify app. Try a track or album link instead.`);
  return { label: playlist.name ?? 'Spotify playlist', url: `https://open.spotify.com/playlist/${id}`, thumbnail: playlist.images?.[0]?.url ?? null, songs, totalItems: list?.total ?? songs.length };
}

export interface LinkedResult {
  service: 'YouTube' | 'Spotify';
  /** What the link was: a song's name, or a playlist's. */
  label: string;
  url: string;
  tracks: Track[];
  /** How many songs the link held, up to the limit. */
  total: number;
  /** Songs beyond the limit that were not looked at. */
  beyondLimit: number;
  /** The song a single link points to, with its details from YouTube or Spotify. */
  song?: SongInfo;
  /** Cover art for an album or playlist. */
  thumbnail?: string | null;
}

async function matchAll(songs: SongInfo[], userId: string): Promise<Track[]> {
  const found: Array<Track | null> = [];
  for (let n = 0; n < songs.length; n += MATCHES_AT_ONCE) {
    const batch = songs.slice(n, n + MATCHES_AT_ONCE);
    // One failed lookup should not lose the rest of a playlist.
    found.push(...await Promise.all(batch.map((song) => findMatch(song, userId).catch(() => null))));
  }
  return found.filter((t): t is Track => t !== null);
}

const NAME_SEARCH_RESULTS = 2;

/**
 * A song name, or an Audius or direct audio link. With a YouTube key, YouTube works out which song
 * was meant, and that exact song plays if it has a permitted source. Otherwise the closest Audius
 * result plays, and the reply says it may be a different song.
 */
export async function resolvePlayable(input: string, userId: string): Promise<Track> {
  const query = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(query) || !youtubeConfig.key()) return resolveTrack(query, userId);
  // A failed or used-up YouTube search must not stop the music.
  const hits = await searchYoutube(query).catch(() => []);
  for (const hit of hits.slice(0, NAME_SEARCH_RESULTS)) {
    const song = { ...readVideoTitle(hit.title, hit.channel), durationSec: null, url: `https://www.youtube.com/watch?v=${hit.id}`, thumbnail: hit.thumbnail };
    const match = await findMatch(song, userId).catch(() => null);
    if (match) return match;
  }
  const track = await resolveTrack(query, userId);
  if (hits[0]) track.note = 'This is the closest result on Audius, so it may not be the song you meant.';
  return track;
}

/** Reads a YouTube or Spotify link, or a bare video ID. Null means the input is neither. */
export async function resolveLinked(input: string, userId: string): Promise<LinkedResult | null> {
  const text = input.trim();
  let link = parseLink(text);
  let bareId = false;
  if (!link) {
    // A song name can look like a video ID, so an ID only counts if YouTube recognises it.
    if (!VIDEO_ID.test(text) || !youtubeConfig.key()) return null;
    link = { kind: 'youtube-video', id: text };
    bareId = true;
  }
  if (link.kind === 'spotify-track') {
    const song = await getSpotifyTrack(link.id);
    const track = await findMatch(song, userId);
    return { service: 'Spotify', label: song.artist ? `${song.title} by ${song.artist}` : song.title, url: song.url, tracks: track ? [track] : [], total: 1, beyondLimit: 0, song };
  }
  if (link.kind === 'spotify-album' || link.kind === 'spotify-playlist') {
    const collection = await (link.kind === 'spotify-album' ? getSpotifyAlbum(link.id) : getSpotifyPlaylist(link.id));
    if (!collection.songs.length) throw new UserError('That Spotify link has no songs.');
    return { service: 'Spotify', label: collection.label, url: collection.url, thumbnail: collection.thumbnail, tracks: await matchAll(collection.songs, userId), total: collection.songs.length, beyondLimit: Math.max(0, collection.totalItems - collection.songs.length) };
  }
  if (link.kind === 'youtube-video') {
    let song: SongInfo | null;
    try {
      song = await getYoutubeVideo(link.id);
    } catch (err) {
      if (bareId) return null; // it was probably just a song name, so search for it as one
      throw err;
    }
    if (!song) {
      if (bareId) return null;
      throw new UserError('That YouTube video is unavailable. It may be private or removed.');
    }
    const track = await findMatch(song, userId);
    return { service: 'YouTube', label: song.artist ? `${song.title} by ${song.artist}` : song.title, url: song.url, tracks: track ? [track] : [], total: 1, beyondLimit: 0, song };
  }
  const playlist = await getYoutubePlaylist(link.id, PLAYLIST_LIMIT);
  if (!playlist.songs.length) throw new UserError('That YouTube playlist is empty or unavailable. It may be private, and YouTube mixes cannot be read.');
  return { service: 'YouTube', label: playlist.title, url: `https://www.youtube.com/playlist?list=${link.id}`, tracks: await matchAll(playlist.songs, userId), total: playlist.songs.length, beyondLimit: Math.max(0, playlist.totalItems - playlist.songs.length) };
}
