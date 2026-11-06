import { ActivityType, Client, Events, GatewayIntentBits, Options, Partials } from 'discord.js';
import { BRAND } from '../ui/theme.js';
import { aliasListener } from './aliasCommands.js';
import { InteractionRouter, type RouterOptions } from './interactions.js';
import { logger } from './logger.js';
import { Scheduler } from './scheduler.js';
import type { VortexModule } from './types.js';

export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers, // privileged
      GatewayIntentBits.GuildModeration, // audit log entries, bans
      GatewayIntentBits.GuildWebhooks,
      GatewayIntentBits.GuildInvites,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent, // privileged
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember, Partials.User],
    allowedMentions: { parse: ['users'], repliedUser: false },
    makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 500 }),
    sweepers: { ...Options.DefaultSweeperSettings, messages: { interval: 900, lifetime: 86_400 } },
    presence: { activities: [{ type: ActivityType.Watching, name: BRAND.tagline }] },
  });
}

/** Wires modules to the client. Every listener is isolated: one failing module cannot affect the others. */
export function wireModules(client: Client, modules: VortexModule[], options: RouterOptions = {}): { router: InteractionRouter; shutdown(): void } {
  const router = new InteractionRouter(modules, options);
  client.on(Events.InteractionCreate, (i) => void router.handle(i));
  const runAlias = aliasListener(router);
  client.on(Events.MessageCreate, (message) => void runAlias(message).catch((err) => logger.error({ err }, 'Alias handling failed')));

  for (const mod of modules) {
    for (const listener of mod.events ?? []) {
      client.on(listener.event, (...args: unknown[]) => {
        Promise.resolve()
          .then(() => (listener.run as (...a: unknown[]) => unknown)(...args))
          .catch((err) => logger.error({ err, module: mod.name, event: listener.event }, 'Event handler failed'));
      });
    }
  }

  const timers: NodeJS.Timeout[] = [];
  let scheduler: Scheduler | undefined;

  client.once(Events.ClientReady, (ready) => {
    logger.info({ tag: ready.user.tag, guilds: ready.guilds.cache.size }, 'ZYTHERON is online');
    const handlers = Object.assign({}, ...modules.map((m) => m.jobs ?? {}));
    scheduler = new Scheduler(ready, handlers);
    scheduler.start();
    for (const mod of modules) {
      for (const task of mod.intervals ?? []) {
        timers.push(setInterval(() => void task.run(ready).catch((err) => logger.error({ err, task: task.name }, 'Interval task failed')), task.everyMs));
      }
      void mod.onReady?.(ready).catch((err) => logger.error({ err, module: mod.name }, 'Module startup failed'));
    }
  });

  client.on(Events.Error, (err) => logger.error({ err }, 'Discord client error'));
  client.on(Events.Warn, (msg) => logger.warn(msg));
  client.on(Events.ShardDisconnect, (e, id) => logger.warn({ code: e.code, shard: id }, 'Gateway disconnected'));
  client.on(Events.ShardReconnecting, (id) => logger.info({ shard: id }, 'Gateway reconnecting'));

  return {
    router,
    shutdown() {
      scheduler?.stop();
      timers.forEach(clearInterval);
    },
  };
}
