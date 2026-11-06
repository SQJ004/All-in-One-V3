import { CronExpressionParser } from 'cron-parser';
import safeRegex from 'safe-regex2';
import type { MatchType } from '../../db/models.js';
import { UserError } from '../../core/types.js';

const compiled = new Map<string, RegExp | null>();

/** User-supplied regexes run on every message, so catastrophic-backtracking patterns are refused. */
export function compileUserRegex(pattern: string): RegExp {
  if (pattern.length > 200) throw new UserError('Regex patterns are limited to 200 characters.');
  if (!safeRegex(pattern)) throw new UserError('That regex could run dangerously slowly, so it was rejected.');
  try {
    return new RegExp(pattern, 'iu');
  } catch {
    throw new UserError('That is not a valid regular expression.');
  }
}

function cachedRegex(pattern: string): RegExp | null {
  if (!compiled.has(pattern)) {
    try {
      compiled.set(pattern, compileUserRegex(pattern));
    } catch {
      compiled.set(pattern, null);
    }
    if (compiled.size > 2000) compiled.delete(compiled.keys().next().value!);
  }
  return compiled.get(pattern) ?? null;
}

export function matchesTrigger(content: string, trigger: string, type: MatchType): boolean {
  const text = content.slice(0, 2000).toLowerCase();
  const t = trigger.toLowerCase();
  switch (type) {
    case 'exact': return text.trim() === t;
    case 'contains': return text.includes(t);
    case 'startsWith': return text.trimStart().startsWith(t);
    case 'word': {
      const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(text);
    }
    case 'regex': return cachedRegex(trigger)?.test(content.slice(0, 2000)) ?? false;
    default: return false;
  }
}

const MIN_INTERVAL_MS = 5 * 60_000;

/** Validates a cron expression and its timezone. Refuses anything faster than every 5 minutes. */
export function nextCronRun(expression: string, timezone = 'UTC', from = new Date()): Date {
  try {
    const it = CronExpressionParser.parse(expression, { tz: timezone, currentDate: from });
    const first = it.next().toDate();
    const second = it.next().toDate();
    if (second.getTime() - first.getTime() < MIN_INTERVAL_MS) throw new UserError('Schedules can run at most once every 5 minutes.');
    return first;
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError('Invalid schedule. Use cron format, for example `0 9 * * 1` for Mondays at 09:00, and a valid timezone such as `Europe/Paris`.');
  }
}
