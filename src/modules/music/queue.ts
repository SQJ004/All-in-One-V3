import { UserError } from '../../core/types.js';

export interface Track {
  /** Identifies the song, so the same one is not queued twice. */
  key: string;
  title: string;
  artist: string;
  url: string;
  /** Null until known. Direct links learn it once playback starts, and live streams never do. */
  durationSec: number | null;
  artwork: string | null;
  pageUrl: string | null;
  source: 'audius' | 'direct';
  requestedById: string;
  /** Shown once when the song is added, if it may not be exactly what was asked for. */
  note?: string;
}

export const MAX_QUEUE = 200;
const MAX_HISTORY = 25;

/** One server's song order. It holds no audio, so a server's queue cannot touch another's. */
export class MusicQueue {
  current: Track | null = null;
  upcoming: Track[] = [];
  history: Track[] = [];
  loop = false;

  /** Returns the position in the upcoming list, or 0 if the track can start right now. */
  add(track: Track): number {
    if (this.current?.key === track.key || this.upcoming.some((t) => t.key === track.key)) throw new UserError(`**${track.title}** is already in the queue.`);
    if (this.upcoming.length >= MAX_QUEUE) throw new UserError(`The queue is full (${MAX_QUEUE} songs). Remove some or wait for them to play.`);
    this.upcoming.push(track);
    return this.current ? this.upcoming.length : 0;
  }

  /** Moves on when a song ends by itself. Song loop repeats it. */
  advance(): Track | null {
    return this.loop && this.current ? this.current : this.skip();
  }

  /** Moves on regardless of loop, because someone asked to or the song cannot play. */
  skip(): Track | null {
    if (this.current) {
      this.history.push(this.current);
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }
    this.current = this.upcoming.shift() ?? null;
    return this.current;
  }

  previous(): Track | null {
    const track = this.history.pop();
    if (!track) return null;
    if (this.current) this.upcoming.unshift(this.current);
    this.current = track;
    return track;
  }

  shuffle(random: () => number = Math.random): void {
    for (let n = this.upcoming.length - 1; n > 0; n--) {
      const m = Math.floor(random() * (n + 1));
      [this.upcoming[n], this.upcoming[m]] = [this.upcoming[m]!, this.upcoming[n]!];
    }
  }

  /** Position is the number shown in /queue, starting at 1. */
  remove(position: number): Track {
    const [removed] = position >= 1 ? this.upcoming.splice(position - 1, 1) : [];
    if (!removed) throw new UserError(this.upcoming.length ? `Pick a position from 1 to ${this.upcoming.length}.` : 'There are no upcoming songs to remove.');
    return removed;
  }

  clearUpcoming(): number {
    const count = this.upcoming.length;
    this.upcoming = [];
    return count;
  }

  reset(): void {
    this.current = null;
    this.upcoming = [];
    this.history = [];
  }
}
