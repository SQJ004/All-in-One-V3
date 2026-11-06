import { AuditLogEvent, ChannelType, Collection, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { getConfig, invalidateConfig, updateConfig } from '../../src/core/configService.js';
import { Scheduler, scheduleJob } from '../../src/core/scheduler.js';
import { AutoResponse, Case, GuildSettings, Jail, Job, Lockdown, MemberLevel, nextSequence, ScheduledMessage, SecurityEvent } from '../../src/db/models.js';
import { runDueSchedules } from '../../src/modules/automation/index.js';
import { awardXp } from '../../src/modules/community/levels.js';
import { flushStats, runBirthdays } from '../../src/modules/community/members.js';
import { Birthday } from '../../src/db/models.js';
import { runMass } from '../../src/modules/moderation/index.js';
import { applyWarnThresholds, banUser, jailMember, kickMember, recordCase, timeoutMember, unbanUser, unjailMember } from '../../src/modules/moderation/service.js';
import { handleAuditEntry, handleJoin, handleMessage, punishActor } from '../../src/modules/security/index.js';
import { engageLockdown, liftLockdown } from '../../src/modules/security/lockdown.js';
import { snapshotChannel, snapshotRole } from '../../src/modules/security/recovery.js';
import { useDatabase } from '../helpers/db.js';
import { auditEntry, BOT_ID, fakeChannel, fakeGuild, fakeMember, fakeRole, GUILD_ID, OWNER_ID } from '../helpers/fakes.js';

useDatabase();
const MOD = '300000000000000011';
const ATTACKER = '300000000000000012';
const LOG_CH = '300000000000000013';

describe('config service', () => {
  it('returns defaults for a new guild and persists partial updates', async () => {
    expect((await getConfig(GUILD_ID)).security.enabled).toBe(false);
    await updateConfig(GUILD_ID, 'security', { enabled: true, antiNuke: { limits: { ban: { count: 9, windowSec: 10 } } } });
    invalidateConfig();
    const c = await getConfig(GUILD_ID);
    expect(c.security.enabled).toBe(true);
    expect(c.security.antiNuke.limits.ban.count).toBe(9);
    expect(c.security.antiNuke.limits.kick.count).toBe(5); // untouched siblings survive
  });
  it('rejects invalid values without saving', async () => {
    await expect(updateConfig(GUILD_ID, 'security', { mode: 'chaos' })).rejects.toThrow();
    expect(await GuildSettings.countDocuments({ guildId: GUILD_ID })).toBe(0);
  });
  it('keeps guilds isolated', async () => {
    await updateConfig(GUILD_ID, 'welcome', { enabled: true });
    expect((await getConfig('100000000000000002')).welcome.enabled).toBe(false);
  });
  it('fills new defaults for documents saved by older versions', async () => {
    await GuildSettings.create({ guildId: GUILD_ID, config: { security: { enabled: true } } });
    invalidateConfig();
    const c = await getConfig(GUILD_ID);
    expect(c.security.enabled).toBe(true);
    expect(c.security.antiRaid.joinThreshold).toBe(10);
  });
});

describe('sequences', () => {
  it('never hands out the same number twice under concurrency', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, () => nextSequence(GUILD_ID, 'case')));
    expect(new Set(results).size).toBe(25);
    expect(Math.max(...results)).toBe(25);
  });
});

describe('scheduler', () => {
  const client = {} as never;
  it('runs due jobs once, and leaves future jobs alone', async () => {
    const run = vi.fn(async () => undefined);
    await scheduleJob('t', GUILD_ID, new Date(Date.now() - 1000), { a: 1 });
    await scheduleJob('t', GUILD_ID, new Date(Date.now() + 60_000));
    const s = new Scheduler(client, { t: run });
    expect(await s.tick()).toBe(1);
    expect(await s.tick()).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(client, GUILD_ID, { a: 1 });
  });
  it('retries with backoff, then gives up', async () => {
    const run = vi.fn(async () => { throw new Error('boom'); });
    await scheduleJob('t', GUILD_ID, new Date(0));
    const s = new Scheduler(client, { t: run });
    for (let n = 0; n < 5; n++) {
      await s.tick(new Date(Date.now() + 10 ** 10));
    }
    expect(run).toHaveBeenCalledTimes(5);
    const job = await Job.findOne();
    expect(job?.status).toBe('failed');
    expect(job?.lastError).toMatch(/boom/);
  });
  it('recovers jobs from a crashed run after the lock expires', async () => {
    const run = vi.fn(async () => undefined);
    await Job.create({ type: 't', guildId: GUILD_ID, runAt: new Date(0), status: 'running', lockedUntil: new Date(Date.now() + 60_000), attempts: 1 });
    const s = new Scheduler(client, { t: run });
    expect(await s.tick()).toBe(0);
    expect(await s.tick(new Date(Date.now() + 120_000))).toBe(1);
  });
  it('replaces rather than duplicates jobs with a dedupe key', async () => {
    await scheduleJob('t', GUILD_ID, new Date(1000), {}, 'key');
    await scheduleJob('t', GUILD_ID, new Date(2000), {}, 'key');
    const jobs = await Job.find({ dedupeKey: 'key' });
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.runAt.getTime()).toBe(2000);
  });
  it('fails cleanly for unknown job types', async () => {
    await scheduleJob('missing', GUILD_ID, new Date(0));
    await new Scheduler(client, {}).tick();
    expect((await Job.findOne())?.lastError).toMatch(/No handler/);
  });
});

describe('moderation service', () => {
  const setup = () => {
    const guild = fakeGuild();
    const mod = fakeMember(guild, MOD, { position: 20, perms: [PermissionFlagsBits.BanMembers] });
    const target = fakeMember(guild, '400000000000000001', { position: 5 });
    const actor = { id: mod.id, tag: 'mod', member: mod };
    return { guild, mod, target, actor };
  };
  it('bans, DMs first, numbers the case', async () => {
    const { guild, target, actor } = setup();
    const c = await banUser(guild, actor, target.user, 'spam', { deleteMessageDays: 1 });
    expect(c).toMatchObject({ number: 1, type: 'ban', reason: 'spam', targetId: target.id });
    expect(guild.members.ban).toHaveBeenCalledWith(target.id, expect.objectContaining({ deleteMessageSeconds: 86400 }));
    expect(target.user.send.mock.invocationCallOrder[0]).toBeLessThan(guild.members.ban.mock.invocationCallOrder[0]);
  });
  it('refuses to act above the hierarchy, and records nothing', async () => {
    const { guild, actor } = setup();
    const boss = fakeMember(guild, '400000000000000002', { position: 30 });
    await expect(banUser(guild, actor, boss.user, 'x')).rejects.toThrow(/higher role/);
    await expect(kickMember(guild, actor, boss, 'x')).rejects.toThrow(/higher role/);
    expect(guild.members.ban).not.toHaveBeenCalled();
    expect(boss.kick).not.toHaveBeenCalled();
    expect(await Case.countDocuments()).toBe(0);
  });
  it('tempban schedules the unban, and a manual unban cancels it', async () => {
    const { guild, target, actor } = setup();
    await banUser(guild, actor, target.user, 'x', { durationMs: 3_600_000 });
    expect(await Job.countDocuments({ type: 'mod.unban', status: 'pending' })).toBe(1);
    guild.bans.fetch = vi.fn(async () => ({ user: target.user }));
    await unbanUser(guild, actor, target.id, 'appeal');
    expect(await Job.countDocuments({ type: 'mod.unban', status: 'pending' })).toBe(0);
    expect(guild.members.unban).toHaveBeenCalled();
  });
  it('explains an unban for someone not banned', async () => {
    const { guild, actor } = setup();
    await expect(unbanUser(guild, actor, '400000000000000099', 'x')).rejects.toThrow(/not banned/);
  });
  it('enforces timeout rules', async () => {
    const { guild, target, actor } = setup();
    await expect(timeoutMember(guild, actor, target, 30 * 86_400_000, 'x')).rejects.toThrow(/28 days/);
    const admin = fakeMember(guild, '400000000000000003', { position: 3, perms: [PermissionFlagsBits.Administrator] });
    await expect(timeoutMember(guild, actor, admin, 60_000, 'x')).rejects.toThrow(/administrators/);
    await timeoutMember(guild, actor, target, 60_000, 'x');
    expect(target.timeout).toHaveBeenCalled();
  });
  it('jails and restores the exact roles', async () => {
    const { guild, actor } = setup();
    const jailRole = fakeRole('500000000000000009', 2);
    const a = fakeRole('500000000000000001', 3);
    const b = fakeRole('500000000000000002', 4);
    const managed = fakeRole('500000000000000003', 5, { managed: true });
    for (const r of [jailRole, a, b, managed]) guild.roles.cache.set(r.id, r);
    await updateConfig(guild.id, 'moderation', { jailRoleId: jailRole.id });
    const m = fakeMember(guild, '400000000000000004', { position: 5, roles: [a, b, managed] });
    await jailMember(guild, actor, m, 'x', 3_600_000);
    expect(m.roles.set).toHaveBeenLastCalledWith([managed.id, jailRole.id], expect.any(String));
    expect((await Jail.findOne({ userId: m.id }))?.previousRoles.sort()).toEqual([a.id, b.id].sort());
    expect(await Job.countDocuments({ type: 'mod.unjail' })).toBe(1);
    await expect(jailMember(guild, actor, m, 'x')).rejects.toThrow(/already jailed/);
    await unjailMember(guild, actor, m.id, 'done');
    expect(m.roles.set.mock.lastCall[0].sort()).toEqual([a.id, b.id, managed.id].sort());
    expect(await Job.countDocuments({ type: 'mod.unjail', status: 'pending' })).toBe(0);
  });
  it('requires jail setup first', async () => {
    const { guild, target, actor } = setup();
    await expect(jailMember(guild, actor, target, 'x')).rejects.toThrow(/jail-setup/);
  });
  it('applies warning thresholds only at the exact count', async () => {
    const { guild, target, actor } = setup();
    await updateConfig(guild.id, 'moderation', { warnThresholds: [{ warnings: 3, action: 'timeout', durationMinutes: 10 }] });
    expect(await applyWarnThresholds(guild, actor, target, 2)).toBeNull();
    expect(await applyWarnThresholds(guild, actor, target, 3)).toBe('timeout');
    expect(target.timeout).toHaveBeenCalledTimes(1);
    expect(await applyWarnThresholds(guild, actor, target, 4)).toBeNull();
  });
  it('posts cases to the mod log, but keeps notes private', async () => {
    const { guild } = setup();
    const log = fakeChannel(guild, LOG_CH);
    await updateConfig(guild.id, 'moderation', { modLogChannelId: LOG_CH });
    await recordCase({ guild, type: 'warn', targetId: '1', targetTag: 't', moderatorId: '2', moderatorTag: 'm', reason: 'r' });
    expect(log.send).toHaveBeenCalledTimes(1);
    await recordCase({ guild, type: 'note', targetId: '1', targetTag: 't', moderatorId: '2', moderatorTag: 'm', reason: 'secret' });
    expect(log.send).toHaveBeenCalledTimes(1);
  });
  it('still works when the member has DMs closed', async () => {
    const { guild, target, actor } = setup();
    target.user.send = vi.fn(async () => { throw new Error('Cannot send messages to this user'); });
    await expect(banUser(guild, actor, target.user, 'x')).resolves.toMatchObject({ type: 'ban' });
  });
  it('mass actions report partial failures', async () => {
    const { guild, actor, target } = setup();
    const boss = fakeMember(guild, '400000000000000005', { position: 40 });
    const r = await runMass(guild, actor, { action: 'kick', ids: [target.id, boss.id, '400000000000000006'], reason: 'x', moderatorId: MOD, expires: 0 });
    expect(r.ok).toBe(1);
    expect(r.failed.map((f) => f.id)).toEqual([boss.id, '400000000000000006']);
    expect(target.kick).toHaveBeenCalled();
    expect(boss.kick).not.toHaveBeenCalled();
  });
});

describe('anti-nuke', () => {
  const arm = async (guild: any, patch: object = {}) => {
    const log = fakeChannel(guild, LOG_CH);
    await updateConfig(guild.id, 'security', { enabled: true, mode: 'enforce', logChannelId: LOG_CH, antiNuke: { limits: { channelDelete: { count: 2, windowSec: 60 } } }, ...patch });
    return log;
  };
  const del = (executorId: string, targetId: string) => auditEntry({ action: AuditLogEvent.ChannelDelete, executorId, targetId });
  let n = 0;
  const attackerId = () => `3000000000000${String(1000 + ++n)}`; // the tracker is process-wide, so each test gets its own attacker

  it('stays silent below the limit', async () => {
    const guild = fakeGuild();
    await arm(guild);
    const id = attackerId();
    const m = fakeMember(guild, id, { position: 5, roles: [fakeRole('500000000000000001', 2)] });
    await handleAuditEntry(del(id, '600000000000000001'), guild);
    expect(m.roles.set).not.toHaveBeenCalled();
    expect(await SecurityEvent.countDocuments()).toBe(0);
  });
  it('monitor mode logs what it would do and touches nothing', async () => {
    const guild = fakeGuild();
    await arm(guild, { mode: 'monitor' });
    const id = attackerId();
    const m = fakeMember(guild, id, { position: 5 });
    await handleAuditEntry(del(id, '600000000000000001'), guild);
    await handleAuditEntry(del(id, '600000000000000002'), guild);
    expect(m.roles.set).not.toHaveBeenCalled();
    expect(guild.channels.create).not.toHaveBeenCalled();
    expect(await SecurityEvent.findOne()).toMatchObject({ type: 'anti_nuke', monitorOnly: true, actorId: id });
  });
  it('enforce mode strips the attacker, rebuilds channels and logs it', async () => {
    const guild = fakeGuild();
    const log = await arm(guild);
    const id = attackerId();
    const role = fakeRole('500000000000000001', 2);
    const managed = fakeRole('500000000000000002', 2, { managed: true });
    const m = fakeMember(guild, id, { position: 5, roles: [role, managed] });
    const c1 = fakeChannel(guild, '600000000000000001', { name: 'general' });
    const c2 = fakeChannel(guild, '600000000000000002', { name: 'rules' });
    snapshotChannel(c1); snapshotChannel(c2);
    guild.channels.cache.delete(c1.id); guild.channels.cache.delete(c2.id);
    await handleAuditEntry(del(id, c1.id), guild);
    await handleAuditEntry(del(id, c2.id), guild);
    expect(m.roles.set).toHaveBeenCalledWith([managed.id], expect.stringContaining('Anti-nuke'));
    expect(guild.channels.create.mock.calls.map((c: any) => c[0].name).sort()).toEqual(['general', 'rules']);
    expect(log.send).toHaveBeenCalled();
    expect((await SecurityEvent.findOne({ type: 'anti_nuke' }))?.action).toMatch(/Rebuilt channel #general/);
  });
  it('rebuilds a deleted role, re-assigns members and preserves overwrites', async () => {
    const guild = fakeGuild();
    await arm(guild, { antiNuke: { limits: { roleDelete: { count: 1, windowSec: 60 } } } });
    const id = attackerId();
    fakeMember(guild, id, { position: 5 });
    const holder = fakeMember(guild, '400000000000000010', { position: 2 });
    const role = fakeRole('500000000000000005', 3, { perms: [PermissionFlagsBits.ManageMessages] });
    role.members = new Collection([[holder.id, holder]]);
    snapshotRole(role);
    await handleAuditEntry(auditEntry({ action: AuditLogEvent.RoleDelete, executorId: id, targetId: role.id, targetType: 'Role' }), guild);
    expect(guild.roles.create).toHaveBeenCalledWith(expect.objectContaining({ name: role.name, permissions: PermissionFlagsBits.ManageMessages }));
    expect(holder.roles.add).toHaveBeenCalled();
  });
  it('reverses mass bans', async () => {
    const guild = fakeGuild();
    await arm(guild, { antiNuke: { limits: { ban: { count: 2, windowSec: 60 } } } });
    const id = attackerId();
    fakeMember(guild, id, { position: 5 });
    await handleAuditEntry(auditEntry({ action: AuditLogEvent.MemberBanAdd, executorId: id, targetId: '400000000000000021', targetType: 'User', actionType: 'Delete' }), guild);
    await handleAuditEntry(auditEntry({ action: AuditLogEvent.MemberBanAdd, executorId: id, targetId: '400000000000000022', targetType: 'User', actionType: 'Delete' }), guild);
    expect(guild.members.unban.mock.calls.map((c: any) => c[0]).sort()).toEqual(['400000000000000021', '400000000000000022']);
  });
  it('removes webhooks made during an attack', async () => {
    const guild = fakeGuild();
    await arm(guild, { antiNuke: { limits: { webhookCreate: { count: 1, windowSec: 60 } } } });
    const id = attackerId();
    fakeMember(guild, id, { position: 5 });
    const hook = { name: 'spam', delete: vi.fn(async () => undefined) };
    guild.fetchWebhooks = vi.fn(async () => new Collection([['700000000000000001', hook]]));
    await handleAuditEntry(auditEntry({ action: AuditLogEvent.WebhookCreate, executorId: id, targetId: '700000000000000001', targetType: 'Webhook', actionType: 'Create' }), guild);
    expect(hook.delete).toHaveBeenCalled();
  });
  it('removes dangerous roles handed to members during an attack', async () => {
    const guild = fakeGuild();
    await arm(guild, { antiNuke: { limits: { dangerousRoleGrant: { count: 1, windowSec: 60 } } } });
    const id = attackerId();
    fakeMember(guild, id, { position: 5 });
    const accomplice = fakeMember(guild, '400000000000000033', { position: 1 });
    const admin = fakeRole('500000000000000011', 3, { perms: [PermissionFlagsBits.Administrator], name: 'Admin' });
    const harmless = fakeRole('500000000000000012', 2, { name: 'Member' });
    guild.roles.cache.set(admin.id, admin);
    guild.roles.cache.set(harmless.id, harmless);
    await handleAuditEntry(auditEntry({ action: AuditLogEvent.MemberRoleUpdate, executorId: id, targetId: accomplice.id, targetType: 'User', actionType: 'Update', changes: [{ key: '$add', new: [{ id: admin.id, name: 'Admin' }, { id: harmless.id, name: 'Member' }] }] }), guild);
    expect(accomplice.roles.remove).toHaveBeenCalledWith([admin.id], expect.any(String));
  });
  it('reverts dangerous permission grants', async () => {
    const guild = fakeGuild();
    await arm(guild, { antiNuke: { limits: { dangerousRoleGrant: { count: 1, windowSec: 60 } } } });
    const id = attackerId();
    fakeMember(guild, id, { position: 5 });
    const role = fakeRole('500000000000000006', 3);
    guild.roles.cache.set(role.id, role);
    await handleAuditEntry(auditEntry({ action: AuditLogEvent.RoleUpdate, executorId: id, targetId: role.id, targetType: 'Role', actionType: 'Update', changes: [{ key: 'permissions', old: '0', new: PermissionFlagsBits.Administrator.toString() }] }), guild);
    expect(role.setPermissions).toHaveBeenCalledWith(0n, expect.any(String));
  });
  it('ignores harmless role edits', async () => {
    const guild = fakeGuild();
    await arm(guild, { antiNuke: { limits: { dangerousRoleGrant: { count: 1, windowSec: 60 } } } });
    const id = attackerId();
    const m = fakeMember(guild, id, { position: 5 });
    await handleAuditEntry(auditEntry({ action: AuditLogEvent.RoleUpdate, executorId: id, targetId: '500000000000000007', targetType: 'Role', actionType: 'Update', changes: [{ key: 'permissions', old: '0', new: PermissionFlagsBits.SendMessages.toString() }] }), guild);
    expect(m.roles.set).not.toHaveBeenCalled();
  });
  it.each(['owner', 'bot', 'trusted', 'whitelisted user', 'whitelisted role'])('never acts on the %s', async (who) => {
    const guild = fakeGuild();
    const id = attackerId();
    const wlRole = '500000000000000008';
    const patch: Record<string, object> = { trusted: { trustedAdmins: [id] }, 'whitelisted user': { whitelistUsers: [id] }, 'whitelisted role': { whitelistRoles: [wlRole] } };
    await arm(guild, patch[who] ?? {});
    const executor = who === 'owner' ? OWNER_ID : who === 'bot' ? BOT_ID : id;
    if (executor === id) fakeMember(guild, id, { position: 5, roles: [fakeRole(wlRole, 2)] });
    for (const t of ['1', '2', '3', '4']) await handleAuditEntry(del(executor, `60000000000000000${t}`), guild);
    expect(await SecurityEvent.countDocuments()).toBe(0);
    expect(guild.members.cache.get(executor).roles.set).not.toHaveBeenCalled();
  });
  it('does nothing when security is off', async () => {
    const guild = fakeGuild();
    const id = attackerId();
    const m = fakeMember(guild, id, { position: 5 });
    for (const t of ['1', '2', '3']) await handleAuditEntry(del(id, `60000000000000000${t}`), guild);
    expect(m.roles.set).not.toHaveBeenCalled();
  });
  it('reports when the attacker is above the bot', async () => {
    const guild = fakeGuild();
    fakeMember(guild, MOD, { position: 90 });
    expect(await punishActor(guild, MOD, 'ban', 'x')).toMatch(/above mine/);
    expect(guild.members.ban).not.toHaveBeenCalled();
  });
  it('kicks bots instead of stripping their roles', async () => {
    const guild = fakeGuild();
    const bot = fakeMember(guild, '400000000000000031', { position: 5, bot: true });
    expect(await punishActor(guild, bot.id, 'strip_roles', 'x')).toBe('Kicked');
    expect(bot.kick).toHaveBeenCalled();
  });
  it('removes unapproved bots, but allows approved ones and those added by trusted staff', async () => {
    const guild = fakeGuild();
    const allowed = '400000000000000041';
    await arm(guild, { antiBot: { allowedBots: [allowed] } });
    const adder = attackerId();
    fakeMember(guild, adder, { position: 5 });
    const badBot = fakeMember(guild, '400000000000000042', { position: 1, bot: true });
    const goodBot = fakeMember(guild, allowed, { position: 1, bot: true });
    const ownerBot = fakeMember(guild, '400000000000000043', { position: 1, bot: true });
    await handleAuditEntry(auditEntry({ action: AuditLogEvent.BotAdd, executorId: adder, targetId: badBot.id, targetType: 'User', actionType: 'Create' }), guild);
    await handleAuditEntry(auditEntry({ action: AuditLogEvent.BotAdd, executorId: adder, targetId: goodBot.id, targetType: 'User', actionType: 'Create' }), guild);
    await handleAuditEntry(auditEntry({ action: AuditLogEvent.BotAdd, executorId: OWNER_ID, targetId: ownerBot.id, targetType: 'User', actionType: 'Create' }), guild);
    expect(badBot.kick).toHaveBeenCalled();
    expect(goodBot.kick).not.toHaveBeenCalled();
    expect(ownerBot.kick).not.toHaveBeenCalled();
  });
});

describe('join protection', () => {
  it('acts on a raid: earlier joiners too, and sends a critical event', async () => {
    const guild = fakeGuild({ id: '100000000000000050' });
    await updateConfig(guild.id, 'security', { enabled: true, mode: 'enforce', suspicious: { enabled: false }, antiRaid: { joinThreshold: 3, windowSec: 60, action: 'kick' } });
    const members = ['a', 'b', 'c', 'd'].map((x, n) => fakeMember(guild, `40000000000000005${n}`, { position: 1, tag: x }));
    for (const m of members) await handleJoin(m);
    expect(members.map((m) => m.kick.mock.calls.length)).toEqual([1, 1, 1, 1]);
    expect(await SecurityEvent.countDocuments({ type: 'anti_raid' })).toBe(1);
  });
  it('monitor mode kicks nobody', async () => {
    const guild = fakeGuild({ id: '100000000000000051' });
    await updateConfig(guild.id, 'security', { enabled: true, suspicious: { enabled: false }, antiRaid: { joinThreshold: 2, windowSec: 60 } });
    const members = ['a', 'b', 'c'].map((x, n) => fakeMember(guild, `40000000000000006${n}`, { position: 1, tag: x }));
    for (const m of members) await handleJoin(m);
    expect(members.every((m) => m.kick.mock.calls.length === 0)).toBe(true);
    expect(await SecurityEvent.findOne({ type: 'anti_raid' })).toMatchObject({ monitorOnly: true });
  });
  it('flags suspicious accounts and applies the configured action', async () => {
    const guild = fakeGuild({ id: '100000000000000052' });
    await updateConfig(guild.id, 'security', { enabled: true, mode: 'enforce', suspicious: { action: 'kick' } });
    const fresh = fakeMember(guild, '400000000000000070', { position: 1, createdDaysAgo: 0.2, avatar: null });
    const old = fakeMember(guild, '400000000000000071', { position: 1, createdDaysAgo: 900 });
    await handleJoin(fresh);
    await handleJoin(old);
    expect(fresh.kick).toHaveBeenCalled();
    expect(old.kick).not.toHaveBeenCalled();
  });
});

describe('message protection', () => {
  const msg = (guild: any, member: any, over: Record<string, unknown> = {}) => {
    const channel = fakeChannel(guild, '600000000000000020');
    return { inGuild: () => true, guildId: guild.id, guild, id: String(Math.random()), channelId: channel.id, channel, member, client: guild.client, author: member?.user, webhookId: null, system: false, content: 'hello', mentions: { users: new Map(), roles: new Map(), everyone: false }, delete: vi.fn(async () => undefined), ...over } as any;
  };
  it('deletes scam links in enforce mode and records them', async () => {
    const guild = fakeGuild({ id: '100000000000000060' });
    await updateConfig(guild.id, 'security', { enabled: true, mode: 'enforce' });
    const m = fakeMember(guild, '400000000000000080', { position: 1 });
    const message = msg(guild, m, { content: 'free stuff https://dlscord.com/nitro' });
    await handleMessage(message);
    expect(message.delete).toHaveBeenCalled();
    expect(await SecurityEvent.findOne({ type: 'scam_link' })).toMatchObject({ severity: 'critical', actorId: m.id });
    expect(m.timeout).toHaveBeenCalled(); // a phishing link counts 3 strikes, which reaches the timeout rung
  });
  it('monitor mode leaves the message in place', async () => {
    const guild = fakeGuild({ id: '100000000000000061' });
    await updateConfig(guild.id, 'security', { enabled: true });
    const m = fakeMember(guild, '400000000000000081', { position: 1 });
    const message = msg(guild, m, { content: 'https://dlscord.com/nitro' });
    await handleMessage(message);
    expect(message.delete).not.toHaveBeenCalled();
    expect(await SecurityEvent.findOne({ type: 'scam_link' })).toMatchObject({ monitorOnly: true });
  });
  it('skips admins, whitelisted members, exempt channels and bots', async () => {
    const guild = fakeGuild({ id: '100000000000000062' });
    await updateConfig(guild.id, 'security', { enabled: true, mode: 'enforce', whitelistUsers: ['400000000000000083'], exemptChannels: ['600000000000000021'] });
    const content = 'https://dlscord.com/nitro';
    const cases = [
      msg(guild, fakeMember(guild, '400000000000000082', { position: 1, perms: [PermissionFlagsBits.Administrator] }), { content }),
      msg(guild, fakeMember(guild, '400000000000000083', { position: 1 }), { content }),
      msg(guild, fakeMember(guild, '400000000000000084', { position: 1 }), { content, channelId: '600000000000000021' }),
      msg(guild, fakeMember(guild, '400000000000000085', { position: 1, bot: true }), { content }),
    ];
    for (const c of cases) await handleMessage(c);
    expect(cases.every((c) => c.delete.mock.calls.length === 0)).toBe(true);
  });
  it('deletes a webhook that pings everyone', async () => {
    const guild = fakeGuild({ id: '100000000000000063' });
    await updateConfig(guild.id, 'security', { enabled: true, mode: 'enforce' });
    const hook = { delete: vi.fn(async () => undefined) };
    const m = msg(guild, null, { webhookId: '700000000000000002', author: { bot: true }, mentions: { everyone: true, users: new Map(), roles: new Map() }, fetchWebhook: vi.fn(async () => hook) });
    await handleMessage(m);
    expect(m.delete).toHaveBeenCalled();
    expect(hook.delete).toHaveBeenCalled();
  });
});

describe('lockdown', () => {
  const EVERY = GUILD_ID;
  const setup = () => {
    const guild = fakeGuild();
    const open = fakeChannel(guild, '600000000000000030', { name: 'open' });
    const custom = fakeChannel(guild, '600000000000000031', { name: 'custom', overwrites: [{ id: EVERY, allow: PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks, deny: PermissionFlagsBits.ViewChannel }, { id: MOD, allow: PermissionFlagsBits.SendMessages, deny: 0n, type: 1 }] });
    const category = fakeChannel(guild, '600000000000000032', { type: ChannelType.GuildCategory });
    return { guild, open, custom, category };
  };
  it('denies sending in every channel, then restores exactly', async () => {
    const { guild, open, custom, category } = setup();
    const r = await engageLockdown(guild, OWNER_ID, 'test');
    expect(r).toEqual({ locked: 2, failed: 0 });
    expect(category.edit).not.toHaveBeenCalled();
    const lockedCustom = custom.permissionOverwrites.cache.get(EVERY);
    expect(lockedCustom.deny.bitfield & PermissionFlagsBits.SendMessages).toBe(PermissionFlagsBits.SendMessages);
    expect(lockedCustom.allow.bitfield & PermissionFlagsBits.SendMessages).toBe(0n);
    expect(lockedCustom.allow.bitfield & PermissionFlagsBits.EmbedLinks).toBe(PermissionFlagsBits.EmbedLinks); // unrelated bits stay
    expect(custom.permissionOverwrites.cache.get(MOD).allow.bitfield).toBe(PermissionFlagsBits.SendMessages); // other overwrites stay
    expect(guild.disableInvites).toHaveBeenCalledWith(true);
    await expect(engageLockdown(guild, OWNER_ID, 'again')).rejects.toThrow(/already/);

    const lifted = await liftLockdown(guild, OWNER_ID);
    expect(lifted).toEqual({ restored: 2, failed: 0 });
    const restored = custom.permissionOverwrites.cache.get(EVERY);
    expect(restored.allow.bitfield).toBe(PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks);
    expect(restored.deny.bitfield).toBe(PermissionFlagsBits.ViewChannel);
    expect(open.permissionOverwrites.cache.has(EVERY)).toBe(false); // had none before, so none after
    expect(guild.disableInvites).toHaveBeenLastCalledWith(false);
    expect((await Lockdown.findOne({ guildId: guild.id }))?.active).toBe(false);
  });
  it('keeps going when one channel fails, and reports it', async () => {
    const { guild, open } = setup();
    open.edit = vi.fn(async () => { throw new Error('Missing permissions'); });
    expect(await engageLockdown(guild, OWNER_ID, 'x')).toEqual({ locked: 1, failed: 1 });
  });
  it('refuses to lift when not locked', async () => {
    await expect(liftLockdown(setup().guild, OWNER_ID)).rejects.toThrow(/not in lockdown/);
  });
});

describe('leveling persistence', () => {
  it('awards once per cooldown, even under concurrency', async () => {
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 10 }, () => awardXp(GUILD_ID, 'u1', 20, 60, now)));
    expect(results.filter(Boolean).length).toBe(1);
    const doc = await MemberLevel.findOne({ userId: 'u1' });
    expect(doc?.xp).toBe(20);
    expect(doc?.messages).toBe(10);
  });
  it('awards again after the cooldown and detects level ups', async () => {
    const t = Date.now();
    await awardXp(GUILD_ID, 'u2', 50, 60, new Date(t));
    const second = await awardXp(GUILD_ID, 'u2', 100, 60, new Date(t + 61_000));
    expect(second).toMatchObject({ leveledUp: true, level: 1, xp: 150 });
    const third = await awardXp(GUILD_ID, 'u2', 1, 60, new Date(t + 122_000));
    expect(third?.leveledUp).toBe(false);
  });
});

describe('scheduled messages', () => {
  const client = (guild: any) => ({ guilds: { cache: new Collection([[guild.id, guild]]) } }) as any;
  it('posts due messages once and moves to the next run', async () => {
    const guild = fakeGuild();
    const channel = fakeChannel(guild, LOG_CH);
    await ScheduledMessage.create({ guildId: guild.id, name: 'daily', channelId: LOG_CH, cron: '0 9 * * *', content: 'Hello {server}', nextRunAt: new Date(Date.now() - 1000), createdBy: MOD });
    expect(await runDueSchedules(client(guild))).toBe(1);
    expect(channel.send.mock.calls[0][0].content).toBe('Hello Test Guild');
    expect(await runDueSchedules(client(guild))).toBe(0);
    const doc = await ScheduledMessage.findOne();
    expect(doc?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    expect(doc?.enabled).toBe(true);
  });
  it('one-time messages run once and then switch off', async () => {
    const guild = fakeGuild();
    fakeChannel(guild, LOG_CH);
    await ScheduledMessage.create({ guildId: guild.id, name: 'once', channelId: LOG_CH, cron: null, content: 'x', nextRunAt: new Date(Date.now() - 1000), createdBy: MOD });
    await runDueSchedules(client(guild));
    expect((await ScheduledMessage.findOne())?.enabled).toBe(false);
  });
  it('never double-posts when two workers race', async () => {
    const guild = fakeGuild();
    const channel = fakeChannel(guild, LOG_CH);
    await ScheduledMessage.create({ guildId: guild.id, name: 'r', channelId: LOG_CH, cron: '0 9 * * *', content: 'x', nextRunAt: new Date(Date.now() - 1000), createdBy: MOD });
    await Promise.all([runDueSchedules(client(guild)), runDueSchedules(client(guild))]);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });
});

describe('birthdays', () => {
  it('celebrates once a year and schedules the role removal', async () => {
    const guild = fakeGuild();
    const channel = fakeChannel(guild, LOG_CH);
    const role = fakeRole('500000000000000030', 3);
    guild.roles.cache.set(role.id, role);
    await updateConfig(guild.id, 'community', { birthdays: { enabled: true, channelId: LOG_CH, roleId: role.id } });
    const m = fakeMember(guild, '400000000000000090', { position: 1 });
    await Birthday.create({ guildId: guild.id, userId: m.id, month: 3, day: 14 });
    const client = { guilds: { cache: new Collection([[guild.id, guild]]) } } as any;
    const when = new Date('2027-03-14T08:00:00Z');
    await runBirthdays(client, when);
    await runBirthdays(client, when);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(m.roles.add).toHaveBeenCalledTimes(1);
    expect(await Job.countDocuments({ type: 'role.expire' })).toBe(1);
    await runBirthdays(client, new Date('2028-03-14T08:00:00Z'));
    expect(channel.send).toHaveBeenCalledTimes(2);
  });
});

describe('models', () => {
  it('blocks duplicate auto responses per guild, but allows them across guilds', async () => {
    const base = { trigger: 'hi', response: 'hello' };
    await AutoResponse.create({ ...base, guildId: GUILD_ID });
    await expect(AutoResponse.create({ ...base, guildId: GUILD_ID })).rejects.toMatchObject({ code: 'DUPLICATE' });
    await expect(AutoResponse.create({ ...base, guildId: '100000000000000002' })).resolves.toBeTruthy();
  });
  it('flushStats does not fail with nothing to write', async () => {
    await expect(flushStats()).resolves.toBeUndefined();
  });
});

