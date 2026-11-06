import type { Guild } from 'discord.js';
import { getConfig } from '../../core/configService.js';
import { logger } from '../../core/logger.js';
import { SecurityEvent, type ISecurityEvent } from '../../db/models.js';
import { baseEmbed, COLORS, ICONS } from '../../ui/theme.js';
import { sendLog } from '../logging/service.js';

type EventInput = Pick<ISecurityEvent, 'type' | 'severity' | 'summary'> & Partial<Pick<ISecurityEvent, 'actorId' | 'targetId' | 'action' | 'monitorOnly' | 'details'>>;

const SEVERITY_COLOR = { info: COLORS.accent, warning: COLORS.warning, critical: COLORS.danger } as const;

/** Persists a security event and posts it to the security log channel. */
export async function logSecurity(guild: Guild, event: EventInput): Promise<void> {
  try {
    await SecurityEvent.create({ guildId: guild.id, ...event });
  } catch (err) {
    logger.error({ err }, 'Could not persist security event');
  }
  const embed = baseEmbed(SEVERITY_COLOR[event.severity])
    .setTitle(`${ICONS.shield}  Security ${'·'} ${event.type.replace(/_/g, ' ')}`)
    .setDescription(event.summary);
  if (event.actorId) embed.addFields({ name: 'Actor', value: `<@${event.actorId}> (${event.actorId})`, inline: true });
  if (event.targetId) embed.addFields({ name: 'Target', value: `<@${event.targetId}> (${event.targetId})`, inline: true });
  if (event.action) embed.addFields({ name: event.monitorOnly ? 'Would have done (monitor mode)' : 'Response', value: event.action });
  const { security } = await getConfig(guild.id);
  await sendLog(guild, 'security', embed, security.logChannelId);
}
