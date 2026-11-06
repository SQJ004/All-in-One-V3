/**
 * Testing tool only: runs the real website against a fake Discord with sample data, kept in
 * memory, so the UI can be explored without a bot or a Discord login. The bot never loads this
 * file and it is not part of the build. Refuses to run with NODE_ENV=production.
 */
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import { createDashboardApp, sealer } from '../../src/dashboard/app.js';
import type { DashboardGateway } from '../../src/dashboard/gateway.js';
import { AiFlag, AiStat, AuditEntry, AutoResponse, Case, CustomCommand, DailyStat, EmbedTemplate, RolePanel, SecurityEvent, ServerBackup, StaffEvent, StaffRecord, Ticket, TicketPanel, WebSession } from '../../src/db/models.js';
import { backupSummary } from '../../src/modules/backup/index.js';
import { updateConfig } from '../../src/core/configService.js';
import { utcDate } from '../../src/core/util.js';

if (process.env.NODE_ENV === 'production') throw new Error('The dashboard preview must never run in production.');

const PORT = Number(process.env.PREVIEW_PORT ?? 5199);
const GUILD = '100000000000000001';
const USER = '200000000000000001';
const secret = randomBytes(32).toString('hex');

const channels = [['300000000000000001', 'general', 'text'], ['300000000000000002', 'welcome', 'text'], ['300000000000000003', 'security-log', 'text'], ['300000000000000004', 'mod-log', 'text'], ['300000000000000005', 'announcements', 'announcement'], ['300000000000000006', 'Lounge', 'voice'], ['300000000000000007', 'Support', 'category']] as const;
const roles = [['400000000000000001', 'Admin', '#ef4444', true], ['400000000000000002', 'Moderator', '#3b82f6', true], ['400000000000000003', 'Member', '#10b981', false], ['400000000000000004', 'Gamer', '#8b5cf6', false]] as const;
let locked = false;
let previewNickname: string | null = null;
const previewImages: { avatarUrl: string | null; bannerUrl: string | null } = { avatarUrl: null, bannerUrl: null };

const demoStaff = [
  { id: USER, name: 'vortex_admin', avatar: null, joinedAt: new Date('2024-02-11'), roleIds: [roles[0][0]], roleName: 'Admin' },
  { id: '200000000000000011', name: 'mira', avatar: null, joinedAt: new Date('2024-09-03'), roleIds: [roles[1][0]], roleName: 'Moderator' },
  { id: '200000000000000012', name: 'dax', avatar: null, joinedAt: new Date('2025-01-20'), roleIds: [roles[1][0]], roleName: 'Moderator' },
  { id: '200000000000000013', name: 'sol', avatar: null, joinedAt: new Date('2025-06-14'), roleIds: [roles[3][0]], roleName: 'Gamer' },
];
let previewWebhooks = [{ id: '800000000000000001', name: 'GitHub updates', channelId: channels[0][0], createdBy: 'vortex_admin', createdAt: new Date(Date.now() - 40 * 86_400_000), application: false }, { id: '800000000000000002', name: 'Free Nitro', channelId: channels[0][0], createdBy: 'member_3', createdAt: new Date(Date.now() - 3_600_000), application: false }];
let previewIdentity = { status: 'online' as const, activityType: 'watching' as const, activityText: 'over your server', embedColor: '#7c3aed', username: 'ZYTHERON' };
const backupData = { name: 'Zytheron Community', roles: roles.map(([id, name]) => ({ id, name })), categories: [], channels: channels.map(([id, name]) => ({ id, name })), emojis: [] };
const makeBackup = (createdBy: string, kind: 'manual' | 'auto') => ServerBackup.create({ guildId: GUILD, backupId: randomBytes(6).toString('hex'), kind, createdBy, sizeBytes: JSON.stringify(backupData).length, counts: { roles: roles.length, categories: 0, channels: channels.length, emojis: 0 }, data: backupData });

const gateway: DashboardGateway = {
  clientId: '500000000000000001',
  ping: () => 42,
  uptimeMs: () => process.uptime() * 1000,
  isOnline: () => true,
  getBotProfile: async () => ({ username: 'ZYTHERON', nickname: previewNickname, ...previewImages, defaultAvatarUrl: '/logo-1024.png', defaultBannerUrl: null }),
  setBotImages: async (_g, images) => {
    if (images.avatar !== undefined) previewImages.avatarUrl = images.avatar;
    if (images.banner !== undefined) previewImages.bannerUrl = images.banner;
  },
  assertCanPost: async () => undefined,
  setNickname: async (_g, nickname) => { previewNickname = nickname; },
  guildIds: () => [GUILD],
  getGuild: (id) => (id === GUILD ? { id, name: 'Zytheron Community', icon: null, memberCount: 12480, ownerId: USER, channels: channels.length, roles: roles.length, boosts: 14, online: true } : null),
  getChannels: () => channels.map(([id, name, type]) => ({ id, name, type, parentId: null })),
  getRoles: () => roles.map(([id, name, color, dangerous], n) => ({ id, name, color, position: 10 - n, managed: false, dangerous })),
  getAccess: async (guildId, userId) => (guildId === GUILD && userId === USER ? { canManage: true, isOwner: true, isTrusted: true } : null),
  postMessage: async () => ({ url: 'https://discord.com/channels/preview' }),
  publishRolePanel: async (_g, id, channelId) => { await RolePanel.updateOne({ _id: id }, { $set: { channelId, messageId: '700000000000000002' } }); return { url: 'https://discord.com/channels/preview' }; },
  publishTicketPanel: async (_g, id, channelId) => { await TicketPanel.updateOne({ _id: id }, { $set: { channelId, messageId: '700000000000000003' } }); return { url: 'https://discord.com/channels/preview' }; },
  deleteMessage: async () => undefined,
  isLocked: async () => locked,
  setLockdown: async (_g, on) => { locked = on; return { changed: channels.length, failed: 0 }; },
  listWebhooks: async () => previewWebhooks,
  deleteWebhook: async (_g, id) => { previewWebhooks = previewWebhooks.filter((w) => w.id !== id); },
  getIdentity: async () => ({ ...previewIdentity, avatarUrl: '/logo-1024.png', bannerUrl: null, canEdit: true }),
  updateIdentity: async (_u, change) => { const { username, avatar: _a, banner: _b, ...rest } = change; previewIdentity = { ...previewIdentity, ...rest, username: username ?? previewIdentity.username } as typeof previewIdentity; },
  createBackup: async (_g, by) => backupSummary(await makeBackup(by, 'manual')),
  restoreBackup: async (_g, backupId, by) => { await ServerBackup.updateOne({ guildId: GUILD, backupId }, { $set: { lastRestore: { at: new Date(), by, created: 0, updated: 0, failed: 0, notes: ['Demo mode: nothing was changed.'] } } }); },
  memberName: (_g, id) => (id === USER ? 'vortex_admin' : `member_${id.slice(-2)}`),
  reviewAiFlag: async (_g, id, decision, userId) => { await AiFlag.updateOne({ _id: id }, { $set: { status: decision === 'dismiss' ? 'dismissed' : decision === 'false_positive' ? 'false_positive' : 'actioned', action: decision === 'warn' ? 'Warned' : decision === 'timeout' ? 'Timed out for 10 minutes' : null, reviewedBy: userId === USER ? 'vortex_admin' : userId } }); },
  staffRoster: async () => demoStaff,
  memberCard: (_g, id) => demoStaff.find((m) => m.id === id) ?? null,
  ticketAction: async (_g, id, action, userId, targetId) => { await Ticket.updateOne({ _id: id }, { $set: action === 'close' ? { status: 'closed', closedBy: userId } : action === 'reopen' ? { status: 'open', closedBy: null } : action === 'assign' ? { claimedBy: targetId } : {} }); },
};

// ---------- Demo data ----------
const days = Array.from({ length: 14 }, (_, n) => ({ guildId: GUILD, date: utcDate(new Date(Date.now() - n * 86_400_000)), messages: 900 + Math.round(1400 * Math.abs(Math.sin(n * 0.7))), joins: 8 + (n * 7) % 30, leaves: 2 + (n * 3) % 11 }));
await DailyStat.insertMany(days);
await SecurityEvent.insertMany([
  { guildId: GUILD, type: 'anti_raid', severity: 'critical', summary: 'Raid detected: 24 joins within 15s. Raid mode is on for 10 minutes.', action: 'kick every new joiner' },
  { guildId: GUILD, type: 'scam_link', severity: 'critical', actorId: USER, summary: 'Imitates discord on an unofficial domain (dlscord-nitro.gift)', action: 'timeout 10m' },
  { guildId: GUILD, type: 'suspicious_account', severity: 'warning', summary: 'Suspicious account joined (risk 65/100): Account is only 0.4 days old', action: 'log' },
]);
const reasons = ['Spam in general', 'Repeated advertising', 'Harassment after a warning', 'Scam link', 'Raid participant'];
const types = ['warn', 'timeout', 'ban', 'kick', 'automod'] as const;
await Case.insertMany(Array.from({ length: 32 }, (_, n) => ({ guildId: GUILD, number: n + 1, type: types[n % 5], targetId: '600000000000000001', targetTag: `member_${n % 7}`, moderatorId: USER, moderatorTag: 'vortex_admin', reason: reasons[n % 5], active: true })));
await Ticket.insertMany([{ guildId: GUILD, number: 1, channelId: '300000000000000099', ownerId: '600000000000000002', ownerTag: 'luna', categoryLabel: 'Billing', subject: 'I was charged twice for my subscription', status: 'open' }, { guildId: GUILD, number: 2, channelId: '300000000000000098', ownerId: '600000000000000003', ownerTag: 'kai', categoryLabel: 'Report', subject: 'Reporting a member for scam DMs', status: 'closed', rating: 5 }]);
await AutoResponse.create({ guildId: GUILD, trigger: 'how do i verify', matchType: 'contains', response: 'Head to the verify channel, {user}.' });
await CustomCommand.create({ guildId: GUILD, name: 'rules', response: 'Read the rules in the rules channel.', createdBy: USER, uses: 83 });
await EmbedTemplate.create({ guildId: GUILD, name: 'server-rules', createdBy: USER, spec: { embeds: [{ title: 'Server Rules', description: 'Be **kind**. No spam.', color: '#7c3aed', fields: [] }] } });
await RolePanel.create({ guildId: GUILD, name: 'games', kind: 'button', title: 'Pick your games', description: 'Choose below', channelId: channels[0][0], messageId: '700000000000000001', items: [{ roleId: roles[3][0], label: 'Gamer' }] });
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
await AuditEntry.insertMany([
  ...Array.from({ length: 60 }, (_, n) => ({ guildId: GUILD, category: 'member', action: 'Member joined', userId: `60000000000000${String(1000 + n)}`, status: 'ok', details: 'Account created 2 years ago', createdAt: ago(n * 22) })),
  { guildId: GUILD, category: 'role', action: 'Role updated', userId: USER, userName: 'vortex_admin', target: '@Moderator', status: 'ok', details: 'Permissions changed', createdAt: ago(5) },
  { guildId: GUILD, category: 'channel', action: 'Channel created', userId: USER, userName: 'vortex_admin', target: '#announcements', channelId: channels[4][0], status: 'ok', createdAt: ago(12) },
  { guildId: GUILD, category: 'security', action: 'Security · anti raid', status: 'enforced', details: 'Raid detected: 24 joins within 15s', createdAt: ago(30) },
  { guildId: GUILD, category: 'webhook', action: 'Webhook created', userId: '600000000000000003', target: 'Free Nitro', channelId: channels[0][0], status: 'monitor', createdAt: ago(60) },
  { guildId: GUILD, category: 'message', action: 'Message deleted', userId: '600000000000000002', channelId: channels[0][0], status: 'ok', createdAt: ago(90) },
] as never);
await AiFlag.insertMany([
  { guildId: GUILD, messageId: '900000000000000001', channelId: channels[0][0], authorId: '600000000000000004', authorTag: 'nova', category: 'harassment', confidence: 78, reason: 'Repeatedly insults another member by name.', excerpt: 'Sample flagged message', source: 'ai', status: 'pending' },
  { guildId: GUILD, messageId: '900000000000000002', channelId: channels[0][0], authorId: '600000000000000005', authorTag: 'rift', category: 'phishing', confidence: 95, reason: 'Imitates discord on an unofficial domain', excerpt: 'claim free nitro at dlscord-nitro.gift', source: 'link_scanner', status: 'actioned', action: 'Message deleted, Warned' },
] as never);
await AiStat.insertMany(days.map((d, n) => ({ guildId: GUILD, date: d.date, analyzed: 800 + n * 40, flagged: 3 + (n * 5) % 9, warned: n % 3, timedOut: n % 2, falsePositive: n % 4 === 0 ? 1 : 0 })) as never);
await makeBackup('Schedule', 'auto');
const staffAgo = (d: number, h = 0) => new Date(Date.now() - d * 86_400_000 - h * 3_600_000);
const demoIds = demoStaff.map((m) => m.id);
await Case.insertMany(Array.from({ length: 90 }, (_, n) => ({ guildId: GUILD, number: 100 + n, type: (['warn', 'timeout', 'warn', 'kick', 'ban'] as const)[n % 5], targetId: '600000000000000001', targetTag: `member_${n % 7}`, moderatorId: demoIds[n % 3 + 1], moderatorTag: demoStaff[n % 3 + 1]!.name, reason: n % 11 === 0 ? 'No reason provided' : reasons[n % 5], active: n % 4 !== 0, createdAt: staffAgo(n * 3, n % 20) })) as never);
await Ticket.insertMany(Array.from({ length: 40 }, (_, n) => { const owner = demoIds[n % 4]!; const open = n % 9 === 0; return { guildId: GUILD, number: 10 + n, channelId: `30000000000001${String(1000 + n)}`, ownerId: '600000000000000002', ownerTag: 'luna', categoryLabel: 'Support', subject: `Sample ticket ${n + 1}`, status: open ? 'open' : 'closed', claimedBy: n % 13 === 0 ? null : owner, claimedAt: staffAgo(n * 2), firstResponseAt: n % 13 === 0 ? null : new Date(staffAgo(n * 2).getTime() + (5 + n * 2) * 60_000), firstResponderId: n % 13 === 0 ? null : owner, closedBy: open ? null : owner, closedAt: open ? null : staffAgo(n * 2 - 0.2), resolvedAt: open ? null : staffAgo(n * 2 - 0.2), resolvedBy: open ? null : owner, rating: open || n % 3 === 0 ? null : 3 + n % 3, createdAt: staffAgo(n * 2) }; }) as never);
await StaffEvent.insertMany(Array.from({ length: 300 }, (_, n) => ({ guildId: GUILD, userId: demoIds[n % 4], type: 'ticket_reply', createdAt: staffAgo((n * 7) % 330, n % 24) })) as never);
await StaffRecord.create({ guildId: GUILD, userId: demoIds[1]!, userName: 'mira', type: 'promotion', adminId: USER, adminName: 'vortex_admin', reason: 'Promoted to Moderator after a strong review.', date: staffAgo(40) });
await updateConfig(GUILD, 'staff', { adminRoles: [roles[0][0]], moderatorRoles: [roles[1][0]], supportRoles: [roles[3][0]] });
await updateConfig(GUILD, 'security', { enabled: true, logChannelId: channels[2][0] });
await updateConfig(GUILD, 'logging', { enabled: true, defaultChannelId: channels[3][0] });
await updateConfig(GUILD, 'welcome', { enabled: true, channelId: channels[1][0] });

const preview = express();
preview.get('/preview-login', async (_req, res) => {
  const id = randomBytes(32).toString('base64url');
  await WebSession.create({ _id: createHash('sha256').update(id).digest('hex'), userId: USER, username: 'vortex_admin', avatar: null, accessTokenEnc: sealer(secret).seal('preview'), csrf: randomBytes(24).toString('hex'), expiresAt: new Date(Date.now() + 86_400_000) });
  res.setHeader('Set-Cookie', `vx_session=${id}; HttpOnly; SameSite=Lax; Path=/`);
  res.redirect('/#/g/100000000000000001/overview');
});
preview.use(createDashboardApp({
  gateway,
  oauth: {
    authorizeUrl: () => '/preview-login',
    exchange: async () => { throw new Error('OAuth is disabled in preview mode'); },
    fetchUser: async () => { throw new Error('OAuth is disabled in preview mode'); },
    fetchGuilds: async () => [{ id: GUILD, name: 'Zytheron Community', icon: null, owner: true, permissions: '8' }, { id: '100000000000000002', name: 'Friends Hangout', icon: null, owner: false, permissions: '32' }],
  },
  demo: true,
  sessionSecret: secret,
  secureCookies: false,
  trustProxy: 0,
  publicUrl: `http://localhost:${PORT}`,
}));
preview.listen(PORT, () => console.log(`Dashboard preview: http://localhost:${PORT}/preview-login`));
