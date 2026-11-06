import type {
  AnySelectMenuInteraction,
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  ClientEvents,
  ModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

export class UserError extends Error {}

export type GuildCommand = ChatInputCommandInteraction<'cached'>;
export type ComponentInteraction = ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction;

export interface SlashCommand {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  cooldownSec?: number;
  /**
   * Discord permissions per subcommand ("sub" or "group.sub"; "*" for all), checked
   * server-side on every call, since Server Settings > Integrations can widen
   * who sees a command.
   */
  perms?: Record<string, bigint[]>;
  /** Permissions the bot needs per subcommand ("*" for all). */
  botPerms?: Record<string, bigint[]>;
  execute(i: GuildCommand): Promise<unknown>;
  autocomplete?(i: AutocompleteInteraction<'cached'>): Promise<unknown>;
}

/** Component custom IDs follow "prefix:arg:arg". Handlers register the prefix. */
export interface ComponentHandler {
  prefix: string;
  /** Allow in DMs (e.g. ticket ratings). Default guild-only. */
  dm?: boolean;
  run(i: ComponentInteraction, args: string[]): Promise<unknown>;
}

export type EventListener = { [K in keyof ClientEvents]: { event: K; run(...args: ClientEvents[K]): Promise<void> | void } }[keyof ClientEvents];

export const on = <K extends keyof ClientEvents>(event: K, run: (...args: ClientEvents[K]) => Promise<void> | void): EventListener =>
  ({ event, run }) as unknown as EventListener;

export interface VortexModule {
  name: string;
  commands?: SlashCommand[];
  components?: ComponentHandler[];
  events?: EventListener[];
  /** Scheduler job handlers keyed by job type. */
  jobs?: Record<string, (client: Client<true>, guildId: string, payload: Record<string, any>) => Promise<void>>;
  /** Periodic tasks. Failures are logged and never stop the timer. */
  intervals?: Array<{ name: string; everyMs: number; run(client: Client<true>): Promise<void> }>;
  onReady?(client: Client<true>): Promise<void>;
}
