import { createHash } from 'node:crypto';
import type { Client } from 'discord.js';
import { Meta } from '../db/models.js';
import { logger } from './logger.js';
import { allCommandData } from './registry.js';

export type SyncResult = 'up-to-date' | 'registered' | 'blocked';

/**
 * Registers slash commands on startup, but only when they changed, because Discord rate
 * limits registration. Discord replaces the whole list at once, so commands ZYTHERON did not
 * register are never overwritten unless replaceForeign is set: this application could
 * belong to another bot.
 */
export async function syncCommands(client: Client<true>, opts: { devGuildId?: string; replaceForeign?: boolean } = {}): Promise<SyncResult> {
  const { devGuildId, replaceForeign } = opts;
  const body = allCommandData();
  const target = devGuildId ?? 'global';
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const key = `commands:${client.application.id}:${target}`;
  const stored = await Meta.findById(key);
  // Always ask Discord. Commands can disappear there, for example when the bot is removed from a server.
  const registered = await (devGuildId ? client.application.commands.fetch({ guildId: devGuildId }) : client.application.commands.fetch());
  const names = new Set([...registered.values()].map((c) => c.name));
  if (stored?.value === hash && body.every((c) => names.has(c.name))) {
    logger.info({ count: body.length, target }, 'Slash commands are up to date');
    return 'up-to-date';
  }
  if (!stored && !replaceForeign) {
    // Global commands count in test-server mode too: having them means this application belongs to another bot.
    const global = devGuildId ? await client.application.commands.fetch() : registered;
    const ours = new Set(body.map((c) => c.name));
    const foreign = [...global.values(), ...(devGuildId ? registered.values() : [])].filter((c) => !ours.has(c.name));
    if (foreign.length) {
      const advice = devGuildId
        ? 'Set REPLACE_COMMANDS=true to add ZYTHERON commands to this server: global commands are left alone while DEV_GUILD_ID is set'
        : 'Use a new application, set DEV_GUILD_ID to add them to one server, or set REPLACE_COMMANDS=true to delete those commands';
      logger.warn({ target, foreign: foreign.length }, `Not registering slash commands: this application already has ${foreign.length} commands from something else. ${advice}`);
      return 'blocked';
    }
  }
  await client.application.commands.set(body as never, devGuildId as string);
  await Meta.updateOne({ _id: key }, { $set: { value: hash } }, { upsert: true });
  logger.info({ count: body.length, target }, devGuildId ? 'Slash commands registered in the test server' : 'Slash commands registered globally. New ones can take a few minutes to appear');
  return 'registered';
}
