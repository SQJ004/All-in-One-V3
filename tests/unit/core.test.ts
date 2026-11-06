import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { defaultGuildConfig, GuildConfigSchema, WelcomeTemplateSchema } from '../../src/config/guildConfig.js';
import { getEnv } from '../../src/config/env.js';
import { deepMerge } from '../../src/core/configService.js';
import { describeError, InteractionRouter } from '../../src/core/interactions.js';
import { hasDangerousPermissions, moderationBlock, roleAssignBlock } from '../../src/core/permissions.js';
import { Cooldown, SlidingWindow } from '../../src/core/rateLimit.js';
import { allCommandData, MODULES } from '../../src/core/registry.js';
import { isPrivateAddress, fetchPublicImage } from '../../src/core/safeFetch.js';
import { UserError } from '../../src/core/types.js';
import { chunk, extractIds, formatDuration, parseDuration, parseMessageLink, progressBar, truncate } from '../../src/core/util.js';
import { renderVars } from '../../src/core/variables.js';
import { fakeGuild, fakeMember, fakeRole, OWNER_ID } from '../helpers/fakes.js';

describe('durations', () => {
  it.each([['30m', 1_800_000], ['2h', 7_200_000], ['1d 2h', 93_600_000], ['1w', 604_800_000], ['45s', 45_000], ['2 hours', 7_200_000], ['90 minutes', 5_400_000], ['1 day', 86_400_000]])('parses %s', (t, ms) => expect(parseDuration(t)).toBe(ms));
  it.each(['', 'soon', '10', '5x', '1d and more', '0m'])('rejects "%s"', (t) => expect(parseDuration(t)).toBeNull());
  it('formats', () => {
    expect(formatDuration(93_600_000)).toBe('1d 2h');
    expect(formatDuration(500)).toBe('0s');
  });
});

describe('helpers', () => {
  it('extracts unique IDs from mixed input', () => expect(extractIds('<@123456789012345678>, 123456789012345678 234567890123456789 hello 12')).toEqual(['123456789012345678', '234567890123456789']));
  it('truncates and chunks', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });
  it('clamps progress bars', () => {
    expect(progressBar(2, 4)).toBe('████');
    expect(progressBar(-1, 4)).toBe('░░░░');
  });
  it('parses message links', () => {
    expect(parseMessageLink('https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333')?.messageId).toBe('333333333333333333');
    expect(parseMessageLink('nope')).toBeNull();
  });
  it('renders known variables once, leaving others untouched', () => {
    expect(renderVars('{user} {USER} {nope}', { user: 'x' })).toBe('x x {nope}');
    expect(renderVars('{a}', { a: '{b}', b: 'pwned' })).toBe('{b}');
  });
});

describe('rate limits', () => {
  it('sliding window counts inside the window', () => {
    const w = new SlidingWindow();
    w.hit('k', 1000, 0);
    w.hit('k', 1000, 500);
    expect(w.hit('k', 1000, 900)).toBe(3);
    expect(w.count('k', 1000, 1600)).toBe(1);
  });
  it('sliding window caps memory', () => {
    const w = new SlidingWindow(10);
    for (let n = 0; n < 100; n++) w.hit(`k${n}`, 1000, n);
    expect(w.count('k0', 1000, 100)).toBe(0);
    expect(w.count('k99', 1000, 100)).toBe(1);
  });
  it('cooldown reports time left', () => {
    const c = new Cooldown();
    expect(c.allow('k', 1000, 0)).toBe(0);
    expect(c.allow('k', 1000, 400)).toBe(600);
    expect(c.allow('k', 1000, 1000)).toBe(0);
  });
});

describe('guild config', () => {
  it('has safe defaults: security starts disabled and in monitor mode', () => {
    const c = defaultGuildConfig();
    expect(c.security.enabled).toBe(false);
    expect(c.security.mode).toBe('monitor');
    expect(c.security.antiNuke.limits.channelDelete.count).toBe(3);
    expect(c.welcome.templates[0]?.id).toBe('default');
  });
  it('rejects invalid values', () => {
    expect(() => GuildConfigSchema.parse({ security: { mode: 'yolo' } })).toThrow(ZodError);
    expect(() => GuildConfigSchema.parse({ security: { logChannelId: 'not-an-id' } })).toThrow(ZodError);
    expect(() => GuildConfigSchema.parse({ security: { antiRaid: { joinThreshold: 0 } } })).toThrow(ZodError);
    expect(() => WelcomeTemplateSchema.parse({ id: 'x', color: 'red' })).toThrow(ZodError);
  });
  it('merges deeply, replaces arrays, and drops prototype keys', () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { b: 9 }, l: [3] })).toEqual({ a: { b: 9, c: 2 }, l: [3] });
    const polluted = deepMerge({}, JSON.parse('{"__proto__":{"admin":true},"constructor":{"x":1}}')) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(polluted.admin).toBeUndefined();
    expect(Object.keys(polluted)).toEqual([]);
  });
});

describe('environment', () => {
  const base = { DISCORD_TOKEN: 'x'.repeat(40) };
  it('needs only a token, and leaves the website off', () => {
    const env = getEnv({ ...base });
    expect(env.DASHBOARD_ENABLED).toBe(false);
    expect(env.DATA_DIR).toBe('./data');
  });
  it('turns the website on when its login secret is set', () => expect(getEnv({ ...base, DISCORD_CLIENT_SECRET: 's' }).DASHBOARD_ENABLED).toBe(true));
  it('can force the website off', () => expect(getEnv({ ...base, DISCORD_CLIENT_SECRET: 's', DASHBOARD_ENABLED: 'false' }).DASHBOARD_ENABLED).toBe(false));
  it('explains a website forced on without a secret', () => expect(() => getEnv({ ...base, DASHBOARD_ENABLED: 'true' })).toThrow(/DISCORD_CLIENT_SECRET/));
  it('treats blank optional values as unset', () => expect(getEnv({ ...base, SESSION_SECRET: '', DISCORD_CLIENT_SECRET: '', DEV_GUILD_ID: '' }).DEV_GUILD_ID).toBeUndefined());
  it('rejects a short session secret', () => expect(() => getEnv({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/));
  it('lists problems readably', () => expect(() => getEnv({})).toThrow(/DISCORD_TOKEN/));
});

describe('permissions', () => {
  const setup = () => {
    const guild = fakeGuild();
    return { guild, me: guild.members.me, mod: fakeMember(guild, '11', { position: 10 }), low: fakeMember(guild, '12', { position: 5 }), peer: fakeMember(guild, '13', { position: 10 }), high: fakeMember(guild, '14', { position: 60 }), owner: guild.members.cache.get(OWNER_ID) };
  };
  it('enforces the moderation hierarchy', () => {
    const { mod, low, peer, high, owner, me } = setup();
    expect(moderationBlock(mod, low, me)).toBeNull();
    expect(moderationBlock(mod, mod, me)).toMatch(/yourself/);
    expect(moderationBlock(mod, me, me)).toMatch(/myself/);
    expect(moderationBlock(mod, peer, me)).toMatch(/higher role than you/);
    expect(moderationBlock(owner, high, me)).toMatch(/higher role than me/);
    expect(moderationBlock(mod, owner, me)).toMatch(/owner/);
    expect(moderationBlock(owner, low, me)).toBeNull();
  });
  it('blocks unsafe roles from being assigned', () => {
    const { me, mod, owner, guild } = setup();
    const g = { id: guild.id };
    expect(roleAssignBlock(fakeRole('21', 3, { guild: g }), me, mod)).toBeNull();
    expect(roleAssignBlock(fakeRole('22', 3, { managed: true, guild: g }), me)).toMatch(/integration/);
    expect(roleAssignBlock(fakeRole('23', 70, { guild: g }), me)).toMatch(/above my highest/);
    expect(roleAssignBlock(fakeRole('24', 20, { guild: g }), me, mod)).toMatch(/your highest/);
    expect(roleAssignBlock(fakeRole('25', 3, { perms: [PermissionFlagsBits.BanMembers], guild: g }), me)).toMatch(/moderator or admin/);
    expect(roleAssignBlock(fakeRole('25', 3, { perms: [PermissionFlagsBits.BanMembers], guild: g }), me, owner, { allowDangerous: true })).toBeNull();
    expect(roleAssignBlock(fakeRole(guild.id, 0, { guild: g }), me)).toMatch(/@everyone/);
  });
  it('recognises dangerous bits', () => {
    expect(hasDangerousPermissions(PermissionFlagsBits.Administrator)).toBe(true);
    expect(hasDangerousPermissions(PermissionFlagsBits.SendMessages | PermissionFlagsBits.ManageWebhooks)).toBe(true);
    expect(hasDangerousPermissions(PermissionFlagsBits.SendMessages)).toBe(false);
  });
});

describe('SSRF protection', () => {
  it.each(['127.0.0.1', '10.1.1.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])('treats %s as private', (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700::1111'])('treats %s as public', (ip) => expect(isPrivateAddress(ip)).toBe(false));
  it('refuses non-HTTPS and internal hosts before fetching', async () => {
    await expect(fetchPublicImage('http://example.com/a.png')).rejects.toThrow(/HTTPS/);
    await expect(fetchPublicImage('https://localhost/a.png')).rejects.toThrow(/not allowed/);
    await expect(fetchPublicImage('https://127.0.0.1/a.png')).rejects.toThrow(/not allowed/);
    await expect(fetchPublicImage('nonsense')).rejects.toThrow(/valid URL/);
  });
});

describe('command definitions meet Discord limits', () => {
  const commands = allCommandData();
  const NAME = /^[\p{Ll}\p{Lm}\p{Lo}\p{N}\p{sc=Devanagari}\p{sc=Thai}_-]{1,32}$/u;
  const walk = (options: any[] | undefined, path: string, cb: (o: any, path: string) => void) => {
    expect(options?.length ?? 0, `${path} has too many options`).toBeLessThanOrEqual(25);
    let seenOptional = false;
    for (const o of options ?? []) {
      cb(o, `${path} ${o.name}`);
      if (o.type > 2) {
        if (o.required && seenOptional) throw new Error(`${path}: required option ${o.name} follows an optional one`);
        if (!o.required) seenOptional = true;
      }
      if (o.type <= 2) walk(o.options, `${path} ${o.name}`, cb);
    }
  };
  it('stays under the global limit, with unique names', () => {
    expect(commands.length).toBeLessThanOrEqual(100);
    expect(new Set(commands.map((c) => c.name)).size).toBe(commands.length);
  });
  it.each(commands.map((c) => [c.name, c] as const))('/%s is valid', (_n, c) => {
    expect(c.name).toMatch(NAME);
    expect(c.description.length).toBeGreaterThan(0);
    expect(c.description.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(c).length).toBeLessThan(8000);
    walk(c.options as any[], c.name, (o, path) => {
      expect(o.name, path).toMatch(NAME);
      expect(o.description.length, path).toBeGreaterThan(0);
      expect(o.description.length, path).toBeLessThanOrEqual(100);
      expect(new Set((c.options as any[]).map((x) => x.name)).size).toBe((c.options as any[]).length);
      if (o.choices) expect(o.choices.length, path).toBeLessThanOrEqual(25);
    });
  });
  it('includes every command the spec names', () => {
    const shape = new Map(commands.map((c) => [c.name, (c.options ?? []).map((o: any) => o.name)]));
    const expected: Record<string, string[]> = { security: ['setup', 'config', 'whitelist', 'lockdown'], welcome: ['setup', 'test', 'preview'], embed: ['create', 'edit', 'delete', 'preview', 'list', 'duplicate', 'template'], moderation: ['ban', 'warn', 'history'], logs: ['setup'], autorole: ['setup'], ticket: ['setup'], level: ['setup'], giveaway: ['create'] };
    for (const [name, subs] of Object.entries(expected)) for (const s of subs) expect(shape.get(name), `/${name} ${s}`).toContain(s);
  });
  it('has a handler for every moderation subcommand', () => {
    const mod = MODULES.flatMap((m) => m.commands ?? []).find((c) => c.data.name === 'moderation')!;
    expect(Object.keys(mod.perms ?? {}).sort()).toEqual((mod.data.options ?? []).map((o: any) => o.name).sort());
  });
});

describe('interaction router', () => {
  const makeCommandInteraction = (over: Record<string, unknown> = {}) => {
    const guild = fakeGuild();
    const member = fakeMember(guild, '777', { position: 5, perms: [] });
    return {
      id: '1', commandName: 'moderation', user: { id: '777', tag: 'u' }, guild, member, guildId: guild.id, deferred: false, replied: false,
      isAutocomplete: () => false, isChatInputCommand: () => true, isRepliable: () => true, inCachedGuild: () => true,
      options: { getSubcommandGroup: () => null, getSubcommand: () => 'ban' }, reply: vi.fn(async () => undefined), followUp: vi.fn(async () => undefined), ...over,
    } as any;
  };
  const replyText = (i: any) => JSON.stringify(i.reply.mock.calls[0][0].embeds[0].toJSON());
  const command = (run = vi.fn(async () => undefined)) => ({ data: { name: 'moderation', description: 'x' }, perms: { ban: [PermissionFlagsBits.BanMembers] }, execute: run });

  it('refuses a user without the subcommand permission and never runs the handler', async () => {
    const run = vi.fn(async () => undefined);
    const i = makeCommandInteraction();
    await new InteractionRouter([{ name: 't', commands: [command(run)] }]).handle(i);
    expect(run).not.toHaveBeenCalled();
    expect(replyText(i)).toMatch(/BanMembers/);
  });
  it('runs for a user with permission and applies the cooldown', async () => {
    const run = vi.fn(async () => undefined);
    const router = new InteractionRouter([{ name: 't', commands: [command(run)] }]);
    const i = makeCommandInteraction({ user: { id: '888', tag: 'u' } });
    i.member.permissions.has = () => true;
    await router.handle(i);
    expect(run).toHaveBeenCalledTimes(1);
    const again = makeCommandInteraction({ user: { id: '888', tag: 'u' } });
    again.member.permissions.has = () => true;
    await router.handle(again);
    expect(run).toHaveBeenCalledTimes(1);
    expect(replyText(again)).toMatch(/wait/);
  });
  it('shows expected errors and hides unexpected ones', async () => {
    const user = makeCommandInteraction({ user: { id: '901', tag: 'u' } });
    user.member.permissions.has = () => true;
    await new InteractionRouter([{ name: 't', commands: [command(vi.fn(async () => { throw new UserError('Friendly message'); }))] }]).handle(user);
    expect(replyText(user)).toMatch(/Friendly message/);
    const crash = makeCommandInteraction({ user: { id: '902', tag: 'u' } });
    crash.member.permissions.has = () => true;
    await new InteractionRouter([{ name: 't', commands: [command(vi.fn(async () => { throw new Error('secret database detail'); }))] }]).handle(crash);
    expect(replyText(crash)).not.toMatch(/secret/);
    expect(replyText(crash)).toMatch(/went wrong/);
  });
  it('resolves component IDs by longest prefix', () => {
    const a = { prefix: 'x:y', run: vi.fn() };
    const b = { prefix: 'x:y:z', run: vi.fn() };
    const r = new InteractionRouter([{ name: 't', components: [a, b] }]);
    expect(r.resolveComponent('x:y:1')).toEqual({ handler: a, args: ['1'] });
    expect(r.resolveComponent('x:y:z:2')).toEqual({ handler: b, args: ['2'] });
    expect(r.resolveComponent('unknown')).toBeNull();
  });
  it('refuses duplicates at startup', () => {
    expect(() => new InteractionRouter([{ name: 'a', components: [{ prefix: 'p', run: vi.fn() }, { prefix: 'p', run: vi.fn() }] }])).toThrow(/Duplicate/);
  });
  it('wires all real modules without conflicts', () => {
    expect(new InteractionRouter(MODULES).commands.size).toBeGreaterThan(25);
  });
  it('maps zod and duplicate-key errors for users', () => {
    expect(describeError({ code: 'DUPLICATE' })).toMatch(/already exists/);
    expect(describeError(new Error('x'))).toBeNull();
  });
});
