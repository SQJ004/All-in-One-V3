import type { RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { snowflake } from '../config/guildConfig.js';
import { getConfig } from '../core/configService.js';
import { UserError } from '../core/types.js';
import { Case, StaffEvent, StaffRecord, StaffRecordLog, Ticket, type IStaffRecord } from '../db/models.js';
import { activityMaps, buildRow, goalProgress, moderationAnalytics, rankRows, stampsFor, ticketAnalytics, tierOf, type Dataset, type Range, type StaffConfig, type StaffMemberInfo, type StaffRow, type Tier } from '../modules/staff/analytics.js';
import type { Access, DashboardGateway } from './gateway.js';

interface StaffRequest { access: Access; guildId: string; session: { userId: string; username: string }; query: Record<string, unknown>; params: Record<string, unknown>; body: unknown }
type Handler = (req: StaffRequest, res: Response) => Promise<unknown>;

const DAY = 86_400_000;
const MAX_RANGE_DAYS = 400;
const MAX_COMPARE = 6;
const TREND_WEEKS = 8;

const RangeQuery = z.object({ days: z.coerce.number().int().min(1).max(MAX_RANGE_DAYS).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), staff: snowflake.optional() });

export function parseRange(query: unknown, now = Date.now()): Range & { staff?: string } {
  const q = RangeQuery.parse(query);
  const to = q.to ?? new Date(now);
  const from = q.from ?? new Date(to.getTime() - (q.days ?? 30) * DAY);
  if (from > to) throw new UserError('The start date must be before the end date.');
  if (to.getTime() - from.getTime() > (MAX_RANGE_DAYS + 1) * DAY) throw new UserError(`Choose a range of ${MAX_RANGE_DAYS} days or less.`);
  return { from, to, staff: q.staff };
}

const RECORD_TYPES = ['warning', 'note', 'review', 'admin_action', 'promotion', 'role_change'] as const;
const RecordInput = z.object({ userId: snowflake, type: z.enum(RECORD_TYPES), reason: z.string().trim().min(1, 'Write a reason').max(1000), date: z.coerce.date().optional() });

const trustedOnly = (req: StaffRequest) => { if (!req.access.isTrusted) throw new UserError('Only the server owner or a trusted admin can see or change staff records.'); };
const snapshot = (r: IStaffRecord) => ({ userId: r.userId, type: r.type, reason: r.reason, date: r.date });

/** Reads a server's records once per request, so every number on a page agrees. */
async function load(guildId: string): Promise<Dataset> {
  const [cases, tickets, events] = await Promise.all([Case.find({ guildId }), Ticket.find({ guildId }), StaffEvent.find({ guildId })]);
  return { cases, tickets, events };
}

export function staffRoutes(guild: Router, gateway: DashboardGateway, route: (fn: Handler) => RequestHandler): void {
  const context = async (guildId: string, data: Dataset) => {
    const { staff: cfg, tickets } = await getConfig(guildId);
    const roster = await gateway.staffRoster(guildId, [...cfg.adminRoles, ...cfg.moderatorRoles, ...cfg.helperRoles, ...cfg.supportRoles, ...tickets.staffRoleIds]);
    const info = new Map<string, StaffMemberInfo>(roster.map((m) => [m.id, m]));
    const bot = gateway.clientId;
    // Anyone with recorded staff work still appears, even without a listed role.
    const ids = new Set(info.keys());
    for (const c of data.cases) if (c.moderatorId !== bot && c.type !== 'automod') ids.add(c.moderatorId);
    for (const t of data.tickets) for (const id of [t.claimedBy, t.firstResponderId, t.resolvedBy]) if (id && id !== bot) ids.add(id);
    for (const e of data.events) ids.add(e.userId);
    const card = (id: string): StaffMemberInfo => info.get(id) ?? gateway.memberCard(guildId, id) ?? { id, name: data.cases.find((c) => c.moderatorId === id)?.moderatorTag ?? gateway.memberName(guildId, id), avatar: null, joinedAt: null, roleIds: [], roleName: null };
    const tier = (m: StaffMemberInfo): Tier => tierOf(m.roleIds, cfg, tickets.staffRoleIds);
    return { cfg, ids: [...ids], card, tier, bot };
  };
  const rowsFor = async (guildId: string, data: Dataset, range: Range) => {
    const c = await context(guildId, data);
    return { ...c, rows: rankRows(c.ids.map((id) => { const m = c.card(id); return buildRow(m, c.tier(m), data, range, c.cfg, c.bot); })) };
  };
  const today = (now = Date.now()): Range => ({ from: new Date(new Date(now).setUTCHours(0, 0, 0, 0)), to: new Date(now) });

  guild.get('/staff', route(async (req, res) => {
    const range = parseRange(req.query);
    const data = await load(req.guildId);
    const { rows, cfg, bot } = await rowsFor(req.guildId, data, range);
    const scored = rows.filter((r) => r.score !== null);
    const responses = rows.filter((r) => r.avgResponseMin !== null).map((r) => r.avgResponseMin!);
    const t = today();
    const ctx = await context(req.guildId, data);
    res.json({
      from: range.from, to: range.to, activeWithinDays: cfg.activeWithinDays,
      totals: {
        staff: rows.length, active: rows.filter((r) => r.status === 'active').length, inactive: rows.filter((r) => r.status === 'inactive').length,
        actionsToday: ctx.ids.reduce((sum, id) => sum + buildRow(ctx.card(id), 'unlisted', data, t, cfg, bot).actions, 0),
        resolved: rows.reduce((sum, r) => sum + r.resolved, 0), moderation: rows.reduce((sum, r) => sum + r.cases, 0),
        avgResponseMin: responses.length ? responses.reduce((a, b) => a + b, 0) / responses.length : null,
        overall: scored.length ? Math.round(scored.reduce((sum, r) => sum + r.score!, 0) / scored.length) : null,
      },
      staff: rows.map((r) => ({ ...r, claimed: r.claimed, averageRating: r.averageRating })),
    });
  }));

  guild.get('/staff/tickets', route(async (req, res) => {
    const range = parseRange(req.query);
    const data = await load(req.guildId);
    const { rows, bot } = await rowsFor(req.guildId, data, range);
    res.json({ ...ticketAnalytics(data.tickets, range, bot, range.staff), comparison: rows.filter((r) => r.handled).map((r) => ({ userId: r.userId, name: r.name, handled: r.handled, resolved: r.resolved, avgResponseMin: r.avgResponseMin })), people: rows.map((r) => ({ userId: r.userId, name: r.name })) });
  }));

  guild.get('/staff/moderation', route(async (req, res) => {
    const range = parseRange(req.query);
    const data = await load(req.guildId);
    const { rows, bot } = await rowsFor(req.guildId, data, range);
    res.json({ ...moderationAnalytics(data.cases, range, bot, range.staff), comparison: rows.filter((r) => r.cases).map((r) => ({ userId: r.userId, name: r.name, cases: r.cases, quality: r.parts.moderation })), people: rows.map((r) => ({ userId: r.userId, name: r.name })) });
  }));

  guild.get('/staff/heatmap', route(async (req, res) => {
    const { staff } = parseRange(req.query);
    const data = await load(req.guildId);
    res.json(activityMaps(stampsFor(staff ?? null, data, gateway.clientId)));
  }));

  guild.get('/staff/goals', route(async (req, res) => {
    const data = await load(req.guildId);
    const now = Date.now();
    const period = (days: number): Range => ({ from: new Date(now - days * DAY), to: new Date(now) });
    const [week, month] = await Promise.all([rowsFor(req.guildId, data, period(7)), rowsFor(req.guildId, data, period(30))]);
    const targetsFor = (cfg: StaffConfig, r: StaffRow) => cfg.goals[r.tier === 'unlisted' ? 'support' : r.tier];
    const monthly = new Map(month.rows.map((r) => [r.userId, r]));
    res.json({ staff: week.rows.map((r) => ({ userId: r.userId, name: r.name, tier: r.tier, weekly: goalProgress(r, targetsFor(week.cfg, r), 7), monthly: goalProgress(monthly.get(r.userId) ?? r, targetsFor(week.cfg, r), 30) })) });
  }));

  guild.get('/staff/compare', route(async (req, res) => {
    const range = parseRange(req.query);
    const ids = z.array(snowflake).min(1).max(MAX_COMPARE).parse(String(req.query.ids ?? '').split(',').filter(Boolean));
    const data = await load(req.guildId);
    const c = await context(req.guildId, data);
    const now = Date.now();
    res.json({ staff: ids.map((id) => {
      const m = c.card(id);
      const row = buildRow(m, c.tier(m), data, range, c.cfg, c.bot);
      const trend = Array.from({ length: TREND_WEEKS }, (_, n) => {
        const to = now - (TREND_WEEKS - 1 - n) * 7 * DAY;
        return { weekEnding: new Date(to), score: buildRow(m, c.tier(m), data, { from: new Date(to - 7 * DAY), to: new Date(to) }, c.cfg, c.bot).score };
      });
      return { ...row, trend };
    }) });
  }));

  // ---------- History ----------
  guild.get('/staff/records', route(async (req, res) => {
    trustedOnly(req);
    const staff = z.string().optional().parse(req.query.staff);
    const [records, log] = await Promise.all([
      StaffRecord.find({ guildId: req.guildId, ...(staff ? { userId: staff } : {}) }).sort({ date: -1 }),
      StaffRecordLog.find({ guildId: req.guildId }).sort({ createdAt: -1 }).limit(100),
    ]);
    res.json({ records, log });
  }));
  guild.post('/staff/records', route(async (req, res) => {
    trustedOnly(req);
    const input = RecordInput.parse(req.body);
    const doc = await StaffRecord.create({ guildId: req.guildId, userId: input.userId, userName: gateway.memberCard(req.guildId, input.userId)?.name ?? gateway.memberName(req.guildId, input.userId), type: input.type, adminId: req.session.userId, adminName: req.session.username, reason: input.reason, date: input.date ?? new Date() });
    await StaffRecordLog.create({ guildId: req.guildId, recordId: String(doc._id), action: 'created', by: req.session.username, after: snapshot(doc) });
    res.status(201).json(doc);
  }));
  guild.put('/staff/records/:id', route(async (req, res) => {
    trustedOnly(req);
    const input = RecordInput.parse(req.body);
    const doc = await StaffRecord.findOne({ _id: String(req.params.id), guildId: req.guildId });
    if (!doc) throw new UserError('That record no longer exists.');
    const before = snapshot(doc);
    await StaffRecord.updateOne({ _id: doc._id }, { $set: { type: input.type, reason: input.reason, ...(input.date ? { date: input.date } : {}) } });
    const after = await StaffRecord.findOne({ _id: doc._id });
    await StaffRecordLog.create({ guildId: req.guildId, recordId: String(doc._id), action: 'edited', by: req.session.username, before, after: after ? snapshot(after) : null });
    res.json(after);
  }));
  guild.delete('/staff/records/:id', route(async (req, res) => {
    trustedOnly(req);
    const doc = await StaffRecord.findOne({ _id: String(req.params.id), guildId: req.guildId });
    if (!doc) throw new UserError('That record no longer exists.');
    await StaffRecordLog.create({ guildId: req.guildId, recordId: String(doc._id), action: 'removed', by: req.session.username, before: snapshot(doc) });
    await StaffRecord.deleteOne({ _id: doc._id });
    res.json({ ok: true });
  }));

  // ---------- One person. Kept last, so it cannot catch the paths above. ----------
  guild.get('/staff/:userId', route(async (req, res) => {
    const id = snowflake.parse(req.params.userId);
    const range = parseRange(req.query);
    const data = await load(req.guildId);
    const c = await context(req.guildId, data);
    const m = c.card(id);
    const now = Date.now();
    const row = buildRow(m, c.tier(m), data, range, c.cfg, c.bot);
    const period = (days: number): Range => ({ from: new Date(now - days * DAY), to: new Date(now) });
    const count = (days: number) => buildRow(m, c.tier(m), data, period(days), c.cfg, c.bot).actions;
    const trend = Array.from({ length: TREND_WEEKS }, (_, n) => {
      const to = now - (TREND_WEEKS - 1 - n) * 7 * DAY;
      const w = buildRow(m, c.tier(m), data, { from: new Date(to - 7 * DAY), to: new Date(to) }, c.cfg, c.bot);
      return { weekEnding: new Date(to), score: w.score, actions: w.actions };
    });
    const targets = c.cfg.goals[row.tier === 'unlisted' ? 'support' : row.tier];
    res.json({
      row, activity: { today: count(1), week: count(7), month: count(30) }, trend, map: activityMaps(stampsFor(id, data, c.bot)),
      goals: goalProgress(row, targets, Math.max(1, Math.round((range.to.getTime() - range.from.getTime()) / DAY))),
      moderation: moderationAnalytics(data.cases, range, c.bot, id).recent.slice(0, 20),
      tickets: ticketAnalytics(data.tickets, range, c.bot, id).list.slice(0, 20),
    });
  }));
}
