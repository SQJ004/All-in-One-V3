import { randomUUID } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { CONFIG_SECTIONS, snowflake, type ConfigSection } from '../config/guildConfig.js';
import { getConfig, updateConfig } from '../core/configService.js';
import { UserError } from '../core/types.js';
import { utcDate } from '../core/util.js';
import { renderVars } from '../core/variables.js';
import { AiFlag, AiStat, AuditEntry, AutomationRule, AutoResponse, Case, CustomCommand, DailyStat, EmbedTemplate, Giveaway, RolePanel, ScheduledMessage, SecurityEvent, ServerBackup, Ticket, TicketPanel, DashboardAction } from '../db/models.js';
import { aiConnected, aiModel, classifyMessage } from '../modules/aimod/classifier.js';
import { backupSummary } from '../modules/backup/index.js';
import { csvCell } from '../modules/logging/audit.js';
import { IdentitySchema } from '../modules/platform/index.js';
import { compileUserRegex, nextCronRun } from '../modules/automation/rules.js';
import { invalidateAutomation } from '../modules/automation/index.js';
import { MessageSpecSchema } from '../modules/embeds/spec.js';
import { BACKGROUND_PRESETS, renderCard } from '../modules/welcome/card.js';
import type { AuthedRequest } from './app.js';
import type { Access, DashboardGateway } from './gateway.js';
import { builtInOwner, PREFIX } from '../core/textCommands.js';
import { commandSummaries } from './commandCatalog.js';
import { botInviteUrl } from './invite.js';
import { staffRoutes } from './staffApi.js';
import { ALWAYS_ON } from '../core/commandRules.js';
import type { OAuthGuild } from './oauth.js';

const MANAGE_GUILD = 0x20n;
const ADMIN = 0x8n;

interface GuildRequest extends AuthedRequest { access: Access; guildId: string }
type Handler = (req: GuildRequest, res: Response) => Promise<unknown> | unknown;
const route = (fn: Handler): RequestHandler => async (req, res) => { await fn(req as GuildRequest, res); };

const name40 = z.string().trim().min(1).max(40);
const CustomCommandInput = z.object({ name: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{1,32}$/, 'Use lowercase letters, numbers, dashes and underscores'), response: z.string().max(2000).default(''), templateName: z.string().max(40).nullish(), allowedRoles: z.array(snowflake).max(25).default([]) }).refine((c) => c.response || c.templateName, { message: 'Provide a response or a template' });
const AutoResponseInput = z.object({ trigger: z.string().min(1).max(200), matchType: z.enum(['exact', 'contains', 'word', 'startsWith', 'regex']).default('contains'), response: z.string().min(1).max(2000), channels: z.array(snowflake).max(50).default([]), cooldownSec: z.number().int().min(0).max(3600).default(10), deleteTrigger: z.boolean().default(false), enabled: z.boolean().default(true) });
const ScheduleInput = z.object({ name: name40, channelId: snowflake, cron: z.string().max(100), timezone: z.string().max(60).default('UTC'), content: z.string().max(2000).default(''), templateName: z.string().max(40).nullish(), enabled: z.boolean().default(true) }).refine((s) => s.content || s.templateName, { message: 'Provide a message or a template' });
const RuleInput = z.object({
  name: name40,
  trigger: z.object({ type: z.enum(['keyword', 'regex', 'member_join', 'role_added']), value: z.string().max(200).optional() }),
  channels: z.array(snowflake).max(50).default([]),
  actions: z.array(z.object({ type: z.enum(['reply', 'send_channel', 'dm', 'add_role', 'remove_role', 'delete_message', 'timeout', 'log']), value: z.string().max(1900).optional(), channelId: snowflake.optional(), minutes: z.number().int().min(1).max(40320).optional() })).min(1).max(5),
  enabled: z.boolean().default(true),
  cooldownSec: z.number().int().min(0).max(3600).default(5),
});
const TemplateInput = z.object({ name: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{1,40}$/, 'Use lowercase letters, numbers, dashes and underscores'), spec: MessageSpecSchema });
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color such as #7c3aed').default('#7c3aed');
const blankToNull = z.preprocess((v) => (v === '' ? null : v), snowflake.nullish());
const RolePanelInput = z.object({
  name: name40, kind: z.enum(['button', 'select', 'reaction']), behavior: z.enum(['toggle', 'unique', 'add_only', 'remove_only']).default('toggle'),
  title: z.string().trim().min(1).max(200), description: z.string().max(1500).default('Choose below.'), color: hex,
  tempMinutes: z.number().int().min(1).max(525_600).nullish(), requiredRoleId: blankToNull,
  items: z.array(z.object({ roleId: snowflake, label: z.string().max(80).optional(), emoji: z.string().max(64).nullish(), description: z.string().max(100).nullish() })).min(1, 'Choose at least one role').max(25),
}).refine((p) => p.kind !== 'reaction' || p.items.every((x) => x.emoji), { message: 'Reaction panels need an emoji for every role' });
const TicketPanelInput = z.object({
  name: name40, title: z.string().trim().min(1).max(200), description: z.string().max(1500).default('Open a ticket and our team will help you privately.'), style: z.enum(['buttons', 'select']).default('buttons'), color: hex,
  categories: z.array(z.object({ id: z.string().max(16).optional(), label: z.string().trim().min(1).max(80), emoji: z.string().max(64).nullish(), description: z.string().max(100).nullish(), staffRoleIds: z.array(snowflake).max(25).default([]), parentCategoryId: snowflake.nullish(), welcomeMessage: z.string().max(1500).nullish(), questions: z.array(z.string().trim().min(1).max(45, 'A question can be at most 45 characters')).max(5, 'Discord allows up to 5 questions').default([]) })).min(1, 'Add at least one category').max(25),
});
const PublishInput = z.object({ channelId: snowflake });
const LockdownInput = z.object({ on: z.boolean(), reason: z.string().trim().min(1).max(300).default('Dashboard') });

const IdentityInput = IdentitySchema.extend({ username: z.string().trim().min(2).max(32).optional(), avatar: z.string().max(250_000, 'That image is too large. The limit is 180 KB.').regex(/^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/, 'Use a PNG, JPG or GIF image.').nullable().optional(), banner: z.string().max(250_000, 'That image is too large. The limit is 180 KB.').regex(/^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/, 'Use a PNG, JPG or GIF image.').nullable().optional() });
const RestoreInput = z.object({ roles: z.boolean().default(false), channels: z.boolean().default(false), permissions: z.boolean().default(false), settings: z.boolean().default(false), emojis: z.boolean().default(false) }).refine((o) => Object.values(o).some(Boolean), 'Choose at least one thing to restore.');
const AuditQuery = z.object({ page: z.coerce.number().int().min(0).default(0), category: z.string().regex(/^[a-z]{0,20}$/).optional(), user: z.string().max(40).optional(), q: z.string().max(100).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() });
const TicketActionInput = z.object({ action: z.enum(['close', 'reopen', 'assign', 'add', 'remove']), userId: snowflake.optional() });
const ReviewInput = z.object({ decision: z.enum(['dismiss', 'false_positive', 'warn', 'timeout']) });
const AI_TEST_MAX = 1000;
const AUDIT_PAGE = 25;

const NicknameInput = z.object({ nickname: z.string().trim().max(32, 'A nickname can be at most 32 characters') });
const MAX_ACTIONS_SHOWN = 500;
const imageData = z.string().max(250_000, 'That image is too large. The limit is 180 KB.').regex(/^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/, 'Use a PNG, JPG or GIF image.').nullable();
const BotImagesInput = z.object({ avatar: imageData.optional(), banner: imageData.optional() }).refine((v) => v.avatar !== undefined || v.banner !== undefined, 'Choose an image.');

/** Turns a request into a short name such as logging.update or role_panels.publish. */
export function actionName(method: string, path: string): string {
  const parts = path.split('/').filter((p) => p && !/^[\da-f]{10,}$/i.test(p)).map((p) => p.replace(/-/g, '_'));
  const named = parts[0] === 'config' ? parts.slice(1) : parts;
  const verb = method === 'DELETE' ? 'delete' : method === 'POST' ? 'create' : 'update';
  return method === 'POST' && named.length > 1 ? named.join('.') : [...named, verb].join('.');
}

export function apiRouter(gateway: DashboardGateway, userGuilds: (s: AuthedRequest['session']) => Promise<OAuthGuild[]>): Router {
  const api = Router();

  api.get('/me', (req: Request, res) => {
    const s = (req as AuthedRequest).session;
    res.json({ id: s.userId, username: s.username, avatar: s.avatar, csrf: s.csrf });
  });

  api.get('/guilds', async (req: Request, res) => {
    const guilds = await userGuilds((req as AuthedRequest).session);
    const manageable = guilds.filter((g) => g.owner || (BigInt(g.permissions) & (MANAGE_GUILD | ADMIN)) !== 0n);
    const present = new Set(gateway.guildIds());
    res.json(manageable.map((g) => ({
      id: g.id, name: g.name,
      icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128` : null,
      botPresent: present.has(g.id),
      memberCount: present.has(g.id) ? gateway.getGuild(g.id)?.memberCount ?? null : null,
      inviteUrl: present.has(g.id) ? null : botInviteUrl(gateway.clientId, g.id),
    })));
  });

  // Every /guilds/:id route passes through here. Access is checked against the
  // live member on each request, so losing a role takes effect immediately.
  const guild = Router({ mergeParams: true });
  api.use('/guilds/:guildId', async (req: Request, res, next) => {
    const guildId = String(req.params.guildId);
    if (!snowflake.safeParse(guildId).success) return void res.status(404).json({ error: 'Not found.' });
    if (!gateway.getGuild(guildId)) return void res.status(404).json({ error: 'ZYTHERON is not in that server.' });
    const access = await gateway.getAccess(guildId, (req as AuthedRequest).session.userId);
    if (!access?.canManage && !access?.isOwner) return void res.status(403).json({ error: 'You need the Manage Server permission.' });
    Object.assign(req, { access, guildId });
    next();
  }, guild);

  // Records each successful change, for the Recent actions table. Values are not stored, only what was changed.
  guild.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const { session, guildId } = req as unknown as GuildRequest;
    const action = actionName(req.method, req.path);
    res.once('finish', () => {
      if (res.statusCode >= 400) return;
      void DashboardAction.create({ guildId, userId: session.userId, username: session.username, action }).catch(() => undefined);
    });
    next();
  });

  guild.get('/actions', route(async (req, res) => {
    const rows = await DashboardAction.find({ guildId: req.guildId }).sort({ createdAt: -1 }).limit(MAX_ACTIONS_SHOWN);
    res.json(rows.map((r) => ({ at: r.createdAt, username: r.username, action: r.action })));
  }));

  guild.get('/bot-profile', route(async (req, res) => { res.json(await gateway.getBotProfile(req.guildId)); }));

  guild.put('/bot-images', route(async (req, res) => {
    const images = BotImagesInput.parse(req.body);
    await gateway.setBotImages(req.guildId, images);
    res.json({ ok: true });
  }));

  guild.put('/nickname', route(async (req, res) => {
    const { nickname } = NicknameInput.parse(req.body);
    await gateway.setNickname(req.guildId, nickname || null, (req as unknown as AuthedRequest).session.username);
    res.json({ nickname: nickname || null });
  }));

  guild.get('/overview', route(async (req, res) => {
    const id = req.guildId;
    const info = gateway.getGuild(id)!;
    const [config, cases24h, openTickets, events24h, activeGiveaways, locked, days, recentEvents, attacksBlocked, totalTickets] = await Promise.all([
      getConfig(id),
      Case.countDocuments({ guildId: id, createdAt: { $gte: new Date(Date.now() - 86_400_000) } }),
      Ticket.countDocuments({ guildId: id, status: 'open' }),
      SecurityEvent.countDocuments({ guildId: id, createdAt: { $gte: new Date(Date.now() - 86_400_000) } }),
      Giveaway.countDocuments({ guildId: id, ended: false }),
      gateway.isLocked(id),
      DailyStat.find({ guildId: id }).sort({ date: -1 }).limit(14),
      SecurityEvent.find({ guildId: id }).sort({ createdAt: -1 }).limit(6),
      SecurityEvent.countDocuments({ guildId: id, severity: 'critical', monitorOnly: { $ne: true } }),
      Ticket.countDocuments({ guildId: id }),
    ]);
    const s = config.security;
    const modules = [s.antiNuke.enabled, s.antiRaid.enabled, s.suspicious.enabled, s.antiBot.enabled, s.antiSpam.enabled, s.antiMention.enabled, s.antiLinks.scam || s.antiLinks.phishing, s.antiWebhook.enabled];
    const byDate = new Map(days.map((d) => [d.date, d]));
    const activity = Array.from({ length: 14 }, (_, n) => {
      const date = utcDate(new Date(Date.now() - (13 - n) * 86_400_000));
      const d = byDate.get(date);
      return { date, messages: d?.messages ?? 0, joins: d?.joins ?? 0, leaves: d?.leaves ?? 0 };
    });
    res.json({
      guild: info,
      access: req.access,
      bot: { ping: gateway.ping(), uptimeMs: gateway.uptimeMs() },
      stats: { cases24h, openTickets, events24h, activeGiveaways, attacksBlocked, totalTickets, activeModules: s.enabled ? modules.filter(Boolean).length : 0, totalModules: modules.length },
      status: { security: config.security.enabled ? config.security.mode : 'off', locked, logging: config.logging.enabled, welcome: config.welcome.enabled, tickets: config.tickets.enabled, levels: config.community.levels.enabled },
      activity,
      recentEvents: recentEvents.map((e) => ({ type: e.type, severity: e.severity, summary: e.summary.split('\n')[0], at: e.createdAt, monitorOnly: e.monitorOnly })),
    });
  }));

  guild.get('/resources', route((req, res) => {
    res.json({ channels: gateway.getChannels(req.guildId), roles: gateway.getRoles(req.guildId), backgrounds: Object.keys(BACKGROUND_PRESETS) });
  }));

  guild.get('/command-list', route((_req, res) => { res.json(commandSummaries()); }));

  // ---------- Config ----------
  guild.get('/config/:section', route(async (req, res) => {
    const section = String(req.params.section) as ConfigSection;
    if (!CONFIG_SECTIONS.includes(section)) return res.status(404).json({ error: 'Not found.' });
    res.json((await getConfig(req.guildId))[section]);
  }));

  guild.put('/config/:section', route(async (req, res) => {
    const section = String(req.params.section) as ConfigSection;
    if (!CONFIG_SECTIONS.includes(section)) return res.status(404).json({ error: 'Not found.' });
    const body = z.record(z.string(), z.unknown()).parse(req.body);
    if ((section === 'backup' || section === 'aiModeration' || section === 'staff') && !req.access.isTrusted) throw new UserError('Only the server owner or a trusted admin can change this.');
    if (section === 'security') {
      // An ordinary admin must not be able to disarm protection before attacking.
      if (!req.access.isTrusted) throw new UserError('Only the server owner or a trusted admin can change security settings.');
      const current = (await getConfig(req.guildId)).security;
      if (body.trustedAdmins && JSON.stringify(body.trustedAdmins) !== JSON.stringify(current.trustedAdmins) && !req.access.isOwner) throw new UserError('Only the server owner can change trusted admins.');
    }
    if (section === 'commands') {
      const names = [...(Array.isArray(body.disabled) ? body.disabled : []), ...Object.keys((body.rules as object | undefined) ?? {})];
      const known = new Set(commandSummaries().map((c) => c.name));
      if (names.some((n) => !known.has(String(n)))) throw new UserError('That command does not exist.');
      // Always-on commands can have aliases, but nothing that could switch them off or limit them.
      const rulesIn = (body.rules ?? {}) as Record<string, Record<string, unknown>>;
      const limits = (rule: Record<string, unknown>) => Object.entries(rule).some(([key, value]) => key !== 'aliases' && (Array.isArray(value) ? value.length > 0 : Boolean(value)));
      const locked = (Array.isArray(body.disabled) ? body.disabled : []).find((n) => ALWAYS_ON.has(String(n))) ?? Object.keys(rulesIn).find((n) => ALWAYS_ON.has(n) && limits(rulesIn[n]!));
      if (locked) throw new UserError(`/${String(locked)} is always on, so it cannot be turned off or limited.`);
      const incoming = (body.rules ?? {}) as Record<string, { aliases?: unknown }>;
      const merged = { ...(await getConfig(req.guildId)).commands.rules, ...incoming } as Record<string, { aliases?: unknown }>;
      const owners = new Map<string, string>();
      for (const [name, rule] of Object.entries(merged)) {
        const aliases = Array.isArray(rule.aliases) ? rule.aliases.map(String) : [];
        for (const alias of aliases) {
          const builtIn = builtInOwner(alias.startsWith(PREFIX) ? alias.slice(PREFIX.length) : alias);
          if (builtIn && builtIn !== name) throw new UserError(`"${alias}" already runs /${builtIn}, so it cannot be an alias of /${name}.`);
          if (owners.has(alias) && owners.get(alias) !== name) throw new UserError(`"${alias}" is already an alias of /${owners.get(alias)}.`);
          owners.set(alias, name);
        }
      }
    }
    const items = Array.isArray(body.items) ? (body.items as Array<{ channelId?: string; roleId?: string }>) : [];
    if (section === 'autoPurge' && !req.access.isTrusted) throw new UserError('Only the server owner or a trusted admin can change Auto Purge, because it deletes messages.');
    if (section === 'sticky' || section === 'autoPurge') {
      const ids = items.map((i) => i.channelId);
      if (new Set(ids).size !== ids.length) throw new UserError('Each channel can only be listed once.');
      const known = new Set(gateway.getChannels(req.guildId).filter((c) => c.type === 'text' || c.type === 'announcement').map((c) => c.id));
      if (ids.some((id) => id && !known.has(id))) throw new UserError('Choose a text channel in this server.');
    }
    if (section === 'sticky') {
      // Otherwise a dashboard user could post in a channel they cannot reach in Discord.
      const saved = new Set((await getConfig(req.guildId)).sticky.items.map((s) => s.channelId));
      for (const { channelId } of items) if (channelId && !saved.has(channelId)) await gateway.assertCanPost(req.guildId, channelId, (req as unknown as AuthedRequest).session.userId);
    }
    if (section === 'voiceLink') {
      const voice = new Set(gateway.getChannels(req.guildId).filter((c) => c.type === 'voice').map((c) => c.id));
      const roles = gateway.getRoles(req.guildId);
      for (const { channelId, roleId } of items) {
        if (channelId && !voice.has(channelId)) throw new UserError('Choose a voice channel in this server.');
        const role = roles.find((r) => r.id === roleId);
        if (roleId && (!role || role.dangerous || role.managed)) throw new UserError('Voice Link cannot give that role. Roles with moderator or admin permissions, and roles managed by an integration, are not allowed.');
      }
    }
    if (section === 'moderation' && typeof body.jailRoleId === 'string') {
      const role = gateway.getRoles(req.guildId).find((r) => r.id === body.jailRoleId);
      if (!role || role.dangerous || role.managed) throw new UserError('The jail role cannot have moderator or admin permissions.');
    }
    res.json(await updateConfig(req.guildId, section, body));
  }));

  // ---------- Security ----------
  guild.get('/security/events', route(async (req, res) => {
    res.json(await SecurityEvent.find({ guildId: req.guildId }).sort({ createdAt: -1 }).limit(100));
  }));

  guild.post('/security/lockdown', route(async (req, res) => {
    if (!req.access.isTrusted) throw new UserError('Only the server owner or a trusted admin can control lockdown.');
    const { on, reason } = LockdownInput.parse(req.body);
    res.json(await gateway.setLockdown(req.guildId, on, req.session.userId, reason));
  }));

  // ---------- Top bar ----------
  guild.get('/notifications', route(async (req, res) => {
    const [events, pendingFlags] = await Promise.all([SecurityEvent.find({ guildId: req.guildId }).sort({ createdAt: -1 }).limit(8), AiFlag.countDocuments({ guildId: req.guildId, status: 'pending' })]);
    res.json({ pendingFlags, events: events.map((e) => ({ type: e.type, severity: e.severity, summary: e.summary.split('\n')[0], at: e.createdAt })) });
  }));

  // ---------- Anti-raid ----------
  guild.get('/anti-raid/stats', route(async (req, res) => {
    const since = Date.now() - 24 * 3_600_000;
    const [joins, days, raids] = await Promise.all([
      AuditEntry.find({ guildId: req.guildId, category: 'member', action: 'Member joined', createdAt: { $gte: new Date(since) } }),
      DailyStat.find({ guildId: req.guildId }).sort({ date: -1 }).limit(14),
      SecurityEvent.find({ guildId: req.guildId, type: { $in: ['anti_raid', 'suspicious_account', 'anti_bot'] } }).sort({ createdAt: -1 }).limit(20),
    ]);
    const hours = Array.from({ length: 24 }, (_, n) => ({ hoursAgo: 23 - n, joins: 0 }));
    for (const j of joins) { const slot = hours[23 - Math.floor((Date.now() - new Date(j.createdAt).getTime()) / 3_600_000)]; if (slot) slot.joins += 1; }
    res.json({ joins24h: joins.length, hours, days: days.reverse().map((d) => ({ date: d.date, joins: d.joins, leaves: d.leaves })), events: raids, locked: await gateway.isLocked(req.guildId) });
  }));

  // ---------- Webhooks ----------
  guild.get('/webhooks', route(async (req, res) => {
    const [hooks, activity, { security }] = await Promise.all([gateway.listWebhooks(req.guildId), SecurityEvent.find({ guildId: req.guildId, type: { $regex: '^(anti_webhook|webhook_)' } }).sort({ createdAt: -1 }).limit(30), getConfig(req.guildId)]);
    res.json({ webhooks: hooks.map((w) => ({ ...w, trusted: security.antiWebhook.trustedWebhooks.includes(w.id) })), activity });
  }));
  guild.delete('/webhooks/:id', route(async (req, res) => {
    if (!req.access.isTrusted) throw new UserError('Only the server owner or a trusted admin can remove webhooks.');
    await gateway.deleteWebhook(req.guildId, snowflake.parse(req.params.id), req.session.username);
    res.json({ ok: true });
  }));

  // ---------- Backups ----------
  const trustedOnly = (req: GuildRequest) => { if (!req.access.isTrusted) throw new UserError('Only the server owner or a trusted admin can manage backups.'); };
  guild.get('/backups', route(async (req, res) => {
    res.json((await ServerBackup.find({ guildId: req.guildId }).sort({ createdAt: -1 })).map(backupSummary));
  }));
  guild.post('/backups', route(async (req, res) => {
    trustedOnly(req);
    res.json(await gateway.createBackup(req.guildId, req.session.username));
  }));
  guild.get('/backups/:id/download', route(async (req, res) => {
    trustedOnly(req);
    const doc = await ServerBackup.findOne({ guildId: req.guildId, backupId: String(req.params.id) });
    if (!doc) throw new UserError('That backup no longer exists.');
    res.setHeader('Content-Disposition', `attachment; filename="zytheron-backup-${doc.backupId}.json"`);
    res.json({ backupId: doc.backupId, createdAt: doc.createdAt, createdBy: doc.createdBy, ...doc.data });
  }));
  guild.post('/backups/:id/restore', route(async (req, res) => {
    trustedOnly(req);
    await gateway.restoreBackup(req.guildId, String(req.params.id), req.session.username, RestoreInput.parse(req.body));
    res.json({ started: true });
  }));
  guild.delete('/backups/:id', route(async (req, res) => {
    trustedOnly(req);
    const removed = await ServerBackup.deleteOne({ guildId: req.guildId, backupId: String(req.params.id), status: 'ready' });
    if (!removed.deletedCount) throw new UserError('That backup is in use or no longer exists.');
    res.json({ ok: true });
  }));

  // ---------- Audit logs ----------
  const auditRows = async (guildId: string, q: z.infer<typeof AuditQuery>) => {
    const rows = await AuditEntry.find({ guildId, ...(q.category ? { category: q.category } : {}) }).sort({ createdAt: -1 });
    const text = q.q?.toLowerCase();
    const user = q.user?.toLowerCase();
    return rows.filter((r) => {
      const at = new Date(r.createdAt).getTime();
      if (q.from && at < q.from.getTime()) return false;
      if (q.to && at > q.to.getTime()) return false;
      if (user && !`${r.userId ?? ''} ${r.userName ?? ''}`.toLowerCase().includes(user)) return false;
      return !text || `${r.action} ${r.target ?? ''} ${r.details ?? ''}`.toLowerCase().includes(text);
    });
  };
  guild.get('/audit-logs', route(async (req, res) => {
    const q = AuditQuery.parse(req.query);
    const rows = await auditRows(req.guildId, q);
    res.json({ total: rows.length, page: q.page, pageSize: AUDIT_PAGE, items: rows.slice(q.page * AUDIT_PAGE, (q.page + 1) * AUDIT_PAGE).map((r) => ({ _id: r._id, createdAt: r.createdAt, category: r.category, action: r.action, userId: r.userId, target: r.target, channelId: r.channelId, status: r.status, details: r.details, userName: r.userName ?? (r.userId ? gateway.memberName(req.guildId, r.userId) : null) })) });
  }));
  guild.get('/audit-logs/export', route(async (req, res) => {
    const rows = await auditRows(req.guildId, AuditQuery.parse(req.query));
    const lines = [['Time', 'Category', 'Action', 'User', 'User ID', 'Target', 'Channel ID', 'Status', 'Details'].join(',')];
    for (const r of rows) lines.push([r.createdAt, r.category, r.action, r.userName ?? '', r.userId ?? '', r.target ?? '', r.channelId ?? '', r.status, r.details ?? ''].map(csvCell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="zytheron-audit-logs.csv"');
    res.send(lines.join('\r\n'));
  }));

  // ---------- AI moderation ----------
  guild.get('/ai/overview', route(async (req, res) => {
    const [days, pending, recent] = await Promise.all([AiStat.find({ guildId: req.guildId }).sort({ date: -1 }).limit(14), AiFlag.find({ guildId: req.guildId, status: 'pending' }).sort({ createdAt: -1 }).limit(50), AiFlag.find({ guildId: req.guildId, status: { $ne: 'pending' } }).sort({ createdAt: -1 }).limit(50)]);
    const total = (key: 'analyzed' | 'flagged' | 'warned' | 'timedOut' | 'falsePositive') => days.reduce((sum, d) => sum + (d[key] ?? 0), 0);
    res.json({ connected: aiConnected(), model: aiModel(), totals: { analyzed: total('analyzed'), flagged: total('flagged'), warned: total('warned'), timedOut: total('timedOut'), falsePositive: total('falsePositive') }, days: days.reverse(), pending, recent });
  }));
  guild.post('/ai/flags/:id/review', route(async (req, res) => {
    const { decision } = ReviewInput.parse(req.body);
    await gateway.reviewAiFlag(req.guildId, String(req.params.id), decision, req.session.userId);
    res.json({ ok: true });
  }));
  guild.post('/ai/test', route(async (req, res) => {
    if (!req.access.isTrusted) throw new UserError('Only the server owner or a trusted admin can run a test.');
    if (!aiConnected()) throw new UserError('AI is not connected. Add ANTHROPIC_API_KEY to the .env file and restart the bot.');
    const { text } = z.object({ text: z.string().trim().min(1).max(AI_TEST_MAX) }).parse(req.body);
    res.json({ verdict: await classifyMessage(text, (await getConfig(req.guildId)).aiModeration) });
  }));

  // ---------- Bot identity ----------
  guild.get('/identity', route(async (req, res) => { res.json(await gateway.getIdentity(req.session.userId)); }));
  guild.put('/identity', route(async (req, res) => {
    await gateway.updateIdentity(req.session.userId, IdentityInput.parse(req.body));
    res.json({ ok: true });
  }));

  staffRoutes(guild, gateway, route as never);

  // ---------- Moderation ----------
  guild.get('/cases', route(async (req, res) => {
    const q = z.object({ page: z.coerce.number().int().min(0).default(0), type: z.string().regex(/^[a-z]{0,20}$/).optional(), user: snowflake.optional() }).parse(req.query);
    const filter: Record<string, unknown> = { guildId: req.guildId, ...(q.type ? { type: q.type } : {}), ...(q.user ? { targetId: q.user } : {}) };
    const [total, items] = await Promise.all([Case.countDocuments(filter), Case.find(filter).sort({ number: -1 }).skip(q.page * 25).limit(25)]);
    res.json({ total, page: q.page, items });
  }));

  // ---------- Tickets ----------
  guild.get('/tickets', route(async (req, res) => {
    const all = await Ticket.find({ guildId: req.guildId }).sort({ number: -1 });
    const rated = all.filter((t) => t.rating);
    res.json({ tickets: all.slice(0, 100), stats: { total: all.length, open: all.filter((t) => t.status === 'open').length, closed: all.filter((t) => t.status !== 'open').length, unclaimed: all.filter((t) => t.status === 'open' && !t.claimedBy).length, averageRating: rated.length ? rated.reduce((sum, t) => sum + t.rating!, 0) / rated.length : null } });
  }));

  // ---------- Embed templates ----------
  guild.post('/tickets/:id/action', route(async (req, res) => {
    const { action, userId } = TicketActionInput.parse(req.body);
    await gateway.ticketAction(req.guildId, String(req.params.id), action, req.session.userId, userId);
    res.json({ ok: true });
  }));

  guild.get('/embeds', route(async (req, res) => {
    res.json(await EmbedTemplate.find({ guildId: req.guildId }).sort({ name: 1 }));
  }));
  guild.put('/embeds', route(async (req, res) => {
    const { name, spec } = TemplateInput.parse(req.body);
    const exists = await EmbedTemplate.exists({ guildId: req.guildId, name });
    if (!exists && (await EmbedTemplate.countDocuments({ guildId: req.guildId })) >= 100) throw new UserError('This server has reached 100 templates.');
    await EmbedTemplate.updateOne({ guildId: req.guildId, name }, { $set: { spec, createdBy: req.session.userId } }, { upsert: true });
    res.json({ ok: true, name });
  }));
  guild.delete('/embeds/:name', route(async (req, res) => {
    await EmbedTemplate.deleteOne({ guildId: req.guildId, name: String(req.params.name) });
    res.json({ ok: true });
  }));
  guild.post('/embeds/send', route(async (req, res) => {
    const body = z.object({ channelId: snowflake, spec: MessageSpecSchema }).parse(req.body);
    if (!body.spec.embeds.length && !body.spec.content) throw new UserError('There is nothing to send yet.');
    res.json(await gateway.postMessage(req.guildId, body.channelId, body.spec, req.session.userId));
  }));

  // ---------- Automation CRUD ----------
  const crud = (path: string, model: any, parse: (body: unknown, guildId: string) => Record<string, unknown>, opts: { limit: number; after?: (guildId: string) => void; beforeDelete?: (item: any, guildId: string) => Promise<void> }) => {
    guild.get(`/${path}`, route(async (req, res) => { res.json(await model.find({ guildId: req.guildId }).sort({ createdAt: -1 })); }));
    guild.post(`/${path}`, route(async (req, res) => {
      if ((await model.countDocuments({ guildId: req.guildId })) >= opts.limit) throw new UserError(`This server has reached the limit of ${opts.limit}.`);
      const doc = await model.create({ ...parse(req.body, req.guildId), guildId: req.guildId, createdBy: req.session.userId });
      opts.after?.(req.guildId);
      res.status(201).json(doc);
    }));
    guild.put(`/${path}/:id`, route(async (req, res) => {
      // Scoped by guildId as well as _id, so an ID from another server can never be edited.
      const doc = await model.findOneAndUpdate({ _id: String(req.params.id), guildId: req.guildId }, { $set: parse(req.body, req.guildId) });
      if (!doc) return res.status(404).json({ error: 'Not found.' });
      opts.after?.(req.guildId);
      res.json(doc);
    }));
    guild.delete(`/${path}/:id`, route(async (req, res) => {
      const item = opts.beforeDelete ? await model.findOne({ _id: String(req.params.id), guildId: req.guildId }) : null;
      if (item) await opts.beforeDelete!(item, req.guildId);
      await model.deleteOne({ _id: String(req.params.id), guildId: req.guildId });
      opts.after?.(req.guildId);
      res.json({ ok: true });
    }));
  };

  crud('commands', CustomCommand, (b) => CustomCommandInput.parse(b), { limit: 100 });
  crud('autoresponses', AutoResponse, (b) => {
    const v = AutoResponseInput.parse(b);
    if (v.matchType === 'regex') compileUserRegex(v.trigger);
    return v;
  }, { limit: 100, after: invalidateAutomation });
  crud('schedules', ScheduledMessage, (b) => {
    const v = ScheduleInput.parse(b);
    return { ...v, nextRunAt: nextCronRun(v.cron, v.timezone) };
  }, { limit: 50 });
  crud('rules', AutomationRule, (b) => {
    const v = RuleInput.parse(b);
    if (v.trigger.type === 'regex') compileUserRegex(v.trigger.value ?? '');
    if ((v.trigger.type === 'keyword' || v.trigger.type === 'regex' || v.trigger.type === 'role_added') && !v.trigger.value) throw new UserError('This trigger needs a value.');
    return v;
  }, { limit: 100, after: invalidateAutomation });

  // ---------- Panels: created here, posted by the bot ----------
  const removePanelMessage = async (panel: { channelId?: string | null; messageId?: string | null }, guildId: string) => {
    if (panel.channelId && panel.messageId) await gateway.deleteMessage(guildId, panel.channelId, panel.messageId);
  };
  crud('rolepanels', RolePanel, (b, guildId) => {
    const v = RolePanelInput.parse(b);
    const roles = gateway.getRoles(guildId);
    const items = v.items.map((item) => {
      const role = roles.find((r) => r.id === item.roleId);
      if (!role) throw new UserError('One of the roles no longer exists.');
      if (role.managed || role.dangerous) throw new UserError(`@${role.name} cannot go on a panel: it has moderator or admin permissions, or is managed by an integration.`);
      return { ...item, label: item.label || role.name.slice(0, 80) };
    });
    return { ...v, items };
  }, { limit: 50, beforeDelete: removePanelMessage });
  crud('ticketpanels', TicketPanel, (b) => {
    const v = TicketPanelInput.parse(b);
    return { ...v, categories: v.categories.map((c) => ({ ...c, id: c.id ?? randomUUID().slice(0, 8) })) };
  }, { limit: 50, beforeDelete: removePanelMessage });
  guild.post('/rolepanels/:id/publish', route(async (req, res) => {
    const { channelId } = PublishInput.parse(req.body);
    res.json(await gateway.publishRolePanel(req.guildId, String(req.params.id), channelId, req.session.userId));
  }));
  guild.post('/ticketpanels/:id/publish', route(async (req, res) => {
    const { channelId } = PublishInput.parse(req.body);
    res.json(await gateway.publishTicketPanel(req.guildId, String(req.params.id), channelId, req.session.userId));
  }));

  // ---------- Welcome card preview, drawn by the same code the bot uses ----------
  guild.get('/welcome/card/:template', route(async (req, res) => {
    const { welcome } = await getConfig(req.guildId);
    const id = String(req.params.template);
    const template = id === 'goodbye' ? welcome.goodbye : welcome.templates.find((t) => t.id === id);
    if (!template) return res.status(404).json({ error: 'Not found.' });
    const info = gateway.getGuild(req.guildId)!;
    const vars = { server: info.name, membercount: info.memberCount.toLocaleString(), username: req.session.username };
    const png = await renderCard({ background: template.card.background, accent: template.card.accent, headline: renderVars(template.card.headline, vars), title: req.session.username, subline: renderVars(template.card.subline, vars), avatar: null, seed: req.session.userId });
    res.type('png').set('Cache-Control', 'no-store').send(png);
  }));

  return api;
}
