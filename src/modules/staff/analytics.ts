import type { GuildConfig } from '../../config/guildConfig.js';
import type { ICase, IStaffEvent, ITicket } from '../../db/models.js';

export type StaffConfig = GuildConfig['staff'];
export type Tier = 'admin' | 'moderator' | 'helper' | 'support' | 'unlisted';
type GoalTargets = StaffConfig['goals']['admin'];

export interface Range { from: Date; to: Date }
export interface StaffMemberInfo { id: string; name: string; avatar: string | null; joinedAt: Date | null; roleIds: string[]; roleName: string | null }
export interface Dataset { cases: ICase[]; tickets: ITicket[]; events: IStaffEvent[] }

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const PUNISHMENTS = new Set(['warn', 'ban', 'tempban', 'kick', 'timeout', 'jail', 'voicemute', 'voicedeafen']);
const REVERSALS: Record<string, string> = { unban: 'ban', untimeout: 'timeout', unjail: 'jail', voiceunmute: 'voicemute', voiceundeafen: 'voicedeafen' };
const OVERTURN_WINDOW = WEEK;
/** Below this many rated tickets, the resolved share stands in for star ratings. */
const NO_REASON = 'No reason provided';

const at = (d: Date | string | null | undefined): number => (d ? new Date(d).getTime() : 0);
const inRange = (t: number, r: Range) => t >= r.from.getTime() && t <= r.to.getTime();
const average = (list: number[]) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const clamp = (n: number) => Math.max(0, Math.min(100, n));
export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Who a ticket's resolution belongs to. Each ticket has at most one, so it can only ever count once.
 * A bot's auto-close resolves nothing. If the member closed their own ticket, credit goes to whoever claimed it.
 */
export function resolverOf(t: Pick<ITicket, 'resolvedBy' | 'status' | 'closedBy' | 'ownerId' | 'claimedBy'>, botId: string): string | null {
  if (t.resolvedBy) return t.resolvedBy;
  if (t.status === 'open' || !t.closedBy || t.closedBy === botId) return null;
  return t.closedBy === t.ownerId ? t.claimedBy ?? null : t.closedBy;
}
const resolvedAt = (t: ITicket) => at(t.resolvedAt ?? t.closedAt ?? t.createdAt);

export function tierOf(roleIds: string[], cfg: StaffConfig, ticketStaffRoles: string[] = []): Tier {
  const has = (list: string[]) => roleIds.some((r) => list.includes(r));
  if (has(cfg.adminRoles)) return 'admin';
  if (has(cfg.moderatorRoles)) return 'moderator';
  if (has(cfg.helperRoles)) return 'helper';
  if (has(cfg.supportRoles) || has(ticketStaffRoles)) return 'support';
  return 'unlisted';
}

/**
 * Share of a person's punishments that had a written reason and were not undone by someone else within a week.
 * It deliberately ignores how many there were, so handing out more punishments never raises it.
 */
export function moderationQuality(userId: string, inPeriod: ICase[], allCases: ICase[]): number | null {
  const mine = inPeriod.filter((c) => c.moderatorId === userId && PUNISHMENTS.has(c.type));
  if (!mine.length) return null;
  const good = mine.filter((c) => {
    if (!c.reason || c.reason === NO_REASON) return false;
    return !allCases.some((other) => REVERSALS[other.type] === c.type && other.targetId === c.targetId && other.moderatorId !== userId && at(other.createdAt) > at(c.createdAt) && at(other.createdAt) - at(c.createdAt) <= OVERTURN_WINDOW);
  });
  return (good.length / mine.length) * 100;
}

/** Full marks at or under the target, falling to zero at four times the target. */
export const responseScore = (minutes: number | null, target: number): number | null => (minutes === null ? null : minutes <= target ? 100 : clamp(100 - ((minutes - target) / (3 * target)) * 100));

export interface ScoreParts { quality: number | null; response: number | null; moderation: number | null; activity: number | null }

/** Only what can be measured counts, and the weights are shared between those parts. Activity alone is not enough for a score. */
export function computeScore(parts: ScoreParts, weights: StaffConfig['weights']): number | null {
  if (parts.quality === null && parts.response === null && parts.moderation === null) return null;
  let total = 0;
  let used = 0;
  for (const key of ['quality', 'response', 'moderation', 'activity'] as const) {
    const value = parts[key];
    if (value === null || !weights[key]) continue;
    total += value * weights[key];
    used += weights[key];
  }
  return used ? Math.round(total / used) : null;
}

export interface StaffRow {
  userId: string; name: string; avatar: string | null; joinedAt: Date | null; roleName: string | null; tier: Tier;
  cases: number; byType: Record<string, number>; messagesDeleted: number;
  claimed: number; handled: number; resolved: number; closed: number;
  avgResponseMin: number | null; avgResolutionMin: number | null; averageRating: number | null; ratingCount: number;
  activeDays: number; actions: number; actionsPerActiveDay: number | null; lastActive: Date | null; status: 'active' | 'inactive';
  parts: ScoreParts; score: number | null;
}

function dayStamps(userId: string, data: Dataset, botId: string): number[] {
  return [
    ...data.cases.filter((c) => c.moderatorId === userId && c.moderatorId !== botId && c.type !== 'automod').map((c) => at(c.createdAt)),
    ...data.events.filter((e) => e.userId === userId).map((e) => at(e.createdAt)),
  ];
}

export function buildRow(info: StaffMemberInfo, tier: Tier, data: Dataset, range: Range, cfg: StaffConfig, botId: string, now = Date.now()): StaffRow {
  const id = info.id;
  const casesInRange = data.cases.filter((c) => inRange(at(c.createdAt), range) && c.moderatorId === id && c.type !== 'automod');
  const byType: Record<string, number> = {};
  for (const c of casesInRange) byType[c.type] = (byType[c.type] ?? 0) + 1;
  const tickets = data.tickets;
  const claimed = tickets.filter((t) => t.claimedBy === id && inRange(at(t.claimedAt ?? t.createdAt), range));
  const resolved = tickets.filter((t) => resolverOf(t, botId) === id && inRange(resolvedAt(t), range));
  const closed = tickets.filter((t) => t.closedBy === id && t.status !== 'open' && inRange(at(t.closedAt ?? t.createdAt), range));
  const responded = tickets.filter((t) => t.firstResponderId === id && t.firstResponseAt && inRange(at(t.firstResponseAt), range));
  const handled = new Set([...claimed, ...resolved, ...responded].map((t) => String(t._id))).size;
  const rated = resolved.filter((t) => t.rating);
  const avgResponse = average(responded.map((t) => (at(t.firstResponseAt) - at(t.createdAt)) / 60_000));
  const avgResolution = average(resolved.filter((t) => t.resolvedAt).map((t) => (at(t.resolvedAt) - at(t.createdAt)) / 60_000));
  const averageRating = average(rated.map((t) => t.rating!));

  const stamps = dayStamps(id, data, botId);
  const inPeriod = stamps.filter((t) => inRange(t, range));
  const activeDays = new Set(inPeriod.map(utcDay)).size;
  const last = stamps.length ? Math.max(...stamps) : 0;
  const spanWeeks = Math.max(1, (range.to.getTime() - range.from.getTime()) / WEEK);
  const target = cfg.goals[tier === 'unlisted' ? 'support' : tier];
  const activity = inPeriod.length ? clamp((activeDays / (spanWeeks * target.activeDaysPerWeek)) * 100) : null;
  const quality = rated.length ? (averageRating! / 5) * 100 : handled ? (resolved.length / handled) * 100 : null;
  const parts: ScoreParts = { quality, response: responseScore(avgResponse, target.responseMinutes), moderation: moderationQuality(id, data.cases.filter((c) => inRange(at(c.createdAt), range)), data.cases), activity };
  return {
    userId: id, name: info.name, avatar: info.avatar, joinedAt: info.joinedAt, roleName: info.roleName, tier,
    cases: casesInRange.length, byType,
    messagesDeleted: casesInRange.filter((c) => c.type === 'purge').reduce((sum, c) => sum + Number(c.reason.match(/^Purged (\d+)/)?.[1] ?? 0), 0),
    claimed: claimed.length, handled, resolved: resolved.length, closed: closed.length,
    avgResponseMin: avgResponse, avgResolutionMin: avgResolution, averageRating, ratingCount: rated.length,
    activeDays, actions: inPeriod.length, actionsPerActiveDay: activeDays ? inPeriod.length / activeDays : null,
    lastActive: last ? new Date(last) : null,
    status: last && now - last <= cfg.activeWithinDays * DAY ? 'active' : 'inactive',
    parts, score: computeScore(parts, cfg.weights),
  };
}

/** A score first, then by name. Nobody ranks higher for doing more punishments. */
export const rankRows = (rows: StaffRow[]): StaffRow[] => [...rows].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.name.localeCompare(b.name));

export interface GoalResult { key: string; label: string; target: number; value: number | null; unit: string; done: boolean; percent: number }

/** Progress against a role's targets. A period's count targets scale with its length. */
export function goalProgress(row: StaffRow, targets: GoalTargets, days: number): GoalResult[] {
  const scale = days / 7;
  const up = (key: string, label: string, value: number | null, target: number, unit: string): GoalResult => ({ key, label, target, value, unit, done: value !== null && value >= target, percent: value === null || !target ? 0 : Math.round(clamp((value / target) * 100)) });
  const response: GoalResult = {
    key: 'response', label: 'Ticket response time', target: targets.responseMinutes, value: row.avgResponseMin, unit: 'minutes',
    done: row.avgResponseMin !== null && row.avgResponseMin <= targets.responseMinutes,
    percent: row.avgResponseMin === null ? 0 : Math.round(responseScore(row.avgResponseMin, targets.responseMinutes) ?? 0),
  };
  return [
    response,
    up('resolved', 'Tickets resolved', row.resolved, Math.ceil(targets.resolvedPerWeek * scale), 'tickets'),
    up('quality', 'Support quality', row.parts.quality, targets.qualityPercent, '%'),
    up('moderation', 'Moderation review', row.parts.moderation, targets.moderationPercent, '%'),
    up('activity', 'Active days', row.activeDays, Math.ceil(targets.activeDaysPerWeek * scale), 'days'),
  ];
}

/** Counts per day and per hour (UTC) from events the bot recorded. Nothing here looks at presence or private messages. */
export function activityMaps(stamps: number[], now = Date.now()) {
  const days: Record<string, number> = {};
  const hours = Array.from({ length: 24 }, () => 0);
  const weekdays = Array.from({ length: 7 }, () => 0);
  for (const t of stamps) {
    if (now - t > 366 * DAY) continue;
    days[utcDay(t)] = (days[utcDay(t)] ?? 0) + 1;
    const d = new Date(t);
    hours[d.getUTCHours()]! += 1;
    weekdays[d.getUTCDay()]! += 1;
  }
  return { days, hours, weekdays, activeDays: Object.keys(days).length };
}

export const stampsFor = (userId: string | null, data: Dataset, botId: string): number[] => {
  if (userId) return dayStamps(userId, data, botId);
  return [...data.cases.filter((c) => c.moderatorId !== botId && c.type !== 'automod').map((c) => at(c.createdAt)), ...data.events.map((e) => at(e.createdAt))];
};

/** One value per day in the range, for charts. */
export function dailySeries(range: Range, entries: Array<{ t: number; key: string }>, keys: string[]) {
  const rows: Array<Record<string, number | string>> = [];
  const end = Math.min(range.to.getTime(), Date.now());
  for (let t = Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), range.from.getUTCDate()); t <= end; t += DAY) {
    const row: Record<string, number | string> = { date: utcDay(t) };
    for (const k of keys) row[k] = 0;
    rows.push(row);
  }
  const byDate = new Map(rows.map((r) => [r.date as string, r]));
  for (const e of entries) {
    const row = byDate.get(utcDay(e.t));
    if (row && keys.includes(e.key)) (row[e.key] as number) += 1;
  }
  return rows;
}

/** Tickets in the range, with each one's own timings. */
export function ticketAnalytics(tickets: ITicket[], range: Range, botId: string, staffId?: string) {
  const mine = staffId ? tickets.filter((t) => t.claimedBy === staffId || t.firstResponderId === staffId || t.closedBy === staffId || resolverOf(t, botId) === staffId) : tickets;
  const opened = mine.filter((t) => inRange(at(t.createdAt), range));
  const claimed = mine.filter((t) => t.claimedBy && inRange(at(t.claimedAt ?? t.createdAt), range));
  const assigned = mine.filter((t) => t.assignedAt && inRange(at(t.assignedAt), range));
  const resolved = mine.filter((t) => resolverOf(t, botId) && inRange(resolvedAt(t), range));
  const closed = mine.filter((t) => t.status !== 'open' && inRange(at(t.closedAt ?? t.createdAt), range));
  const unanswered = mine.filter((t) => t.status === 'open' && !t.firstResponseAt && !t.claimedBy);
  const responses = opened.filter((t) => t.firstResponseAt).map((t) => (at(t.firstResponseAt) - at(t.createdAt)) / 60_000);
  const resolutions = resolved.filter((t) => t.resolvedAt).map((t) => (at(t.resolvedAt) - at(t.createdAt)) / 60_000);
  return {
    opened: opened.length, claimed: claimed.length, assigned: assigned.length, resolved: resolved.length, closed: closed.length, unanswered: unanswered.length,
    avgFirstResponseMin: average(responses), avgResolutionMin: average(resolutions),
    daily: dailySeries(range, [...opened.map((t) => ({ t: at(t.createdAt), key: 'opened' })), ...resolved.map((t) => ({ t: resolvedAt(t), key: 'resolved' }))], ['opened', 'resolved']),
    list: [...new Map([...opened, ...resolved, ...closed].map((t) => [String(t._id), t])).values()].sort((a, b) => b.number - a.number).slice(0, 100).map((t) => ({
      number: t.number, subject: t.subject, status: t.status, owner: t.ownerTag, category: t.categoryLabel ?? null, claimedBy: t.claimedBy ?? null, resolvedBy: resolverOf(t, botId),
      firstResponseMin: t.firstResponseAt ? (at(t.firstResponseAt) - at(t.createdAt)) / 60_000 : null,
      resolutionMin: t.resolvedAt ? (at(t.resolvedAt) - at(t.createdAt)) / 60_000 : null, rating: t.rating ?? null, openedAt: t.createdAt,
    })),
  };
}

export function moderationAnalytics(cases: ICase[], range: Range, botId: string, staffId?: string) {
  const inPeriod = cases.filter((c) => inRange(at(c.createdAt), range) && c.moderatorId !== botId && c.type !== 'automod' && (!staffId || c.moderatorId === staffId));
  const count = (...types: string[]) => inPeriod.filter((c) => types.includes(c.type)).length;
  return {
    warnings: count('warn'), bans: count('ban', 'tempban'), kicks: count('kick'), timeouts: count('timeout'),
    messagesDeleted: inPeriod.filter((c) => c.type === 'purge').reduce((sum, c) => sum + Number(c.reason.match(/^Purged (\d+)/)?.[1] ?? 0), 0),
    total: inPeriod.length,
    daily: dailySeries(range, inPeriod.map((c) => ({ t: at(c.createdAt), key: 'actions' })), ['actions']),
    recent: [...inPeriod].sort((a, b) => at(b.createdAt) - at(a.createdAt)).slice(0, 100).map((c) => ({ caseId: c.number, staff: c.moderatorTag, staffId: c.moderatorId, type: c.type, target: c.targetTag, reason: c.reason, at: c.createdAt, status: c.active ? 'Active' : 'Ended' })),
  };
}
