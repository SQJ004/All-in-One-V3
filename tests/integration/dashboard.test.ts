import { UserError } from '../../src/core/types.js';
import { actionName } from '../../src/dashboard/api.js';
import { MODULES } from '../../src/core/registry.js';
import { CATEGORIES, commandCatalog } from '../../src/dashboard/commandCatalog.js';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig, updateConfig } from '../../src/core/configService.js';
import { createDashboardApp, safeEqual, sealer } from '../../src/dashboard/app.js';
import type { Access, DashboardGateway } from '../../src/dashboard/gateway.js';
import type { OAuthClient } from '../../src/dashboard/oauth.js';
import { AutoResponse, Case, CustomCommand, RolePanel, SecurityEvent, WebSession, AuditEntry, ServerBackup, Ticket, StaffRecord } from '../../src/db/models.js';
import { useDatabase } from '../helpers/db.js';

useDatabase();

const G1 = '100000000000000001';
const G2 = '100000000000000002';
const USER = '200000000000000001';
const CHANNEL = '300000000000000001';
const SAFE_ROLE = '400000000000000001';
const DANGER_ROLE = '400000000000000002';
const secret = 'x'.repeat(40);
const ORIGIN = 'http://localhost:9999';

let access: Access | null;
let gateway: DashboardGateway;
let nicknameNow: string | null = null;
let oauth: OAuthClient;

const makeApp = () => createDashboardApp({ gateway, oauth, sessionSecret: secret, secureCookies: false, trustProxy: 0, publicUrl: ORIGIN, rateLimitPerMinute: 100_000 });

async function login(userId = USER) {
  const id = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('hex');
  await WebSession.create({ _id: createHash('sha256').update(id).digest('hex'), userId, username: 'tester', accessTokenEnc: sealer(secret).seal('token'), csrf, expiresAt: new Date(Date.now() + 3_600_000) });
  return { cookie: `vx_session=${id}`, csrf };
}

beforeEach(() => {
  access = { canManage: true, isOwner: true, isTrusted: true };
  gateway = {
    clientId: '500000000000000001', ping: () => 10, uptimeMs: () => 1000, isOnline: () => true, listWebhooks: vi.fn(async () => [{ id: '800000000000000001', name: 'hook', channelId: CHANNEL, createdBy: 'a', createdAt: new Date(), application: false }]), deleteWebhook: vi.fn(async () => undefined), getIdentity: vi.fn(async () => ({ status: 'online', activityType: 'none', activityText: '', embedColor: '#7c3aed', username: 'ZYTHERON', avatarUrl: null, bannerUrl: null, canEdit: true })), updateIdentity: vi.fn(async () => undefined), createBackup: vi.fn(async () => ({ backupId: 'abc123abc123' })), restoreBackup: vi.fn(async () => undefined), memberName: (_g: string, id: string) => `name-${id}`, reviewAiFlag: vi.fn(async () => undefined), staffRoster: vi.fn(async () => []), memberCard: () => null, ticketAction: vi.fn(async () => undefined), getBotProfile: async () => ({ username: 'ZYTHERON', nickname: nicknameNow, avatarUrl: null, bannerUrl: null, defaultAvatarUrl: 'https://cdn.example/bot.png', defaultBannerUrl: 'https://cdn.example/banner.png' }), setBotImages: vi.fn(async () => undefined), assertCanPost: vi.fn(async () => undefined), setNickname: vi.fn(async (_g: string, nick: string | null) => { nicknameNow = nick; }), guildIds: () => [G1, G2],
    getGuild: (id) => ([G1, G2].includes(id) ? { id, name: `Guild ${id}`, icon: null, memberCount: 5, ownerId: USER, channels: 1, roles: 2, boosts: 0, online: true } : null),
    getChannels: () => [{ id: CHANNEL, name: 'general', type: 'text', parentId: null }],
    getRoles: () => [{ id: SAFE_ROLE, name: 'Safe', color: '#000000', position: 1, managed: false, dangerous: false }, { id: DANGER_ROLE, name: 'Admin', color: '#000000', position: 2, managed: false, dangerous: true }],
    getAccess: vi.fn(async () => access),
    postMessage: vi.fn(async () => ({ url: 'https://discord.com/x' })),
    publishRolePanel: vi.fn(async () => ({ url: 'https://discord.com/r' })),
    publishTicketPanel: vi.fn(async () => ({ url: 'https://discord.com/t' })),
    deleteMessage: vi.fn(async () => undefined),
    isLocked: async () => false,
    setLockdown: vi.fn(async () => ({ changed: 3, failed: 0 })),
  };
  oauth = {
    authorizeUrl: (state) => `https://discord.test/auth?state=${state}`,
    exchange: vi.fn(async () => ({ accessToken: 'real-token', expiresIn: 3600 })),
    fetchUser: vi.fn(async () => ({ id: USER, username: 'tester', avatar: null })),
    fetchGuilds: vi.fn(async () => [{ id: G1, name: 'Mine', icon: null, owner: true, permissions: '0' }, { id: G2, name: 'Managed', icon: 'abc', owner: false, permissions: '32' }, { id: '100000000000000003', name: 'Member only', icon: null, owner: false, permissions: '1024' }, { id: '100000000000000004', name: 'Admin, no bot', icon: null, owner: false, permissions: '8' }]),
  };
});

describe('authentication', () => {
  it('blocks the API without a session', async () => {
    const app = makeApp();
    for (const path of ['/api/me', '/api/guilds', `/api/guilds/${G1}/overview`, `/api/guilds/${G1}/config/security`]) await request(app).get(path).expect(401);
  });
  it('rejects forged and expired sessions', async () => {
    const app = makeApp();
    await request(app).get('/api/me').set('Cookie', 'vx_session=forged').expect(401);
    const { cookie } = await login();
    await WebSession.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await request(app).get('/api/me').set('Cookie', cookie).expect(401);
  });
  it('completes the OAuth flow and stores no raw secrets', async () => {
    const app = makeApp();
    const start = await request(app).get('/auth/login').expect(302);
    const state = new URL(start.headers.location!).searchParams.get('state')!;
    const stateCookie = (start.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    expect(start.headers['set-cookie']![0]).toMatch(/HttpOnly/);
    expect(start.headers['set-cookie']![0]).toMatch(/SameSite=Lax/);

    const cb = await request(app).get(`/auth/callback?code=abc&state=${state}`).set('Cookie', stateCookie).expect(302);
    const session = (cb.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('vx_session='))!.split(';')[0]!;
    const me = await request(app).get('/api/me').set('Cookie', session).expect(200);
    expect(me.body).toMatchObject({ id: USER, username: 'tester' });
    expect(me.body.accessTokenEnc).toBeUndefined();

    const stored = await WebSession.findOne();
    const rawId = session.split('=')[1]!;
    expect(stored?._id).not.toBe(rawId);
    expect(stored?.accessTokenEnc).not.toContain('real-token');
    expect(sealer(secret).open(stored!.accessTokenEnc)).toBe('real-token');
  });
  it('rejects a callback with a wrong or missing state', async () => {
    const app = makeApp();
    await request(app).get('/auth/callback?code=abc&state=evil').set('Cookie', 'vx_state=good').expect(400);
    await request(app).get('/auth/callback?code=abc&state=evil').expect(400);
    expect(oauth.exchange).not.toHaveBeenCalled();
  });
  it('logs out and kills the session', async () => {
    const app = makeApp();
    const { cookie, csrf } = await login();
    await request(app).post('/auth/logout').set('Cookie', cookie).set('x-csrf-token', csrf).expect(200);
    await request(app).get('/api/me').set('Cookie', cookie).expect(401);
  });
});

describe('CSRF', () => {
  it('requires the token and blocks other origins', async () => {
    const app = makeApp();
    const { cookie, csrf } = await login();
    const path = `/api/guilds/${G1}/config/welcome`;
    await request(app).put(path).set('Cookie', cookie).send({ enabled: true }).expect(403);
    await request(app).put(path).set('Cookie', cookie).set('x-csrf-token', 'wrong').send({ enabled: true }).expect(403);
    await request(app).put(path).set('Cookie', cookie).set('x-csrf-token', csrf).set('Origin', 'https://evil.example').send({ enabled: true }).expect(403);
    await request(app).put(path).set('Cookie', cookie).set('x-csrf-token', csrf).set('Origin', ORIGIN).send({ enabled: true }).expect(200);
  });
});

describe('authorization', () => {
  it('lists only servers the user manages, marking where the bot is missing', async () => {
    const { cookie } = await login();
    const res = await request(makeApp()).get('/api/guilds').set('Cookie', cookie).expect(200);
    expect(res.body.map((g: any) => g.name)).toEqual(['Mine', 'Managed', 'Admin, no bot']);
    expect(res.body[2].botPresent).toBe(false);
    expect(res.body[2].inviteUrl).toContain('guild_id=100000000000000004');
    expect(res.body[0].inviteUrl).toBeNull();
  });
  it('checks live permissions: a member without Manage Server gets 403 even if the OAuth list said otherwise', async () => {
    access = { canManage: false, isOwner: false, isTrusted: false };
    const { cookie, csrf } = await login();
    const app = makeApp();
    await request(app).get(`/api/guilds/${G1}/overview`).set('Cookie', cookie).expect(403);
    await request(app).put(`/api/guilds/${G1}/config/welcome`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ enabled: true }).expect(403);
    expect((await getConfig(G1)).welcome.enabled).toBe(false);
  });
  it('gives 403 when the user is not in the server, and 404 for unknown servers', async () => {
    access = null;
    const { cookie } = await login();
    const app = makeApp();
    await request(app).get(`/api/guilds/${G1}/overview`).set('Cookie', cookie).expect(403);
    await request(app).get('/api/guilds/999999999999999999/overview').set('Cookie', cookie).expect(404);
    await request(app).get('/api/guilds/not-an-id/overview').set('Cookie', cookie).expect(404);
  });
  it('only lets the owner or trusted admins change security', async () => {
    access = { canManage: true, isOwner: false, isTrusted: false };
    const { cookie, csrf } = await login();
    const app = makeApp();
    await request(app).get(`/api/guilds/${G1}/config/security`).set('Cookie', cookie).expect(200);
    const res = await request(app).put(`/api/guilds/${G1}/config/security`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ enabled: false }).expect(400);
    expect(res.body.error).toMatch(/owner or a trusted admin/);
    await request(app).post(`/api/guilds/${G1}/security/lockdown`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ on: true }).expect(400);
    expect(gateway.setLockdown).not.toHaveBeenCalled();
  });
  it('only lets the owner change trusted admins', async () => {
    access = { canManage: true, isOwner: false, isTrusted: true };
    const { cookie, csrf } = await login();
    const app = makeApp();
    await request(app).put(`/api/guilds/${G1}/config/security`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ trustedAdmins: [USER] }).expect(400);
    await request(app).put(`/api/guilds/${G1}/config/security`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ enabled: true }).expect(200);
    access = { canManage: true, isOwner: true, isTrusted: true };
    await request(app).put(`/api/guilds/${G1}/config/security`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ trustedAdmins: [USER] }).expect(200);
    expect((await getConfig(G1)).security.trustedAdmins).toEqual([USER]);
  });
  it('refuses a dangerous jail role', async () => {
    const { cookie, csrf } = await login();
    const app = makeApp();
    const put = (jailRoleId: string) => request(app).put(`/api/guilds/${G1}/config/moderation`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ jailRoleId });
    await put(DANGER_ROLE).expect(400);
    await put(SAFE_ROLE).expect(200);
  });
});

describe('guild isolation', () => {
  it('cannot read, edit or delete another guild\'s items by ID', async () => {
    const { cookie, csrf } = await login();
    const app = makeApp();
    const other = await CustomCommand.create({ guildId: G2, name: 'secret', response: 'private', createdBy: 'x' });
    const list = await request(app).get(`/api/guilds/${G1}/commands`).set('Cookie', cookie).expect(200);
    expect(list.body).toEqual([]);
    await request(app).put(`/api/guilds/${G1}/commands/${other._id}`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ name: 'hacked', response: 'x' }).expect(404);
    await request(app).delete(`/api/guilds/${G1}/commands/${other._id}`).set('Cookie', cookie).set('x-csrf-token', csrf).expect(200);
    const still = await CustomCommand.findById(other._id);
    expect(still).toMatchObject({ name: 'secret', response: 'private' });
  });
  it('filters cases and events by guild', async () => {
    const { cookie } = await login();
    const app = makeApp();
    await Case.create({ guildId: G2, number: 1, type: 'ban', targetId: '1', reason: 'other guild' });
    await SecurityEvent.create({ guildId: G2, type: 'x', severity: 'info', summary: 'other guild' });
    expect((await request(app).get(`/api/guilds/${G1}/cases`).set('Cookie', cookie)).body.total).toBe(0);
    expect((await request(app).get(`/api/guilds/${G1}/security/events`).set('Cookie', cookie)).body).toEqual([]);
  });
});

describe('input validation', () => {
  it('returns readable errors and saves nothing', async () => {
    const { cookie, csrf } = await login();
    const res = await request(makeApp()).put(`/api/guilds/${G1}/config/security`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ antiRaid: { joinThreshold: -5 } }).expect(400);
    expect(res.body.issues[0].path).toContain('joinThreshold');
    expect((await getConfig(G1)).security.antiRaid.joinThreshold).toBe(10);
  });
  it('does not let query strings inject NoSQL operators', async () => {
    const { cookie } = await login();
    const app = makeApp();
    await Case.create({ guildId: G1, number: 1, type: 'ban', targetId: '1', reason: 'mine' });
    await Case.create({ guildId: G2, number: 1, type: 'ban', targetId: '1', reason: 'other guild' });
    for (const q of ['user[$ne]=1', 'type[$ne]=x', 'guildId[$ne]=x', 'guildId=' + G2]) {
      const res = await request(app).get(`/api/guilds/${G1}/cases?${q}`).set('Cookie', cookie).expect(200);
      expect(res.body.items.map((c: any) => c.reason)).toEqual(['mine']);
    }
    await request(app).get(`/api/guilds/${G1}/cases?type=${encodeURIComponent('{"$ne":1}')}`).set('Cookie', cookie).expect(400);
  });
  it('rejects unknown sections and non-object bodies', async () => {
    const { cookie, csrf } = await login();
    const app = makeApp();
    await request(app).get(`/api/guilds/${G1}/config/nope`).set('Cookie', cookie).expect(404);
    await request(app).put(`/api/guilds/${G1}/config/welcome`).set('Cookie', cookie).set('x-csrf-token', csrf).send([1, 2]).expect(400);
    await request(app).put(`/api/guilds/${G1}/config/welcome`).set('Cookie', cookie).set('x-csrf-token', csrf).set('content-type', 'application/json').send('{bad').expect(400);
  });
  it('refuses dangerous regexes in automation', async () => {
    const { cookie, csrf } = await login();
    const res = await request(makeApp()).post(`/api/guilds/${G1}/autoresponses`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ trigger: '(a+)+$', matchType: 'regex', response: 'x' }).expect(400);
    expect(res.body.error).toMatch(/slowly/);
    expect(await AutoResponse.countDocuments()).toBe(0);
  });
  it('validates schedules and computes the next run', async () => {
    const { cookie, csrf } = await login();
    const app = makeApp();
    const post = (b: object) => request(app).post(`/api/guilds/${G1}/schedules`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ name: 'n', channelId: CHANNEL, content: 'x', ...b });
    await post({ cron: '* * * * *' }).expect(400);
    await post({ cron: 'nonsense' }).expect(400);
    const ok = await post({ cron: '0 9 * * 1' }).expect(201);
    expect(new Date(ok.body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });
  it('validates embeds before sending', async () => {
    const { cookie, csrf } = await login();
    const app = makeApp();
    const send = (b: object) => request(app).post(`/api/guilds/${G1}/embeds/send`).set('Cookie', cookie).set('x-csrf-token', csrf).send(b);
    await send({ channelId: CHANNEL, spec: { embeds: [{ title: 'x'.repeat(300) }] } }).expect(400);
    await send({ channelId: 'nope', spec: { embeds: [{ title: 't' }] } }).expect(400);
    await send({ channelId: CHANNEL, spec: { embeds: [] } }).expect(400);
    expect(gateway.postMessage).not.toHaveBeenCalled();
    await send({ channelId: CHANNEL, spec: { embeds: [{ title: 't' }] } }).expect(200);
    expect(gateway.postMessage).toHaveBeenCalledWith(G1, CHANNEL, expect.anything(), USER);
  });
  it('rejects oversized bodies', async () => {
    const { cookie, csrf } = await login();
    await request(makeApp()).put(`/api/guilds/${G1}/embeds`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ name: 'big', spec: { content: 'x'.repeat(300_000) } }).expect(413);
  });
  it('does not leak internals on server errors', async () => {
    gateway.getAccess = vi.fn(async () => { throw new Error('secret connection string'); });
    const { cookie } = await login();
    const res = await request(makeApp()).get(`/api/guilds/${G1}/overview`).set('Cookie', cookie).expect(500);
    expect(JSON.stringify(res.body)).not.toMatch(/secret/);
  });
});

describe('features', () => {
  it('serves overview with a full 14-day series', async () => {
    const { cookie } = await login();
    await updateConfig(G1, 'security', { enabled: true });
    const res = await request(makeApp()).get(`/api/guilds/${G1}/overview`).set('Cookie', cookie).expect(200);
    expect(res.body.activity.length).toBe(14);
    expect(res.body.status.security).toBe('monitor');
    expect(res.body.guild.name).toContain(G1);
  });
  it('saves, lists and deletes embed templates', async () => {
    const { cookie, csrf } = await login();
    const app = makeApp();
    await request(app).put(`/api/guilds/${G1}/embeds`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ name: 'welcome', spec: { embeds: [{ title: 't' }] } }).expect(200);
    await request(app).put(`/api/guilds/${G1}/embeds`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ name: 'Bad Name!', spec: { embeds: [] } }).expect(400);
    expect((await request(app).get(`/api/guilds/${G1}/embeds`).set('Cookie', cookie)).body.map((t: any) => t.name)).toEqual(['welcome']);
    await request(app).delete(`/api/guilds/${G1}/embeds/welcome`).set('Cookie', cookie).set('x-csrf-token', csrf).expect(200);
    expect((await request(app).get(`/api/guilds/${G1}/embeds`).set('Cookie', cookie)).body).toEqual([]);
  });
  it('creates, edits and deletes through the CRUD endpoints', async () => {
    const { cookie, csrf } = await login();
    const app = makeApp();
    const created = await request(app).post(`/api/guilds/${G1}/commands`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ name: 'Hello', response: 'hi' }).expect(201);
    expect(created.body.name).toBe('hello');
    await request(app).post(`/api/guilds/${G1}/commands`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ name: 'hello', response: 'dup' }).expect(409);
    const edited = await request(app).put(`/api/guilds/${G1}/commands/${created.body._id}`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ name: 'hello', response: 'updated' }).expect(200);
    expect(edited.body.response).toBe('updated');
    await request(app).delete(`/api/guilds/${G1}/commands/${created.body._id}`).set('Cookie', cookie).set('x-csrf-token', csrf).expect(200);
    expect(await CustomCommand.countDocuments()).toBe(0);
  });
  it('triggers lockdown for the owner', async () => {
    const { cookie, csrf } = await login();
    const res = await request(makeApp()).post(`/api/guilds/${G1}/security/lockdown`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ on: true, reason: 'Test' }).expect(200);
    expect(res.body.changed).toBe(3);
    expect(gateway.setLockdown).toHaveBeenCalledWith(G1, true, USER, 'Test');
  });
});

describe('panels', () => {
  const role = { name: 'games', kind: 'button', title: 'Games', items: [{ roleId: SAFE_ROLE }] };
  const send = (app: any, s: { cookie: string; csrf: string }, method: 'post' | 'put' | 'delete', path: string) => (request(app) as any)[method](`/api/guilds/${G1}/${path}`).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);

  it('creates, labels, publishes, edits and deletes role panels', async () => {
    const s = await login();
    const app = makeApp();
    const made = await send(app, s, 'post', 'rolepanels').send(role).expect(201);
    expect(made.body).toMatchObject({ guildId: G1, behavior: 'toggle', color: '#7c3aed' });
    expect(made.body.items[0].label).toBe('Safe');
    const pub = await send(app, s, 'post', `rolepanels/${made.body._id}/publish`).send({ channelId: CHANNEL }).expect(200);
    expect(pub.body.url).toContain('discord.com');
    expect(gateway.publishRolePanel).toHaveBeenCalledWith(G1, made.body._id, CHANNEL, USER);
    const edited = await send(app, s, 'put', `rolepanels/${made.body._id}`).send({ ...role, title: 'Updated' }).expect(200);
    expect(edited.body.title).toBe('Updated');
    await RolePanel.updateOne({ _id: made.body._id }, { $set: { channelId: CHANNEL, messageId: '900000000000000001' } });
    await send(app, s, 'delete', `rolepanels/${made.body._id}`).expect(200);
    expect(gateway.deleteMessage).toHaveBeenCalledWith(G1, CHANNEL, '900000000000000001');
    expect(await RolePanel.countDocuments()).toBe(0);
  });
  it('refuses unsafe role panels', async () => {
    const s = await login();
    const app = makeApp();
    const bad = await send(app, s, 'post', 'rolepanels').send({ ...role, items: [{ roleId: DANGER_ROLE }] }).expect(400);
    expect(bad.body.error).toMatch(/moderator or admin/);
    await send(app, s, 'post', 'rolepanels').send({ ...role, items: [] }).expect(400);
    await send(app, s, 'post', 'rolepanels').send({ ...role, kind: 'reaction' }).expect(400);
    await send(app, s, 'post', 'rolepanels').send({ ...role, kind: 'reaction', items: [{ roleId: SAFE_ROLE, emoji: '🔥' }] }).expect(201);
    await send(app, s, 'post', 'rolepanels/abc/publish').send({ channelId: 'nope' }).expect(400);
  });
  it('creates ticket panels with category IDs, keeping them on edit', async () => {
    const s = await login();
    const app = makeApp();
    const made = await send(app, s, 'post', 'ticketpanels').send({ name: 'support', title: 'Help', categories: [{ label: 'Billing' }] }).expect(201);
    const id = made.body.categories[0].id;
    expect(id).toBeTruthy();
    const edited = await send(app, s, 'put', `ticketpanels/${made.body._id}`).send({ name: 'support', title: 'Help', categories: [{ id, label: 'Payments' }, { label: 'Other' }] }).expect(200);
    expect(edited.body.categories[0]).toMatchObject({ id, label: 'Payments' });
    expect(edited.body.categories[1].id).toBeTruthy();
    await send(app, s, 'post', `ticketpanels/${made.body._id}/publish`).send({ channelId: CHANNEL }).expect(200);
    await send(app, s, 'post', 'ticketpanels').send({ name: 'x', title: 'y', categories: [] }).expect(400);
  });
  it('keeps panels inside their guild', async () => {
    const s = await login();
    const other = await RolePanel.create({ guildId: G2, name: 'theirs', kind: 'button', title: 't', description: 'd' });
    await send(makeApp(), s, 'put', `rolepanels/${other._id}`).send(role).expect(404);
    await send(makeApp(), s, 'delete', `rolepanels/${other._id}`).expect(200);
    expect(await RolePanel.countDocuments()).toBe(1);
  });
  it('previews welcome cards as images', async () => {
    const { cookie } = await login();
    const res = await request(makeApp()).get(`/api/guilds/${G1}/welcome/card/default`).set('Cookie', cookie).expect(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.body.length).toBeGreaterThan(10_000);
    await request(makeApp()).get(`/api/guilds/${G1}/welcome/card/goodbye`).set('Cookie', cookie).expect(200);
    await request(makeApp()).get(`/api/guilds/${G1}/welcome/card/nope`).set('Cookie', cookie).expect(404);
  });
});

describe('public homepage data', () => {
  it('works without signing in, and exposes nothing private', async () => {
    const res = await request(makeApp()).get('/api/public').expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['inviteUrl', 'stats', 'supportUrl']);
    expect(res.body.supportUrl).toBeNull(); // never invented when it is not configured
    expect(res.body.stats).toEqual({ servers: 2, users: 10, commands: MODULES.flatMap((m) => m.commands ?? []).length, subcommands: commandCatalog().length, online: true });
    const invite = new URL(res.body.inviteUrl);
    expect(invite.searchParams.get('client_id')).toBe('500000000000000001');
    expect(BigInt(invite.searchParams.get('permissions')!) & 8n).toBe(0n); // never Administrator
  });
  it('reports the bot as offline when it is disconnected', async () => {
    gateway.isOnline = () => false;
    const res = await request(makeApp()).get('/api/public').expect(200);
    expect(res.body.stats.online).toBe(false);
  });
  it('lists the real commands with usage and the permissions the router enforces', async () => {
    const { body } = await request(makeApp()).get('/api/public/commands').expect(200);
    const find = (name: string) => body.commands.find((c: any) => c.name === name);
    expect(body.commands.length).toBe(commandCatalog().length);
    expect(find('/moderation ban')).toMatchObject({ category: 'Moderation', permissions: ['Ban Members'] });
    expect(find('/moderation ban').usage).toMatch(/^\/moderation ban user:@user \[reason:text\]/);
    expect(find('/embed template save')).toMatchObject({ category: 'Admin', permissions: ['Manage Messages'] });
    expect(find('/level setup').permissions).toEqual(['Manage Server']);
    expect(find('/level rank').permissions).toEqual([]);
    expect(find('/ping')).toMatchObject({ category: 'Utility', usage: '/ping', permissions: [] });
  });
  it('lists the 17 music commands under Music, with who can use them', async () => {
    const { body } = await request(makeApp()).get('/api/public/commands').expect(200);
    const music = body.commands.filter((c: any) => c.category === 'Music');
    expect(music.map((c: any) => c.name).sort()).toEqual(['/clearqueue', '/leave', '/loop', '/lyrics', '/nowplaying', '/pause', '/play', '/previous', '/queue', '/remove', '/resume', '/seek', '/shuffle', '/skip', '/stop', '/volume', '/youtube']);
    expect(music.find((c: any) => c.name === '/play')).toMatchObject({ usage: '/play song:text', prefixUsage: 'v!play <song or link> (or v!p)', requirement: 'Be in a voice channel' });
    expect(music.find((c: any) => c.name === '/queue').requirement).toBeUndefined();
  });
  it('asks for the voice permissions music needs when adding the bot', async () => {
    const res = await request(makeApp()).get('/api/public').expect(200);
    const bits = BigInt(new URL(res.body.inviteUrl).searchParams.get('permissions')!);
    expect(bits & (1n << 20n)).not.toBe(0n);
    expect(bits & (1n << 21n)).not.toBe(0n);
    expect(bits & (1n << 24n)).not.toBe(0n); // Move Members, for /moveme
  });
  it('shows both ways to run a utility command', async () => {
    const { body } = await request(makeApp()).get('/api/public/commands').expect(200);
    expect(body.commands.find((c: any) => c.name === '/user')).toMatchObject({ category: 'Utility', usage: '/user [user:@user]', prefixUsage: 'v!user [@user] (or v!whois, v!ui)' });
    expect(body.commands.find((c: any) => c.name === '/roll')).toMatchObject({ category: 'Fun', prefixUsage: 'v!roll [dice] (or v!dice)' });
    expect(body.commands.find((c: any) => c.name === '/ping').prefixUsage).toBeUndefined();
  });
  it('files every command under a category, and offers no economy commands', () => {
    for (const command of MODULES.flatMap((m) => m.commands ?? [])) expect(CATEGORIES).toHaveProperty(command.data.name);
    expect(commandCatalog().some((c) => /economy/i.test(c.name))).toBe(false);
  });
  it('says whether a visitor is signed in, without revealing who', async () => {
    await request(makeApp()).get('/api/public/session').expect(200, { signedIn: false });
    await request(makeApp()).get('/api/public/session').set('Cookie', 'vx_session=forged').expect(200, { signedIn: false });
    const { cookie } = await login();
    await request(makeApp()).get('/api/public/session').set('Cookie', cookie).expect(200, { signedIn: true });
  });
  it('still protects every other API route', async () => {
    await request(makeApp()).get('/api/me').expect(401);
    await request(makeApp()).get('/api/guilds').expect(401);
  });
  it('asks only for the permissions it needs when adding the bot', async () => {
    const { cookie } = await login();
    const res = await request(makeApp()).get('/api/guilds').set('Cookie', cookie).expect(200);
    const absent = res.body.find((g: any) => !g.botPresent);
    expect(BigInt(new URL(absent.inviteUrl).searchParams.get('permissions')!) & 8n).toBe(0n);
  });
});

describe('the Bot settings page', () => {
  const put = (path: string, cookie: string, csrf: string, body: object) => request(makeApp()).put(`/api/guilds/${G1}/${path}`).set('Cookie', cookie).set('x-csrf-token', csrf).send(body);

  it('reads and changes the nickname, and clears it', async () => {
    const { cookie, csrf } = await login();
    nicknameNow = null;
    expect((await request(makeApp()).get(`/api/guilds/${G1}/bot-profile`).set('Cookie', cookie).expect(200)).body).toMatchObject({ username: 'ZYTHERON', nickname: null, defaultAvatarUrl: 'https://cdn.example/bot.png', defaultBannerUrl: 'https://cdn.example/banner.png' });
    expect((await put('nickname', cookie, csrf, { nickname: '  Zytheron Bot ' }).expect(200)).body.nickname).toBe('Zytheron Bot');
    expect(nicknameNow).toBe('Zytheron Bot');
    expect((await put('nickname', cookie, csrf, { nickname: '' }).expect(200)).body.nickname).toBeNull();
    await put('nickname', cookie, csrf, { nickname: 'x'.repeat(33) }).expect(400);
  });

  it('needs the Manage Server permission and the CSRF token', async () => {
    await request(makeApp()).get(`/api/guilds/${G1}/bot-profile`).expect(401);
    const { cookie } = await login();
    await request(makeApp()).put(`/api/guilds/${G1}/nickname`).set('Cookie', cookie).send({ nickname: 'x' }).expect(403);
    access = { canManage: false, isOwner: false, isTrusted: false };
    await request(makeApp()).get(`/api/guilds/${G1}/actions`).set('Cookie', cookie).expect(403);
  });

  it('saves prefixes, keeps at least one, and refuses unusable ones', async () => {
    const { cookie, csrf } = await login();
    expect((await request(makeApp()).get(`/api/guilds/${G1}/config/commands`).set('Cookie', cookie).expect(200)).body.prefixes).toEqual(['v!']);
    expect((await put('config/commands', cookie, csrf, { prefixes: ['v!', '?', '!!'] }).expect(200)).body.prefixes).toEqual(['v!', '?', '!!']);
    await put('config/commands', cookie, csrf, { prefixes: [] }).expect(400);
    for (const bad of [['a b'], ['@x'], ['toolong'], ['UP'], ['1', '2', '3', '4', '5', '6']]) await put('config/commands', cookie, csrf, { prefixes: bad }).expect(400);
  });

  it('records who changed what, newest first, but not failures or reads', async () => {
    const { cookie, csrf } = await login();
    await put('nickname', cookie, csrf, { nickname: 'One' }).expect(200);
    await put('config/logging', cookie, csrf, { enabled: true }).expect(200);
    await put('nickname', cookie, csrf, { nickname: 'x'.repeat(33) }).expect(400);
    await request(makeApp()).get(`/api/guilds/${G1}/overview`).set('Cookie', cookie).expect(200);
    await new Promise((r) => setTimeout(r, 30));
    const { body } = await request(makeApp()).get(`/api/guilds/${G1}/actions`).set('Cookie', cookie).expect(200);
    expect(body.map((a: any) => a.action).sort()).toEqual(['logging.update', 'nickname.update']);
    expect(Object.keys(body[0]).sort()).toEqual(['action', 'at', 'username']);
    expect(body[0].username).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('One');
  });

  it('keeps each server\'s actions separate', async () => {
    const { cookie, csrf } = await login();
    await put('nickname', cookie, csrf, { nickname: 'One' }).expect(200);
    await new Promise((r) => setTimeout(r, 30));
    expect((await request(makeApp()).get(`/api/guilds/${G2}/actions`).set('Cookie', cookie).expect(200)).body).toEqual([]);
  });

  it('names actions clearly', () => {
    expect(actionName('PUT', '/config/logging')).toBe('logging.update');
    expect(actionName('PUT', '/nickname')).toBe('nickname.update');
    expect(actionName('POST', '/role-panels')).toBe('role_panels.create');
    expect(actionName('DELETE', '/role-panels/507f1f77bcf86cd799439011')).toBe('role_panels.delete');
    expect(actionName('POST', '/role-panels/507f1f77bcf86cd799439011/publish')).toBe('role_panels.publish');
  });
});

describe('the Premium pages', () => {
  const put = (path: string, cookie: string, csrf: string, body: object) => request(makeApp()).put(`/api/guilds/${G1}/${path}`).set('Cookie', cookie).set('x-csrf-token', csrf).send(body);
  const TEXT = '300000000000000001';
  const VOICE = '300000000000000002';
  const useChannels = () => {
    gateway.getChannels = () => [{ id: TEXT, name: 'chat', type: 'text', parentId: null }, { id: VOICE, name: 'Lounge', type: 'voice', parentId: null }];
  };

  it('saves a sticky message, and refuses bad channels, repeats and channels you cannot post in', async () => {
    useChannels();
    const { cookie, csrf } = await login();
    expect((await put('config/sticky', cookie, csrf, { items: [{ channelId: TEXT, content: 'Hello' }] }).expect(200)).body.items).toHaveLength(1);
    await put('config/sticky', cookie, csrf, { items: [{ channelId: TEXT, content: '' }] }).expect(400);
    expect((await put('config/sticky', cookie, csrf, { items: [{ channelId: VOICE, content: 'x' }] }).expect(400)).body.error).toMatch(/text channel/);
    expect((await put('config/sticky', cookie, csrf, { items: [{ channelId: TEXT, content: 'a' }, { channelId: TEXT, content: 'b' }] }).expect(400)).body.error).toMatch(/only be listed once/);
    await put('config/sticky', cookie, csrf, { items: [] }).expect(200);
    gateway.assertCanPost = vi.fn(async () => { throw new UserError('You cannot post in that channel.'); });
    expect((await put('config/sticky', cookie, csrf, { items: [{ channelId: TEXT, content: 'x' }] }).expect(400)).body.error).toMatch(/cannot post/);
  });

  it('only lets the owner or a trusted admin change Auto Purge', async () => {
    useChannels();
    const { cookie, csrf } = await login();
    await put('config/autoPurge', cookie, csrf, { items: [{ channelId: TEXT, afterMinutes: 60 }] }).expect(200);
    await put('config/autoPurge', cookie, csrf, { items: [{ channelId: TEXT, afterMinutes: 1 }] }).expect(400);
    access = { canManage: true, isOwner: false, isTrusted: false };
    expect((await put('config/autoPurge', cookie, csrf, { items: [] }).expect(400)).body.error).toMatch(/owner or a trusted admin/);
  });

  it('refuses Voice Link roles that would hand out power', async () => {
    useChannels();
    gateway.getRoles = () => [
      { id: '400000000000000021', name: 'Safe', color: '#000000', position: 1, managed: false, dangerous: false },
      { id: '400000000000000022', name: 'Admin', color: '#000000', position: 2, managed: false, dangerous: true },
      { id: '400000000000000023', name: 'Bot role', color: '#000000', position: 3, managed: true, dangerous: false },
    ];
    const { cookie, csrf } = await login();
    await put('config/voiceLink', cookie, csrf, { items: [{ channelId: VOICE, roleId: '400000000000000021' }] }).expect(200);
    for (const roleId of ['400000000000000022', '400000000000000023', '400000000000000099']) {
      expect((await put('config/voiceLink', cookie, csrf, { items: [{ channelId: VOICE, roleId }] }).expect(400)).body.error).toMatch(/cannot give that role/);
    }
    expect((await put('config/voiceLink', cookie, csrf, { items: [{ channelId: TEXT, roleId: '400000000000000021' }] }).expect(400)).body.error).toMatch(/voice channel/);
  });

  it('accepts bot images, and refuses anything else', async () => {
    const { cookie, csrf } = await login();
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    await put('bot-images', cookie, csrf, { avatar: png }).expect(200);
    expect(gateway.setBotImages).toHaveBeenCalledWith(G1, { avatar: png });
    await put('bot-images', cookie, csrf, { banner: null }).expect(200);
    await put('bot-images', cookie, csrf, {}).expect(400);
    await put('bot-images', cookie, csrf, { avatar: 'https://evil.example/a.png' }).expect(400);
    await put('bot-images', cookie, csrf, { avatar: 'data:text/html;base64,AAAA' }).expect(400);
    await put('bot-images', cookie, csrf, { avatar: `data:image/png;base64,${'A'.repeat(250_000)}` }).expect(400);
  });
});

describe('the Commands page', () => {
  const G = () => G1;
  it('lists every command with its category, and marks the protected ones', async () => {
    const { cookie } = await login();
    const { body } = await request(makeApp()).get(`/api/guilds/${G()}/command-list`).set('Cookie', cookie).expect(200);
    expect(body.length).toBe(MODULES.flatMap((m) => m.commands ?? []).length);
    expect(body.find((c: any) => c.name === 'play')).toMatchObject({ category: 'Music', subcommands: 0, alwaysOn: false });
    expect(body.find((c: any) => c.name === 'moderation').subcommands).toBeGreaterThan(5);
    expect(body.filter((c: any) => c.alwaysOn).map((c: any) => c.name).sort()).toEqual(['help', 'security', 'setup']);
  });
  it('saves switches and limits, and refuses protected or unknown commands', async () => {
    const { cookie, csrf } = await login();
    const put = (body: object) => request(makeApp()).put(`/api/guilds/${G()}/config/commands`).set('Cookie', cookie).set('x-csrf-token', csrf).send(body);
    const saved = await put({ disabled: ['play', 'poll'] }).expect(200);
    expect(saved.body.disabled).toEqual(['play', 'poll']);
    const role = '400000000000000001';
    const limited = await put({ rules: { skip: { allowedRoleIds: [role], allowedChannelIds: [] } } }).expect(200);
    expect(limited.body.rules.skip.allowedRoleIds).toEqual([role]);
    expect(limited.body.disabled).toEqual(['play', 'poll']);
    expect((await put({ disabled: ['security'] }).expect(400)).body.error).toMatch(/always on/);
    expect((await put({ rules: { help: { allowedRoleIds: [role] } } }).expect(400)).body.error).toMatch(/always on/);
    expect((await put({ disabled: ['nonsense'] }).expect(400)).body.error).toMatch(/does not exist/);
    await put({ rules: { skip: { allowedRoleIds: ['not-an-id'] } } }).expect(400);
    const full = await put({ rules: { skip: { aliases: ['next'], disabledRoleIds: [role], disabledChannelIds: [], deleteInvocation: true, deleteWithMessage: true, deleteReplyAfter5s: true } } }).expect(200);
    expect(full.body.rules.skip).toMatchObject({ aliases: ['next'], disabledRoleIds: [role], deleteInvocation: true, deleteWithMessage: true, deleteReplyAfter5s: true, allowedRoleIds: [role] });
    expect((await put({ rules: { pause: { aliases: ['next'] } } }).expect(400)).body.error).toMatch(/already an alias of \/skip/);
    expect((await put({ rules: { pause: { aliases: ['play'] } } }).expect(400)).body.error).toMatch(/already runs \/play/);
    expect((await put({ rules: { pause: { aliases: ['q'] } } }).expect(400)).body.error).toMatch(/already runs \/queue/);
    expect((await put({ rules: { pause: { aliases: ['v!q'] } } }).expect(400)).body.error).toMatch(/already runs \/queue/);
    expect((await put({ rules: { play: { aliases: ['p', '#p', '!play', '.song', '-p'] } } }).expect(200)).body.rules.play.aliases).toEqual(['p', '#p', '!play', '.song', '-p']);
    for (const bad of ['@everyone', '<@123>', 'Has Space', 'UPPER', '`x`']) await put({ rules: { pause: { aliases: [bad] } } }).expect(400);
    expect((await put({ rules: { ticket: { aliases: ['tk', '#ticket'] } } }).expect(200)).body.rules.ticket.aliases).toEqual(['tk', '#ticket']);
    expect((await put({ rules: { security: { aliases: ['#sec'] } } }).expect(200)).body.rules.security.aliases).toEqual(['#sec']);
    await put({ rules: { pause: { aliases: ['Bad Alias!'] } } }).expect(400);
    await put({ rules: { skip: { aliases: ['next', 'n'] } } }).expect(200); // keeping its own alias is fine
  });
  it('needs signing in and the CSRF token', async () => {
    await request(makeApp()).get(`/api/guilds/${G()}/command-list`).expect(401);
    const { cookie } = await login();
    await request(makeApp()).put(`/api/guilds/${G()}/config/commands`).set('Cookie', cookie).send({ disabled: ['play'] }).expect(403);
  });
});

describe('hardening', () => {
  it('sends security headers', async () => {
    const res = await request(makeApp()).get('/healthz').expect(200);
    expect(res.headers['content-security-policy']).toMatch(/script-src 'self'/);
    expect(res.headers['content-security-policy']).not.toMatch(/script-src[^;]*unsafe/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
  it('rate limits', async () => {
    const limited = createDashboardApp({ gateway, oauth, sessionSecret: secret, secureCookies: false, trustProxy: 0, publicUrl: ORIGIN, rateLimitPerMinute: 2 });
    await request(limited).get('/auth/login');
    await request(limited).get('/auth/login');
    await request(limited).get('/auth/login').expect(429);
  });
  it('serves the frontend and API 404s as JSON', async () => {
    const app = makeApp();
    expect((await request(app).get('/').expect(200)).text).toContain('ZYTHERON');
    const { cookie } = await login();
    expect((await request(app).get('/api/nope').set('Cookie', cookie).expect(404)).body.error).toBeTruthy();
  });
  it('compares tokens and seals values safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    const s = sealer(secret);
    const a = s.seal('hello');
    expect(a).not.toBe(s.seal('hello'));
    expect(s.open(a)).toBe('hello');
    expect(() => sealer('y'.repeat(40)).open(a)).toThrow();
  });
});

describe('new dashboard pages', () => {
  const base = `/api/guilds/${G1}`;
  const send = (method: 'post' | 'put' | 'delete', path: string, s: { cookie: string; csrf: string }, body?: object) => request(makeApp())[method](`${base}/${path}`).set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send(body);
  const get = (path: string, s: { cookie: string }) => request(makeApp()).get(`${base}/${path}`).set('Cookie', s.cookie);

  it('needs sign-in and Manage Server for every new page', async () => {
    for (const path of ['audit-logs', 'audit-logs/export', 'backups', 'ai/overview', 'staff', 'identity', 'webhooks', 'notifications', 'anti-raid/stats']) await request(makeApp()).get(`${base}/${path}`).expect(401);
    const s = await login();
    access = { canManage: false, isOwner: false, isTrusted: false };
    for (const path of ['audit-logs', 'backups', 'ai/overview', 'staff', 'identity', 'webhooks']) await get(path, s).expect(403);
  });

  it('checks CSRF on the new actions', async () => {
    const s = await login();
    await request(makeApp()).post(`${base}/backups`).set('Cookie', s.cookie).expect(403);
    await request(makeApp()).delete(`${base}/webhooks/800000000000000001`).set('Cookie', s.cookie).expect(403);
  });

  it('keeps backups and webhooks to the owner and trusted admins', async () => {
    const s = await login();
    access = { canManage: true, isOwner: false, isTrusted: false };
    await send('post', 'backups', s).expect(400);
    await send('post', 'backups/abc/restore', s, { roles: true }).expect(400);
    await send('delete', 'backups/abc', s).expect(400);
    await get('backups/abc/download', s).expect(400);
    await send('delete', 'webhooks/800000000000000001', s).expect(400);
    await send('put', 'config/backup', s, { autoEnabled: true }).expect(400);
    await send('put', 'config/aiModeration', s, { enabled: true }).expect(400);
    await send('post', 'ai/test', s, { text: 'x' }).expect(400);
    expect(gateway.createBackup).not.toHaveBeenCalled();
    expect(gateway.restoreBackup).not.toHaveBeenCalled();
    expect(gateway.deleteWebhook).not.toHaveBeenCalled();
  });

  it('creates, lists, restores and downloads a backup', async () => {
    const s = await login();
    await send('post', 'backups', s).expect(200);
    expect(gateway.createBackup).toHaveBeenCalled();
    await send('post', 'backups/abc123/restore', s, {}).expect(400); // nothing chosen
    await send('post', 'backups/abc123/restore', s, { roles: true }).expect(200);
    expect(gateway.restoreBackup).toHaveBeenCalledWith(G1, 'abc123', expect.any(String), expect.objectContaining({ roles: true, emojis: false }));
    const doc = await ServerBackup.create({ guildId: G1, backupId: 'aaa111bbb222', kind: 'manual', createdBy: 'me', sizeBytes: 9, counts: { roles: 1, categories: 0, channels: 0, emojis: 0 }, data: { name: 'x', roles: [] } });
    const list = await get('backups', s).expect(200);
    expect(list.body[0]).toMatchObject({ backupId: doc.backupId });
    expect(list.body[0].data).toBeUndefined();
    const file = await get(`backups/${doc.backupId}/download`, s).expect(200);
    expect(file.headers['content-disposition']).toContain('attachment');
    await send('delete', `backups/${doc.backupId}`, s).expect(200);
    await send('delete', `backups/${doc.backupId}`, s).expect(400);
  });

  it('cannot reach a backup from another server', async () => {
    const s = await login();
    await ServerBackup.create({ guildId: G2, backupId: 'other0server', kind: 'manual', createdBy: 'me', sizeBytes: 9, counts: { roles: 1, categories: 0, channels: 0, emojis: 0 }, data: { secret: 'theirs' } });
    await get('backups/other0server/download', s).expect(400);
    await send('delete', 'backups/other0server', s).expect(400);
    expect((await get('backups', s).expect(200)).body).toEqual([]);
  });

  it('searches, filters, pages and exports audit logs', async () => {
    const s = await login();
    await AuditEntry.insertMany([
      ...Array.from({ length: 30 }, (_, n) => ({ guildId: G1, category: 'member', action: 'Member joined', userId: USER, status: 'ok', createdAt: new Date(2030, 0, 1, n) })),
      { guildId: G1, category: 'role', action: 'Role updated', userName: 'kai', target: '=cmd()', status: 'ok', details: 'Permissions changed', createdAt: new Date(2030, 5, 1) },
      { guildId: G2, category: 'role', action: 'Other server role', status: 'ok', createdAt: new Date(2030, 5, 2) },
    ] as never);
    const all = (await get('audit-logs', s).expect(200)).body;
    expect(all.total).toBe(31);
    expect(all.items).toHaveLength(25);
    expect(all.items[0].action).toBe('Role updated');
    expect((await get('audit-logs?page=1', s).expect(200)).body.items).toHaveLength(6);
    expect((await get('audit-logs?category=role', s).expect(200)).body.total).toBe(1);
    expect((await get('audit-logs?q=permissions', s).expect(200)).body.total).toBe(1);
    expect((await get('audit-logs?user=kai', s).expect(200)).body.total).toBe(1);
    expect((await get(`audit-logs?from=${new Date(2030, 4, 1).toISOString()}`, s).expect(200)).body.total).toBe(1);
    expect((await get(`audit-logs?to=${new Date(2030, 4, 1).toISOString()}`, s).expect(200)).body.total).toBe(30);
    await get('audit-logs?category=Bad!', s).expect(400);
    const csv = await get('audit-logs/export?category=role', s).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain("'=cmd()");
    expect(csv.text).not.toContain('Other server');
  });

  it('counts staff work from real records, leaving out the bot', async () => {
    const s = await login();
    await Case.insertMany([
      { guildId: G1, number: 1, type: 'warn', targetId: '1', targetTag: 'a', moderatorId: USER, moderatorTag: 'Mod', reason: 'r' },
      { guildId: G1, number: 2, type: 'ban', targetId: '1', targetTag: 'a', moderatorId: USER, moderatorTag: 'Mod', reason: 'r' },
      { guildId: G1, number: 3, type: 'timeout', targetId: '1', targetTag: 'a', moderatorId: gateway.clientId, moderatorTag: 'Bot', reason: 'r' },
    ] as never);
    await Ticket.insertMany([{ guildId: G1, number: 1, channelId: '1', ownerId: '2', ownerTag: 'x', subject: 's', claimedBy: USER, closedBy: USER, status: 'closed', rating: 4 }] as never);
    const { staff } = (await get('staff', s).expect(200)).body;
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({ userId: USER, cases: 2, claimed: 1, closed: 1, averageRating: 4, byType: { warn: 1, ban: 1 } });
  });

  it('shows a clear state for AI when no key is set', async () => {
    const s = await login();
    const data = (await get('ai/overview', s).expect(200)).body;
    expect(data).toMatchObject({ connected: false, totals: { analyzed: 0 } });
    expect((await send('post', 'ai/test', s, { text: 'hello' }).expect(400)).body.error).toContain('ANTHROPIC_API_KEY');
  });

  it('only says whether AI is connected, never the key', async () => {
    const s = await login();
    expect(Object.keys((await get('ai/overview', s).expect(200)).body).sort()).toEqual(['connected', 'days', 'model', 'pending', 'recent', 'totals']);
  });

  it('validates a review, and passes it on', async () => {
    const s = await login();
    await send('post', 'ai/flags/abc/review', s, { decision: 'ban' }).expect(400); // AI review cannot ban
    await send('post', 'ai/flags/abc/review', s, { decision: 'warn' }).expect(200);
    expect(gateway.reviewAiFlag).toHaveBeenCalledWith(G1, 'abc', 'warn', USER);
  });

  it('validates the bot identity', async () => {
    const s = await login();
    await send('put', 'identity', s, { embedColor: 'red' }).expect(400);
    await send('put', 'identity', s, { status: 'hacked' }).expect(400);
    await send('put', 'identity', s, { username: 'x' }).expect(400);
    await send('put', 'identity', s, { avatar: 'https://evil.example/a.png' }).expect(400);
    await send('put', 'identity', s, { status: 'idle', activityType: 'playing', activityText: 'a game', embedColor: '#112233', username: 'Zy Bot' }).expect(200);
    expect(gateway.updateIdentity).toHaveBeenCalledWith(USER, expect.objectContaining({ status: 'idle', username: 'Zy Bot' }));
  });

  it('never returns a webhook token', async () => {
    const s = await login();
    const { webhooks } = (await get('webhooks', s).expect(200)).body;
    expect(webhooks[0]).toMatchObject({ id: '800000000000000001', trusted: false });
    expect(JSON.stringify(webhooks)).not.toMatch(/token/i);
    await send('delete', 'webhooks/notanid', s).expect(400);
    await send('delete', 'webhooks/800000000000000001', s).expect(200);
  });

  it('validates ticket actions and questions', async () => {
    const s = await login();
    await send('post', 'tickets/abc/action', s, { action: 'explode' }).expect(400);
    await send('post', 'tickets/abc/action', s, { action: 'assign', userId: USER }).expect(200);
    expect(gateway.ticketAction).toHaveBeenCalledWith(G1, 'abc', 'assign', USER, USER);
    const panel = { name: 'p', title: 't', categories: [{ label: 'Help', questions: ['What happened?'] }] };
    const made = await send('post', 'ticketpanels', s, panel).expect(201);
    expect(made.body.categories[0].questions).toEqual(['What happened?']);
    await send('post', 'ticketpanels', s, { ...panel, name: 'q', categories: [{ label: 'Help', questions: ['1', '2', '3', '4', '5', '6'] }] }).expect(400);
    await send('post', 'ticketpanels', s, { ...panel, name: 'r', categories: [{ label: 'Help', questions: ['x'.repeat(46)] }] }).expect(400);
  });

  it('gives real numbers on the overview', async () => {
    const s = await login();
    await SecurityEvent.insertMany([{ guildId: G1, type: 'anti_raid', severity: 'critical', summary: 'blocked' }, { guildId: G1, type: 'anti_raid', severity: 'critical', summary: 'only logged', monitorOnly: true }, { guildId: G1, type: 'x', severity: 'warning', summary: 'minor' }] as never);
    const { stats } = (await get('overview', s).expect(200)).body;
    expect(stats.attacksBlocked).toBe(1);
    expect(stats).toMatchObject({ activeModules: 0, totalModules: 8, totalTickets: 0 });
    const notes = (await get('notifications', s).expect(200)).body;
    expect(notes.events).toHaveLength(3);
    expect(notes.pendingFlags).toBe(0);
  });

  it('keeps staff records and settings to the owner and trusted admins', async () => {
    const s = await login();
    access = { canManage: true, isOwner: false, isTrusted: false };
    await get('staff/records', s).expect(400);
    await send('post', 'staff/records', s, { userId: USER, type: 'note', reason: 'x' }).expect(400);
    await send('put', 'staff/records/abc', s, { userId: USER, type: 'note', reason: 'x' }).expect(400);
    await send('delete', 'staff/records/abc', s).expect(400);
    await send('put', 'config/staff', s, { activeWithinDays: 3 }).expect(400);
    expect(await StaffRecord.countDocuments()).toBe(0);
  });

  it('needs Manage Server for every staff page', async () => {
    for (const path of ['staff', 'staff/tickets', 'staff/moderation', 'staff/heatmap', 'staff/goals', 'staff/records', `staff/${USER}`]) await request(makeApp()).get(`${base}/${path}`).expect(401);
    const s = await login();
    access = { canManage: false, isOwner: false, isTrusted: false };
    for (const path of ['staff', 'staff/tickets', 'staff/moderation', 'staff/heatmap', 'staff/goals', `staff/${USER}`]) await get(path, s).expect(403);
  });

  it('keeps an audit trail of every staff record change', async () => {
    const s = await login();
    await send('post', 'staff/records', s, { userId: USER, type: 'warning', reason: '' }).expect(400);
    await send('post', 'staff/records', s, { userId: USER, type: 'hacked', reason: 'x' }).expect(400);
    const made = (await send('post', 'staff/records', s, { userId: USER, type: 'warning', reason: 'Late to shift' }).expect(201)).body;
    expect(made).toMatchObject({ type: 'warning', adminId: USER, reason: 'Late to shift' });
    await send('put', `staff/records/${made._id}`, s, { userId: USER, type: 'note', reason: 'Changed' }).expect(200);
    await send('delete', `staff/records/${made._id}`, s).expect(200);
    const { records, log } = (await get('staff/records', s).expect(200)).body;
    expect(records).toEqual([]);
    expect(log.map((l: { action: string }) => l.action).sort()).toEqual(['created', 'edited', 'removed']);
    expect(log.find((l: { action: string }) => l.action === 'removed').before.reason).toBe('Changed');
  });

  it('cannot change a staff record from another server', async () => {
    const s = await login();
    const other = await StaffRecord.create({ guildId: G2, userId: USER, userName: 'x', type: 'note', adminName: 'y', reason: 'theirs', date: new Date() });
    await send('put', `staff/records/${other._id}`, s, { userId: USER, type: 'note', reason: 'hacked' }).expect(400);
    await send('delete', `staff/records/${other._id}`, s).expect(400);
    expect((await StaffRecord.findOne({ _id: other._id }))?.reason).toBe('theirs');
  });

  it('serves totals, a profile, goals and a comparison from real records', async () => {
    const s = await login();
    await Case.insertMany([{ guildId: G1, number: 1, type: 'warn', targetId: '1', targetTag: 'a', moderatorId: USER, moderatorTag: 'Mod', reason: 'Spam' }] as never);
    const { totals, staff } = (await get('staff?days=7', s).expect(200)).body;
    expect(totals).toMatchObject({ staff: 1, active: 1, inactive: 0, moderation: 1, actionsToday: 1 });
    expect(staff[0]).toMatchObject({ userId: USER, cases: 1, status: 'active' });
    const profile = (await get(`staff/${USER}`, s).expect(200)).body;
    expect(profile.row.userId).toBe(USER);
    expect(profile.trend).toHaveLength(8);
    expect(profile.moderation[0]).toMatchObject({ caseId: 1, type: 'warn', reason: 'Spam', status: 'Active' });
    expect((await get('staff/goals', s).expect(200)).body.staff[0].weekly).toHaveLength(5);
    expect((await get(`staff/compare?ids=${USER}`, s).expect(200)).body.staff[0].trend).toHaveLength(8);
    await get('staff/compare', s).expect(400);
    await get('staff/notanid', s).expect(400);
    await get('staff?from=2030-02-01&to=2030-01-01', s).expect(400);
  });

  it('shows the demo marker only in demo mode', async () => {
    expect((await request(makeApp()).get('/api/public').expect(200)).body.demo).toBeUndefined();
  });
});
