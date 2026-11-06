import { ChannelType, SlashCommandBuilder, type BaseMessageOptions, type Guild, type GuildMember, type GuildTextBasedChannel, type Message } from 'discord.js';
import { failEmbed, warnEmbed } from '../ui/theme.js';
import { commandBlockReason, commandRule } from './commandRules.js';
import { getConfig } from './configService.js';
import { describeError } from './interactions.js';
import { logger } from './logger.js';
import { Cooldown } from './rateLimit.js';
import { UserError, type SlashCommand } from './types.js';
import { formatDuration } from './util.js';

export const PREFIX = 'v!';

/** The longest match wins, so v!! is not mistaken for v!. */
export const matchPrefix = (content: string, prefixes: string[]): string | undefined => {
  const lower = content.toLowerCase();
  return [...prefixes].sort((a, b) => b.length - a.length).find((p) => lower.startsWith(p));
};

/** Where a command came from. Slash commands and v! commands run the same code through this. */
export interface CommandContext {
  guild: Guild;
  member: GuildMember;
  channel: GuildTextBasedChannel | null;
  userId: string;
  /** Slow work is about to start, so tell Discord or show typing. */
  working(): Promise<unknown>;
}

export interface CommandOption {
  name: string;
  description: string;
  kind: 'string' | 'integer' | 'user' | 'channel';
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  /** How it appears in v! usage, such as <song> or [user]. */
  shown: string;
}

/** A command that works as both /name and v!name. */
export interface DualCommand {
  name: string;
  description: string;
  aliases?: string[];
  cooldownSec?: number;
  option?: CommandOption;
  run(ctx: CommandContext, arg: string | null): Promise<BaseMessageOptions> | BaseMessageOptions;
}

const registered = new Map<string, DualCommand>();
const cooldowns = new Cooldown();
const REPLY_LIFETIME_MS = 5000;
const MAX_REMEMBERED_REPLIES = 2000;
/** Which reply belongs to which v! message, for deleting them together. */
const repliesByMessage = new Map<string, Message>();

/** Does nothing for messages the bot did not reply to. */
export async function deleteReplyToMessage(messageId: string): Promise<void> {
  const reply = repliesByMessage.get(messageId);
  repliesByMessage.delete(messageId);
  await reply?.delete().catch(() => undefined);
}

/** Applies a server's auto-delete settings once a typed command has answered. */
export async function applyAutoDelete(message: Message, name: string, reply: Message | undefined): Promise<void> {
  const rule = await commandRule(message.guild!.id, name);
  if (!rule) return;
  if (reply && rule.deleteWithMessage) {
    repliesByMessage.set(message.id, reply);
    if (repliesByMessage.size > MAX_REMEMBERED_REPLIES) repliesByMessage.delete(repliesByMessage.keys().next().value!);
  }
  if (reply && rule.deleteReplyAfter5s) setTimeout(() => void reply.delete().catch(() => undefined), REPLY_LIFETIME_MS).unref();
  // Missing Manage Messages should not make a working command look broken.
  if (rule.deleteInvocation) await message.delete().catch(() => undefined);
}

export const hasTextCommand = (name: string): boolean => registered.has(name);
/** Which command already owns a v! word, so a server's alias cannot take it from another command. */
export const builtInOwner = (word: string): string | undefined => [...registered.values()].find((def) => def.name === word || def.aliases?.includes(word))?.name;

export function toSlashCommand(def: DualCommand): SlashCommand {
  const data = new SlashCommandBuilder().setName(def.name).setDescription(def.description).setDMPermission(false);
  const { option } = def;
  if (option?.kind === 'string') {
    data.addStringOption((o) => { o.setName(option.name).setDescription(option.description).setRequired(Boolean(option.required)); if (option.maxLength) o.setMaxLength(option.maxLength); return o; });
  } else if (option?.kind === 'integer') {
    data.addIntegerOption((o) => { o.setName(option.name).setDescription(option.description).setRequired(Boolean(option.required)); if (option.min !== undefined) o.setMinValue(option.min); if (option.max !== undefined) o.setMaxValue(option.max); return o; });
  } else if (option?.kind === 'user') {
    data.addUserOption((o) => o.setName(option.name).setDescription(option.description).setRequired(Boolean(option.required)));
  } else if (option?.kind === 'channel') {
    data.addChannelOption((o) => o.setName(option.name).setDescription(option.description).setRequired(Boolean(option.required)).addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice));
  }
  return {
    cooldownSec: def.cooldownSec,
    data: data.toJSON(),
    async execute(i) {
      let raw: unknown = null;
      if (option?.kind === 'integer') raw = i.options.getInteger(option.name);
      else if (option?.kind === 'string') raw = i.options.getString(option.name);
      else if (option?.kind === 'user') raw = i.options.getUser(option.name)?.id;
      else if (option?.kind === 'channel') raw = i.options.getChannel(option.name)?.id;
      const ctx: CommandContext = { guild: i.guild, member: i.member, channel: i.channel, userId: i.user.id, working: () => i.deferReply() };
      const payload = await def.run(ctx, raw === null || raw === undefined ? null : String(raw));
      await (i.deferred ? i.editReply(payload) : i.reply(payload));
    },
  };
}

/** How to type a command with the text prefix, for the website and for mistakes. */
export function prefixUsage(name: string): string | null {
  const def = registered.get(name);
  return def ? [`${PREFIX}${def.name}`, def.option?.shown].filter(Boolean).join(' ') : null;
}

export const prefixAliases = (name: string): string[] => (registered.get(name)?.aliases ?? []).map((a) => `${PREFIX}${a}`);

/** Builds the listener that runs v! commands, with the same rules and messages as slash commands. */
export function textCommandListener(defs: DualCommand[]): (message: Message) => Promise<void> {
  for (const def of defs) registered.set(def.name, def);
  const byName = new Map(defs.flatMap((def) => [def.name, ...(def.aliases ?? [])].map((name) => [name, def] as const)));
  return async (message) => {
    if (!message.inGuild() || message.author.bot || message.webhookId) return;
    const content = message.content.trim();
    if (!content) return;
    const { commands: settings } = await getConfig(message.guild.id);
    const usedPrefix = matchPrefix(content, settings.prefixes);
    const hasPrefix = usedPrefix !== undefined;
    const body = hasPrefix ? content.slice(usedPrefix.length).trim() : content;
    const word = body.split(/\s+/, 1)[0]!;
    const typed = word.toLowerCase();
    let def = hasPrefix ? byName.get(typed) : undefined;
    let rest = body.slice(word.length);
    if (!def) {
      // Server aliases work exactly as typed, whatever prefix they use. "pic" also answers to v!pic.
      const firstWord = content.split(/\s+/, 1)[0]!;
      const whole = firstWord.toLowerCase();
      const { rules } = settings;
      const owner = Object.keys(rules).find((name) => byName.has(name) && (rules[name]!.aliases.includes(whole) || (hasPrefix && Boolean(typed) && rules[name]!.aliases.includes(typed))));
      def = owner ? byName.get(owner) : undefined;
      if (def && rules[owner!]!.aliases.includes(whole)) rest = content.slice(firstWord.length);
    }
    if (!def) return; // not one of these commands, so stay out of the conversation
    const { name } = def;
    const respond = (payload: BaseMessageOptions) => message.reply({ allowedMentions: { parse: [], repliedUser: false }, ...payload });
    const tidyUp = (reply: Message | undefined) => applyAutoDelete(message, name, reply);
    let allowed = false;
    try {
      const left = cooldowns.allow(`${message.author.id}:${def.name}`, (def.cooldownSec ?? 2) * 1000);
      if (left > 0) {
        await respond({ embeds: [warnEmbed(`Please wait **${formatDuration(left + 999)}** before using this again.`)] });
        return;
      }
      const member = message.member ?? await message.guild.members.fetch(message.author.id);
      const channel = message.channel;
      const blocked = await commandBlockReason(message.guild.id, def.name, member, channel);
      if (blocked) throw new UserError(blocked);
      allowed = true;
      const arg = rest.trim() || null;
      if (def.option?.required && !arg) throw new UserError(`Use it like this: \`${(prefixUsage(def.name) ?? '').replace(PREFIX, usedPrefix ?? PREFIX)}\``);
      const payload = await def.run({ guild: message.guild, member, channel, userId: message.author.id, working: () => channel.sendTyping().catch(() => undefined) }, arg);
      await tidyUp(await respond(payload));
    } catch (err) {
      const text = describeError(err);
      if (text === null) logger.error({ err, command: def.name }, 'Text command failed');
      const reply = await respond({ embeds: [failEmbed(text ?? 'Something went wrong on my side. The error has been logged.')] });
      if (allowed) await tidyUp(reply);
    }
  };
}
