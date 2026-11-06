/**
 * Offline scam and phishing URL analysis. Combines exact lists with heuristics that
 * catch freshly registered lookalikes that no list knows about yet. Heuristics only
 * fire on hosts outside the official allowlist, which limits false positives.
 */
export type LinkVerdict = { url: string; host: string; category: 'phishing' | 'scam' | 'blocked' | 'invite'; reason: string };

const OFFICIAL = ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discord.new', 'discord.gift', 'discordstatus.com', 'steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'paypal.com', 'roblox.com', 'epicgames.com', 'minecraft.net', 'youtube.com', 'youtu.be', 'twitch.tv', 'github.com', 'google.com', 'x.com', 'twitter.com', 'reddit.com', 'tenor.com', 'giphy.com', 'wikipedia.org', 'imgur.com'];
const BRANDS = ['discord', 'discordapp', 'steamcommunity', 'steampowered', 'paypal', 'roblox', 'epicgames', 'metamask', 'opensea', 'binance', 'coinbase'];
const LURE_WORDS = ['nitro', 'gift', 'free', 'airdrop', 'claim', 'verify', 'giveaway', 'promo', 'login', 'auth', 'wallet'];
const SEED_BLOCKLIST = ['grabify.link', 'iplogger.org', 'iplogger.com', 'blasze.com', 'ps3cfw.com', 'yip.su', 'bmwforum.co', '2no.co'];
const SCAM_PHRASES = [/free\s+(discord\s+)?nitro/i, /nitro\s+(for\s+)?free/i, /steam\s+(gift|community).{0,30}(free|\$\d+)/i, /(claim|get)\s+your\s+(free\s+)?(nitro|gift|reward|airdrop)/i, /i('|’)?m\s+leaving\s+(cs|csgo|steam).{0,40}(skins|inventory)/i, /\$\d+\s*(gift|steam)\s*(card)?.{0,20}(https?:|discord)/i, /(wallet|seed\s+phrase).{0,30}(verify|connect|validate)/i];

/** Ordinary words one edit away from a brand name. */
const COMMON_WORDS = new Set(['finance', 'discard', 'accord', 'record', 'paypai']);

const URL_RE =/\bhttps?:\/\/[^\s<>()"'`]+/gi;
const BARE_INVITE_RE = /\b(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]{2,}/i;

const dynamicBlocklist = new Set<string>();

/** Replaces the remote-feed domains (refreshed periodically by the security module). */
export function setFeedDomains(domains: Iterable<string>): void {
  dynamicBlocklist.clear();
  for (const d of domains) {
    const clean = d.trim().toLowerCase().replace(/^\*\./, '');
    if (clean && clean.includes('.')) dynamicBlocklist.add(clean);
  }
}

export function parseFeed(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  }
  return trimmed.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
}

export function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }
  return row[b.length]!;
}

/** Folds common visual substitutions so d1sc0rd and dlscord compare equal to discord. */
export function foldHomoglyphs(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[а]/g, 'a').replace(/[е]/g, 'e').replace(/[о]/g, 'o').replace(/[с]/g, 'c').replace(/[р]/g, 'p').replace(/[і]/g, 'i')
    .replace(/0/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[5$]/g, 's').replace(/rn/g, 'm').replace(/l/g, 'i');
}

const hostMatches = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

export function analyzeHost(host: string): { category: 'phishing' | 'scam'; reason: string } | null {
  if (OFFICIAL.some((d) => hostMatches(host, d))) return null;
  if (SEED_BLOCKLIST.some((d) => hostMatches(host, d))) return { category: 'scam', reason: 'Known IP-logger or scam domain' };
  for (const d of dynamicBlocklist) if (hostMatches(host, d)) return { category: 'scam', reason: 'Listed in the scam domain feed' };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return { category: 'phishing', reason: 'Link points directly at an IP address' };
  if (host.startsWith('xn--') || host.includes('.xn--')) return { category: 'phishing', reason: 'Punycode domain, often used to imitate real sites' };

  const labels = host.split('.');
  const registrable = labels.slice(-2)[0] ?? '';
  const words = labels.slice(0, -1).flatMap((l) => l.split('-'));
  const foldedBrands = BRANDS.map((b) => ({ brand: b, folded: foldHomoglyphs(b) }));

  for (const { brand, folded } of foldedBrands) {
    const reg = foldHomoglyphs(registrable);
    if (reg === folded) return { category: 'phishing', reason: `Imitates ${brand} on an unofficial domain` };
    if (!COMMON_WORDS.has(registrable) && levenshtein(reg, folded) <= (folded.length >= 8 ? 2 : 1)) return { category: 'phishing', reason: `Name is nearly identical to ${brand}` };
    const containsBrand = words.some((w) => foldHomoglyphs(w) === folded) || reg.includes(folded);
    if (containsBrand && words.some((w) => LURE_WORDS.includes(w) || LURE_WORDS.some((lure) => w.includes(lure)))) return { category: 'phishing', reason: `Combines ${brand} with a lure word` };
    // discord.com.evil.ru: the brand sits in a subdomain to fool a quick glance
    if (labels.slice(0, -2).some((l) => foldHomoglyphs(l) === folded)) return { category: 'phishing', reason: `Uses ${brand} as a misleading subdomain` };
  }
  return null;
}

export interface ScanOptions { scam: boolean; phishing: boolean; invites: boolean; allowedDomains: string[]; blockedDomains: string[] }

export function scanContent(content: string, opts: ScanOptions): LinkVerdict[] {
  const verdicts: LinkVerdict[] = [];
  const allowed = opts.allowedDomains.map((d) => d.toLowerCase());
  const blocked = opts.blockedDomains.map((d) => d.toLowerCase());

  for (const raw of content.match(URL_RE) ?? []) {
    let host: string;
    try {
      host = new URL(raw).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
      continue;
    }
    if (allowed.some((d) => hostMatches(host, d))) continue;
    if (blocked.some((d) => hostMatches(host, d))) {
      verdicts.push({ url: raw, host, category: 'blocked', reason: 'Domain blocked by this server' });
      continue;
    }
    const result = analyzeHost(host);
    if (result && ((result.category === 'phishing' && opts.phishing) || (result.category === 'scam' && opts.scam))) verdicts.push({ url: raw, host, ...result });
  }

  if (opts.invites && BARE_INVITE_RE.test(content) && !allowed.includes('discord.gg')) {
    verdicts.push({ url: content.match(BARE_INVITE_RE)![0], host: 'discord.gg', category: 'invite', reason: 'Server invites are not allowed here' });
  }
  if (opts.scam && verdicts.length === 0 && SCAM_PHRASES.some((re) => re.test(content)) && /https?:\/\//i.test(content)) {
    verdicts.push({ url: '', host: '', category: 'scam', reason: 'Message matches a known scam script and contains a link' });
  }
  return verdicts;
}
