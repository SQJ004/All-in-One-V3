import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { UserError } from './types.js';

export function isPrivateAddress(ip: string): boolean {
  if (ip.startsWith('::ffff:')) return isPrivateAddress(ip.slice(7));
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb');
  }
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

/**
 * Fetches a user-supplied image URL. Blocks SSRF: HTTPS only, public addresses only,
 * no redirects (a redirect could land on an internal host), capped size and time.
 */
export async function fetchPublicImage(url: string, maxBytes = 5 * 1024 * 1024): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UserError('That is not a valid URL.');
  }
  if (parsed.protocol !== 'https:') throw new UserError('Image URLs must use HTTPS.');
  const addresses = await lookup(parsed.hostname, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) throw new UserError('That image host is not allowed.');
  const res = await fetch(parsed, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new UserError(`The image host responded with ${res.status}.`);
  if (!res.headers.get('content-type')?.startsWith('image/')) throw new UserError('That URL is not an image.');
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw new UserError('That image is too large (5 MB max).');
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new UserError('That image is too large (5 MB max).');
  return buffer;
}
