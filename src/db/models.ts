import { Collection } from './store.js';

interface Stamped { _id: string; createdAt: Date; updatedAt: Date }
const DAY = 86_400;
const guildAnd = (field: string) => ({ fields: ['guildId', field] });

// ---------- Core ----------
export interface IGuildSettings extends Stamped { guildId: string; config: Record<string, unknown> }
export const GuildSettings = new Collection<IGuildSettings>('guildSettings', { defaults: () => ({ config: {} }), unique: [{ fields: ['guildId'] }] });

export interface ICounter { _id: string; value: number }
export const Counter = new Collection<ICounter>('counters', { timestamps: false });

/** Per-guild sequence (case numbers, ticket numbers, suggestion numbers...). */
export async function nextSequence(guildId: string, name: string): Promise<number> {
  const doc = await Counter.findOneAndUpdate({ _id: `${guildId}:${name}` }, { $inc: { value: 1 } }, { upsert: true });
  return doc!.value;
}

export interface IMeta { _id: string; value: string }
export const Meta = new Collection<IMeta>('meta', { timestamps: false });

export interface IJob extends Stamped { type: string; guildId: string; runAt: Date; payload: Record<string, unknown>; status: 'pending' | 'running' | 'done' | 'failed'; attempts: number; lockedUntil?: Date | null; lastError?: string; dedupeKey?: string | null }
export const Job = new Collection<IJob>('jobs', {
  defaults: () => ({ payload: {}, status: 'pending', attempts: 0, dedupeKey: null }),
  unique: [{ fields: ['dedupeKey'], where: { status: 'pending', dedupeKey: { $ne: null } } }],
  ttl: [{ field: 'updatedAt', seconds: 14 * DAY, where: { status: { $in: ['done', 'failed'] } } }],
});

// ---------- Security ----------
export interface ISecurityEvent extends Stamped { guildId: string; type: string; severity: 'info' | 'warning' | 'critical'; actorId?: string; targetId?: string; summary: string; action?: string; monitorOnly?: boolean; details?: Record<string, unknown> }
export const SecurityEvent = new Collection<ISecurityEvent>('securityEvents', { ttl: [{ field: 'createdAt', seconds: 90 * DAY }] });

export interface ILockdown extends Stamped { guildId: string; active: boolean; reason?: string; by?: string; snapshot: Array<{ channelId: string; allow: string; deny: string; existed: boolean }> }
export const Lockdown = new Collection<ILockdown>('lockdowns', { defaults: () => ({ snapshot: [] }), unique: [{ fields: ['guildId'] }] });

// ---------- Moderation ----------
export type CaseType = 'ban' | 'unban' | 'tempban' | 'kick' | 'timeout' | 'untimeout' | 'warn' | 'note' | 'jail' | 'unjail' | 'voicemute' | 'voiceunmute' | 'voicedeafen' | 'voiceundeafen' | 'nickname' | 'purge' | 'slowmode' | 'lock' | 'unlock' | 'hide' | 'unhide' | 'automod';
export interface ICase extends Stamped { guildId: string; number: number; type: CaseType; targetId: string; targetTag: string; moderatorId: string; moderatorTag: string; reason: string; durationMs?: number | null; expiresAt?: Date | null; active: boolean; meta?: Record<string, unknown> }
export const Case = new Collection<ICase>('cases', { defaults: () => ({ active: true }), unique: [guildAnd('number')] });

export interface IJail extends Stamped { guildId: string; userId: string; previousRoles: string[]; active: boolean }
export const Jail = new Collection<IJail>('jails', { defaults: () => ({ previousRoles: [], active: true }), unique: [guildAnd('userId')] });

// ---------- Embeds ----------
export interface IEmbedTemplate extends Stamped { guildId: string; name: string; spec: Record<string, unknown>; createdBy: string }
export const EmbedTemplate = new Collection<IEmbedTemplate>('embedTemplates', { unique: [guildAnd('name')] });

export interface IEmbedDraft extends Stamped { guildId: string; userId: string; spec: Record<string, unknown>; activeIndex: number; channelId?: string | null; messageId?: string | null; templateName?: string | null }
export const EmbedDraft = new Collection<IEmbedDraft>('embedDrafts', { defaults: () => ({ activeIndex: 0 }), unique: [guildAnd('userId')], ttl: [{ field: 'updatedAt', seconds: 7 * DAY }] });

export interface IPostedEmbed extends Stamped { guildId: string; channelId: string; messageId: string; spec: Record<string, unknown>; createdBy: string }
export const PostedEmbed = new Collection<IPostedEmbed>('postedEmbeds', { unique: [{ fields: ['messageId'] }] });

// ---------- Roles ----------
export interface IRolePanelItem { roleId: string; label: string; emoji?: string | null; description?: string | null }
export interface IRolePanel extends Stamped { guildId: string; name: string; kind: 'button' | 'select' | 'reaction'; behavior: 'toggle' | 'unique' | 'add_only' | 'remove_only'; title: string; description: string; color: string; channelId?: string | null; messageId?: string | null; tempMinutes?: number | null; requiredRoleId?: string | null; items: IRolePanelItem[] }
export const RolePanel = new Collection<IRolePanel>('rolePanels', { defaults: () => ({ behavior: 'toggle', color: '#7c3aed', items: [] }), unique: [guildAnd('name')] });

// ---------- Tickets ----------
export interface ITicketCategory { id: string; label: string; emoji?: string | null; description?: string | null; staffRoleIds: string[]; parentCategoryId?: string | null; welcomeMessage?: string | null; questions?: string[] }
export interface ITicketPanel extends Stamped { guildId: string; name: string; style: 'buttons' | 'select'; title: string; description: string; color: string; channelId?: string | null; messageId?: string | null; categories: ITicketCategory[] }
export const TicketPanel = new Collection<ITicketPanel>('ticketPanels', { defaults: () => ({ style: 'buttons', color: '#7c3aed', categories: [] }), unique: [guildAnd('name')] });

export interface ITicket extends Stamped { guildId: string; number: number; channelId: string; ownerId: string; ownerTag: string; panelName?: string; categoryLabel?: string; subject: string; status: 'open' | 'closed' | 'deleted'; claimedBy?: string | null; addedUsers: string[]; closedBy?: string | null; closedAt?: Date | null; rating?: number | null; messageCount?: number; claimedAt?: Date | null; assignedAt?: Date | null; assignedBy?: string | null; firstResponseAt?: Date | null; firstResponderId?: string | null; resolvedAt?: Date | null; resolvedBy?: string | null }
export const Ticket = new Collection<ITicket>('tickets', { defaults: () => ({ status: 'open', addedUsers: [] }), unique: [guildAnd('number')] });

// ---------- Automation ----------
export type MatchType = 'exact' | 'contains' | 'word' | 'startsWith' | 'regex';
export interface IAutoResponse extends Stamped { guildId: string; trigger: string; matchType: MatchType; response: string; channels: string[]; cooldownSec: number; deleteTrigger: boolean; enabled: boolean }
export const AutoResponse = new Collection<IAutoResponse>('autoResponses', { defaults: () => ({ matchType: 'contains', channels: [], cooldownSec: 10, deleteTrigger: false, enabled: true }), unique: [guildAnd('trigger')] });

export interface ICustomCommand extends Stamped { guildId: string; name: string; response: string; templateName?: string | null; allowedRoles: string[]; uses: number; createdBy: string }
export const CustomCommand = new Collection<ICustomCommand>('customCommands', { defaults: () => ({ response: '', allowedRoles: [], uses: 0 }), unique: [guildAnd('name')] });

export interface IScheduledMessage extends Stamped { guildId: string; name: string; channelId: string; cron?: string | null; timezone: string; content: string; templateName?: string | null; enabled: boolean; nextRunAt?: Date | null; lastRunAt?: Date | null; createdBy: string }
export const ScheduledMessage = new Collection<IScheduledMessage>('scheduledMessages', { defaults: () => ({ timezone: 'UTC', content: '', enabled: true }), unique: [guildAnd('name')] });

export interface IRuleAction { type: 'reply' | 'send_channel' | 'dm' | 'add_role' | 'remove_role' | 'delete_message' | 'timeout' | 'log'; value?: string; channelId?: string; minutes?: number }
export interface IAutomationRule extends Stamped { guildId: string; name: string; trigger: { type: 'keyword' | 'regex' | 'member_join' | 'role_added'; value?: string }; channels: string[]; actions: IRuleAction[]; enabled: boolean; cooldownSec: number; runs: number }
export const AutomationRule = new Collection<IAutomationRule>('automationRules', { defaults: () => ({ channels: [], actions: [], enabled: true, cooldownSec: 5, runs: 0 }), unique: [guildAnd('name')] });

// ---------- Community ----------
export interface IMemberLevel extends Stamped { guildId: string; userId: string; xp: number; level: number; messages: number; lastXpAt?: Date | null }
export const MemberLevel = new Collection<IMemberLevel>('memberLevels', { defaults: () => ({ xp: 0, level: 0, messages: 0 }), unique: [guildAnd('userId')] });

export interface IGiveaway extends Stamped { guildId: string; channelId: string; messageId?: string | null; prize: string; winnersCount: number; hostId: string; endsAt: Date; requiredRoleId?: string | null; entrants: string[]; winners: string[]; ended: boolean }
export const Giveaway = new Collection<IGiveaway>('giveaways', { defaults: () => ({ entrants: [], winners: [], ended: false }) });

export interface IPoll extends Stamped { guildId: string; channelId: string; messageId?: string | null; question: string; options: string[]; multi: boolean; authorId: string; endsAt?: Date | null; ended: boolean; votes: Array<{ userId: string; option: number }> }
export const Poll = new Collection<IPoll>('polls', { defaults: () => ({ ended: false, votes: [] }) });

export interface ISuggestion extends Stamped { guildId: string; number: number; channelId: string; messageId?: string | null; authorId: string; content: string; status: 'open' | 'approved' | 'denied'; up: string[]; down: string[]; staffReason?: string | null }
export const Suggestion = new Collection<ISuggestion>('suggestions', { defaults: () => ({ status: 'open', up: [], down: [] }), unique: [guildAnd('number')] });

export interface IStarEntry extends Stamped { guildId: string; messageId: string; channelId: string; starboardMessageId?: string | null; count: number }
export const StarEntry = new Collection<IStarEntry>('starEntries', { unique: [{ fields: ['messageId'] }] });

export interface IInviteRecord extends Stamped { guildId: string; memberId: string; inviterId?: string | null; code?: string | null; left: boolean }
export const InviteRecord = new Collection<IInviteRecord>('inviteRecords', { defaults: () => ({ left: false }), unique: [guildAnd('memberId')] });

export interface IDailyStat { _id: string; guildId: string; date: string; messages: number; joins: number; leaves: number }
export const DailyStat = new Collection<IDailyStat>('dailyStats', { defaults: () => ({ messages: 0, joins: 0, leaves: 0 }), unique: [guildAnd('date')], timestamps: false });

export interface IBirthday extends Stamped { guildId: string; userId: string; month: number; day: number; lastCelebratedYear?: number | null }
export const Birthday = new Collection<IBirthday>('birthdays', { unique: [guildAnd('userId')] });

export interface IAfk extends Stamped { guildId: string; userId: string; reason: string }
export const Afk = new Collection<IAfk>('afk', { unique: [guildAnd('userId')] });

export interface IProfile extends Stamped { guildId: string; userId: string; bio: string; pronouns: string; color: string; link: string }
export const Profile = new Collection<IProfile>('profiles', { defaults: () => ({ bio: '', pronouns: '', color: '#7c3aed', link: '' }), unique: [guildAnd('userId')] });

// ---------- Dashboard ----------
export interface IWebSession { _id: string; userId: string; username: string; avatar?: string | null; accessTokenEnc: string; csrf: string; expiresAt: Date }
export const WebSession = new Collection<IWebSession>('webSessions', { timestamps: false, ttl: [{ field: 'expiresAt', seconds: 0 }] });

// ---------- Dashboard ----------
/** Who changed what on the dashboard, shown under Recent actions. */
export interface IDashboardAction extends Stamped { guildId: string; userId: string; username: string; action: string }
export const DashboardAction = new Collection<IDashboardAction>('dashboardActions', { ttl: [{ field: 'createdAt', seconds: 90 * DAY }] });

// ---------- Audit logs ----------
/** A searchable copy of each log event. Message text is never stored here. */
export interface IAuditEntry extends Stamped { guildId: string; category: string; action: string; userId?: string | null; userName?: string | null; target?: string | null; channelId?: string | null; status: 'ok' | 'enforced' | 'monitor'; details?: string | null }
export const AuditEntry = new Collection<IAuditEntry>('auditEntries', { ttl: [{ field: 'createdAt', seconds: 30 * DAY }] });

// ---------- Backups ----------
export interface IRestoreReport { at: Date; by: string; created: number; updated: number; failed: number; notes: string[] }
export interface IServerBackup extends Stamped { guildId: string; backupId: string; kind: 'manual' | 'auto'; createdBy: string; status: 'ready' | 'restoring'; sizeBytes: number; counts: { roles: number; categories: number; channels: number; emojis: number }; data: Record<string, unknown>; lastRestore?: IRestoreReport | null }
export const ServerBackup = new Collection<IServerBackup>('serverBackups', { defaults: () => ({ status: 'ready', lastRestore: null }), unique: [{ fields: ['backupId'] }] });

// ---------- AI moderation ----------
export type AiCategory = 'toxicity' | 'harassment' | 'spam' | 'scam' | 'phishing' | 'suspicious';
export interface IAiFlag extends Stamped { guildId: string; messageId: string; channelId: string; authorId: string; authorTag: string; category: AiCategory; confidence: number; reason: string; excerpt: string; source: 'ai' | 'link_scanner'; status: 'pending' | 'actioned' | 'dismissed' | 'false_positive'; action?: string | null; reviewedBy?: string | null }
export const AiFlag = new Collection<IAiFlag>('aiFlags', { defaults: () => ({ status: 'pending' }), ttl: [{ field: 'createdAt', seconds: 30 * DAY }] });

export interface IAiStat { _id: string; guildId: string; date: string; analyzed: number; flagged: number; warned: number; timedOut: number; falsePositive: number }
export const AiStat = new Collection<IAiStat>('aiStats', { defaults: () => ({ analyzed: 0, flagged: 0, warned: 0, timedOut: 0, falsePositive: 0 }), unique: [guildAnd('date')], timestamps: false });

// ---------- Staff performance ----------
/** Staff work the bot saw in the server. Message text is never stored. */
export interface IStaffEvent extends Stamped { guildId: string; userId: string; type: 'ticket_claim' | 'ticket_close' | 'ticket_reply' }
export const StaffEvent = new Collection<IStaffEvent>('staffEvents', { ttl: [{ field: 'createdAt', seconds: 400 * DAY }] });

export interface IStaffRecord extends Stamped { guildId: string; userId: string; userName: string; type: 'warning' | 'note' | 'review' | 'admin_action' | 'promotion' | 'role_change'; adminId?: string | null; adminName: string; reason: string; date: Date }
export const StaffRecord = new Collection<IStaffRecord>('staffRecords');

/** Every change to a staff record. Nothing edits or removes these. */
export interface IStaffRecordLog extends Stamped { guildId: string; recordId: string; action: 'created' | 'edited' | 'removed'; by: string; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null }
export const StaffRecordLog = new Collection<IStaffRecordLog>('staffRecordLog');
