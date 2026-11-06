import { lookup, type LookupAddress } from 'node:dns';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { get as httpsGet } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { UserError } from '../../core/types.js';

/** Anyone can give /play a URL, so it must not reach this machine or its private network. */
const PRIVATE = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]] as const) PRIVATE.addSubnet(net, bits, 'ipv6');

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return PRIVATE.check(mapped, 'ipv4');
  return PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

const BLOCKED = 'That link points to a private address, so I will not open it.';

/** Checks the address actually connected to, which also stops a name changing after a check. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as (e: Error) => void)(err);
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) return (callback as (e: Error) => void)(new UserError(BLOCKED));
    if ((options as { all?: boolean }).all) (callback as (e: null, a: LookupAddress[]) => void)(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  });
};

export interface OpenOptions {
  /** Only for automated tests, which serve audio from this machine. */
  allowPrivate?: boolean;
  timeoutMs?: number;
}

const MAX_REDIRECTS = 5;

/** Opens an audio URL for reading, following redirects and checking each one. Never uses a proxy or shell. */
export function openStream(url: string, opts: OpenOptions = {}, redirects = 0): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new UserError('That is not a valid link.'));
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return reject(new UserError('Only http and https links can be played.'));
    if (parsed.username || parsed.password) return reject(new UserError('Links with a username or password cannot be played.'));
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (!opts.allowPrivate && isIP(host) && isPrivateAddress(host)) return reject(new UserError(BLOCKED));
    const get = parsed.protocol === 'https:' ? httpsGet : httpGet;
    const req = get(parsed, { headers: { 'user-agent': 'ZYTHERON-Discord-Bot', accept: 'audio/*, application/ogg, */*;q=0.5' }, ...(opts.allowPrivate ? {} : { lookup: guardedLookup }) }, (res) => {
      clearTimeout(timer);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.destroy();
        if (redirects >= MAX_REDIRECTS) return reject(new UserError('That link redirects too many times.'));
        return resolve(openStream(new URL(res.headers.location, parsed).href, opts, redirects + 1));
      }
      if (status < 200 || status >= 300) {
        res.destroy();
        return reject(new UserError(status === 401 || status === 403 ? 'That audio needs a login or is restricted, so I cannot play it.' : status === 404 || status === 410 ? 'That audio is no longer available.' : `That audio could not be loaded (error ${status}).`));
      }
      resolve(res);
    });
    const timer = setTimeout(() => req.destroy(new UserError('That audio took too long to respond.')), opts.timeoutMs ?? 15_000);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err instanceof UserError ? err : new UserError('I could not reach that audio. The site may be down.'));
    });
  });
}
