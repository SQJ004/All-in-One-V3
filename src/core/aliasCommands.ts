import { ApplicationCommandOptionType as T, MessageFlags, type Attachment, type BaseMessageOptions, type GuildMember, type Interaction, type Message } from 'discord.js';
import { failEmbed } from '../ui/theme.js';
import { getConfig } from './configService.js';
import { describeError, type InteractionRouter } from './interactions.js';
import { logger } from './logger.js';
import { applyAutoDelete, hasTextCommand, matchPrefix } from './textCommands.js';
import { UserError } from './types.js';

/**
 * Lets a server's typed aliases run commands that were built for slash use. The message becomes a
 * stand-in for a slash interaction and goes through the real router, so every permission check,
 * cooldown and dashboard rule applies exactly as it does for a slash command.
 */
interface OptionDefinition {
  type: number; name: string; required?: boolean; options?: OptionDefinition[]; choices?: Array<{ name: string; value: string | number }>;
  min_value?: number; max_value?: number; min_length?: number; max_length?: number; channel_types?: number[];
}

/** Replies that slash commands would show only to the person who asked. A channel has no such thing. */
const PRIVATE_REPLY_LIFETIME_MS = 30_000;

interface Token { text: string; start: number; end: number }

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(/(?:[\w-]+:)?"[^"]*"|\S+/g)) tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return tokens;
}

const unquote = (text: string): string => (text.length > 1 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text);
const idFrom = (text: string, pattern: RegExp): string | null => pattern.exec(text)?.[1] ?? null;

function usage(alias: string, path: string[], options: OptionDefinition[]): string {
  const parts = options.map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`));
  return `Use it like this: \`${[alias, ...path, ...parts].join(' ')}\``;
}

async function readValue(message: Message<true>, option: OptionDefinition, raw: string): Promise<unknown> {
  const text = unquote(raw);
  const { guild } = message;
  const fail = (what: string): never => { throw new UserError(`**${option.name}** must be ${what}.`); };
  if (option.choices?.length) {
    const lower = text.toLowerCase();
    const choice = option.choices.find((c) => String(c.value).toLowerCase() === lower || c.name.toLowerCase() === lower);
    return choice ? choice.value : fail(`one of: ${option.choices.map((c) => c.value).join(', ')}`);
  }
  switch (option.type) {
    case T.String:
      if (option.min_length && text.length < option.min_length) fail(`at least ${option.min_length} characters`);
      if (option.max_length && text.length > option.max_length) fail(`at most ${option.max_length} characters`);
      return text;
    case T.Integer:
    case T.Number: {
      const value = Number(text);
      if (text === '' || !Number.isFinite(value) || (option.type === T.Integer && !Number.isInteger(value))) fail(option.type === T.Integer ? 'a whole number' : 'a number');
      if ((option.min_value !== undefined && value < option.min_value) || (option.max_value !== undefined && value > option.max_value)) fail(`from ${option.min_value ?? 'any'} to ${option.max_value ?? 'any'}`);
      return value;
    }
    case T.Boolean: {
      const lower = text.toLowerCase();
      if (['true', 'yes', 'on'].includes(lower)) return true;
      if (['false', 'no', 'off'].includes(lower)) return false;
      return fail('true or false');
    }
    case T.User:
    case T.Mentionable: {
      const id = idFrom(text, /^(?:<@!?)?(\d{17,20})>?$/);
      if (option.type === T.Mentionable) {
        const roleId = idFrom(text, /^<@&(\d{17,20})>$/);
        const role = roleId ? guild.roles.cache.get(roleId) : null;
        if (role) return role;
      }
      if (!id) return fail('a mention or a user ID');
      const user = await guild.client.users.fetch(id).catch(() => null);
      return user ?? fail('a user I can find');
    }
    case T.Channel: {
      const id = idFrom(text, /^(?:<#)?(\d{17,20})>?$/);
      const name = text.replace(/^#/, '').toLowerCase();
      const channel = id ? guild.channels.cache.get(id) : guild.channels.cache.find((c) => c.name.toLowerCase() === name);
      if (!channel) return fail('a channel in this server');
      if (option.channel_types?.length && !option.channel_types.includes(channel!.type)) fail('a different kind of channel');
      return channel;
    }
    case T.Role: {
      const id = idFrom(text, /^(?:<@&)?(\d{17,20})>?$/);
      const name = text.replace(/^@/, '').toLowerCase();
      const role = id ? guild.roles.cache.get(id) : guild.roles.cache.find((r) => r.name.toLowerCase() === name);
      return role ?? fail('a role in this server');
    }
    default:
      return fail('something else');
  }
}

/** Fills in a command's options from what was typed: in order, or as name:value. */
export async function parseArguments(message: Message<true>, alias: string, definition: OptionDefinition[], text: string): Promise<{ group: string | null; sub: string | null; values: Map<string, unknown>; attachment: Attachment | null }> {
  let tokens = tokenize(text);
  let options = definition;
  let group: string | null = null;
  let sub: string | null = null;
  const path: string[] = [];
  const pick = (kinds: number[]) => {
    const choices = options.filter((o) => kinds.includes(o.type));
    const found = choices.find((o) => o.name === tokens[0]?.text.toLowerCase());
    if (!found) throw new UserError(`Choose one: ${choices.map((o) => `\`${[alias, ...path, o.name].join(' ')}\``).join(' ')}`.slice(0, 1800));
    tokens = tokens.slice(1);
    path.push(found.name);
    options = found.options ?? [];
    return found;
  };
  if (options.some((o) => o.type === T.Subcommand || o.type === T.SubcommandGroup)) {
    const first = pick([T.Subcommand, T.SubcommandGroup]);
    if (first.type === T.SubcommandGroup) {
      group = first.name;
      sub = pick([T.Subcommand]).name;
    } else {
      sub = first.name;
    }
  }

  const values = new Map<string, unknown>();
  const attachment = options.find((o) => o.type === T.Attachment) ? (message.attachments?.first?.() ?? null) : null;
  const fields = options.filter((o) => o.type !== T.Attachment);
  const open = () => fields.filter((o) => !values.has(o.name));
  let lastNamedText: string | null = null;
  for (let n = 0; n < tokens.length; n++) {
    const token = tokens[n]!;
    const named = /^([\w-]+):(.*)$/s.exec(token.text);
    const target = named ? fields.find((o) => o.name === named[1]!.toLowerCase()) : undefined;
    if (target) {
      values.set(target.name, await readValue(message, target, named![2]!));
      lastNamedText = target.type === T.String && !target.choices?.length ? target.name : null;
      continue;
    }
    if (lastNamedText) {
      // reason:hello there reads naturally, so the following words belong to it.
      values.set(lastNamedText, `${String(values.get(lastNamedText))} ${unquote(token.text)}`);
      continue;
    }
    const next = open()[0];
    if (!next) throw new UserError(usage(alias, path, options));
    // The final text option takes the rest of the message, so quotes are rarely needed.
    const takesRest = next.type === T.String && !next.choices?.length && open().length === 1;
    if (takesRest) {
      values.set(next.name, await readValue(message, next, text.slice(token.start).trim()));
      break;
    }
    values.set(next.name, await readValue(message, next, token.text));
  }
  for (const o of options) {
    const has = o.type === T.Attachment ? attachment : values.has(o.name);
    if (o.required && !has) throw new UserError(usage(alias, path, options));
  }
  return { group, sub, values, attachment };
}

const isPrivate = (options: { flags?: unknown; ephemeral?: boolean }): boolean => Boolean(options.ephemeral) || (Number(options.flags ?? 0) & Number(MessageFlags.Ephemeral)) !== 0;

function standIn(message: Message<true>, member: GuildMember, commandName: string, parsed: Awaited<ReturnType<typeof parseArguments>>) {
  let first: Message | undefined;
  let deferredPrivate = false;
  const channel = message.channel;
  const post = async (raw: any, makePrivate = false): Promise<Message> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const { flags: _flags, ephemeral: _ephemeral, fetchReply: _fetch, withResponse: _with, ...rest } = typeof raw === 'string' ? { content: raw } as any : raw; // eslint-disable-line @typescript-eslint/no-explicit-any
    const sent = await message.reply({ ...rest, allowedMentions: { parse: [], ...rest.allowedMentions, repliedUser: false } } as BaseMessageOptions);
    if (makePrivate && sent) setTimeout(() => void sent.delete().catch(() => undefined), PRIVATE_REPLY_LIFETIME_MS).unref();
    return sent;
  };
  const { values, sub, group, attachment } = parsed;
  const read = (name: string) => (values.has(name) ? values.get(name) : null);
  const i = {
    id: message.id, commandName, commandGuildId: message.guild.id, guild: message.guild, guildId: message.guild.id, member, user: message.author, client: message.client,
    channel, channelId: message.channelId, createdTimestamp: message.createdTimestamp, deferred: false, replied: false,
    inCachedGuild: () => true, inGuild: () => true, isAutocomplete: () => false, isChatInputCommand: () => true, isButton: () => false, isAnySelectMenu: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false, isRepliable: () => true,
    options: {
      getSubcommand: () => sub, getSubcommandGroup: () => group,
      getString: read, getInteger: read, getNumber: read, getBoolean: read, getUser: read, getChannel: read, getRole: read, getMentionable: read,
      getAttachment: () => attachment,
      getMember: (name: string) => {
        const user = read(name) as { id: string } | null;
        return user ? message.guild.members.cache.get(user.id) ?? null : null;
      },
    },
    async deferReply(options: { flags?: unknown; ephemeral?: boolean } = {}) {
      deferredPrivate = isPrivate(options);
      i.deferred = true;
      await channel.sendTyping().catch(() => undefined);
    },
    async reply(options: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      i.replied = true;
      first = await post(options, isPrivate(typeof options === 'string' ? {} : options));
      return first;
    },
    async editReply(options: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      i.replied = true;
      if (first) return first.edit(options);
      first = await post(options, deferredPrivate);
      return first;
    },
    async followUp(options: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      // The first follow-up after a defer takes that reply's place, as it does for a slash command.
      i.replied = true;
      const sent = await post(options, isPrivate(typeof options === 'string' ? {} : options) || (!first && deferredPrivate));
      first ??= sent;
      return sent;
    },
    async deleteReply() { await first?.delete(); },
    fetchReply: async () => first,
    showModal: async () => { throw new UserError(`This part of **/${commandName}** opens a form, and forms only work from the slash command. Please use **/${commandName}**.`); },
  };
  return { interaction: i as unknown as Interaction, reply: () => first };
}

/** Builds the listener for aliases on commands that have no v! version of their own. */
export function aliasListener(router: InteractionRouter): (message: Message) => Promise<void> {
  return async (message) => {
    if (!message.inGuild() || message.author.bot || message.webhookId) return;
    const content = message.content.trim();
    if (!content) return;
    const firstWord = content.split(/\s+/, 1)[0]!;
    const whole = firstWord.toLowerCase();
    const { rules, prefixes } = (await getConfig(message.guild.id)).commands;
    const usedPrefix = matchPrefix(content, prefixes) ?? '';
    const afterPrefix = usedPrefix ? (content.slice(usedPrefix.length).trim().split(/\s+/, 1)[0] ?? '').toLowerCase() : '';
    const runs = (name: string) => router.commands.has(name) && !hasTextCommand(name);
    const exact = Object.keys(rules).find((name) => runs(name) && rules[name]!.aliases.includes(whole));
    const prefixed = !exact && afterPrefix ? Object.keys(rules).find((name) => runs(name) && rules[name]!.aliases.includes(afterPrefix)) : undefined;
    const name = exact ?? prefixed;
    if (!name) return;
    const typedAlias = exact ? firstWord : `${usedPrefix}${afterPrefix}`;
    const rest = exact ? content.slice(firstWord.length) : content.slice(usedPrefix.length).trim().slice(afterPrefix.length);
    try {
      const command = router.commands.get(name)!;
      const member = message.member ?? await message.guild.members.fetch(message.author.id);
      // Discord enforces this itself for slash commands, so it has to be checked here.
      const defaults = (command.data as { default_member_permissions?: string | null }).default_member_permissions;
      if (defaults && message.guild.ownerId !== member.id && !member.permissions.has(BigInt(defaults))) throw new UserError(`You don't have permission to use **/${name}**.`);
      const parsed = await parseArguments(message, typedAlias, command.data.options as OptionDefinition[] ?? [], rest.trim());
      const { interaction, reply } = standIn(message, member, name, parsed);
      await router.handle(interaction);
      await applyAutoDelete(message, name, reply());
    } catch (err) {
      const text = describeError(err);
      if (text === null) logger.error({ err, command: name }, 'Alias command failed');
      await message.reply({ allowedMentions: { parse: [], repliedUser: false }, embeds: [failEmbed(text ?? 'Something went wrong on my side. The error has been logged.')] }).catch(() => undefined);
    }
  };
}
