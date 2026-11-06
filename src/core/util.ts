const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Parses "1d 2h", "30m", "2w". Returns milliseconds, or null when the input is not a duration. */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  const pattern = /(\d+)\s*(weeks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/g;
  let total = 0;
  let consumed = '';
  for (const match of text.matchAll(pattern)) {
    const ms = UNITS[match[2]![0]!]!; // the first letter identifies the unit in every accepted spelling
    total += Number(match[1]) * ms;
    consumed += match[0];
  }
  if (consumed.replace(/\s/g, '').length !== text.replace(/\s/g, '').length) return null;
  return total > 0 ? total : null;
}

export function formatDuration(ms: number): string {
  const parts: string[] = [];
  let rest = Math.max(0, Math.floor(ms / 1000));
  for (const [label, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]] as const) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${label}`);
      rest %= size;
    }
  }
  return parts.slice(0, 2).join(' ') || '0s';
}

export const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export const hexToInt = (hex: string): number => parseInt(hex.replace('#', ''), 16);

export const discordTime = (date: Date | number, style: 'R' | 'f' | 'F' | 'D' = 'R'): string =>
  `<t:${Math.floor((typeof date === 'number' ? date : date.getTime()) / 1000)}:${style}>`;

/** Extracts unique user IDs from a free-form string of mentions and raw IDs. */
export function extractIds(input: string): string[] {
  return [...new Set([...input.matchAll(/\d{17,20}/g)].map((m) => m[0]))];
}

export const utcDate = (d = new Date()): string => d.toISOString().slice(0, 10);

export const progressBar = (ratio: number, width = 14): string => {
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
};

/** Removes user-controlled mass-mentions from text that the bot repeats. */
export const safeMentions = { parse: ['users'] as ('users' | 'roles' | 'everyone')[] };
export const noMentions = { parse: [] as ('users' | 'roles' | 'everyone')[] };

export const parseMessageLink = (link: string): { guildId: string; channelId: string; messageId: string } | null => {
  const m = link.match(/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})/);
  return m ? { guildId: m[1]!, channelId: m[2]!, messageId: m[3]! } : null;
};
