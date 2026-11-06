import { ActionRowBuilder, type BaseMessageOptions, ButtonBuilder, type EmbedBuilder, ButtonStyle, ChannelType, Events, PermissionFlagsBits as P, SlashCommandBuilder, type Guild, type GuildMember, type GuildTextBasedChannel, type Message, type MessageEditOptions } from 'discord.js';
import { getEnv } from '../../config/env.js';
import { getConfig, updateConfig } from '../../core/configService.js';
import { logger } from '../../core/logger.js';
import { textCommandListener, toSlashCommand, type CommandContext, type DualCommand } from '../../core/textCommands.js';
import { on, UserError, type VortexModule } from '../../core/types.js';
import { progressBar, truncate } from '../../core/util.js';
import { baseEmbed, COLORS, failEmbed, ICONS, infoEmbed, okEmbed, panelEmbed } from '../../ui/theme.js';
import { formatTime, GuildPlayer, parseTime, type PlayerDeps } from './player.js';
import type { Track } from './queue.js';
import { resolveLinked, resolvePlayable, type LinkedResult } from './links.js';
import { findLyrics } from './sources.js';
import { joinVoice } from './voice.js';
import { watchTogetherButton, youtubeCommand } from './youtube.js';

const REFRESH_MS = 15_000;
const QUEUE_LINES = 15;
const LYRICS_MAX = 3900;

/** One entry per server that is using music. Nothing about playback is shared between them. */
interface Session {
  player: GuildPlayer;
  channel: GuildTextBasedChannel | null;
  message: Message | null;
  ticker: NodeJS.Timeout;
  /** Keeps embed edits in order, so a slow edit cannot overwrite a newer one. */
  render: Promise<unknown>;
}

const sessions = new Map<string, Session>();

/** Replaced by automated tests, which have no Discord to connect to. */
export const runtime: { deps: Partial<PlayerDeps>; resolve: typeof resolvePlayable; resolveLinked: typeof resolveLinked } = { deps: {}, resolve: resolvePlayable, resolveLinked };

const describeTrack = (t: Track): string => {
  const title = truncate(t.title, 70).replace(/[[\]]/g, '');
  return t.pageUrl ? `[${title}](${t.pageUrl})` : `**${title}**`;
};

/** Builds the player. Exported so its contents can be tested. */
export function playerPayload(player: GuildPlayer): Required<Pick<MessageEditOptions, 'embeds' | 'components'>> {
  const { queue } = player;
  const track = queue.current;
  if (!track) {
    return { embeds: [panelEmbed('Music Player', 'The queue is finished. Use `/play` to add more songs.', COLORS.muted)], components: [] };
  }
  const position = player.positionSec;
  const progress = track.durationSec
    ? `${progressBar(Math.min(1, position / track.durationSec), 18)}\n\`${formatTime(position)} / ${formatTime(track.durationSec)}\``
    : `\`${formatTime(position)}\` ${ICONS.dot} Length unknown`;
  const nextUp = queue.upcoming[0];
  const embed = baseEmbed(player.paused ? COLORS.warning : COLORS.primary)
    .setAuthor({ name: player.paused ? 'Paused' : 'Now Playing' })
    .setTitle(truncate(track.title, 200))
    .setDescription(`by **${truncate(track.artist, 100)}**\n\n${progress}`)
    .addFields(
      { name: 'Requested by', value: `<@${track.requestedById}>`, inline: true },
      { name: 'Volume', value: `${player.volume}%`, inline: true },
      { name: 'Song loop', value: queue.loop ? 'On' : 'Off', inline: true },
      { name: 'Queue', value: queue.upcoming.length ? `${queue.upcoming.length} upcoming${nextUp ? `\nNext: ${describeTrack(nextUp)}` : ''}` : 'No upcoming songs' },
    );
  if (track.pageUrl) embed.setURL(track.pageUrl);
  if (track.artwork) embed.setThumbnail(track.artwork);
  const button = (id: string, emoji: string, label: string, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(`music:${id}`).setEmoji(emoji).setLabel(label).setStyle(style);
  return {
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      button('toggle', '⏯️', player.paused ? 'Resume' : 'Pause', ButtonStyle.Primary),
      button('skip', '⏭️', 'Skip'),
      button('stop', '⏹️', 'Stop', ButtonStyle.Danger),
      button('loop', '🔁', 'Loop', queue.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
      button('shuffle', '🔀', 'Shuffle'),
    )],
  };
}

/** Edits the player message in place, or posts a new one if it was deleted. */
function refresh(session: Session): void {
  session.render = session.render.then(async () => {
    const payload = playerPayload(session.player);
    if (session.message) {
      try {
        await session.message.edit(payload);
        return;
      } catch {
        session.message = null;
      }
    }
    if (session.player.queue.current && session.channel) session.message = await session.channel.send(payload);
  }).catch((err) => logger.warn({ err: (err as Error).message, guildId: session.player.guildId }, 'Could not update the music player'));
}

function closeSession(guildId: string): void {
  const session = sessions.get(guildId);
  if (!session) return;
  clearInterval(session.ticker);
  sessions.delete(guildId);
  // Stale buttons would only produce errors once the player is gone.
  session.render = session.render.then(() => session.message?.edit({ embeds: [panelEmbed('Music Player', 'The player has closed. Use `/play` to start again.', COLORS.muted)], components: [] })).catch(() => undefined);
}

async function sessionFor(guild: Guild): Promise<Session> {
  const existing = sessions.get(guild.id);
  if (existing) return existing;
  const { music } = await getConfig(guild.id);
  // Another request may have created it while the settings loaded.
  const raced = sessions.get(guild.id);
  if (raced) return raced;
  const deps: PlayerDeps = {
    join: (channelId, onLost) => joinVoice(guild, channelId, onLost),
    changed: () => refresh(session),
    notify: (message) => { void session.channel?.send({ embeds: [infoEmbed(message)] }).catch(() => undefined); },
    closed: () => closeSession(guild.id),
    idleMs: getEnv().MUSIC_IDLE_TIMEOUT_SECONDS * 1000,
    ...runtime.deps,
  };
  const session: Session = {
    player: new GuildPlayer(guild.id, deps, music.volume),
    channel: null,
    message: null,
    render: Promise.resolve(),
    ticker: setInterval(() => { if (session.player.queue.current && !session.player.paused) refresh(session); }, REFRESH_MS),
  };
  session.ticker.unref();
  sessions.set(guild.id, session);
  return session;
}

/** The voice channel someone is in, after checking the bot can use it. */
function usableVoiceChannel(member: GuildMember) {
  const channel = member.voice?.channel;
  if (!channel) throw new UserError('Join a voice channel first, then use `/play`.');
  if (channel.type === ChannelType.GuildStageVoice) throw new UserError('Stage channels are not supported. Join a regular voice channel.');
  const me = member.guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  const missing = [[P.ViewChannel, 'View Channel'], [P.Connect, 'Connect'], [P.Speak, 'Speak']].filter(([bit]) => !perms?.has(bit as bigint)).map(([, name]) => name);
  if (missing.length) throw new UserError(`I am missing **${missing.join(', ')}** in <#${channel.id}>. Ask an admin to give me those permissions.`);
  if (!channel.joinable && !channel.members.has(member.guild.members.me!.id)) throw new UserError(`<#${channel.id}> is full, so I cannot join it.`);
  return channel;
}

/** Controls need an active player and the person must be listening, so nobody can disrupt from outside. */
function controlSession(guildId: string, member: GuildMember): Session {
  const session = sessions.get(guildId);
  if (!session?.player.channelId) throw new UserError('Nothing is playing right now. Use `/play` to start some music.');
  if (member.voice?.channelId !== session.player.channelId) throw new UserError(`Join <#${session.player.channelId}> to control the music.`);
  return session;
}

const done = (message: string): BaseMessageOptions => ({ embeds: [okEmbed(message)] });

/** A command that changes the music, so only people listening can use it. */
const control = (name: string, description: string, aliases: string[], run: (session: Session) => string): DualCommand => ({
  name, description, aliases,
  run: (ctx) => done(run(controlSession(ctx.guild.id, ctx.member))),
});

/** Discord checks these numbers for slash commands, but v! commands are free text. */
function wholeNumber(arg: string | null, message: string): number {
  const value = Number(arg);
  if (!Number.isInteger(value)) throw new UserError(message);
  return value;
}

/** Adds the thumbnail and length that YouTube or Spotify gave for the link. */
function withSongDetails(embed: EmbedBuilder, linked: LinkedResult): EmbedBuilder {
  const thumbnail = linked.song?.thumbnail ?? linked.thumbnail;
  if (thumbnail) embed.setThumbnail(thumbnail);
  if (linked.song?.durationSec) embed.addFields({ name: 'Length', value: formatTime(linked.song.durationSec), inline: true });
  return embed;
}

/** The link worked, but nothing may be played. Saying so beats playing the wrong song, and /play offers nothing but music. */
function noPermittedSource(linked: LinkedResult): BaseMessageOptions {
  const what = linked.total > 1 ? `None of the ${linked.total} songs I checked in **${truncate(linked.label, 150)}** can be played` : `**${truncate(linked.label, 150)}** can't be played`;
  return {
    embeds: [withSongDetails(failEmbed(`${what}. ${linked.service} doesn't allow bots to play its audio, and ${linked.total > 1 ? 'those songs are' : 'this song is'} not on Audius, the source ZYTHERON plays from. Nothing was added.`), linked)],
    allowedMentions: { parse: [] },
  };
}

function addPlaylist(session: Session, linked: LinkedResult): string {
  let added = 0;
  for (const track of linked.tracks) {
    try {
      session.player.enqueue(track);
      added += 1;
    } catch (err) {
      if (!(err instanceof UserError)) throw err; // already queued, or the queue is full
    }
  }
  const beyond = linked.beyondLimit ? ` I only checked the first ${linked.total} songs.` : '';
  return `Added **${added} of ${linked.total}** songs from **${truncate(linked.label, 100)}**. The others have no source ZYTHERON is allowed to play, or were already queued.${beyond}`;
}

const DEFINITIONS: DualCommand[] = [
  {
    name: 'play', description: 'Play a song by name or link', aliases: ['p'], cooldownSec: 2,
    option: { name: 'song', description: 'Song name, or a YouTube, Spotify, Audius or direct audio link', kind: 'string', required: true, maxLength: 500, shown: '<song or link>' },
    async run(ctx, arg) {
      const channel = usableVoiceChannel(ctx.member);
      const current = sessions.get(ctx.guild.id);
      if (current?.player.channelId && current.player.channelId !== channel.id && current.player.queue.current) {
        throw new UserError(`I am already playing in <#${current.player.channelId}>. Join that channel to add songs.`);
      }
      await ctx.working();
      const linked = await runtime.resolveLinked(arg ?? '', ctx.userId);
      if (linked && !linked.tracks.length) return noPermittedSource(linked);
      const tracks = linked ? linked.tracks : [await runtime.resolve(arg ?? '', ctx.userId)];
      const session = await sessionFor(ctx.guild);
      if (ctx.channel) session.channel = ctx.channel;
      try {
        await session.player.connect(channel.id);
      } catch (err) {
        if (!session.player.queue.current) session.player.close();
        throw err;
      }
      if (linked && linked.total > 1) return { embeds: [withSongDetails(okEmbed(addPlaylist(session, linked)), linked)] };
      const track = tracks[0]!;
      track.artwork ??= linked?.song?.thumbnail ?? null;
      const position = session.player.enqueue(track);
      const link = describeTrack(track);
      const from = linked ? ` Matched from your ${linked.service} link.` : '';
      const note = track.note ? ` ${track.note}` : '';
      const message = `${position === 0 ? `Starting ${link} by **${truncate(track.artist, 80)}**.` : `Added ${link} to the queue at position **${position}**.`}${from}${note}`;
      return linked ? { embeds: [withSongDetails(okEmbed(message), linked)] } : done(message);
    },
  },
  control('pause', 'Pause the current song', [], ({ player }) => { player.pause(); return 'Paused. Use `/resume` to continue.'; }),
  control('resume', 'Resume the current song', ['unpause'], ({ player }) => { player.resume(); return 'Resumed.'; }),
  control('skip', 'Skip the current song', ['s'], ({ player }) => `Skipped ${describeTrack(player.skip())}.`),
  control('stop', 'Stop the music and clear the queue', [], ({ player }) => { player.stop(); return 'Stopped the music and cleared the queue.'; }),
  {
    name: 'leave', description: 'Stop the music and leave the voice channel', aliases: ['dc', 'disconnect'],
    run(ctx) {
      if (!sessions.get(ctx.guild.id)?.player.channelId) throw new UserError('I am not in a voice channel.');
      controlSession(ctx.guild.id, ctx.member).player.close();
      return done('Left the voice channel and cleared the queue.');
    },
  },
  {
    name: 'queue', description: 'See the current song and upcoming songs', aliases: ['q'],
    run(ctx) {
      const queue = sessions.get(ctx.guild.id)?.player.queue;
      if (!queue?.current) throw new UserError('The queue is empty. Use `/play` to add a song.');
      const lines = queue.upcoming.slice(0, QUEUE_LINES).map((t, n) => `\`${n + 1}.\` ${describeTrack(t)} ${ICONS.dot} ${t.durationSec ? formatTime(t.durationSec) : 'Unknown length'} ${ICONS.dot} <@${t.requestedById}>`);
      if (queue.upcoming.length > QUEUE_LINES) lines.push(`and ${queue.upcoming.length - QUEUE_LINES} more`);
      const total = queue.upcoming.reduce((sum, t) => sum + (t.durationSec ?? 0), 0);
      return {
        allowedMentions: { parse: [] },
        embeds: [panelEmbed('Music Queue', truncate(`**Now playing:** ${describeTrack(queue.current)} ${ICONS.dot} <@${queue.current.requestedById}>\n\n${lines.join('\n') || 'No upcoming songs.'}`, 4000))
          .addFields({ name: 'Upcoming', value: `${queue.upcoming.length} ${queue.upcoming.length === 1 ? 'song' : 'songs'}${total ? ` ${ICONS.dot} ${formatTime(total)}` : ''}`, inline: true }, { name: 'Song loop', value: queue.loop ? 'On' : 'Off', inline: true })],
      };
    },
  },
  {
    name: 'nowplaying', description: 'Show the song playing now', aliases: ['np'],
    run(ctx) {
      const session = sessions.get(ctx.guild.id);
      if (!session?.player.queue.current) throw new UserError('Nothing is playing right now. Use `/play` to start some music.');
      return { ...playerPayload(session.player), allowedMentions: { parse: [] } } as BaseMessageOptions;
    },
  },
  {
    name: 'volume', description: 'Set the music volume for this server', aliases: ['vol'],
    option: { name: 'level', description: 'Volume from 1 to 100', kind: 'integer', required: true, min: 1, max: 100, shown: '<1-100>' },
    async run(ctx, arg) {
      const session = controlSession(ctx.guild.id, ctx.member);
      const level = wholeNumber(arg, 'Pick a volume from 1 to 100.');
      if (level < 1 || level > 100) throw new UserError('Pick a volume from 1 to 100.');
      session.player.setVolume(level);
      await updateConfig(ctx.guild.id, 'music', { volume: level });
      return done(`Volume set to **${level}%**.`);
    },
  },
  control('loop', 'Turn looping of the current song on or off', ['repeat'], ({ player }) => (player.toggleLoop() ? 'Song loop is **on**.' : 'Song loop is **off**.')),
  control('shuffle', 'Shuffle the upcoming songs', [], ({ player }) => { player.shuffle(); return 'Shuffled the upcoming songs.'; }),
  {
    name: 'remove', description: 'Remove a song from the queue', aliases: ['rm'],
    option: { name: 'position', description: 'Its number in /queue', kind: 'integer', required: true, min: 1, shown: '<position>' },
    run(ctx, arg) {
      const session = controlSession(ctx.guild.id, ctx.member);
      return done(`Removed ${describeTrack(session.player.remove(wholeNumber(arg, "Use the song's number from the queue.")))} from the queue.`);
    },
  },
  control('clearqueue', 'Clear all upcoming songs', ['clear'], ({ player }) => { const n = player.clearQueue(); return `Cleared **${n}** upcoming ${n === 1 ? 'song' : 'songs'}.`; }),
  control('previous', 'Play the previous song', ['prev', 'back'], ({ player }) => `Going back to ${describeTrack(player.previous())}.`),
  {
    name: 'seek', description: 'Jump to a time in the current song',
    option: { name: 'time', description: 'For example 90, 1:30 or 1:02:03', kind: 'string', required: true, maxLength: 10, shown: '<time>' },
    run(ctx, arg) {
      const session = controlSession(ctx.guild.id, ctx.member);
      const seconds = parseTime(arg ?? '');
      if (seconds === null) throw new UserError('Use a time like `90`, `1:30` or `1:02:03`.');
      session.player.seek(seconds);
      return done(`Jumped to **${formatTime(seconds)}**.`);
    },
  },
  {
    name: 'lyrics', description: 'Find the lyrics of a song', aliases: ['ly'], cooldownSec: 5,
    option: { name: 'song', description: 'Song name. Leave empty for the current song', kind: 'string', maxLength: 200, shown: '[song]' },
    async run(ctx, arg) {
      const current = sessions.get(ctx.guild.id)?.player.queue.current;
      const query = arg ?? (current ? `${current.artist === 'Direct link' ? '' : current.artist} ${current.title}`.trim() : null);
      if (!query) throw new UserError('Nothing is playing, so tell me which song to look up.');
      await ctx.working();
      const lyrics = await findLyrics(query);
      if (!lyrics) throw new UserError(`I could not find lyrics for **${truncate(query, 100)}**.`);
      const text = lyrics.text.length > LYRICS_MAX ? `${lyrics.text.slice(0, LYRICS_MAX).trimEnd()}\n\n*The lyrics are too long to show in full.*` : lyrics.text;
      return { embeds: [panelEmbed(truncate(`${lyrics.title} by ${lyrics.artist}`, 240), text).setFooter({ text: 'Lyrics from LRCLIB' })] };
    },
  },
  youtubeCommand,
];

const BUTTONS: Record<string, (session: Session) => void> = {
  toggle: ({ player }) => (player.paused ? player.resume() : player.pause()),
  skip: ({ player }) => void player.skip(),
  stop: ({ player }) => player.stop(),
  loop: ({ player }) => void player.toggleLoop(),
  shuffle: ({ player }) => player.shuffle(),
};

export const musicModule: VortexModule = {
  name: 'music',
  commands: DEFINITIONS.map(toSlashCommand),
  components: [watchTogetherButton, {
    prefix: 'music',
    async run(i, [action]) {
      if (!i.isButton() || !i.inCachedGuild()) return;
      const press = BUTTONS[action ?? ''];
      if (!press) return;
      const session = sessions.get(i.guildId);
      if (!session?.player.channelId) {
        await i.update({ embeds: [panelEmbed('Music Player', 'The player has closed. Use `/play` to start again.', COLORS.muted)], components: [] });
        return;
      }
      press(controlSession(i.guildId, i.member));
      await i.update(playerPayload(session.player));
      if (session.message?.id !== i.message.id) refresh(session);
    },
  }],
  events: [
    on(Events.MessageCreate, textCommandListener(DEFINITIONS)),
    // Leave a channel nobody is listening in, after the same timeout as being idle.
    on(Events.VoiceStateUpdate, (before, after) => {
      const session = sessions.get(after.guild.id);
      const channelId = session?.player.channelId;
      if (!session || !channelId || (before.channelId !== channelId && after.channelId !== channelId)) return;
      const channel = after.guild.channels.cache.get(channelId);
      const listeners = channel?.isVoiceBased() ? channel.members.filter((m) => !m.user.bot).size : 0;
      session.player.setAlone(listeners === 0);
    }),
  ],
};

export const activeMusicSessions = (): number => sessions.size;

/** Ends every player. Used by tests, so one test's music cannot leak into the next. */
export function closeAllMusic(): void {
  for (const session of [...sessions.values()]) session.player.close();
}
