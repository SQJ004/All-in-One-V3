import { AudioPlayerStatus, createAudioPlayer, createAudioResource, NoSubscriberBehavior, StreamType, type AudioPlayer, type AudioResource } from '@discordjs/voice';
import { logger } from '../../core/logger.js';
import { UserError } from '../../core/types.js';
import { openAudio, type AudioHandle } from './pipeline.js';
import { MusicQueue, type Track } from './queue.js';

/** A voice connection, as far as the player cares. */
export interface VoiceLink {
  channelId: string;
  subscribe(audio: AudioPlayer): void;
  move(channelId: string): void;
  destroy(): void;
}

export interface PlayerDeps {
  /** Connects to voice. onLost runs if the connection is gone for good. */
  join(channelId: string, onLost: () => void): Promise<VoiceLink>;
  open?: typeof openAudio;
  /** Something the player embed shows has changed. */
  changed(): void;
  /** Tell people in the text channel. */
  notify(message: string): void;
  /** The player has shut down and left voice. */
  closed(): void;
  idleMs: number;
  retryDelayMs?: number;
  /** Tests run without Discord, so nothing subscribes to the audio. */
  playWithoutListeners?: boolean;
}

const MAX_RETRIES = 2;

/** One server's music. Every value lives on this object, so servers cannot affect each other. */
export class GuildPlayer {
  readonly queue = new MusicQueue();
  readonly audio: AudioPlayer;
  private link: VoiceLink | null = null;
  private connecting: Promise<void> | null = null;
  private resource: AudioResource | null = null;
  private handle: AudioHandle | null = null;
  private offsetSec = 0;
  private retries = 0;
  private alone = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private isClosed = false;

  constructor(readonly guildId: string, private readonly deps: PlayerDeps, public volume: number) {
    this.audio = createAudioPlayer({ behaviors: { noSubscriber: deps.playWithoutListeners ? NoSubscriberBehavior.Play : NoSubscriberBehavior.Pause } });
    this.audio.on('error', (err) => logger.warn({ guildId, err: err.message }, 'Music playback error'));
    this.audio.on('stateChange', (before, after) => {
      if (after.status !== AudioPlayerStatus.Idle || before.status === AudioPlayerStatus.Idle) return;
      // Only the active song ending counts. Replacing or stopping it clears this.resource first.
      if (before.resource === this.resource) void this.songEnded();
    });
  }

  get channelId(): string | null { return this.link?.channelId ?? null; }
  get paused(): boolean { return this.audio.state.status === AudioPlayerStatus.Paused; }
  get positionSec(): number {
    if (!this.queue.current) return 0;
    return Math.floor(this.offsetSec + (this.resource?.playbackDuration ?? 0) / 1000);
  }

  /** Joins, or moves when nothing is playing. Two people using /play at once share one join. */
  async connect(channelId: string): Promise<void> {
    if (this.connecting) await this.connecting;
    if (this.link) {
      if (this.link.channelId === channelId) return;
      if (this.queue.current) throw new UserError(`I am already playing in <#${this.link.channelId}>. Join that channel to add songs.`);
      this.link.move(channelId);
      return;
    }
    this.connecting = this.deps.join(channelId, () => this.close('I was disconnected from voice, so the music stopped.')).then((link) => {
      link.subscribe(this.audio);
      this.link = link;
    });
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /** Adds a song, starting it if nothing is playing. Returns its queue position, or 0 if it starts now. */
  enqueue(track: Track): number {
    const position = this.queue.add(track);
    if (position === 0) {
      this.queue.skip();
      this.play(0);
    } else {
      this.update();
    }
    return position;
  }

  private play(offsetSec: number): void {
    const track = this.queue.current!;
    this.stopSource();
    this.offsetSec = offsetSec;
    const handle = (this.deps.open ?? openAudio)(track, offsetSec);
    handle.onInfo((info) => {
      if (track.source !== 'direct') return;
      track.durationSec ??= info.durationSec ?? null;
      if (info.title) track.title = info.title;
      if (info.artist) track.artist = info.artist;
      this.deps.changed();
    });
    const resource = createAudioResource(handle.pcm, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume!.setVolume(this.volume / 100);
    this.handle = handle;
    this.resource = resource;
    this.audio.play(resource);
    this.update();
  }

  private stopSource(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.resource = null;
    this.handle?.kill();
    this.handle = null;
  }

  private async songEnded(): Promise<void> {
    const handle = this.handle;
    const track = this.queue.current;
    const position = this.positionSec;
    await handle?.closed;
    if (this.handle !== handle || !track) return; // someone moved on while decoding finished
    if (handle?.failed()) {
      if (this.retries < MAX_RETRIES) {
        // Network drops are often brief, so try again from the same spot.
        this.retries += 1;
        this.resource = null;
        this.retryTimer = setTimeout(() => { if (this.queue.current === track) this.play(track.durationSec ? position : 0); }, this.deps.retryDelayMs ?? 2000);
        return;
      }
      this.deps.notify(`I could not keep playing **${track.title}**. ${handle.failure() ?? ''} Moving on.`.replace(/\s+/g, ' '));
      this.retries = 0;
      this.moveOn(this.queue.skip());
      return;
    }
    this.retries = 0;
    this.moveOn(this.queue.advance());
  }

  private moveOn(next: Track | null): void {
    if (next) return this.play(0);
    this.stopSource();
    this.update();
  }

  private requireSong(): Track {
    const track = this.queue.current;
    if (!track) throw new UserError('Nothing is playing right now. Use `/play` to start some music.');
    return track;
  }

  pause(): void {
    this.requireSong();
    if (this.paused) throw new UserError('The music is already paused. Use `/resume` to continue.');
    // The audio player ignores this while a song is still loading.
    if (!this.audio.pause(true)) throw new UserError('The song is still loading. Try again in a moment.');
    this.update();
  }

  resume(): void {
    this.requireSong();
    if (!this.paused) throw new UserError('The music is not paused.');
    this.audio.unpause();
    this.update();
  }

  skip(): Track {
    const skipped = this.requireSong();
    this.retries = 0;
    this.moveOn(this.queue.skip());
    return skipped;
  }

  previous(): Track {
    const track = this.queue.previous();
    if (!track) throw new UserError('There is no previous song yet.');
    this.retries = 0;
    this.play(0);
    return track;
  }

  stop(): void {
    this.requireSong();
    this.stopSource();
    this.queue.reset();
    this.audio.stop(true);
    this.update();
  }

  seek(seconds: number): void {
    const track = this.requireSong();
    if (track.durationSec === null) throw new UserError('This audio has no known length, so it cannot be seeked. Live streams cannot be seeked either.');
    if (seconds < 0 || seconds >= track.durationSec) throw new UserError(`Pick a time within the song. It is ${formatTime(track.durationSec)} long.`);
    this.play(seconds);
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.resource?.volume?.setVolume(volume / 100);
    this.update();
  }

  toggleLoop(): boolean {
    this.requireSong();
    this.queue.loop = !this.queue.loop;
    this.update();
    return this.queue.loop;
  }

  shuffle(): void {
    if (this.queue.upcoming.length < 2) throw new UserError('Add at least two upcoming songs before shuffling.');
    this.queue.shuffle();
    this.update();
  }

  remove(position: number): Track {
    const removed = this.queue.remove(position);
    this.update();
    return removed;
  }

  clearQueue(): number {
    const count = this.queue.clearUpcoming();
    if (!count) throw new UserError('There are no upcoming songs to clear.');
    this.update();
    return count;
  }

  /** Whether anyone but bots is still in the voice channel. */
  setAlone(alone: boolean): void {
    this.alone = alone;
    this.updateIdleTimer();
  }

  private update(): void {
    this.updateIdleTimer();
    this.deps.changed();
  }

  /** The bot stays while music is playing to someone, and leaves after the timeout otherwise. */
  private updateIdleTimer(): void {
    const idle = !this.queue.current || this.alone || this.audio.state.status === AudioPlayerStatus.Paused;
    if (!idle) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
    } else if (!this.idleTimer && !this.isClosed) {
      this.idleTimer = setTimeout(() => this.close('I left voice because nothing was playing.'), this.deps.idleMs);
      this.idleTimer.unref();
    }
  }

  /** Stops everything and leaves voice. Safe to call more than once. */
  close(message?: string): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.stopSource();
    this.queue.reset();
    this.audio.stop(true);
    this.link?.destroy();
    this.link = null;
    if (message) this.deps.notify(message);
    this.deps.closed();
  }
}

export function formatTime(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const clock = `${Math.floor(s / 60) % 60}:${String(s % 60).padStart(2, '0')}`;
  return s >= 3600 ? `${Math.floor(s / 3600)}:${clock.padStart(5, '0')}` : clock;
}

/** Accepts 90, 1:30 or 1:02:03. Null if it is none of those. */
export function parseTime(input: string): number | null {
  const text = input.trim();
  if (!/^\d+(:\d{1,2}){0,2}$/.test(text)) return null;
  const parts = text.split(':').map(Number);
  if (parts.slice(1).some((n) => n >= 60)) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
}
