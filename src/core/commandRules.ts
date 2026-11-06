import { PermissionFlagsBits, type GuildMember } from 'discord.js';
import { getConfig } from './configService.js';

/** Always usable, so an admin account cannot switch off protection before attacking a server. */
export const ALWAYS_ON = new Set(['security', 'help', 'setup']);

interface ChannelLike { id: string; parentId?: string | null; isThread?(): boolean }

/** A server's settings for one command, if it has any. */
export async function commandRule(guildId: string, name: string) {
  return ALWAYS_ON.has(name) ? undefined : (await getConfig(guildId)).commands.rules[name];
}

/**
 * Checks a server's own rules from the dashboard's Commands page. Returns why the command
 * cannot run here, or null if it can. Slash commands and v! commands both come through this.
 */
export async function commandBlockReason(guildId: string, name: string, member: GuildMember, channel: ChannelLike | null): Promise<string | null> {
  if (ALWAYS_ON.has(name)) return null;
  const { commands } = await getConfig(guildId);
  if (commands.disabled.includes(name)) return `**/${name}** is turned off on this server.`;
  const rule = commands.rules[name];
  if (!rule) return null;
  // Limits are for members. The people who set them should never lock themselves out.
  if (member.guild.ownerId === member.id || member.permissions.has(PermissionFlagsBits.Administrator)) return null;
  if (rule.disabledRoleIds.some((id) => member.roles.cache.has(id))) return `**/${name}** is not available to one of your roles.`;
  if (rule.allowedRoleIds.length && !rule.allowedRoleIds.some((id) => member.roles.cache.has(id))) {
    return `**/${name}** is limited to these roles: ${rule.allowedRoleIds.map((id) => `<@&${id}>`).join(' ')}`;
  }
  const here = channel?.isThread?.() ? channel.parentId : channel?.id;
  if (here && rule.disabledChannelIds.includes(here)) return `**/${name}** can't be used in this channel.`;
  if (rule.allowedChannelIds.length) {
    if (!here || !rule.allowedChannelIds.includes(here)) return `**/${name}** can only be used in: ${rule.allowedChannelIds.map((id) => `<#${id}>`).join(' ')}`;
  }
  return null;
}
