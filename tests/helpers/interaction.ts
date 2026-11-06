import { ChannelType } from 'discord.js';
import { vi } from 'vitest';
import { fakeGuild, fakeMember } from './fakes.js';

/** Turns builders into the raw JSON discord.js would send, which runs its validators. */
export const serialize = (payload: any): any => JSON.parse(JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v && typeof v.toJSON === 'function' ? v.toJSON() : v)));

export function setupGuild() {
  const guild = fakeGuild();
  Object.assign(guild, { iconURL: () => null, createdAt: new Date('2020-01-01'), premiumTier: 0, premiumSubscriptionCount: 2, available: true });
  guild.client.ws = { ping: 12 };
  guild.client.uptime = 90_000;
  guild.client.application = { id: '500000000000000001' };
  return guild;
}

export function commandInteraction(guild: any, command: string, sub: string | null, options: Record<string, unknown> = {}, opts: { group?: string; member?: any } = {}) {
  const member = opts.member ?? guild.members.cache.get(guild.ownerId);
  const get = (name: string) => options[name] ?? null;
  const i: any = {
    id: String(Math.floor(Math.random() * 1e12)), commandName: command, guild, guildId: guild.id, member, user: { ...member.user, toString: () => `<@${member.id}>` }, client: guild.client, channelId: '600000000000000001',
    channel: guild.channels.cache.get('600000000000000001') ?? null, deferred: false, replied: false,
    inCachedGuild: () => true, isChatInputCommand: () => true, isAutocomplete: () => false, isRepliable: () => true,
    options: {
      getSubcommand: () => sub, getSubcommandGroup: () => opts.group ?? null,
      getString: get, getInteger: get, getNumber: get, getBoolean: get, getUser: get, getMember: (name: string) => { const v: any = options[name]; return v ? (v.roles ? v : guild.members.cache.get(v.id) ?? null) : guild.members.cache.get((options.user as any)?.id) ?? null; }, getChannel: get, getRole: get, getMentionable: get, getAttachment: get,
    },
    reply: vi.fn(async function (this: any) { i.replied = true; }), followUp: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined),
    deferReply: vi.fn(async () => { i.deferred = true; }), showModal: vi.fn(async () => { i.replied = true; }),
  };
  return i;
}

/** What a button, select or modal interaction looks like to a component handler. */
export function componentInteraction(guild: any, kind: 'button' | 'select' | 'modal', customId: string, data: { values?: string[]; fields?: Record<string, string>; member?: any } = {}) {
  const member = data.member ?? guild.members.cache.get(guild.ownerId);
  const i: any = {
    customId, guild, guildId: guild.id, member, user: member.user, client: guild.client, channelId: '600000000000000001', channel: guild.channels.cache.get('600000000000000001'), deferred: false, replied: false,
    values: data.values ?? [],
    inCachedGuild: () => true, isButton: () => kind === 'button', isStringSelectMenu: () => kind === 'select', isAnySelectMenu: () => kind === 'select', isModalSubmit: () => kind === 'modal', isFromMessage: () => kind === 'modal', isRepliable: () => true,
    fields: { getTextInputValue: (id: string) => data.fields?.[id] ?? '' },
    reply: vi.fn(async () => { i.replied = true; }), update: vi.fn(async () => { i.replied = true; }), followUp: vi.fn(async () => undefined), showModal: vi.fn(async () => { i.replied = true; }), deferReply: vi.fn(async () => { i.deferred = true; }), deferUpdate: vi.fn(async () => { i.deferred = true; }), editReply: vi.fn(async () => undefined),
  };
  return i;
}

export { ChannelType, fakeMember };
