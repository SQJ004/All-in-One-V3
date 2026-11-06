import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, InviteTargetType, PermissionFlagsBits as P, type BaseMessageOptions, type VoiceBasedChannel } from 'discord.js';
import { getEnv } from '../../config/env.js';
import { commandBlockReason } from '../../core/commandRules.js';
import { logger } from '../../core/logger.js';
import type { DualCommand } from '../../core/textCommands.js';
import { UserError, type ComponentHandler } from '../../core/types.js';
import { truncate } from '../../core/util.js';
import { ICONS, panelEmbed } from '../../ui/theme.js';
import { readVideoTitle, type SongInfo } from './sources.js';

/**
 * YouTube search, song details, and Discord's own Watch Together activity. ZYTHERON never plays
 * YouTube audio itself: the Data API has no audio, and YouTube's terms forbid extracting it.
 */
const API_URL = 'https://www.googleapis.com/youtube/v3';
const RESULTS = 5;
/** Discord's official Watch Together activity. */
const WATCH_TOGETHER_APP_ID = '880218394199220334';
const INVITE_LIFETIME_SEC = 3600;

/** Replaced by automated tests. */
export const youtubeConfig = { key: (): string | undefined => getEnv().YOUTUBE_API_KEY };

export interface YoutubeResult { id: string; title: string; channel: string; thumbnail: string | null }

const ENTITIES: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' };
const decode = (text: string) => text.replace(/&(amp|quot|#39|lt|gt);/g, (m) => ENTITIES[m] ?? m);

const SEARCH_DOWN = 'YouTube search is not responding right now. Please try again in a moment.';

/** The key goes only in the request. It is never logged or shown, whatever goes wrong. */
async function youtubeGet<T>(path: string, query: Record<string, string>): Promise<T> {
  const key = youtubeConfig.key();
  if (!key) throw new UserError('YouTube is not set up yet. Site owner: put your key in `YOUTUBE_API_KEY` in the .env file, then restart.');
  let res: Response;
  try {
    res = await fetch(`${API_URL}/${path}?${new URLSearchParams({ ...query, key })}`, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new UserError(SEARCH_DOWN);
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: { errors?: Array<{ reason?: string }> } }) | null;
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason ?? 'unknown';
    logger.warn({ status: res.status, reason }, 'YouTube request failed');
    if (reason === 'playlistNotFound' || reason === 'playlistItemsNotAccessible') return { items: [] } as T;
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || reason === 'rateLimitExceeded') throw new UserError('YouTube search has reached its daily limit. It should work again tomorrow.');
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new UserError('YouTube rejected the search key. Site owner: check `YOUTUBE_API_KEY` and that the YouTube Data API is enabled for it.');
    throw new UserError(SEARCH_DOWN);
  }
  return (body ?? {}) as T;
}

interface Snippet { title?: string; channelTitle?: string; videoOwnerChannelTitle?: string; thumbnails?: { medium?: { url?: string }; high?: { url?: string } }; resourceId?: { videoId?: string } }

export async function searchYoutube(query: string): Promise<YoutubeResult[]> {
  const body = await youtubeGet<{ items?: Array<{ id?: { videoId?: string }; snippet?: Snippet }> }>('search', { part: 'snippet', type: 'video', maxResults: String(RESULTS), safeSearch: 'moderate', q: query });
  return (body.items ?? []).filter((item) => item.id?.videoId).map((item) => ({
    id: item.id!.videoId!,
    title: decode(item.snippet?.title ?? 'Untitled'),
    channel: decode(item.snippet?.channelTitle ?? 'Unknown channel'),
    thumbnail: item.snippet?.thumbnails?.medium?.url ?? null,
  }));
}

/** Reads PT3M20S and similar. */
export function parseIsoDuration(text: string | undefined): number | null {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(text ?? '');
  if (!m || !text || text === 'P0D') return null;
  return Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

const songFrom = (id: string, snippet: Snippet | undefined, durationSec: number | null): SongInfo => {
  const { title, artist } = readVideoTitle(decode(snippet?.title ?? ''), decode(snippet?.videoOwnerChannelTitle ?? snippet?.channelTitle ?? ''));
  return { title, artist, durationSec, url: `https://www.youtube.com/watch?v=${id}`, thumbnail: snippet?.thumbnails?.high?.url ?? snippet?.thumbnails?.medium?.url ?? null };
};

/** Song details for one video, or null if YouTube has no such video. */
export async function getYoutubeVideo(id: string): Promise<SongInfo | null> {
  const body = await youtubeGet<{ items?: Array<{ snippet?: Snippet; contentDetails?: { duration?: string } }> }>('videos', { part: 'snippet,contentDetails', id });
  const item = body.items?.[0];
  return item ? songFrom(id, item.snippet, parseIsoDuration(item.contentDetails?.duration)) : null;
}

export async function getYoutubePlaylist(id: string, limit: number): Promise<{ title: string; songs: SongInfo[]; totalItems: number }> {
  const [info, list] = await Promise.all([
    youtubeGet<{ items?: Array<{ snippet?: Snippet }> }>('playlists', { part: 'snippet', id }),
    youtubeGet<{ items?: Array<{ snippet?: Snippet }>; pageInfo?: { totalResults?: number } }>('playlistItems', { part: 'snippet', playlistId: id, maxResults: String(Math.min(limit, 50)) }),
  ]);
  const items = (list.items ?? []).filter((i) => i.snippet?.resourceId?.videoId && !/^(Private|Deleted) video$/.test(i.snippet.title ?? ''));
  const ids = items.map((i) => i.snippet!.resourceId!.videoId!);
  // Lengths need a second request, and they make matches much more reliable.
  const details = ids.length ? await youtubeGet<{ items?: Array<{ id?: string; contentDetails?: { duration?: string } }> }>('videos', { part: 'contentDetails', id: ids.join(',') }) : { items: [] };
  const lengths = new Map((details.items ?? []).map((d) => [d.id, parseIsoDuration(d.contentDetails?.duration)]));
  return {
    title: decode(info.items?.[0]?.snippet?.title ?? 'YouTube playlist'),
    songs: items.map((i) => songFrom(i.snippet!.resourceId!.videoId!, i.snippet, lengths.get(i.snippet!.resourceId!.videoId!) ?? null)),
    totalItems: list.pageInfo?.totalResults ?? items.length,
  };
}

export const togetherRow = () => new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId('youtube:together').setEmoji('📺').setLabel('Watch Together').setStyle(ButtonStyle.Primary),
);

export const youtubeCommand: DualCommand = {
  name: 'youtube', description: 'Search YouTube, or watch it together in voice', aliases: ['yt'], cooldownSec: 5,
  option: { name: 'search', description: 'What to search for. Leave empty to just start Watch Together', kind: 'string', maxLength: 200, shown: '[search]' },
  async run(ctx, arg): Promise<BaseMessageOptions> {
    if (!arg) {
      return { embeds: [panelEmbed('YouTube', 'Join a voice channel and press **Watch Together** to watch and listen with everyone there, using Discord\'s own YouTube activity.')], components: [togetherRow()] };
    }
    await ctx.working();
    const results = await searchYoutube(arg);
    if (!results.length) throw new UserError(`YouTube found nothing for **${truncate(arg, 100)}**.`);
    const lines = results.map((r, n) => `\`${n + 1}.\` [${truncate(r.title, 80).replace(/[[\]]/g, '')}](https://www.youtube.com/watch?v=${r.id})\n${ICONS.dot} ${truncate(r.channel, 60)}`);
    const embed = panelEmbed(truncate(`YouTube results for ${arg}`, 240), `${lines.join('\n')}\n\nPress **Watch Together** to watch with people in your voice channel.`).setFooter({ text: 'Results from YouTube' });
    if (results[0]!.thumbnail) embed.setThumbnail(results[0]!.thumbnail);
    return { embeds: [embed], components: [togetherRow()], allowedMentions: { parse: [] } };
  },
};

async function createTogetherInvite(channel: VoiceBasedChannel): Promise<string> {
  try {
    const invite = await channel.createInvite({ targetType: InviteTargetType.EmbeddedApplication, targetApplication: WATCH_TOGETHER_APP_ID, maxAge: INVITE_LIFETIME_SEC });
    return invite.url;
  } catch (err) {
    logger.warn({ err: (err as Error).message, code: (err as { code?: unknown }).code }, 'Could not create a Watch Together invite');
    throw new UserError('Discord would not start Watch Together here. Please try again in a moment.');
  }
}

export const watchTogetherButton: ComponentHandler = {
  prefix: 'youtube:together',
  async run(i) {
    if (!i.isButton() || !i.inCachedGuild()) return;
    const blocked = await commandBlockReason(i.guildId, 'youtube', i.member, i.channel);
    if (blocked) throw new UserError(blocked);
    const channel = i.member.voice?.channel;
    if (!channel) throw new UserError('Join a voice channel first, then press **Watch Together**.');
    if (channel.type !== ChannelType.GuildVoice) throw new UserError('Watch Together needs a regular voice channel.');
    const me = i.guild.members.me;
    if (!me || !channel.permissionsFor(me).has([P.ViewChannel, P.CreateInstantInvite])) throw new UserError(`I need **View Channel** and **Create Invite** in <#${channel.id}>. Ask an admin to give me those permissions.`);
    const url = await createTogetherInvite(channel);
    await i.reply({
      allowedMentions: { parse: [] },
      embeds: [panelEmbed('Watch Together', `<@${i.user.id}> started YouTube in <#${channel.id}>. Press the button to join.`)],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Join Watch Together').setURL(url))],
    });
  },
};
