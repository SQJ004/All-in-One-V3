import { GuildConfigSchema, type ConfigSection, type GuildConfig } from '../config/guildConfig.js';
import { GuildSettings } from '../db/models.js';

const TTL_MS = 60_000;
const cache = new Map<string, { value: GuildConfig; at: number }>();

export async function getConfig(guildId: string): Promise<GuildConfig> {
  const hit = cache.get(guildId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const doc = await GuildSettings.findOne({ guildId });
  const value = GuildConfigSchema.parse(doc?.config ?? {});
  cache.set(guildId, { value, at: Date.now() });
  return value;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursive merge. Arrays and scalars replace. Prototype-polluting keys are dropped. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = deepMerge(out[key], value);
  }
  return out as T;
}

/** Merge a partial section, validate the result, and persist it. Throws ZodError on invalid input. */
export async function updateConfig<S extends ConfigSection>(guildId: string, section: S, patch: unknown): Promise<GuildConfig[S]> {
  const current = await getConfig(guildId);
  const merged = deepMerge(current[section], patch);
  const validated = GuildConfigSchema.shape[section].parse(merged) as GuildConfig[S];
  await GuildSettings.updateOne({ guildId }, { $set: { [`config.${section}`]: validated } }, { upsert: true });
  cache.set(guildId, { value: { ...current, [section]: validated }, at: Date.now() });
  return validated;
}

export function invalidateConfig(guildId?: string): void {
  if (guildId) cache.delete(guildId);
  else cache.clear();
}
