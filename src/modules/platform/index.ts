import { ActivityType, Routes, type Client, type PresenceStatusData } from 'discord.js';
import { z } from 'zod';
import { logger } from '../../core/logger.js';
import { UserError, type VortexModule } from '../../core/types.js';
import { hexToInt } from '../../core/util.js';
import { Meta } from '../../db/models.js';
import { setEmbedColor } from '../../ui/theme.js';
import { trimAudit } from '../logging/audit.js';

const KEY = 'bot-identity';
const ACTIVITY_TYPES = { none: null, playing: ActivityType.Playing, listening: ActivityType.Listening, watching: ActivityType.Watching, competing: ActivityType.Competing, custom: ActivityType.Custom } as const;

export const IdentitySchema = z.object({
  status: z.enum(['online', 'idle', 'dnd', 'invisible']).default('online'),
  activityType: z.enum(['none', 'playing', 'listening', 'watching', 'competing', 'custom']).default('none'),
  activityText: z.string().trim().max(120).default(''),
  embedColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#7c3aed'),
});
export type Identity = z.infer<typeof IdentitySchema>;

export async function readIdentity(): Promise<Identity> {
  const row = await Meta.findById(KEY);
  try {
    return IdentitySchema.parse(row?.value ? JSON.parse(row.value) : {});
  } catch {
    return IdentitySchema.parse({});
  }
}

/** Applies status, activity and embed colour to the running bot. */
export function applyIdentity(client: Client, identity: Identity): void {
  setEmbedColor(hexToInt(identity.embedColor));
  const type = ACTIVITY_TYPES[identity.activityType];
  client.user?.setPresence({
    status: identity.status as PresenceStatusData,
    activities: type !== null && identity.activityText ? [{ type, name: identity.activityText, ...(type === ActivityType.Custom ? { state: identity.activityText } : {}) }] : [],
  });
}

export async function saveIdentity(client: Client, identity: Identity): Promise<void> {
  await Meta.updateOne({ _id: KEY }, { $set: { value: JSON.stringify(identity) } }, { upsert: true });
  applyIdentity(client, identity);
}

/** Changes the bot's name and pictures everywhere. Discord allows only a couple of changes per hour. */
export async function updateBotAccount(client: Client, body: { username?: string; avatar?: string | null; banner?: string | null }): Promise<void> {
  if (!Object.keys(body).length) return;
  try {
    await client.rest.patch(Routes.user(), { body });
    await client.user?.fetch();
  } catch (err) {
    const message = (err as Error).message ?? '';
    if (/fast|rate/i.test(message) || (err as { status?: number }).status === 429) throw new UserError('Discord limits how often the bot can change its name or picture. Please try again later.');
    throw new UserError(`Discord refused that change: ${message.slice(0, 200)}`);
  }
}

/** Only whoever owns the bot in the Discord Developer Portal, or their team. */
export async function isBotOwner(client: Client, userId: string): Promise<boolean> {
  const app = await client.application?.fetch().catch(() => null);
  const owner = app?.owner;
  if (!owner) return false;
  return 'members' in owner ? owner.members.has(userId) : owner.id === userId;
}

export const platformModule: VortexModule = {
  name: 'platform',
  intervals: [{
    name: 'audit-trim',
    everyMs: 3_600_000,
    run: async (client) => { for (const id of client.guilds.cache.keys()) await trimAudit(id).catch((err) => logger.debug({ err }, 'Could not trim audit entries')); },
  }],
  onReady: async (client) => { if (await Meta.findById(KEY)) applyIdentity(client, await readIdentity()); },
};
