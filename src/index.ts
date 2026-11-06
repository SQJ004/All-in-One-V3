import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';
import { Events, type Client } from 'discord.js';
import { getEnv, type Env } from './config/env.js';
import { createClient, wireModules } from './core/client.js';
import { syncCommands } from './core/commands.js';
import { logger } from './core/logger.js';
import { MODULES } from './core/registry.js';
import { createDashboardApp } from './dashboard/app.js';
import { createClientGateway } from './dashboard/gateway.js';
import { botInviteUrl } from './dashboard/invite.js';
import { discordOAuth } from './dashboard/oauth.js';
import { closeStore, openStore } from './db/store.js';

/** Uses SESSION_SECRET when set, otherwise a random one saved next to the data so sign-ins survive restarts. */
function sessionSecret(env: Env, dataDir: string): string {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const file = join(dataDir, 'session-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

/** The website is optional: if it cannot start, the bot keeps running. */
function startDashboard(client: Client<true>, env: Env, dataDir: string): Server | undefined {
  if (!env.DASHBOARD_ENABLED) {
    logger.info('Website is off. Set DISCORD_CLIENT_SECRET in .env to turn it on');
    return undefined;
  }
  const app = createDashboardApp({
    gateway: createClientGateway(client),
    oauth: discordOAuth({ clientId: client.application.id, clientSecret: env.DISCORD_CLIENT_SECRET!, redirectUri: `${env.DASHBOARD_URL.replace(/\/$/, '')}/auth/callback` }),
    sessionSecret: sessionSecret(env, dataDir),
    secureCookies: env.DASHBOARD_URL.startsWith('https://'),
    trustProxy: env.TRUST_PROXY,
    publicUrl: env.DASHBOARD_URL,
    supportUrl: env.SUPPORT_URL,
  });
  const server = app.listen(env.DASHBOARD_PORT, () => logger.info({ url: env.DASHBOARD_URL }, 'Website is running'));
  server.on('error', (err) => logger.error({ err }, `Website could not start on port ${env.DASHBOARD_PORT}. The bot keeps running`));
  return server;
}

function explainLoginFailure(err: unknown): string {
  const code = (err as { code?: string }).code;
  if (code === 'TokenInvalid') return 'Discord rejected DISCORD_TOKEN. Reset the token in the Developer Portal and update .env.';
  if (code === 'DisallowedIntents' || String((err as Error).message).includes('disallowed intents')) return 'Turn on the Server Members and Message Content intents in the Developer Portal > Bot, then start again.';
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  const env = getEnv();
  const dataDir = resolve(env.DATA_DIR);
  openStore(dataDir);
  logger.info({ dataDir }, 'Data folder ready');

  const client = createClient();
  const { shutdown: stopTimers } = wireModules(client, MODULES, { ownedGuildId: env.DEV_GUILD_ID, ignoreForeign: env.IGNORE_FOREIGN_COMMANDS });
  let server: Server | undefined;

  client.once(Events.ClientReady, (ready) => {
    server = startDashboard(ready, env, dataDir);
    syncCommands(ready, { devGuildId: env.DEV_GUILD_ID, replaceForeign: env.REPLACE_COMMANDS }).catch((err) => logger.error({ err }, 'Could not register slash commands'));
    if (!ready.guilds.cache.size) {
      logger.warn(`The bot is in no servers yet. Invite it: ${botInviteUrl(ready.application.id)}`);
    }
  });

  const closeServer = (): Promise<void> => new Promise((done) => {
    if (!server?.listening) return done();
    server.close(() => done());
    server.closeAllConnections();
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down');
    stopTimers();
    await closeServer();
    await client.destroy();
    closeStore();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await client.login(env.DISCORD_TOKEN);
  } catch (err) {
    stopTimers();
    await client.destroy().catch(() => undefined);
    closeStore();
    throw new Error(explainLoginFailure(err));
  }
}

process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled rejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  try {
    closeStore(); // save what we can before exiting
  } finally {
    process.exit(1);
  }
});

main().catch((err) => {
  console.error(`\nVORTEX could not start.\n${err instanceof Error ? err.message : err}\n`);
  process.exitCode = 1; // lets open handles close normally, instead of aborting them
});
