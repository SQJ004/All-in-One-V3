import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import { logger } from '../../core/logger.js';
import { fetchPublicImage } from '../../core/safeFetch.js';

const WIDTH = 1100;
const HEIGHT = 420;

let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  fontsReady = true;
  try {
    const require = createRequire(import.meta.url);
    const dir = join(dirname(require.resolve('@fontsource/inter/package.json')), 'files');
    for (const weight of [400, 700, 800]) GlobalFonts.registerFromPath(join(dir, `inter-latin-${weight}-normal.woff2`), 'VortexInter');
  } catch (err) {
    logger.warn({ err }, 'Could not register card fonts');
  }
}

export const BACKGROUND_PRESETS: Record<string, { stops: [string, string, string]; swirl: string }> = {
  zytheron: { stops: ['#000000', '#1a0b3b', '#000000'], swirl: '#8b5cf6' },
  aurora: { stops: ['#03110f', '#07303a', '#1a0b3b'], swirl: '#22d3ee' },
  nebula: { stops: ['#10040f', '#3b0b3a', '#120a33'], swirl: '#ec4899' },
  midnight: { stops: ['#020617', '#0b1b3f', '#020617'], swirl: '#3b82f6' },
  ember: { stops: ['#0c0403', '#3a1208', '#1c0a24'], swirl: '#f97316' },
};

/** Stable hash, so a member gets the same swirl on repeat renders, but different members differ. */
function seedFrom(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

function drawPreset(ctx: SKRSContext2D, name: string, seedText: string): void {
  const preset = BACKGROUND_PRESETS[name] ?? BACKGROUND_PRESETS.zytheron!;
  const seed = seedFrom(seedText);
  const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  gradient.addColorStop(0, preset.stops[0]);
  gradient.addColorStop(0.55, preset.stops[1]);
  gradient.addColorStop(1, preset.stops[2]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Logarithmic spiral arms: the spiral motif, centered behind the avatar.
  const cx = 210;
  const cy = HEIGHT / 2;
  const phase = (seed % 628) / 100;
  ctx.save();
  ctx.strokeStyle = preset.swirl;
  ctx.lineCap = 'round';
  for (let arm = 0; arm < 5; arm++) {
    ctx.globalAlpha = 0.28 - arm * 0.035;
    ctx.lineWidth = 2.5 - arm * 0.3;
    ctx.beginPath();
    for (let t = 0; t < 7.5; t += 0.04) {
      const r = 60 * Math.exp(0.33 * t);
      const a = t + phase + (arm * Math.PI * 2) / 5;
      const x = cx + r * Math.cos(a);
      const y = cy + r * 0.72 * Math.sin(a);
      if (t === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();

  // Scattered stars
  ctx.save();
  ctx.fillStyle = '#ffffff';
  let s = seed;
  for (let i = 0; i < 70; i++) {
    s = Math.imul(s, 1664525) + 1013904223;
    const x = (s >>> 0) % WIDTH;
    s = Math.imul(s, 1664525) + 1013904223;
    const y = (s >>> 0) % HEIGHT;
    ctx.globalAlpha = 0.1 + (i % 5) * 0.08;
    ctx.fillRect(x, y, i % 7 === 0 ? 2 : 1, i % 7 === 0 ? 2 : 1);
  }
  ctx.restore();
}

function fit(ctx: SKRSContext2D, text: string, maxWidth: number, weight: number, size: number, min: number): number {
  let current = size;
  while (current > min) {
    ctx.font = `${weight} ${current}px VortexInter, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    current -= 2;
  }
  ctx.font = `${weight} ${current}px VortexInter, sans-serif`;
  return current;
}

function ellipsize(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}

export interface CardInput { background: string; accent: string; headline: string; title: string; subline: string; avatar?: Buffer | null; seed: string }

export async function renderCard(input: CardInput): Promise<Buffer> {
  ensureFonts();
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  let customDrawn = false;
  if (input.background.startsWith('https://')) {
    try {
      const image = await loadImage(await fetchPublicImage(input.background));
      const scale = Math.max(WIDTH / image.width, HEIGHT / image.height);
      ctx.drawImage(image, (WIDTH - image.width * scale) / 2, (HEIGHT - image.height * scale) / 2, image.width * scale, image.height * scale);
      const shade = ctx.createLinearGradient(0, 0, WIDTH, 0);
      shade.addColorStop(0, 'rgba(5,3,12,0.55)');
      shade.addColorStop(1, 'rgba(5,3,12,0.8)');
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      customDrawn = true;
    } catch (err) {
      logger.debug({ err }, 'Custom card background failed, using preset');
    }
  }
  if (!customDrawn) drawPreset(ctx, input.background, input.seed);

  // Avatar with an accent ring and a soft glow
  const ax = 210;
  const ay = HEIGHT / 2;
  const radius = 118;
  ctx.save();
  ctx.shadowColor = input.accent;
  ctx.shadowBlur = 42;
  ctx.fillStyle = input.accent;
  ctx.beginPath();
  ctx.arc(ax, ay, radius + 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(ax, ay, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#120a24';
  ctx.fillRect(ax - radius, ay - radius, radius * 2, radius * 2);
  if (input.avatar) {
    try {
      const avatar = await loadImage(input.avatar);
      ctx.drawImage(avatar, ax - radius, ay - radius, radius * 2, radius * 2);
    } catch (err) {
      logger.debug({ err }, 'Could not decode avatar');
    }
  }
  ctx.restore();

  const left = 380;
  const maxWidth = WIDTH - left - 56;
  ctx.textBaseline = 'alphabetic';

  ctx.font = '700 26px VortexInter, sans-serif';
  ctx.fillStyle = input.accent;
  ctx.letterSpacing = '6px';
  ctx.fillText(ellipsize(ctx, input.headline.toUpperCase(), maxWidth), left, 150);
  ctx.letterSpacing = '0px';

  fit(ctx, input.title, maxWidth, 800, 66, 34);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(ellipsize(ctx, input.title, maxWidth), left, 226);

  ctx.font = '400 28px VortexInter, sans-serif';
  ctx.fillStyle = 'rgba(226,222,245,0.85)';
  ctx.fillText(ellipsize(ctx, input.subline, maxWidth), left, 280);

  return canvas.encode('png');
}
