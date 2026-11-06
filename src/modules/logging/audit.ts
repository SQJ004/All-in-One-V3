import type { EmbedBuilder, Guild } from 'discord.js';
import { logger } from '../../core/logger.js';
import { AuditEntry, type IAuditEntry } from '../../db/models.js';

const USER_FIELDS = /^(actor|author|by|responsible moderator|moderator|member|user)$/i;
const TARGET_FIELDS = /^(target|subject)$/i;
/** People's words stay out of the searchable log. They only go to the log channel the server chose. */
const PRIVATE_FIELDS = /^(content|before|after|attachments)$/i;
const MAX_DETAILS = 500;
export const AUDIT_KEEP_PER_GUILD = 5000;

const firstId = (text: string | undefined, pattern: RegExp) => text?.match(pattern)?.[1] ?? null;
const USER_MENTION = /<@!?(\d{17,20})>/;
const CHANNEL_MENTION = /<#(\d{17,20})>/;

type EmbedData = { title?: string; description?: string; fields?: Array<{ name: string; value: string }> };

/** Reads who, what and where out of a log embed. */
export function auditFromEmbed(category: string, data: EmbedData): Pick<IAuditEntry, 'category' | 'action' | 'userId' | 'target' | 'channelId' | 'status' | 'details'> {
  const fields = data.fields ?? [];
  const named = (pattern: RegExp) => fields.find((f) => pattern.test(f.name))?.value;
  const description = category === 'message' && /deleted|edited/i.test(data.title ?? '') && !/bulk/i.test(data.title ?? '') ? undefined : data.description;
  const everything = [description, ...fields.filter((f) => !PRIVATE_FIELDS.test(f.name)).map((f) => f.value)].filter(Boolean).join(' ');
  const shown = fields.filter((f) => !PRIVATE_FIELDS.test(f.name) && !USER_FIELDS.test(f.name) && !TARGET_FIELDS.test(f.name)).map((f) => `${f.name}: ${f.value}`);
  const status = fields.some((f) => /monitor mode/i.test(f.name)) ? 'monitor' : fields.some((f) => f.name === 'Response') ? 'enforced' : 'ok';
  return {
    category,
    action: (data.title ?? category).replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 120),
    userId: firstId(named(USER_FIELDS), USER_MENTION) ?? firstId(description, USER_MENTION),
    target: named(TARGET_FIELDS)?.slice(0, 200) ?? null,
    channelId: firstId(named(/^channel$/i), CHANNEL_MENTION) ?? firstId(everything, CHANNEL_MENTION),
    status,
    details: [description, ...shown].filter(Boolean).join(' · ').slice(0, MAX_DETAILS) || null,
  };
}

/** Saves a searchable copy. A failure here must never stop the log message being posted. */
export function recordAudit(guild: Guild, category: string, embed: EmbedBuilder): void {
  try {
    const entry = auditFromEmbed(category, embed.data as EmbedData);
    const userName = entry.userId ? guild.members?.cache?.get(entry.userId)?.user.tag ?? null : null;
    void AuditEntry.create({ guildId: guild.id, ...entry, userName }).catch((err: unknown) => logger.debug({ err }, 'Could not save an audit entry'));
  } catch (err) {
    logger.debug({ err }, 'Could not read a log embed');
  }
}

/** Keeps the data file small on busy servers. */
export async function trimAudit(guildId: string, keep = AUDIT_KEEP_PER_GUILD): Promise<void> {
  const extra = await AuditEntry.find({ guildId }).sort({ createdAt: -1 }).skip(keep);
  await Promise.all(extra.map((row) => AuditEntry.deleteOne({ _id: row._id })));
}

/** One CSV cell. A leading = + - or @ would run as a formula in a spreadsheet, so it is made plain text. */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
