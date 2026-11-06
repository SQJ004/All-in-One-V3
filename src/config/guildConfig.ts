import { z } from 'zod';

/**
 * The single source of truth for per-guild settings. Slash commands and the
 * dashboard both write through this schema, so a value can never be stored
 * without being validated, and new settings get defaults on existing guilds.
 */
export const snowflake = z.string().regex(/^\d{17,20}$/, 'Invalid Discord ID');
const optId = snowflake.nullable().default(null);
const ids = z.array(snowflake).max(100).default([]);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const limit = (count: number, windowSec: number) =>
  z
    .object({ count: z.number().int().min(1).max(100), windowSec: z.number().int().min(1).max(3600) })
    .prefault({ count, windowSec });

const PunishAction = z.enum(['strip_roles', 'quarantine', 'timeout', 'kick', 'ban']);
/** Anti-nuke checks that can be switched off one by one. */
export const NUKE_MODULES = ['channelDelete', 'channelCreate', 'roleDelete', 'roleCreate', 'ban', 'kick', 'webhookCreate', 'dangerousRoleGrant', 'emojiDelete', 'serverUpdate', 'permissionChange'] as const;
const JoinAction = z.enum(['log', 'timeout', 'kick', 'ban']);

const SecuritySchema = z
  .object({
    enabled: z.boolean().default(false),
    /** monitor = detect and log only. New guilds start here to avoid false positives. */
    mode: z.enum(['monitor', 'enforce']).default('monitor'),
    logChannelId: optId,
    whitelistUsers: ids,
    whitelistRoles: ids,
    trustedAdmins: ids,
    exemptChannels: ids,
    antiNuke: z
      .object({
        enabled: z.boolean().default(true),
        punishment: PunishAction.default('strip_roles'),
        recover: z.boolean().default(true),
        disabled: z.array(z.enum(NUKE_MODULES)).default([]),
        limits: z
          .object({
            channelDelete: limit(3, 30),
            channelCreate: limit(6, 30),
            roleDelete: limit(3, 30),
            roleCreate: limit(6, 30),
            ban: limit(4, 60),
            kick: limit(5, 60),
            webhookCreate: limit(3, 60),
            dangerousRoleGrant: limit(2, 60),
            emojiDelete: limit(5, 60),
            serverUpdate: limit(3, 60),
            permissionChange: limit(6, 60),
          })
          .prefault({}),
      })
      .prefault({}),
    antiRaid: z
      .object({
        enabled: z.boolean().default(true),
        joinThreshold: z.number().int().min(2).max(200).default(10),
        windowSec: z.number().int().min(1).max(600).default(15),
        action: z.enum(['timeout', 'kick', 'ban']).default('kick'),
        raidModeMinutes: z.number().int().min(1).max(1440).default(10),
        autoLockdown: z.boolean().default(false),
        /** Raised on Discord when a raid starts in Enforce mode. Discord keeps it until an admin lowers it. */
        raiseVerification: z.enum(['off', 'low', 'medium', 'high', 'very_high']).default('off'),
      })
      .prefault({}),
    suspicious: z
      .object({
        enabled: z.boolean().default(true),
        minAccountAgeDays: z.number().int().min(0).max(365).default(3),
        scoreThreshold: z.number().int().min(1).max(100).default(60),
        action: JoinAction.default('log'),
      })
      .prefault({}),
    antiBot: z
      .object({
        enabled: z.boolean().default(true),
        action: z.enum(['log', 'kick', 'ban']).default('kick'),
        allowedBots: ids,
        punishAdder: z.boolean().default(false),
      })
      .prefault({}),
    antiSpam: z
      .object({
        enabled: z.boolean().default(true),
        maxMessages: z.number().int().min(2).max(60).default(7),
        windowSec: z.number().int().min(1).max(120).default(5),
        maxDuplicates: z.number().int().min(2).max(30).default(4),
        duplicateWindowSec: z.number().int().min(1).max(600).default(20),
      })
      .prefault({}),
    antiMention: z
      .object({
        enabled: z.boolean().default(true),
        maxMentions: z.number().int().min(1).max(100).default(6),
        blockEveryone: z.boolean().default(true),
      })
      .prefault({}),
    antiLinks: z
      .object({
        scam: z.boolean().default(true),
        phishing: z.boolean().default(true),
        invites: z.boolean().default(false),
        allowedDomains: z.array(z.string().max(253)).max(500).default([]),
        blockedDomains: z.array(z.string().max(253)).max(500).default([]),
      })
      .prefault({}),
    antiWebhook: z
      .object({
        enabled: z.boolean().default(true),
        maxMessages: z.number().int().min(1).max(100).default(8),
        windowSec: z.number().int().min(1).max(120).default(10),
        blockEveryone: z.boolean().default(true),
        deleteWebhook: z.boolean().default(true),
        alertCreate: z.boolean().default(true),
        alertDelete: z.boolean().default(true),
        /** In Enforce mode, removes webhooks made by anyone who is not trusted. */
        removeUnauthorized: z.boolean().default(false),
        trustedWebhooks: ids,
      })
      .prefault({}),
    automod: z
      .object({
        bannedWords: z.array(z.string().min(1).max(100)).max(500).default([]),
        maxCapsPercent: z.number().int().min(0).max(100).default(0), // 0 = disabled
      })
      .prefault({}),
    /** Strike ladder used for all message-based violations. */
    ladder: z
      .array(
        z.object({
          strikes: z.number().int().min(1).max(100),
          action: z.enum(['delete', 'timeout', 'kick', 'ban']),
          durationMinutes: z.number().int().min(1).max(40320).default(10),
        }),
      )
      .max(10)
      .default([
        { strikes: 1, action: 'delete', durationMinutes: 10 },
        { strikes: 3, action: 'timeout', durationMinutes: 10 },
        { strikes: 6, action: 'timeout', durationMinutes: 120 },
        { strikes: 10, action: 'kick', durationMinutes: 10 },
      ]),
    strikeDecayMinutes: z.number().int().min(1).max(10080).default(60),
  })
  .prefault({});

const CardSchema = z
  .object({
    enabled: z.boolean().default(true),
    background: z.string().max(500).default('zytheron'), // preset name or https URL
    accent: hexColor.default('#7c3aed'),
    headline: z.string().max(80).default('WELCOME'),
    subline: z.string().max(120).default('Member #{membercount} of {server}'),
  })
  .prefault({});

export const WelcomeTemplateSchema = z.object({
  id: z.string().min(1).max(32),
  content: z.string().max(2000).default(''),
  title: z.string().max(256).default('Welcome, {username}'),
  description: z.string().max(4000).default('{user} just joined **{server}**. You are member **#{membercount}**.'),
  color: hexColor.default('#7c3aed'),
  footer: z.string().max(200).default('Account created {createdat}'),
  card: CardSchema,
});
export type WelcomeTemplate = z.infer<typeof WelcomeTemplateSchema>;

const defaultWelcome = WelcomeTemplateSchema.parse({ id: 'default' });
const defaultGoodbye = WelcomeTemplateSchema.parse({
  id: 'goodbye',
  title: 'Goodbye, {username}',
  description: '**{username}** left {server}. We now have **{membercount}** members.',
  card: { headline: 'GOODBYE', subline: '{server} now has {membercount} members', accent: '#8b5cf6' },
});

const WelcomeSchema = z
  .object({
    enabled: z.boolean().default(false),
    channelId: optId,
    activeTemplate: z.string().default('default'),
    templates: z.array(WelcomeTemplateSchema).min(1).max(15).default([defaultWelcome]),
    goodbyeEnabled: z.boolean().default(false),
    goodbyeChannelId: optId,
    goodbye: WelcomeTemplateSchema.default(defaultGoodbye),
    dmEnabled: z.boolean().default(false),
    dmMessage: z.string().max(2000).default('Welcome to **{server}**, {username}!'),
  })
  .prefault({});

const ModerationSchema = z
  .object({
    modLogChannelId: optId,
    dmOnAction: z.boolean().default(true),
    jailRoleId: optId,
    warnThresholds: z
      .array(
        z.object({
          warnings: z.number().int().min(1).max(100),
          action: z.enum(['timeout', 'kick', 'ban', 'jail']),
          durationMinutes: z.number().int().min(1).max(40320).default(60),
        }),
      )
      .max(10)
      .default([]),
  })
  .prefault({});

export const LOG_CATEGORIES = ['message', 'member', 'role', 'channel', 'voice', 'ban', 'moderation', 'invite', 'webhook', 'server', 'security'] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];

const LoggingSchema = z
  .object({
    enabled: z.boolean().default(false),
    defaultChannelId: optId,
    channels: z.partialRecord(z.enum(LOG_CATEGORIES), snowflake).default({}),
    disabled: z.array(z.enum(LOG_CATEGORIES)).default([]),
    ignoredChannels: ids,
  })
  .prefault({});

const RolesSchema = z
  .object({
    humanRoles: ids,
    botRoles: ids,
    selfRoles: ids,
  })
  .prefault({});

const TicketsSchema = z
  .object({
    enabled: z.boolean().default(false),
    staffRoleIds: ids,
    parentCategoryId: optId,
    transcriptChannelId: optId,
    notifyChannelId: optId,
    maxOpenPerUser: z.number().int().min(1).max(10).default(1),
    ratingsEnabled: z.boolean().default(true),
    welcomeMessage: z.string().max(2000).default('Hello {user}, the team will be with you shortly. Please describe your issue in detail.'),
    color: hexColor.default('#7c3aed'),
    channelName: z.string().trim().min(1).max(60).default('ticket-{number}'),
    autoCloseHours: z.number().int().min(0).max(720).default(0), // 0 = never
    transcriptFormat: z.enum(['html', 'text']).default('html'),
  })
  .prefault({});

const AutomationSchema = z
  .object({
    customCommandPrefix: z.string().min(1).max(5).default('!'),
  })
  .prefault({});

const LevelsSchema = z
  .object({
    enabled: z.boolean().default(false),
    xpMin: z.number().int().min(1).max(500).default(15),
    xpMax: z.number().int().min(1).max(1000).default(25),
    cooldownSec: z.number().int().min(0).max(3600).default(60),
    multiplier: z.number().min(0.1).max(10).default(1),
    announceChannelId: optId,
    announceMessage: z.string().max(500).default('{user} reached **level {level}**.'),
    announce: z.boolean().default(true),
    ignoredChannels: ids,
    ignoredRoles: ids,
    rewards: z.array(z.object({ level: z.number().int().min(1).max(1000), roleId: snowflake })).max(50).default([]),
  })
  .prefault({});

const CommunitySchema = z
  .object({
    levels: LevelsSchema,
    suggestions: z.object({ enabled: z.boolean().default(false), channelId: optId }).prefault({}),
    starboard: z
      .object({
        enabled: z.boolean().default(false),
        channelId: optId,
        emoji: z.string().max(64).default('⭐'),
        threshold: z.number().int().min(1).max(100).default(3),
        allowSelfStar: z.boolean().default(false),
        ignoredChannels: ids,
      })
      .prefault({}),
    invites: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    birthdays: z
      .object({
        enabled: z.boolean().default(false),
        channelId: optId,
        roleId: optId,
        message: z.string().max(500).default('Happy birthday {user}! The whole of {server} wishes you a great day.'),
      })
      .prefault({}),
    afk: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    challenge: z
      .object({
        enabled: z.boolean().default(false),
        channelId: optId,
        verifiedRoleId: optId,
        type: z.enum(['button', 'math']).default('math'),
        timeoutMinutes: z.number().int().min(0).max(1440).default(0), // 0 = never kick
      })
      .prefault({}),
    statsChannels: z
      .array(z.object({ channelId: snowflake, template: z.string().max(90), metric: z.enum(['members', 'humans', 'bots', 'channels', 'roles', 'boosts']) }))
      .max(5)
      .default([]),
  })
  .prefault({});

const CommandRuleSchema = z.object({
  // Any prefix is fine, such as p, #p or !profile, but not spaces or anything that could mention someone.
  aliases: z.array(z.string().regex(/^[^\s@<>`A-Z]{1,32}$/, 'Aliases are one word in lowercase, with no spaces or the characters @ < > `')).max(10).default([]),
  allowedRoleIds: z.array(snowflake).max(25).default([]),
  disabledRoleIds: z.array(snowflake).max(25).default([]),
  allowedChannelIds: z.array(snowflake).max(25).default([]),
  disabledChannelIds: z.array(snowflake).max(25).default([]),
  deleteWithMessage: z.boolean().default(false),
  deleteInvocation: z.boolean().default(false),
  deleteReplyAfter5s: z.boolean().default(false),
});
const CommandsSchema = z.object({
  // Typed-command prefixes. Discord mentions and spaces would make them unusable.
  prefixes: z.array(z.string().regex(/^[^\s@<>`A-Z]{1,5}$/, 'A prefix is 1 to 5 characters in lowercase, with no spaces or the characters @ < > `')).min(1, 'Keep at least one prefix').max(5).default(['v!']),
  disabled: z.array(z.string().regex(/^[a-z0-9_-]{1,32}$/)).max(200).default([]),
  rules: z.record(z.string().regex(/^[a-z0-9_-]{1,32}$/), CommandRuleSchema).default({}),
}).prefault({});

const StickySchema = z.object({ items: z.array(z.object({ channelId: snowflake, content: z.string().trim().min(1, 'Write a message').max(2000) })).max(25).default([]) }).prefault({});
const AutoPurgeSchema = z.object({ items: z.array(z.object({ channelId: snowflake, afterMinutes: z.number().int().min(5).max(20_160) })).max(25).default([]) }).prefault({});
const VoiceLinkSchema = z.object({ items: z.array(z.object({ channelId: snowflake, roleId: snowflake })).max(50).default([]) }).prefault({});

const MusicSchema = z.object({ volume: z.number().int().min(1).max(100).default(60) }).prefault({});

const BackupSchema = z.object({ autoEnabled: z.boolean().default(false), everyHours: z.number().int().min(1).max(168).default(24), keep: z.number().int().min(1).max(25).default(10) }).prefault({});

const AiModerationSchema = z.object({
  enabled: z.boolean().default(false),
  reviewThreshold: z.number().int().min(1).max(100).default(70),
  actionThreshold: z.number().int().min(1).max(100).default(90),
  categories: z.object({ toxicity: z.boolean().default(true), harassment: z.boolean().default(true), spam: z.boolean().default(true), scam: z.boolean().default(true), phishing: z.boolean().default(true), suspicious: z.boolean().default(true) }).prefault({}),
  linkProtection: z.boolean().default(true),
  autoDelete: z.boolean().default(false),
  autoWarn: z.boolean().default(false),
  autoTimeout: z.boolean().default(false),
  timeoutMinutes: z.number().int().min(1).max(60).default(10),
  dailyLimit: z.number().int().min(1).max(100_000).default(2000),
  exemptRoles: ids,
  exemptChannels: ids,
  customRules: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  logChannelId: optId,
}).prefault({});

const StaffGoals = z.object({
  responseMinutes: z.number().int().min(1).max(10_080).default(30),
  resolvedPerWeek: z.number().int().min(0).max(1000).default(5),
  qualityPercent: z.number().int().min(0).max(100).default(80),
  moderationPercent: z.number().int().min(0).max(100).default(90),
  activeDaysPerWeek: z.number().int().min(0).max(7).default(3),
}).prefault({});

const StaffSchema = z.object({
  adminRoles: ids,
  moderatorRoles: ids,
  helperRoles: ids,
  supportRoles: ids,
  activeWithinDays: z.number().int().min(1).max(90).default(14),
  weights: z.object({ quality: z.number().min(0).max(100).default(30), response: z.number().min(0).max(100).default(25), moderation: z.number().min(0).max(100).default(25), activity: z.number().min(0).max(100).default(20) }).prefault({}),
  goals: z.object({ admin: StaffGoals, moderator: StaffGoals, helper: StaffGoals, support: StaffGoals }).prefault({}),
}).prefault({});

export const GuildConfigSchema = z.object({
  staff: StaffSchema,
  backup: BackupSchema,
  aiModeration: AiModerationSchema,
  music: MusicSchema,
  sticky: StickySchema,
  autoPurge: AutoPurgeSchema,
  voiceLink: VoiceLinkSchema,
  commands: CommandsSchema,
  security: SecuritySchema,
  welcome: WelcomeSchema,
  moderation: ModerationSchema,
  logging: LoggingSchema,
  roles: RolesSchema,
  tickets: TicketsSchema,
  automation: AutomationSchema,
  community: CommunitySchema,
});

export type GuildConfig = z.infer<typeof GuildConfigSchema>;
export type ConfigSection = keyof GuildConfig;
export const CONFIG_SECTIONS = Object.keys(GuildConfigSchema.shape) as ConfigSection[];

export const defaultGuildConfig = (): GuildConfig => GuildConfigSchema.parse({});
