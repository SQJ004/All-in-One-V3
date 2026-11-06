import { AuditLogEvent, ChannelType, Collection, EmbedBuilder, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuildConfigSchema } from '../../src/config/guildConfig.js';
import { updateConfig } from '../../src/core/configService.js';
import { AiFlag, AiStat, AuditEntry, Case, SecurityEvent, ServerBackup, Ticket } from '../../src/db/models.js';
import { classifyMessage, decide } from '../../src/modules/aimod/classifier.js';
import { handleAiMessage, linkVerdict, reviewFlag } from '../../src/modules/aimod/index.js';
import { captureGuild, createBackup, runRestore, runScheduledBackups, startRestore, type BackupData } from '../../src/modules/backup/index.js';
import { auditFromEmbed, csvCell, recordAudit, trimAudit } from '../../src/modules/logging/audit.js';
import { handleAuditEntry, handleJoin, handleMessage, punishActor } from '../../src/modules/security/index.js';
import { autoCloseTickets, dashboardTicketAction, ticketChannelName } from '../../src/modules/tickets/index.js';
import { baseEmbed, COLORS, setEmbedColor } from '../../src/ui/theme.js';
import { useDatabase } from '../helpers/db.js';
import { BOT_ID, fakeChannel, fakeMember, fakeRole, OWNER_ID } from '../helpers/fakes.js';
import { setupGuild } from '../helpers/interaction.js';

const classify = vi.hoisted(() => vi.fn());
vi.mock('../../src/modules/aimod/classifier.js', async (original) => {
  const real = await original<typeof import('../../src/modules/aimod/classifier.js')>();
  return { ...real, aiConnected: () => connected.value, classifyMessage: (...a: Parameters<typeof real.classifyMessage>) => (classify.getMockImplementation() ? classify(...a) : real.classifyMessage(...a)) };
});
const connected = vi.hoisted(() => ({ value: true }));

useDatabase();

const ATTACKER = '700000000000000031';
const entry = (action: AuditLogEvent, over: object = {}): any => ({ action, executorId: ATTACKER, targetId: '600000000000000077', targetType: 'Channel', actionType: 'Delete', changes: [], createdTimestamp: Date.now(), ...over });

function world() {
  const guild = setupGuild();
  guild.members.me = fakeMember(guild, BOT_ID, { position: 50, bot: true, perms: [P.Administrator, P.ManageRoles, P.ManageChannels, P.ManageGuild, P.ManageGuildExpressions] });
  fakeMember(guild, OWNER_ID, { position: 100 });
  return guild;
}

async function arm(guild: any, security: object = {}) {
  await updateConfig(guild.id, 'security', { enabled: true, mode: 'enforce', ...security });
}

describe('new anti-nuke modules', () => {
  it('counts emoji deletes, and punishes at the limit', async () => {
    const guild = world();
    await arm(guild, { antiNuke: { limits: { emojiDelete: { count: 2, windowSec: 60 } } } });
    const m = fakeMember(guild, ATTACKER, { position: 5 });
    await handleAuditEntry(entry(AuditLogEvent.EmojiDelete), guild);
    expect(m.roles.set).not.toHaveBeenCalled();
    await handleAuditEntry(entry(AuditLogEvent.EmojiDelete), guild);
    expect(m.roles.set).toHaveBeenCalled();
    expect(await SecurityEvent.findOne({ type: 'anti_nuke' })).toBeTruthy();
  });

  it('counts channel and role permission changes', async () => {
    const guild = world();
    await arm(guild, { antiNuke: { limits: { permissionChange: { count: 2, windowSec: 60 } } } });
    const m = fakeMember(guild, '700000000000000032', { position: 5 });
    await handleAuditEntry(entry(AuditLogEvent.ChannelOverwriteUpdate, { executorId: m.id }), guild);
    await handleAuditEntry(entry(AuditLogEvent.RoleUpdate, { executorId: m.id, changes: [{ key: 'permissions', old: '0', new: '1024' }] }), guild);
    expect(m.roles.set).toHaveBeenCalled();
  });

  it('ignores a module that was switched off', async () => {
    const guild = world();
    await arm(guild, { antiNuke: { disabled: ['serverUpdate'], limits: { serverUpdate: { count: 1, windowSec: 60 } } } });
    const m = fakeMember(guild, '700000000000000033', { position: 5 });
    await handleAuditEntry(entry(AuditLogEvent.GuildUpdate, { executorId: m.id }), guild);
    expect(m.roles.set).not.toHaveBeenCalled();
    expect(await SecurityEvent.countDocuments()).toBe(0);
  });

  it('never punishes the owner or trusted people', async () => {
    const guild = world();
    const trusted = fakeMember(guild, '700000000000000034', { position: 5 });
    await arm(guild, { trustedAdmins: [trusted.id], antiNuke: { limits: { emojiDelete: { count: 1, windowSec: 60 } } } });
    await handleAuditEntry(entry(AuditLogEvent.EmojiDelete, { executorId: trusted.id }), guild);
    await handleAuditEntry(entry(AuditLogEvent.EmojiDelete, { executorId: OWNER_ID }), guild);
    expect(trusted.roles.set).not.toHaveBeenCalled();
    expect(await SecurityEvent.countDocuments()).toBe(0);
  });

  it('only logs in monitor mode', async () => {
    const guild = world();
    await arm(guild, { mode: 'monitor', antiNuke: { limits: { emojiDelete: { count: 1, windowSec: 60 } } } });
    const m = fakeMember(guild, '700000000000000035', { position: 5 });
    await handleAuditEntry(entry(AuditLogEvent.EmojiDelete, { executorId: m.id }), guild);
    expect(m.roles.set).not.toHaveBeenCalled();
    expect(await SecurityEvent.findOne({ type: 'anti_nuke' })).toMatchObject({ monitorOnly: true });
  });

  it('quarantine uses the jail role, or strips roles when there is none', async () => {
    const guild = world();
    await arm(guild);
    const m = fakeMember(guild, '700000000000000036', { position: 5 });
    expect(await punishActor(guild, m.id, 'quarantine', 'test')).toContain('stripped');
    const jail = fakeRole('500000000000000099', 1);
    guild.roles.cache.set(jail.id, jail);
    await updateConfig(guild.id, 'moderation', { jailRoleId: jail.id });
    expect(await punishActor(guild, m.id, 'quarantine', 'test')).toContain('Quarantined');
    expect(m.roles.set.mock.lastCall[0]).toContain(jail.id);
  });
});

describe('anti-webhook', () => {
  const hookWorld = () => {
    const guild = world();
    const hook = { id: '800000000000000009', delete: vi.fn(async () => undefined) };
    guild.fetchWebhooks = vi.fn(async () => new Collection([[hook.id, hook]]));
    fakeMember(guild, ATTACKER, { position: 5 });
    return { guild, hook };
  };
  const created = (hook: { id: string }, over: object = {}) => entry(AuditLogEvent.WebhookCreate, { targetId: hook.id, targetType: 'Webhook', ...over });

  it('reports an unauthorized webhook and leaves it unless told to remove it', async () => {
    const { guild, hook } = hookWorld();
    await arm(guild);
    await handleAuditEntry(created(hook), guild);
    expect(hook.delete).not.toHaveBeenCalled();
    expect(await SecurityEvent.findOne({ type: 'webhook_unauthorized' })).toMatchObject({ action: 'Reported only' });
  });

  it('removes it when told to, in Enforce mode only', async () => {
    const { guild, hook } = hookWorld();
    await arm(guild, { mode: 'monitor', antiWebhook: { removeUnauthorized: true } });
    await handleAuditEntry(created(hook), guild);
    expect(hook.delete).not.toHaveBeenCalled();
    await arm(guild, { antiWebhook: { removeUnauthorized: true } });
    await handleAuditEntry(created(hook), guild);
    expect(hook.delete).toHaveBeenCalledOnce();
  });

  it('keeps a trusted webhook, and one made by a trusted person', async () => {
    const { guild, hook } = hookWorld();
    await arm(guild, { antiWebhook: { removeUnauthorized: true, trustedWebhooks: [hook.id] } });
    await handleAuditEntry(created(hook), guild);
    await arm(guild, { antiWebhook: { removeUnauthorized: true, trustedWebhooks: [] } });
    await handleAuditEntry(created(hook, { executorId: OWNER_ID }), guild);
    expect(hook.delete).not.toHaveBeenCalled();
  });

  it('reports deletions, and respects the alert switch', async () => {
    const { guild, hook } = hookWorld();
    await arm(guild);
    await handleAuditEntry(entry(AuditLogEvent.WebhookDelete, { targetId: hook.id }), guild);
    expect(await SecurityEvent.countDocuments({ type: 'webhook_deleted' })).toBe(1);
    await arm(guild, { antiWebhook: { alertDelete: false } });
    await handleAuditEntry(entry(AuditLogEvent.WebhookDelete, { targetId: hook.id }), guild);
    expect(await SecurityEvent.countDocuments({ type: 'webhook_deleted' })).toBe(1);
  });

  it('never stores a webhook token', async () => {
    const { guild, hook } = hookWorld();
    Object.assign(hook, { token: 'SECRET-TOKEN', url: 'https://discord.com/api/webhooks/1/SECRET-TOKEN' });
    await arm(guild, { antiWebhook: { removeUnauthorized: true } });
    await handleAuditEntry(created(hook), guild);
    expect(JSON.stringify(await SecurityEvent.find())).not.toContain('SECRET-TOKEN');
  });

  it('does not count a trusted webhook as spam', async () => {
    const guild = world();
    const channel = fakeChannel(guild, '600000000000000001');
    const hookId = '800000000000000010';
    await arm(guild, { antiWebhook: { maxMessages: 1, trustedWebhooks: [hookId] } });
    const del = vi.fn(async () => undefined);
    await handleMessage({ inGuild: () => true, guildId: guild.id, guild, webhookId: hookId, channelId: channel.id, mentions: { everyone: false }, delete: del } as never);
    expect(del).not.toHaveBeenCalled();
  });
});

describe('anti-raid verification', () => {
  it('raises the level when a raid starts in Enforce mode', async () => {
    const guild = world();
    guild.setVerificationLevel = vi.fn(async () => undefined);
    await arm(guild, { antiRaid: { joinThreshold: 2, windowSec: 60, raiseVerification: 'high' } });
    for (const id of ['700000000000000041', '700000000000000042']) await handleJoin(fakeMember(guild, id, { position: 1 }));
    expect(guild.setVerificationLevel).toHaveBeenCalledOnce();
  });
});

describe('audit log records', () => {
  it('reads who, what and where, without keeping message text', () => {
    const e = auditFromEmbed('message', { title: 'Message deleted', fields: [{ name: 'Author', value: '<@700000000000000031> (x)' }, { name: 'Channel', value: '<#600000000000000001>' }, { name: 'Content', value: 'private words' }] });
    expect(e).toMatchObject({ action: 'Message deleted', userId: '700000000000000031', channelId: '600000000000000001', status: 'ok' });
    expect(JSON.stringify(e)).not.toContain('private words');
    const edit = auditFromEmbed('message', { title: 'Message edited', fields: [{ name: 'Before', value: 'old words' }, { name: 'After', value: 'new words' }] });
    expect(JSON.stringify(edit)).not.toMatch(/old words|new words/);
  });

  it('marks monitor and enforced security events', () => {
    expect(auditFromEmbed('security', { title: '⛨  Security · anti raid', fields: [{ name: 'Would have done (monitor mode)', value: 'kick' }] })).toMatchObject({ status: 'monitor', action: 'Security · anti raid' });
    expect(auditFromEmbed('security', { title: 'x', fields: [{ name: 'Response', value: 'kick' }] }).status).toBe('enforced');
  });

  it('saves a copy even when posting logs is off', async () => {
    const guild = world();
    recordAudit(guild, 'member', new EmbedBuilder().setTitle('Member joined').setDescription(`<@${OWNER_ID}>`));
    await new Promise((r) => setTimeout(r, 5));
    expect(await AuditEntry.findOne({ guildId: guild.id })).toMatchObject({ category: 'member', userId: OWNER_ID });
  });

  it('keeps only the newest rows', async () => {
    await AuditEntry.insertMany(Array.from({ length: 5 }, (_, n) => ({ guildId: 'g', category: 'member', action: `a${n}`, status: 'ok', createdAt: new Date(2030, 0, n + 1) })) as never);
    await trimAudit('g', 2);
    expect((await AuditEntry.find({ guildId: 'g' })).map((r) => r.action).sort()).toEqual(['a3', 'a4']);
  });

  it('makes spreadsheet formulas harmless in CSV', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
  });
});

describe('backups', () => {
  const backupWorld = () => {
    const guild = world();
    Object.assign(guild, { verificationLevel: 1, explicitContentFilter: 0, defaultMessageNotifications: 0, afkTimeout: 300, afkChannelId: null, systemChannelId: null, rulesChannelId: null, edit: vi.fn(async () => undefined) });
    guild.roles.everyone = { id: guild.id, permissions: new PermissionsBitField([P.SendMessages]), setPermissions: vi.fn(async () => undefined) };
    guild.roles.cache.set(guild.id, guild.roles.everyone);
    guild.members.me.roles.highest = { position: 50 };
    guild.emojis = { cache: new Collection([['1', { name: 'wave', imageURL: () => 'https://cdn/wave.png' }]]), create: vi.fn(async () => undefined) };
    const role = fakeRole('500000000000000011', 3, { name: 'Staff', perms: [P.ManageMessages], guild });
    guild.roles.cache.set(role.id, role);
    guild.roles.cache.set('500000000000000012', fakeRole('500000000000000012', 4, { name: 'Bot role', managed: true, guild }));
    const channel = fakeChannel(guild, '600000000000000011', { name: 'general', overwrites: [{ id: role.id, allow: P.ViewChannel, deny: 0n }] });
    channel.permissionOverwrites.set = vi.fn(async () => undefined);
    return { guild, role, channel };
  };
  const everything = { roles: true, channels: true, permissions: true, settings: true, emojis: true };

  it('saves roles, channels, permissions and emojis, without managed roles', () => {
    const { guild } = backupWorld();
    const data = captureGuild(guild);
    expect(data.roles.map((r) => r.name)).toEqual(['Staff']);
    expect(data.channels[0]).toMatchObject({ name: 'general', overwrites: [{ type: 'role', allow: String(P.ViewChannel) }] });
    expect(data.emojis).toEqual([{ name: 'wave', url: 'https://cdn/wave.png' }]);
    expect(JSON.stringify(data)).not.toMatch(/token|messages/i);
  });

  it('records its identifier, size and counts, and removes old ones past the limit', async () => {
    const { guild } = backupWorld();
    await updateConfig(guild.id, 'backup', { keep: 2 });
    const first = await createBackup(guild, 'someone');
    expect(first).toMatchObject({ kind: 'manual', status: 'ready', counts: { roles: 1, channels: 1 } });
    expect(first.sizeBytes).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 2));
    await createBackup(guild, 'someone');
    await new Promise((r) => setTimeout(r, 2));
    await createBackup(guild, 'someone');
    expect(await ServerBackup.countDocuments({ guildId: guild.id })).toBe(2);
    expect(await ServerBackup.findOne({ backupId: first.backupId })).toBeNull();
  });

  it('puts back what is missing, and never deletes anything', async () => {
    const { guild, role, channel } = backupWorld();
    const data = captureGuild(guild);
    guild.roles.cache.delete(role.id);
    guild.channels.cache.delete(channel.id);
    const stranger = fakeChannel(guild, '600000000000000012', { name: 'added-later' });
    const strangerRole = fakeRole('500000000000000013', 2, { name: 'Added later', guild });
    guild.roles.cache.set(strangerRole.id, strangerRole);
    const report = await runRestore(guild, data, everything, 'someone');
    expect(guild.roles.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Staff', permissions: P.ManageMessages }));
    expect(guild.channels.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'general' }));
    expect(report.created).toBe(2);
    expect(report.failed).toBe(0);
    expect(stranger.delete).not.toHaveBeenCalled();
    expect(strangerRole.delete).not.toHaveBeenCalled();
    expect(guild.edit).toHaveBeenCalled();
  });

  it('does only what was ticked', async () => {
    const { guild, role, channel } = backupWorld();
    const data = captureGuild(guild);
    guild.roles.cache.delete(role.id);
    guild.channels.cache.delete(channel.id);
    await runRestore(guild, data, { roles: true, channels: false, permissions: false, settings: false, emojis: false }, 'x');
    expect(guild.roles.create).toHaveBeenCalled();
    expect(guild.channels.create).not.toHaveBeenCalled();
    expect(guild.edit).not.toHaveBeenCalled();
  });

  it('will not change a role above the bot', async () => {
    const { guild, role } = backupWorld();
    const data = captureGuild(guild) as BackupData;
    role.position = 99;
    role.permissions = new PermissionsBitField([P.Administrator]);
    await runRestore(guild, data, { ...everything, channels: false, settings: false, emojis: false }, 'x');
    expect(role.setPermissions).not.toHaveBeenCalled();
  });

  it('reports a failure instead of pretending it worked', async () => {
    const { guild, role } = backupWorld();
    const data = captureGuild(guild);
    guild.roles.cache.delete(role.id);
    guild.roles.create = vi.fn(async () => { throw new Error('Missing Permissions'); });
    const report = await runRestore(guild, data, { ...everything, permissions: false, channels: false, settings: false, emojis: false }, 'x');
    expect(report).toMatchObject({ created: 0, failed: 1 });
    expect(report.notes[0]).toContain('Missing Permissions');
  });

  it('refuses to start without the right permissions, and allows one restore at a time', async () => {
    const { guild } = backupWorld();
    const doc = await createBackup(guild, 'x');
    const saved = guild.members.me.permissions;
    guild.members.me.permissions = new PermissionsBitField([]);
    await expect(startRestore(guild, doc as never, everything, 'x')).rejects.toThrow(/Manage Roles/);
    guild.members.me.permissions = saved;
    await startRestore(guild, doc as never, { ...everything, emojis: false }, 'x');
    await expect(startRestore(guild, doc as never, { ...everything, emojis: false }, 'x')).rejects.toThrow(/already running/);
    await vi.waitFor(async () => expect((await ServerBackup.findOne({ backupId: doc.backupId }))?.lastRestore).toBeTruthy());
  });

  it('runs scheduled backups only when turned on and due', async () => {
    const { guild } = backupWorld();
    guild.client.guilds.cache.set(guild.id, guild);
    await runScheduledBackups(guild.client);
    expect(await ServerBackup.countDocuments()).toBe(0);
    await updateConfig(guild.id, 'backup', { autoEnabled: true, everyHours: 24 });
    await runScheduledBackups(guild.client);
    await runScheduledBackups(guild.client);
    expect(await ServerBackup.countDocuments({ kind: 'auto' })).toBe(1);
    await runScheduledBackups(guild.client, Date.now() + 25 * 3_600_000);
    expect(await ServerBackup.countDocuments({ kind: 'auto' })).toBe(2);
  });
});

describe('AI moderation', () => {
  const cfg = { reviewThreshold: 70, actionThreshold: 90, categories: GuildConfigSchema.parse({}).aiModeration.categories };
  beforeEach(() => { classify.mockReset(); connected.value = true; });
  afterEach(() => { classify.mockReset(); });

  const aiWorld = async (settings: object = {}) => {
    const guild = world();
    const channel = fakeChannel(guild, '600000000000000001');
    const member = fakeMember(guild, '700000000000000051', { position: 1 });
    await updateConfig(guild.id, 'aiModeration', { enabled: true, ...settings });
    const message: any = { inGuild: () => true, author: member.user, webhookId: null, system: false, content: 'a message long enough to check', member, guild, guildId: guild.id, channelId: channel.id, id: '900000000000000001', delete: vi.fn(async () => undefined), client: guild.client };
    return { guild, member, message };
  };
  const verdict = (confidence: number) => ({ category: 'harassment' as const, confidence, reason: 'Insults someone.' });

  it('decides using both confidence lines', () => {
    expect(decide(verdict(69), cfg)).toBe('ignore');
    expect(decide(verdict(70), cfg)).toBe('review');
    expect(decide(verdict(90), cfg)).toBe('act');
    expect(decide(verdict(99), { ...cfg, categories: { ...cfg.categories, harassment: false } })).toBe('ignore');
  });

  it('does nothing without an API key, and makes no fake result', async () => {
    connected.value = false;
    const { message, guild } = await aiWorld();
    await handleAiMessage(message);
    expect(await AiFlag.countDocuments()).toBe(0);
    expect(await AiStat.countDocuments({ guildId: guild.id })).toBe(0);
  });

  it('returns nothing when no key is set', async () => {
    connected.value = false;
    expect(await classifyMessage('hello there', { categories: cfg.categories, customRules: [] })).toBeNull();
  });

  it('is off unless turned on', async () => {
    const { message, guild } = await aiWorld({ enabled: false });
    classify.mockResolvedValue(verdict(99));
    await handleAiMessage(message);
    expect(classify).not.toHaveBeenCalled();
    expect(await AiFlag.countDocuments({ guildId: guild.id })).toBe(0);
  });

  it('sends uncertain cases to a person, with confidence and reason', async () => {
    const { message, member } = await aiWorld({ autoWarn: true, autoTimeout: true });
    classify.mockResolvedValue(verdict(75));
    await handleAiMessage(message);
    expect(await AiFlag.findOne()).toMatchObject({ status: 'pending', confidence: 75, reason: 'Insults someone.' });
    expect(member.timeout).not.toHaveBeenCalled();
    expect(await Case.countDocuments()).toBe(0);
  });

  it('takes no automatic step by default, even when very sure', async () => {
    const { message, member } = await aiWorld();
    classify.mockResolvedValue(verdict(99));
    await handleAiMessage(message);
    expect(await AiFlag.findOne()).toMatchObject({ status: 'pending' });
    expect(member.timeout).not.toHaveBeenCalled();
    expect(message.delete).not.toHaveBeenCalled();
  });

  it('runs chosen steps when very sure, and never kicks or bans', async () => {
    const { message, member } = await aiWorld({ autoDelete: true, autoWarn: true, autoTimeout: true, timeoutMinutes: 10 });
    await updateConfig(message.guildId, 'moderation', { warnThresholds: [{ warnings: 1, action: 'ban', durationMinutes: 60 }] });
    classify.mockResolvedValue(verdict(99));
    await handleAiMessage(message);
    expect(message.delete).toHaveBeenCalled();
    expect(member.timeout).toHaveBeenCalledWith(600_000, expect.any(String));
    expect(await Case.findOne({ type: 'warn' })).toBeTruthy();
    expect(member.kick).not.toHaveBeenCalled();
    expect(member.ban ?? message.guild.members.ban).not.toHaveBeenCalled?.();
    expect(await AiFlag.findOne()).toMatchObject({ status: 'actioned' });
  });

  it('skips admins, the owner, exempt roles, exempt channels and bots', async () => {
    const role = fakeRole('500000000000000021', 1);
    const { message, guild } = await aiWorld({ exemptRoles: [role.id] });
    classify.mockResolvedValue(verdict(99));
    const check = async (over: object) => { await handleAiMessage({ ...message, ...over, inGuild: () => true }); };
    await check({ member: fakeMember(guild, '700000000000000052', { perms: [P.ManageGuild] }) });
    await check({ member: fakeMember(guild, '700000000000000053', { roles: [role] }) });
    await check({ member: guild.members.cache.get(OWNER_ID) });
    await check({ author: { bot: true } });
    await check({ webhookId: '800000000000000001' });
    await check({ content: 'hi' });
    await updateConfig(guild.id, 'aiModeration', { exemptChannels: [message.channelId] });
    await check({});
    expect(classify).not.toHaveBeenCalled();
  });

  it('spots known bad links without using AI', async () => {
    connected.value = false;
    expect(linkVerdict('free nitro at https://discord-nitro-gift.ru/claim', [])).toMatchObject({ confidence: expect.any(Number) });
    expect(linkVerdict('see https://example.com/page', [])).toBeNull();
    const { message } = await aiWorld();
    await handleAiMessage({ ...message, inGuild: () => true, content: 'free nitro at https://dlscord-nitro.gift/claim' });
    expect(await AiFlag.findOne()).toMatchObject({ source: 'link_scanner' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('stops at the daily limit', async () => {
    const { message } = await aiWorld({ dailyLimit: 1 });
    classify.mockResolvedValue(null);
    await handleAiMessage(message);
    await handleAiMessage(message);
    expect(classify).toHaveBeenCalledOnce();
  });

  it('records a moderator\'s review, once only', async () => {
    const { guild, member } = await aiWorld();
    const flag = await AiFlag.create({ guildId: guild.id, messageId: '1', channelId: '2', authorId: member.id, authorTag: 'x', category: 'spam', confidence: 80, reason: 'r', excerpt: 'e', source: 'ai' });
    const reviewer = guild.members.cache.get(OWNER_ID);
    await reviewFlag(guild, String(flag._id), 'false_positive', reviewer);
    expect(await AiFlag.findOne({ _id: flag._id })).toMatchObject({ status: 'false_positive' });
    expect((await AiStat.findOne({ guildId: guild.id }))?.falsePositive).toBe(1);
    await expect(reviewFlag(guild, String(flag._id), 'dismiss', reviewer)).rejects.toThrow(/already/);
  });

  it('needs moderator permission to warn from a review', async () => {
    const { guild, member } = await aiWorld();
    const flag = await AiFlag.create({ guildId: guild.id, messageId: '1', channelId: '2', authorId: member.id, authorTag: 'x', category: 'spam', confidence: 80, reason: 'r', excerpt: 'e', source: 'ai' });
    const plain = fakeMember(guild, '700000000000000054', { position: 1, perms: [] });
    plain.permissions = new PermissionsBitField([]);
    await expect(reviewFlag(guild, String(flag._id), 'warn', plain)).rejects.toThrow(/Timeout Members/);
    expect(await Case.countDocuments()).toBe(0);
  });
});

describe('tickets', () => {
  it('builds a channel name Discord allows', () => {
    expect(ticketChannelName('ticket-{number}', 7, 'x')).toBe('ticket-0007');
    expect(ticketChannelName('{username} Help!', 7, 'Luna Star')).toBe('luna-star-help');
    expect(ticketChannelName('!!!', 7, 'x')).toBe('ticket-0007');
  });

  const ticketWorld = async () => {
    const guild = world();
    const channel = fakeChannel(guild, '600000000000000021', { name: 'ticket-0001' });
    Object.assign(channel, { setName: vi.fn(async () => undefined), messages: { fetch: vi.fn(async () => new Collection()) }, lastMessageId: null });
    channel.permissionOverwrites.edit = vi.fn(async () => undefined);
    const staffRole = fakeRole('500000000000000031', 2);
    const staff = fakeMember(guild, '700000000000000061', { position: 2, roles: [staffRole] });
    staff.permissions = new PermissionsBitField([]);
    const plain = fakeMember(guild, '700000000000000062', { position: 1 });
    plain.permissions = new PermissionsBitField([]);
    await updateConfig(guild.id, 'tickets', { enabled: true, staffRoleIds: [staffRole.id] });
    const ticket = await Ticket.create({ guildId: guild.id, number: 1, channelId: channel.id, ownerId: plain.id, ownerTag: 'luna', subject: 'help', createdAt: new Date(Date.now() - 48 * 3_600_000) } as never);
    return { guild, channel, staff, plain, ticket };
  };

  it('only lets staff act from the dashboard', async () => {
    const { guild, plain, ticket } = await ticketWorld();
    await expect(dashboardTicketAction(guild, String(ticket._id), 'close', plain.id)).rejects.toThrow(/staff/);
  });

  it('assigns to staff only', async () => {
    const { guild, staff, plain, ticket, channel } = await ticketWorld();
    await expect(dashboardTicketAction(guild, String(ticket._id), 'assign', staff.id, plain.id)).rejects.toThrow(/not ticket staff/);
    await dashboardTicketAction(guild, String(ticket._id), 'assign', staff.id, staff.id);
    expect(await Ticket.findOne({ _id: ticket._id })).toMatchObject({ claimedBy: staff.id });
    expect(channel.send).toHaveBeenCalled();
  });

  it('auto-closes quiet tickets only when turned on', async () => {
    const { guild, ticket } = await ticketWorld();
    guild.client.guilds.cache.set(guild.id, guild);
    await autoCloseTickets(guild.client);
    expect((await Ticket.findOne({ _id: ticket._id }))?.status).toBe('open');
    await updateConfig(guild.id, 'tickets', { autoCloseHours: 24 });
    await autoCloseTickets(guild.client);
    expect((await Ticket.findOne({ _id: ticket._id }))?.status).toBe('closed');
  });

  it('leaves a recently active ticket open', async () => {
    const { guild, ticket, channel } = await ticketWorld();
    guild.client.guilds.cache.set(guild.id, guild);
    await updateConfig(guild.id, 'tickets', { autoCloseHours: 24 });
    channel.lastMessageId = String((BigInt(Date.now() - 1_420_070_400_000) << 22n));
    await autoCloseTickets(guild.client);
    expect((await Ticket.findOne({ _id: ticket._id }))?.status).toBe('open');
  });
});

describe('embed colour', () => {
  afterEach(() => setEmbedColor(COLORS.primary));
  it('changes the default, and keeps warning colours', () => {
    setEmbedColor(0x112233);
    expect(baseEmbed().data.color).toBe(0x112233);
    expect(baseEmbed(COLORS.danger).data.color).toBe(COLORS.danger);
  });
});

describe('existing servers', () => {
  it('get safe defaults for every new setting', () => {
    const config = GuildConfigSchema.parse({ security: { enabled: true, antiNuke: { punishment: 'ban' } } });
    expect(config.aiModeration).toMatchObject({ enabled: false, autoWarn: false, autoTimeout: false, autoDelete: false });
    expect(config.backup.autoEnabled).toBe(false);
    expect(config.security.antiNuke.punishment).toBe('ban');
    expect(config.security.antiNuke.disabled).toEqual([]);
    expect(config.security.antiWebhook.removeUnauthorized).toBe(false);
    expect(config.security.antiRaid.raiseVerification).toBe('off');
    expect(config.tickets).toMatchObject({ channelName: 'ticket-{number}', autoCloseHours: 0, transcriptFormat: 'html' });
  });
});

void ChannelType;
