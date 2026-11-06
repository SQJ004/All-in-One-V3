import { UserError } from '../../core/types.js';
import { openStream, type OpenOptions } from './http.js';
import type { Track } from './queue.js';

const AUDIUS_API = 'https://api.audius.co/v1';
const APP_NAME = 'ZYTHERON';
const LRCLIB_API = 'https://lrclib.net/api';

/** These services do not permit extracting their audio, so ZYTHERON never tries. */
const RESTRICTED: Array<[RegExp, string]> = [
  [/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i, 'YouTube'],
  [/(^|\.)spotify\.(com|link)$/i, 'Spotify'],
  [/(^|\.)(music\.apple\.com|itunes\.apple\.com)$/i, 'Apple Music'],
  [/(^|\.)soundcloud\.com$|(^|\.)snd\.sc$/i, 'SoundCloud'],
  [/(^|\.)deezer\.(com|page\.link)$/i, 'Deezer'],
  [/(^|\.)tidal\.com$/i, 'Tidal'],
  [/(^|\.)music\.amazon\.[a-z.]+$/i, 'Amazon Music'],
  [/(^|\.)twitch\.tv$/i, 'Twitch'],
];

const AUDIO_TYPES = /^(audio\/|application\/ogg$)/i;
const AUDIO_EXTENSION = /\.(mp3|ogg|oga|opus|wav|flac|m4a|aac|webm)$/i;

interface AudiusTrack {
  id: string; title: string; duration?: number; permalink?: string; artwork?: Record<string, string> | null; user?: { name?: string };
  is_streamable?: boolean; is_delete?: boolean; is_available?: boolean; is_stream_gated?: boolean; stream_conditions?: unknown;
}

/** Tracks the owner gated or removed are left out, never worked around. */
const isPlayable = (t: AudiusTrack): boolean => t.is_streamable === true && !t.is_delete && t.is_available !== false && !t.is_stream_gated && !t.stream_conditions;

function fromAudius(t: AudiusTrack, requestedById: string): Track {
  return {
    key: `audius:${t.id}`, title: t.title, artist: t.user?.name ?? 'Unknown artist',
    url: `${AUDIUS_API}/tracks/${encodeURIComponent(t.id)}/stream?app_name=${APP_NAME}`,
    durationSec: t.duration ?? null, artwork: t.artwork?.['480x480'] ?? null, pageUrl: t.permalink ? `https://audius.co${t.permalink}` : null, source: 'audius', requestedById,
  };
}

async function getJson<T>(url: string, unavailable: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'ZYTHERON-Discord-Bot' } });
  } catch {
    throw new UserError(unavailable);
  }
  if (res.status === 404) return null as T;
  if (!res.ok) throw new UserError(unavailable);
  return (await res.json().catch(() => null)) as T;
}

const SEARCH_DOWN = 'Music search is not responding right now. Please try again in a moment.';

async function searchAudius(query: string, requestedById: string): Promise<Track> {
  const body = await getJson<{ data?: AudiusTrack[] }>(`${AUDIUS_API}/tracks/search?query=${encodeURIComponent(query)}&limit=20&app_name=${APP_NAME}`, SEARCH_DOWN);
  const hit = body?.data?.find(isPlayable);
  if (!hit) throw new UserError(`I found nothing playable for **${query.slice(0, 100)}**. ZYTHERON searches the Audius music catalog. Try other words, or give a direct link to an audio file.`);
  return fromAudius(hit, requestedById);
}

async function resolveAudiusLink(link: string, requestedById: string): Promise<Track> {
  const path = new URL(link).pathname.replace(/^\/|\/$/g, '');
  if (path.split('/').length !== 2) throw new UserError('Only Audius links to a single track can be played.');
  const body = await getJson<{ data?: AudiusTrack[] }>(`${AUDIUS_API}/tracks?permalink=${encodeURIComponent(path)}&app_name=${APP_NAME}`, SEARCH_DOWN);
  const hit = body?.data?.[0];
  if (!hit) throw new UserError('That Audius track could not be found. It may have been removed.');
  if (!isPlayable(hit)) throw new UserError(`**${hit.title}** is not available to stream. Its owner may have restricted it.`);
  return fromAudius(hit, requestedById);
}

async function resolveDirectLink(link: string, requestedById: string, opts: OpenOptions): Promise<Track> {
  const res = await openStream(link, opts);
  res.destroy(); // this was only a check
  const type = String(res.headers['content-type'] ?? '').split(';')[0]!.trim();
  const { pathname } = new URL(link);
  const generic = type === '' || /^(application\/octet-stream|binary\/octet-stream)$/i.test(type);
  if (!AUDIO_TYPES.test(type) && !(generic && AUDIO_EXTENSION.test(pathname))) {
    throw new UserError('That link is not an audio file or stream. Use a direct link to audio, such as one ending in .mp3 or .ogg.');
  }
  let name = pathname.split('/').pop() ?? '';
  try { name = decodeURIComponent(name); } catch { /* keep the raw name */ }
  return { key: `direct:${link}`, title: name.replace(AUDIO_EXTENSION, '').trim() || new URL(link).hostname, artist: 'Direct link', url: link, durationSec: null, artwork: null, pageUrl: link, source: 'direct', requestedById };
}

/** What a YouTube or Spotify link says the song is. Its audio is never used. */
export interface SongInfo { title: string; artist: string | null; durationSec: number | null; url: string; thumbnail?: string | null }

const NOISE = /[([{][^)\]}]*\b(official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|mv|m\/v|remaster(ed)?|explicit|clean|feat|ft|featuring)\b[^)\]}]*[)\]}]/gi;
/** Words that mean a different recording, so they must never be matched by accident. */
const VARIANTS = new Set(['remix', 'live', 'cover', 'instrumental', 'karaoke', 'acoustic', 'sped', 'slowed', 'reverb', 'nightcore', 'mashup', 'edit', 'bootleg', 'tribute', 'type', 'beat', 'mix', 'version', 'demo']);
const DURATION_TOLERANCE_SEC = 15;
const MAX_EXTRA_WORDS = 1;

export const cleanSongTitle = (title: string): string => title.replace(NOISE, ' ').replace(/\s(feat\.?|ft\.?|featuring)\s.*$/i, ' ').replace(/\s+/g, ' ').trim();

const words = (text: string): string[] => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').match(/[\p{L}\p{N}]+/gu) ?? [];

/** Video titles are usually "Artist - Song (Official Video)". Otherwise the channel is the artist. */
export function readVideoTitle(rawTitle: string, channel: string): { title: string; artist: string | null } {
  const cleaned = cleanSongTitle(rawTitle);
  const split = /^(.+?)\s+[-–—|]\s+(.+)$/.exec(cleaned);
  if (split) return { artist: split[1]!.trim(), title: split[2]!.trim() };
  const artist = channel.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s*Official.*$/i, '').trim();
  return { title: cleaned, artist: artist || null };
}

/** True only when a track is clearly the same recording. Playing nothing beats playing the wrong song. */
export function isConfidentMatch(song: SongInfo, candidate: { title: string; artist: string; durationSec: number | null }): boolean {
  if (!song.artist) return false;
  const wanted = words(cleanSongTitle(song.title));
  const artist = words(song.artist);
  const candidateArtist = words(candidate.artist);
  const candidateTitle = words(cleanSongTitle(candidate.title));
  if (!wanted.length || !artist.length || !candidateArtist.length) return false;
  if (!artist.every((w) => candidateArtist.includes(w)) && !candidateArtist.every((w) => artist.includes(w))) return false;
  if (!wanted.every((w) => candidateTitle.includes(w))) return false;
  const extra = candidateTitle.filter((w) => !wanted.includes(w) && !artist.includes(w));
  if (extra.length > MAX_EXTRA_WORDS || extra.some((w) => VARIANTS.has(w))) return false;
  if (song.durationSec && candidate.durationSec && Math.abs(song.durationSec - candidate.durationSec) > DURATION_TOLERANCE_SEC) return false;
  return true;
}

/** Looks for the same song on Audius. Null means no confident match. */
export async function findMatch(song: SongInfo, requestedById: string): Promise<Track | null> {
  const title = cleanSongTitle(song.title);
  for (const query of song.artist ? [`${song.artist} ${title}`, title] : []) {
    const body = await getJson<{ data?: AudiusTrack[] }>(`${AUDIUS_API}/tracks/search?query=${encodeURIComponent(query)}&limit=20&app_name=${APP_NAME}`, SEARCH_DOWN);
    const hit = body?.data?.filter(isPlayable).map((t) => fromAudius(t, requestedById)).find((t) => isConfidentMatch(song, t));
    if (hit) return hit;
  }
  return null;
}

/** Turns what someone typed in /play into a track. Throws a UserError that explains any failure. */
export async function resolveTrack(input: string, requestedById: string, opts: OpenOptions = {}): Promise<Track> {
  const query = input.trim();
  if (!query) throw new UserError('Tell me which song to play.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(query)) return searchAudius(query, requestedById);
  let url: URL;
  try {
    url = new URL(query);
  } catch {
    throw new UserError('That is not a valid link.');
  }
  const restricted = RESTRICTED.find(([pattern]) => pattern.test(url.hostname));
  if (restricted) {
    const hint = restricted[1] === 'YouTube' ? 'Use `/youtube` to search it and watch together in voice, or `/play` with a song name.' : 'Try `/play` with the song name, or a direct link to an audio file.';
    throw new UserError(`**${restricted[1]}** links are not supported, because that service does not permit bots to play its audio. ${hint}`);
  }
  if (/(^|\.)audius\.co$/i.test(url.hostname)) return resolveAudiusLink(query, requestedById);
  return resolveDirectLink(query, requestedById, opts);
}

export interface Lyrics { title: string; artist: string; text: string }

/** Lyrics from LRCLIB, an open database with no key. Null means none were found. */
export async function findLyrics(query: string): Promise<Lyrics | null> {
  const results = await getJson<Array<{ trackName?: string; artistName?: string; plainLyrics?: string | null; instrumental?: boolean }>>(`${LRCLIB_API}/search?q=${encodeURIComponent(query)}`, 'The lyrics service is not responding right now. Please try again in a moment.');
  const hit = results?.find?.((r) => r.plainLyrics?.trim());
  return hit ? { title: hit.trackName ?? query, artist: hit.artistName ?? 'Unknown artist', text: hit.plainLyrics!.trim() } : null;
}
