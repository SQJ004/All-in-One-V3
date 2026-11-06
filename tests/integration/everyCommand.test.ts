import { ApplicationCommandOptionType as T, ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InteractionRouter } from '../../src/core/interactions.js';
import { logger } from '../../src/core/logger.js';
import { MODULES } from '../../src/core/registry.js';
import { useDatabase } from '../helpers/db.js';
import { fakeChannel, fakeMember, fakeRole } from '../helpers/fakes.js';
import { commandInteraction, serialize, setupGuild } from '../helpers/interaction.js';

/**
 * Runs every subcommand, using its real Discord definition, through the real router.
 * Discord itself is faked, so this proves a command responds and handles bad input.
 * It does not prove Discord accepted the result: see docs/COMMAND_CHECKLIST.md.
 */
useDatabase();

const CHANNEL = '600000000000000001';
const router = new InteractionRouter(MODULES);
let actorSeq = 0;

interface Case { label: string; command: string; group?: string; sub: string | null; options: any[]; perms?: bigint[]; botPerms?: bigint[] }

const cases: Case[] = MODULES.flatMap((m) => m.commands ?? []).flatMap((c) => {
  const top = (c.data.options ?? []) as any[];
  const perm = (key: string) => c.perms?.[key] ?? c.perms?.['*'];
  const bot = (key: string) => c.botPerms?.[key] ?? c.botPerms?.['*'];
  const subs = top.filter((o) => o.type === T.Subcommand);
  const groups = top.filter((o) => o.type === T.SubcommandGroup);
  if (!subs.length && !groups.length) return [{ label: `/${c.data.name}`, command: c.data.name, sub: null, options: top, perms: perm(''), botPerms: bot('') }];
  return [
    ...subs.map((s) => ({ label: `/${c.data.name} ${s.name}`, command: c.data.name, sub: s.name, options: s.options ?? [], perms: perm(s.name), botPerms: bot(s.name) })),
    ...groups.flatMap((g) => g.options.map((s: any) => ({ label: `/${c.data.name} ${g.name} ${s.name}`, command: c.data.name, group: g.name, sub: s.name, options: s.options ?? [], perms: perm(`${g.name}.${s.name}`), botPerms: bot(`${g.name}.${s.name}`) }))),
  ];
});

function world() {
  const guild = setupGuild();
  const actorId = `70000000000${String(++actorSeq).padStart(7, '0')}`;
  guild.ownerId = actorId;
  const actor = fakeMember(guild, actorId, { position: 40, perms: [PermissionFlagsBits.Administrator] });
  const target = fakeMember(guild, '710000000000000001', { position: 1 });
  target.voice = { channelId: '600000000000000009', setMute: vi.fn(async () => undefined), setDeaf: vi.fn(async () => undefined) };
  target.isCommunicationDisabled = () => true;
  const role = fakeRole('720000000000000001', 3, { name: 'Safe', guild: { id: guild.id } });
  guild.roles.cache.set(role.id, role);
  guild.roles.cache.set(guild.id, guild.roles.everyone);
  const channel = fakeChannel(guild, CHANNEL);
  const posted: any = { id: '730000000000000001', channelId: CHANNEL, content: 'hi', url: 'https://discord.com/x', author: { id: guild.client.user.id, bot: true }, embeds: [], edit: vi.fn(async () => posted), delete: vi.fn(async () => undefined), react: vi.fn(async () => undefined), pinned: false };
  channel.send = vi.fn(async () => posted);
  channel.messages = { fetch: vi.fn(async (arg: unknown) => (typeof arg === 'string' ? posted : new Collection([[posted.id, posted]]))), delete: vi.fn(async () => undefined) };
  channel.bulkDelete = vi.fn(async (list: unknown[]) => ({ size: list.length }));
  channel.setRateLimitPerUser = vi.fn(async () => undefined);
  channel.setName = vi.fn(async () => undefined);
  channel.permissionOverwrites.edit = vi.fn(async () => undefined);
  guild.client.users.fetch = vi.fn(async () => target.user);
  guild.invites = { fetch: vi.fn(async () => new Collection()) };
  guild.bans.fetch = vi.fn(async () => ({ user: target.user }));
  guild.roles.create = vi.fn(async () => role);
  return { guild, actor, target, role, channel, posted };
}

function value(o: any, w: ReturnType<typeof world>, mode: 'valid' | 'garbage' | 'ghost'): unknown {
  if (o.choices?.length) return o.choices[0].value;
  switch (o.type) {
    case T.String: {
      if (mode === 'garbage') return 'not valid!! ‮ <@&1> {{}} $where';
      const byName: Record<string, string> = {
        duration: '1h', in: '2h', temporary: '1d', cron: '0 9 * * 1', timezone: 'UTC', message_link: `https://discord.com/channels/${w.guild.id}/${CHANNEL}/${w.posted.id}`,
        users: w.target.id, user_id: w.target.id, color: '#8b5cf6', accent: '#7c3aed', image: 'https://example.com/a.png', thumbnail: 'https://example.com/t.png', footer_icon: 'https://example.com/f.png', author_icon: 'https://example.com/i.png', url: 'https://example.com', background: 'zytheron',
        options: 'A | B | C', domain: 'example.com', emoji: '🔥', message_id: w.posted.id, name: 'sample', new_name: 'sample-copy', template: 'sample', keyword: 'hello',
      };
      return byName[o.name] ?? 'sample text';
    }
    case T.Integer: case T.Number: return o.min_value ?? 1;
    case T.Boolean: return false;
    case T.User: return w.target.user;
    case T.Channel: return mode === 'ghost' ? { id: '799999999999999999', name: 'deleted' } : w.channel;
    case T.Role: return w.role;
    case T.Mentionable: return { id: w.role.id };
    case T.Attachment: return { size: 20, url: 'https://cdn.discordapp.com/attachments/1/2/a.json', name: 'a.json' };
    default: return null;
  }
}

function optionsFor(c: Case, w: ReturnType<typeof world>, opts: { mode: 'valid' | 'garbage' | 'ghost'; onlyRequired?: boolean }) {
  return Object.fromEntries(c.options.filter((o) => o.required || !opts.onlyRequired).map((o) => [o.name, value(o, w, opts.mode)]));
}

const responded = (i: any) => i.reply.mock.calls.length + i.deferReply.mock.calls.length + i.showModal.mock.calls.length > 0;
const payloads = (i: any) => [...i.reply.mock.calls, ...i.followUp.mock.calls, ...i.editReply.mock.calls].map((call: any[]) => serialize(call[0]));
const text = (i: any) => JSON.stringify(payloads(i));

const errors: string[] = [];
beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ embeds: [{ title: 'Imported' }] }), { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.spyOn(logger, 'error').mockImplementation(((o: { err?: Error; command?: string }) => { errors.push(`${o.command}: ${o.err?.stack?.split('\n').slice(0, 3).join(' | ')}`); }) as never);
});
afterAll(() => vi.unstubAllGlobals());

async function run(c: Case, w: ReturnType<typeof world>, options: Record<string, unknown>, member = w.actor) {
  errors.length = 0;
  const i = commandInteraction(w.guild, c.command, c.sub, options, { group: c.group, member });
  i.channel = w.channel;
  await router.handle(i);
  return i;
}

function assertHandled(i: any): void {
  expect(responded(i), 'never responded to Discord').toBe(true);
  expect(errors, 'crashed unexpectedly').toEqual([]);
  expect(text(i)).not.toMatch(/went wrong on my side/);
}

describe.each(cases.map((c) => [c.label, c] as const))('%s', (_label, c) => {
  it('responds with only the required options', async () => {
    const w = world();
    assertHandled(await run(c, w, optionsFor(c, w, { mode: 'valid', onlyRequired: true })));
  });
  it('responds with every option filled in', async () => {
    const w = world();
    assertHandled(await run(c, w, optionsFor(c, w, { mode: 'valid' })));
  });
  it('handles invalid text without crashing', async () => {
    const w = world();
    assertHandled(await run(c, w, optionsFor(c, w, { mode: 'garbage' })));
  });
  it('handles a deleted channel without crashing', async () => {
    const w = world();
    assertHandled(await run(c, w, optionsFor(c, w, { mode: 'ghost' })));
  });
  if (c.perms?.length) {
    it('refuses someone without the required permission, before doing anything', async () => {
      const w = world();
      const pleb = fakeMember(w.guild, `75000000000${String(++actorSeq).padStart(7, '0')}`, { position: 1 });
      const i = await run(c, w, optionsFor(c, w, { mode: 'valid' }), pleb);
      expect(text(i)).toMatch(/You need/);
      expect(i.deferReply).not.toHaveBeenCalled();
      expect(i.showModal).not.toHaveBeenCalled();
      expect(w.channel.send).not.toHaveBeenCalled();
    });
  }
  if (c.botPerms?.length) {
    it('explains when the bot lacks a permission, before doing anything', async () => {
      const w = world();
      w.guild.members.me.permissions = new PermissionsBitField([]);
      const i = await run(c, w, optionsFor(c, w, { mode: 'valid' }));
      expect(text(i)).toMatch(/I am missing/);
      expect(w.channel.send).not.toHaveBeenCalled();
    });
  }
});

describe('coverage', () => {
  it('found the whole command list', () => {
    const top = new Set(cases.map((c) => c.command));
    expect(top.size).toBe(MODULES.flatMap((m) => m.commands ?? []).length);
    expect(cases.length).toBeGreaterThan(150);
    expect(ChannelType.GuildText).toBe(0);
  });
});
