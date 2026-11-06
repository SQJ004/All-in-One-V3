import { ApplicationCommandOptionType, DiscordAPIError, type ChatInputCommandInteraction, type Interaction, type RepliableInteraction } from 'discord.js';
import { ZodError } from 'zod';
import { replyFail, replyWarn } from '../ui/theme.js';
import { commandBlockReason, commandRule } from './commandRules.js';
import { logger } from './logger.js';
import { missingPerms } from './permissions.js';
import { Cooldown } from './rateLimit.js';
import { UserError, type ComponentHandler, type ComponentInteraction, type SlashCommand, type VortexModule } from './types.js';
import { formatDuration } from './util.js';

const REPLY_LIFETIME_MS = 5000;
const cooldowns = new Cooldown();
const componentThrottle = new Cooldown();

/** Where an old command's job lives now, for the commands left over on this application. */
const REPLACEMENTS: Record<string, string> = {
  embed: '/embed create', ban: '/moderation ban', unban: '/moderation unban', kick: '/moderation kick', softban: '/moderation ban', timeout: '/moderation timeout', untimeout: '/moderation untimeout',
  warn: '/moderation warn', warnings: '/moderation warnings', clear: '/moderation purge', purge: '/moderation purge', lock: '/moderation lock', unlock: '/moderation unlock', hide: '/moderation hide', unhide: '/moderation unhide',
  slowmode: '/moderation slowmode', nick: '/moderation nickname', modlogs: '/moderation history', rank: '/level rank', leaderboard: '/level leaderboard', xp: '/level set-xp', goodbye: '/welcome goodbye', customcommand: '/cc create',
  announce: '/schedule once', config: '/setup', serverinfo: '/serverstats view', membercount: '/serverstats view', suggestion: '/suggestions approve', role: '/temprole add',
};

export interface RouterOptions {
  /** Commands are registered in this server only, so a global command is never ours. */
  ownedGuildId?: string;
  /** Stay silent on commands ZYTHERON does not own, because another program answers them. */
  ignoreForeign?: boolean;
}

export class InteractionRouter {
  readonly commands = new Map<string, SlashCommand>();
  private readonly components = new Map<string, ComponentHandler>();

  constructor(modules: VortexModule[], private readonly options: RouterOptions = {}) {
    for (const mod of modules) {
      for (const c of mod.commands ?? []) {
        if (this.commands.has(c.data.name)) throw new Error(`Duplicate command: ${c.data.name}`);
        this.commands.set(c.data.name, c);
      }
      for (const h of mod.components ?? []) {
        if (this.components.has(h.prefix)) throw new Error(`Duplicate component prefix: ${h.prefix}`);
        this.components.set(h.prefix, h);
      }
    }
  }

  /** Longest-prefix match on ":"-separated segments. */
  resolveComponent(customId: string): { handler: ComponentHandler; args: string[] } | null {
    const parts = customId.split(':');
    for (let n = parts.length; n > 0; n--) {
      const handler = this.components.get(parts.slice(0, n).join(':'));
      if (handler) return { handler, args: parts.slice(n) };
    }
    return null;
  }

  async handle(i: Interaction): Promise<void> {
    if (i.isAutocomplete()) {
      try {
        if (i.inCachedGuild()) await this.commands.get(i.commandName)?.autocomplete?.(i);
      } catch (err) {
        logger.warn({ err, command: i.commandName }, 'Autocomplete failed');
      }
      return;
    }
    if (!i.isChatInputCommand() && !i.isButton() && !i.isAnySelectMenu() && !i.isModalSubmit()) return;
    const label = i.isChatInputCommand() ? `/${i.commandName}` : i.customId;
    // Discord gives 3 seconds to acknowledge. This names any handler that gets close.
    const watchdog = setTimeout(() => { if (!i.replied && !i.deferred) logger.warn({ label }, 'Interaction not acknowledged after 2.5 seconds'); }, 2500);
    watchdog.unref();
    try {
      const handled = i.isChatInputCommand() ? await this.handleCommand(i) : await this.handleComponent(i);
      // A handler that returned without responding would show "This interaction failed".
      if (handled && !i.replied && !i.deferred) {
        logger.warn({ label }, 'A handler finished without responding');
        await replyWarn(i, 'Nothing changed. This control may be out of date, so please try again.');
      }
    } catch (err) {
      await this.handleError(i, err);
    } finally {
      clearTimeout(watchdog);
    }
  }

  /** Returns false when the interaction is deliberately left unanswered. */
  private async handleComponent(i: ComponentInteraction): Promise<boolean> {
    const resolved = this.resolveComponent(i.customId);
    if (!resolved) return false; // not one of ours
    if (!resolved.handler.dm && !i.inCachedGuild()) {
      await replyFail(i, 'This action only works inside a server.');
      return true;
    }
    if (componentThrottle.allow(`${i.user.id}:${i.customId}`, 700) > 0) {
      await replyWarn(i, 'Slow down a little and try again.');
      return true;
    }
    await resolved.handler.run(i, resolved.args);
    return true;
  }

  private isForeign(i: ChatInputCommandInteraction, command: SlashCommand | undefined, sub: string | null): boolean {
    if (!command) return true;
    if (this.options.ownedGuildId && i.commandGuildId !== this.options.ownedGuildId) return true;
    // Same name, different shape: this is another program's command on this application.
    const expectsSub = command.data.options?.some((o) => o.type === ApplicationCommandOptionType.Subcommand || o.type === ApplicationCommandOptionType.SubcommandGroup);
    return Boolean(expectsSub && !sub);
  }

  private async handleForeign(i: ChatInputCommandInteraction): Promise<boolean> {
    logger.warn({ command: i.commandName }, 'Received a command ZYTHERON does not own. It is left over on this application from another bot');
    if (this.options.ignoreForeign) return false;
    const replacement = REPLACEMENTS[i.commandName];
    const usable = this.commands.has(i.commandName) && !replacement ? `/${i.commandName}` : replacement;
    await replyWarn(i, `This is an old command from before ZYTHERON, so it no longer runs.${usable ? ` Use **${usable}** instead: pick the ZYTHERON entry in the command list.` : ' ZYTHERON has no replacement for it. See **/help** for what is available.'}`);
    return true;
  }

  private async handleCommand(i: ChatInputCommandInteraction): Promise<boolean> {
    const group = i.options.getSubcommandGroup(false);
    const sub = i.options.getSubcommand(false);
    const command = this.commands.get(i.commandName);
    if (this.isForeign(i, command, sub)) return this.handleForeign(i);
    if (!i.inCachedGuild()) {
      await replyFail(i, 'ZYTHERON commands can only be used inside a server.');
      return true;
    }
    const blocked = await commandBlockReason(i.guildId, i.commandName, i.member, i.channel);
    if (blocked) {
      await replyFail(i, blocked);
      return true;
    }
    const key = group ? `${group}.${sub}` : (sub ?? '');

    const need = command!.perms?.[key] ?? command!.perms?.['*'];
    if (need?.length && i.guild.ownerId !== i.user.id) {
      const missing = missingPerms(i.member, need);
      if (missing.length) {
        await replyFail(i, `You need: **${missing.join(', ')}**.`);
        return true;
      }
    }
    const botNeed = command!.botPerms?.[key] ?? command!.botPerms?.['*'];
    if (botNeed?.length && i.guild.members.me) {
      const missing = missingPerms(i.guild.members.me, botNeed);
      if (missing.length) {
        await replyFail(i, `I am missing: **${missing.join(', ')}**.`);
        return true;
      }
    }

    const left = cooldowns.allow(`${i.user.id}:${i.commandName}:${key}`, (command!.cooldownSec ?? 2) * 1000);
    if (left > 0) {
      await replyWarn(i, `Please wait **${formatDuration(left + 999)}** before using this again.`);
      return true;
    }
    await command!.execute(i);
    if ((i.replied || i.deferred) && (await commandRule(i.guildId, i.commandName))?.deleteReplyAfter5s) {
      setTimeout(() => void i.deleteReply().catch(() => undefined), REPLY_LIFETIME_MS).unref();
    }
    return true;
  }

  private async handleError(i: RepliableInteraction, err: unknown): Promise<void> {
    const code = (err as { code?: number }).code;
    if (code === 10062 || code === 40060) {
      // Expired, or answered elsewhere. A second reply cannot succeed.
      logger.warn({ code, command: (i as { commandName?: string }).commandName, id: (i as { customId?: string }).customId }, 'Interaction could not be answered: it expired or was already answered');
      return;
    }
    const message = describeError(err);
    if (message === null) logger.error({ err, id: (i as { customId?: string }).customId, command: (i as { commandName?: string }).commandName }, 'Interaction failed');
    try {
      await replyFail(i, message ?? 'Something went wrong on my side. The error has been logged.');
    } catch (replyErr) {
      logger.warn({ err: replyErr }, 'Could not report an interaction failure to the user');
    }
  }
}

/** Maps expected errors to user-safe text. null means unexpected: log it, show a generic message. */
export function describeError(err: unknown): string | null {
  if (err instanceof UserError) return err.message;
  if (err instanceof ZodError) return err.issues.slice(0, 5).map((x) => `\`${x.path.join('.') || 'value'}\`: ${x.message}`).join('\n');
  if (err instanceof DiscordAPIError) {
    if (err.code === 50013) return 'I am missing the Discord permissions needed for that. Check my role and channel overrides.';
    if (err.code === 50001) return 'I cannot access that channel.';
    if (err.code === 10008) return 'That message no longer exists.';
    if (err.code === 10011) return 'That role no longer exists.';
    if (err.code === 50021 || err.code === 50005) return 'Discord does not allow that on this message.';
    if (err.code === 10003) return 'That channel no longer exists.';
    if (err.code === 10007 || err.code === 10013) return 'That user could not be found.';
    if (err.code === 50035) return `Discord rejected the content: ${err.message.slice(0, 300)}`;
  }
  if ((err as { code?: string })?.code === 'DUPLICATE') return 'An item with that name already exists.';
  return null;
}
