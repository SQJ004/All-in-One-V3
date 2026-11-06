import { Collection, PermissionsBitField } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { GuildConfigSchema } from '../../src/config/guildConfig.js';
import { updateConfig } from '../../src/core/configService.js';
import { Case, StaffEvent, StaffRecord, Ticket, type ICase, type ITicket } from '../../src/db/models.js';
import { parseRange } from '../../src/dashboard/staffApi.js';
import { activityMaps, buildRow, computeScore, goalProgress, moderationQuality, rankRows, resolverOf, responseScore, ticketAnalytics, tierOf, type Dataset } from '../../src/modules/staff/analytics.js';
import { onStaffRoleChange } from '../../src/modules/staff/index.js';
import { dashboardTicketAction, onTicketMessage } from '../../src/modules/tickets/index.js';
import { useDatabase } from '../helpers/db.js';
import { BOT_ID, fakeChannel, fakeMember, fakeRole } from '../helpers/fakes.js';
import { setupGuild } from '../helpers/interaction.js';

useDatabase();

const MOD = '700000000000000071';
const OTHER = '700000000000000072';
const OWNER = '700000000000000073';
const DAY = 86_400_000;
const NOW = Date.UTC(2030, 5, 15, 12);
const range = { from: new Date(NOW - 30 * DAY), to: new Date(NOW) };
const cfg = GuildConfigSchema.parse({}).staff;
const info = (id: string) => ({ id, name: id, avatar: null, joinedAt: null, roleIds: [], roleName: null });

const makeCase = (over: Partial<ICase>): ICase => ({ _id: String(Math.random()), guildId: 'g', number: 1, type: 'warn', targetId: '1', targetTag: 't', moderatorId: MOD, moderatorTag: 'mod', reason: 'Spam', active: true, createdAt: new Date(NOW - DAY), updatedAt: new Date(NOW), ...over }) as ICase;
const makeTicket = (over: Partial<ITicket>): ITicket => ({ _id: String(Math.random()), guildId: 'g', number: 1, channelId: 'c', ownerId: OWNER, ownerTag: 'o', subject: 's', status: 'closed', addedUsers: [], createdAt: new Date(NOW - DAY), updatedAt: new Date(NOW), ...over }) as ITicket;
const data = (over: Partial<Dataset>): Dataset => ({ cases: [], tickets: [], events: [], ...over });

describe('resolved tickets', () => {
  it('belong to one person only', () => {
    expect(resolverOf(makeTicket({ resolvedBy: MOD, closedBy: OTHER }), BOT_ID)).toBe(MOD);
    expect(resolverOf(makeTicket({ closedBy: MOD }), BOT_ID)).toBe(MOD);
  });

  it('are not counted for an automatic close, or while open', () => {
    expect(resolverOf(makeTicket({ closedBy: BOT_ID, claimedBy: MOD }), BOT_ID)).toBeNull();
    expect(resolverOf(makeTicket({ status: 'open', closedBy: MOD }), BOT_ID)).toBeNull();
  });

  it('credit whoever claimed it when members close their own ticket', () => {
    expect(resolverOf(makeTicket({ closedBy: OWNER, claimedBy: MOD }), BOT_ID)).toBe(MOD);
    expect(resolverOf(makeTicket({ closedBy: OWNER }), BOT_ID)).toBeNull();
  });

  it('count once in the totals, even when one person claimed, replied and resolved', () => {
    const t = makeTicket({ claimedBy: MOD, firstResponderId: MOD, firstResponseAt: new Date(NOW - DAY + 60_000), closedBy: MOD, resolvedBy: MOD, resolvedAt: new Date(NOW - DAY + 120_000) });
    const row = buildRow(info(MOD), 'moderator', data({ tickets: [t] }), range, cfg, BOT_ID, NOW);
    expect(row).toMatchObject({ handled: 1, resolved: 1, closed: 1, claimed: 1 });
    expect(ticketAnalytics([t], range, BOT_ID).resolved).toBe(1);
  });
});

describe('moderation quality', () => {
  it('is not raised by giving more punishments', () => {
    const few = moderationQuality(MOD, [makeCase({})], []);
    const many = Array.from({ length: 50 }, () => makeCase({}));
    expect(moderationQuality(MOD, many, many)).toBe(few);
  });

  it('falls for missing reasons, and for punishments someone else undid', () => {
    expect(moderationQuality(MOD, [makeCase({ reason: 'No reason provided' })], [])).toBe(0);
    const ban = makeCase({ type: 'ban', targetId: '9' });
    const unban = makeCase({ type: 'unban', targetId: '9', moderatorId: OTHER, createdAt: new Date(NOW - DAY + 3_600_000) });
    expect(moderationQuality(MOD, [ban], [ban, unban])).toBe(0);
  });

  it('is not lowered when they undo their own, or much later', () => {
    const ban = makeCase({ type: 'ban', targetId: '9', createdAt: new Date(NOW - 20 * DAY) });
    expect(moderationQuality(MOD, [ban], [ban, makeCase({ type: 'unban', targetId: '9', createdAt: new Date(NOW - 19 * DAY) })])).toBe(100);
    expect(moderationQuality(MOD, [ban], [ban, makeCase({ type: 'unban', targetId: '9', moderatorId: OTHER, createdAt: new Date(NOW - DAY) })])).toBe(100);
  });

  it('has no value without punishments', () => {
    expect(moderationQuality(MOD, [makeCase({ type: 'note' })], [])).toBeNull();
  });
});

describe('performance score', () => {
  const weights = cfg.weights;

  it('uses the weights', () => {
    expect(computeScore({ quality: 100, response: 100, moderation: 100, activity: 100 }, weights)).toBe(100);
    expect(computeScore({ quality: 100, response: 0, moderation: 0, activity: 0 }, weights)).toBe(30);
  });

  it('shares the weight of a part with no data, and gives no score for activity alone', () => {
    expect(computeScore({ quality: 80, response: null, moderation: null, activity: null }, weights)).toBe(80);
    expect(computeScore({ quality: null, response: null, moderation: null, activity: 100 }, weights)).toBeNull();
  });

  it('gives full marks for response time up to the target, then falls', () => {
    expect(responseScore(10, 30)).toBe(100);
    expect(responseScore(120, 30)).toBe(0);
    expect(responseScore(null, 30)).toBeNull();
  });

  it('never ranks someone higher for handing out more punishments', () => {
    const careful = buildRow(info(MOD), 'moderator', data({ cases: [makeCase({})] }), range, cfg, BOT_ID, NOW);
    const heavy = Array.from({ length: 40 }, () => makeCase({ moderatorId: OTHER, reason: 'No reason provided', createdAt: new Date(NOW - DAY) }));
    const harsh = buildRow(info(OTHER), 'moderator', data({ cases: heavy }), range, cfg, BOT_ID, NOW);
    expect(rankRows([harsh, careful])[0]!.userId).toBe(MOD);
  });

  it('leaves automatic bot actions out of a person\'s work', () => {
    const row = buildRow(info(MOD), 'moderator', data({ cases: [makeCase({ type: 'automod' })] }), range, cfg, BOT_ID, NOW);
    expect(row).toMatchObject({ cases: 0, actions: 0, status: 'inactive', lastActive: null });
  });
});

describe('staff groups, status and goals', () => {
  it('uses the highest group, and treats ticket staff as support', () => {
    const c = { ...cfg, adminRoles: ['a'], moderatorRoles: ['m'], helperRoles: ['h'], supportRoles: ['s'] };
    expect(tierOf(['m', 'a'], c)).toBe('admin');
    expect(tierOf(['h'], c)).toBe('helper');
    expect(tierOf(['t'], c, ['t'])).toBe('support');
    expect(tierOf(['x'], c)).toBe('unlisted');
  });

  it('calls someone active only from recorded work', () => {
    const recent = buildRow(info(MOD), 'moderator', data({ cases: [makeCase({ createdAt: new Date(NOW - DAY) })] }), range, cfg, BOT_ID, NOW);
    const old = buildRow(info(MOD), 'moderator', data({ cases: [makeCase({ createdAt: new Date(NOW - 20 * DAY) })] }), range, cfg, BOT_ID, NOW);
    expect(recent.status).toBe('active');
    expect(old.status).toBe('inactive');
  });

  it('scales count goals with the period, and leaves missing data pending', () => {
    const row = buildRow(info(MOD), 'moderator', data({}), range, cfg, BOT_ID, NOW);
    const goals = goalProgress(row, cfg.goals.moderator, 30);
    expect(goals.find((g) => g.key === 'resolved')).toMatchObject({ target: 22, done: false });
    expect(goals.find((g) => g.key === 'response')).toMatchObject({ value: null, done: false, percent: 0 });
  });

  it('counts a faster response as done', () => {
    const t = makeTicket({ firstResponderId: MOD, firstResponseAt: new Date(NOW - DAY + 5 * 60_000) });
    const row = buildRow(info(MOD), 'moderator', data({ tickets: [t] }), range, cfg, BOT_ID, NOW);
    expect(goalProgress(row, cfg.goals.moderator, 30).find((g) => g.key === 'response')!.done).toBe(true);
  });
});

describe('activity map', () => {
  it('counts by UTC day and hour, and ignores anything over a year old', () => {
    const map = activityMaps([NOW, NOW - 3_600_000, NOW - 400 * DAY], NOW);
    expect(map.activeDays).toBe(1);
    expect(map.hours[12]).toBe(1);
    expect(map.hours[11]).toBe(1);
    expect(map.days['2030-06-15']).toBe(2);
  });
});

describe('date ranges', () => {
  it('reads presets and custom dates', () => {
    expect(parseRange({ days: '7' }, NOW).from.getTime()).toBe(NOW - 7 * DAY);
    expect(parseRange({ from: '2030-01-01', to: '2030-01-31' }).to.toISOString()).toContain('2030-01-31');
  });

  it('refuses a backwards or huge range', () => {
    expect(() => parseRange({ from: '2030-02-01', to: '2030-01-01' })).toThrow(/before/);
    expect(() => parseRange({ from: '2020-01-01', to: '2030-01-01' })).toThrow(/400/);
  });
});

describe('what the bot records', () => {
  const ticketWorld = async () => {
    const guild = setupGuild();
    guild.members.me = fakeMember(guild, BOT_ID, { position: 50, bot: true });
    const channel = fakeChannel(guild, '600000000000000031', { name: 'ticket-0001' });
    Object.assign(channel, { setName: vi.fn(async () => undefined), messages: { fetch: vi.fn(async () => new Collection()) } });
    channel.permissionOverwrites.edit = vi.fn(async () => undefined);
    const role = fakeRole('500000000000000041', 2);
    const staff = fakeMember(guild, MOD, { position: 2, roles: [role] });
    staff.permissions = new PermissionsBitField([]);
    const owner = fakeMember(guild, OWNER, { position: 1 });
    owner.permissions = new PermissionsBitField([]);
    await updateConfig(guild.id, 'tickets', { enabled: true, staffRoleIds: [role.id] });
    const ticket = await Ticket.create({ guildId: guild.id, number: 1, channelId: channel.id, ownerId: owner.id, ownerTag: 'luna', subject: 'help' });
    const say = (member: any, content = 'private words') => onTicketMessage({ inGuild: () => true, author: member.user, member, channelId: channel.id, guildId: guild.id, content } as never);
    return { guild, channel, staff, owner, ticket, say };
  };

  it('records the first staff reply once, and never the member\'s own', async () => {
    const { staff, owner, ticket, say } = await ticketWorld();
    await say(owner);
    expect((await Ticket.findOne({ _id: ticket._id }))?.firstResponseAt ?? null).toBeNull();
    await say(staff);
    const first = (await Ticket.findOne({ _id: ticket._id }))?.firstResponseAt;
    expect(first).toBeTruthy();
    await new Promise((r) => setTimeout(r, 3));
    await say(staff);
    expect((await Ticket.findOne({ _id: ticket._id }))?.firstResponseAt).toEqual(first);
    expect(await StaffEvent.countDocuments({ type: 'ticket_reply' })).toBe(2);
  });

  it('never stores what was said', async () => {
    const { staff, say } = await ticketWorld();
    await say(staff, 'very private words');
    expect(JSON.stringify(await StaffEvent.find())).not.toContain('private');
  });

  it('resolves a ticket once across a reopen', async () => {
    const { guild, staff, ticket } = await ticketWorld();
    await dashboardTicketAction(guild, String(ticket._id), 'close', staff.id);
    const first = await Ticket.findOne({ _id: ticket._id });
    expect(first).toMatchObject({ status: 'closed', resolvedBy: staff.id });
    await dashboardTicketAction(guild, String(ticket._id), 'reopen', staff.id);
    await new Promise((r) => setTimeout(r, 3));
    await dashboardTicketAction(guild, String(ticket._id), 'close', staff.id);
    expect((await Ticket.findOne({ _id: ticket._id }))?.resolvedAt).toEqual(first?.resolvedAt);
  });

  it('adds a history record when someone gains or loses a staff role', async () => {
    const guild = setupGuild();
    const role = fakeRole('500000000000000051', 2, { name: 'Moderator' });
    guild.roles.cache.set(role.id, role);
    await updateConfig(guild.id, 'staff', { moderatorRoles: [role.id] });
    const before = fakeMember(guild, MOD, { position: 1 });
    const after = fakeMember(guild, MOD, { position: 2, roles: [role] });
    await onStaffRoleChange({ ...before, partial: false } as never, after);
    expect(await StaffRecord.findOne({ userId: MOD })).toMatchObject({ type: 'role_change', adminName: 'Discord', reason: 'Gained Moderator' });
    await onStaffRoleChange({ ...after, partial: false } as never, before);
    expect(await StaffRecord.countDocuments({ userId: MOD })).toBe(2);
  });

  it('ignores role changes when no staff roles are set', async () => {
    const guild = setupGuild();
    const m = fakeMember(guild, MOD, { position: 1 });
    await onStaffRoleChange({ ...m, partial: false } as never, m);
    expect(await StaffRecord.countDocuments()).toBe(0);
  });
});

void Case;
