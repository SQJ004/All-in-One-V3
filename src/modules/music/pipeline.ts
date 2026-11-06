import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import ffmpegStatic from 'ffmpeg-static';
import { logger } from '../../core/logger.js';
import { openStream, type OpenOptions } from './http.js';
import type { Track } from './queue.js';

const ffmpegPath = ffmpegStatic as unknown as string | null;

export interface AudioInfo { durationSec?: number; title?: string; artist?: string }

export interface AudioHandle {
  /** 48 kHz stereo 16-bit audio, ready for Discord's encoder. */
  pcm: Readable;
  /** True if the source broke, as opposed to the song simply ending. */
  failed(): boolean;
  /** Why it failed, in words safe to show. */
  failure(): string | null;
  /** Settles once decoding has fully stopped, so failed() is final. */
  closed: Promise<void>;
  /** Called when the audio file reveals its length or tags. */
  onInfo(listener: (info: AudioInfo) => void): void;
  kill(): void;
}

/**
 * The bot downloads the audio itself and hands ffmpeg only the bytes. Limiting ffmpeg to its
 * input pipe stops a crafted playlist file making it open other addresses.
 */
export function openAudio(track: Track, offsetSec: number, opts: OpenOptions = {}): AudioHandle {
  if (!ffmpegPath) throw new Error('The audio decoder is not installed. Run npm install again.');
  const args = ['-hide_banner', '-nostats', '-loglevel', 'info', '-protocol_whitelist', 'pipe', '-i', 'pipe:0'];
  if (offsetSec > 0) args.push('-ss', String(offsetSec));
  args.push('-vn', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1');
  const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  let killed = false;
  let reason: string | null = null;
  let source: { destroy(): void } | null = null;
  let contentLength = 0;
  let infoListener: ((info: AudioInfo) => void) | null = null;
  const fail = (why: string) => {
    if (killed || reason) return;
    reason = why;
    logger.warn({ track: track.key, why }, 'Music stream failed');
  };

  child.stdin.on('error', () => undefined); // expected when ffmpeg stops before the download does
  child.on('error', () => fail('The audio decoder could not run.'));
  const closed = new Promise<void>((done) => child.once('close', (code) => {
    if (code) fail('That audio could not be decoded.');
    done();
  }));

  let log = '';
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    if (!infoListener || log.length > 16_000) return;
    log += text;
    const info: AudioInfo = {};
    // ffmpeg cannot see the end of a pipe, so the length comes from the file size and bitrate.
    // A stream with no size, such as live radio, stays unknown.
    const bitrate = Number(/bitrate: (\d+) kb\/s/.exec(log)?.[1] ?? 0);
    if (bitrate && contentLength) info.durationSec = Math.round((contentLength * 8) / (bitrate * 1000));
    const tag = (name: string) => new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, 'mi').exec(log)?.[1];
    info.title = tag('title');
    info.artist = tag('artist');
    if (info.durationSec || info.title || info.artist) infoListener(info);
  });

  openStream(track.url, opts).then((res) => {
    source = res;
    contentLength = Number(res.headers['content-length'] ?? 0);
    if (killed) return res.destroy();
    res.on('error', () => fail('The connection to the audio was lost.'));
    res.once('close', () => {
      if (!res.complete) fail('The connection to the audio was lost.');
      child.stdin.destroy();
    });
    res.pipe(child.stdin);
  }, (err: Error) => {
    fail(err.message);
    child.stdin.destroy();
  });

  return {
    pcm: child.stdout,
    failed: () => reason !== null,
    failure: () => reason,
    closed,
    onInfo: (listener) => { infoListener = listener; },
    kill() {
      killed = true;
      source?.destroy();
      child.kill();
    },
  };
}
