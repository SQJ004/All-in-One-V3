import 'dotenv/config';
import { z } from 'zod';

const blankToUndefined = (v: unknown) => (v === '' ? undefined : v);
const optionalString = z.preprocess(blankToUndefined, z.string().optional());
const optionalBool = z.preprocess((v) => (typeof v === 'string' && v !== '' ? ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()) : blankToUndefined(v)), z.boolean().optional());

/** Only DISCORD_TOKEN is required. Everything else has a default that suits local testing. */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DISCORD_TOKEN: z.string({ error: 'is required. Copy .env.example to .env and paste your bot token' }).min(20, 'does not look like a bot token'),
    DISCORD_CLIENT_SECRET: optionalString,
    DATA_DIR: z.string().default('./data'),
    DASHBOARD_ENABLED: optionalBool,
    DASHBOARD_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DASHBOARD_URL: z.string().url().default('http://localhost:3000'),
    SUPPORT_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
    YOUTUBE_API_KEY: optionalString,
    SPOTIFY_CLIENT_ID: optionalString,
    SPOTIFY_CLIENT_SECRET: optionalString,
    ANTHROPIC_API_KEY: optionalString,
    AI_MODERATION_MODEL: z.preprocess(blankToUndefined, z.string().default('claude-opus-5-5')),
    MUSIC_IDLE_TIMEOUT_SECONDS: z.preprocess(blankToUndefined, z.coerce.number().int().min(10).max(86_400).default(300)),
    SESSION_SECRET: z.preprocess(blankToUndefined, z.string().min(32, 'must be at least 32 characters').optional()),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    DEV_GUILD_ID: optionalString,
    REPLACE_COMMANDS: optionalBool,
    IGNORE_FOREIGN_COMMANDS: optionalBool,
    PHISHING_FEED_URL: optionalString,
  })
  .superRefine((env, ctx) => {
    if (env.DASHBOARD_ENABLED === true && !env.DISCORD_CLIENT_SECRET) ctx.addIssue({ code: 'custom', path: ['DISCORD_CLIENT_SECRET'], message: 'is required when DASHBOARD_ENABLED=true' });
  })
  // The dashboard turns itself on as soon as its login secret exists, unless switched off.
  .transform((env) => ({ ...env, DASHBOARD_ENABLED: env.DASHBOARD_ENABLED ?? Boolean(env.DISCORD_CLIENT_SECRET) }));

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parses the environment once. Throws a readable error listing every invalid variable. */
export function getEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached && source === process.env) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')} ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}\nSee .env.example and README.md.`);
  }
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}
