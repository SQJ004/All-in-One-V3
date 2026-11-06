import { ChannelType, type EmbedBuilder, type Guild, type GuildTextBasedChannel } from 'discord.js';
import type { LogCategory } from '../../config/guildConfig.js';
import { getConfig } from '../../core/configService.js';
import { logger } from '../../core/logger.js';
import { recordAudit } from './audit.js';

const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread]);

export function getTextChannel(guild: Guild, id: string | null | undefined): GuildTextBasedChannel | null {
  if (!id) return null;
  const channel = guild.channels.cache.get(id);
  return channel && TEXT_TYPES.has(channel.type) ? (channel as GuildTextBasedChannel) : null;
}

/** Sends a log embed. Logging failures must never break the feature that produced them. */
export async function sendLog(guild: Guild, category: LogCategory, embed: EmbedBuilder, channelOverride?: string | null): Promise<void> {
  recordAudit(guild, category, embed);
  try {
    const { logging } = await getConfig(guild.id);
    let channelId = channelOverride ?? null;
    if (!channelId) {
      if (!logging.enabled || logging.disabled.includes(category)) return;
      channelId = logging.channels[category] ?? logging.defaultChannelId;
    }
    const channel = getTextChannel(guild, channelId);
    if (channel) await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    logger.warn({ err, guild: guild.id, category }, 'Could not send a log message. Check my permissions in the log channel');
  }
}
