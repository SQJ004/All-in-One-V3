import { ChannelType, PermissionFlagsBits as P, PermissionsBitField, type Guild, type GuildMember, type GuildTextBasedChannel } from 'discord.js';
import { UserError } from './types.js';

const POSTABLE = new Set<ChannelType>([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread, ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

const names = (bits: bigint[]): string => bits.flatMap((b) => new PermissionsBitField(b).toArray()).join(', ');

/**
 * Returns a channel the bot can really post embeds in, or explains why not. With `actor`,
 * also requires that person to be able to post there, so nobody can use the bot to reach a
 * channel they could not reach themselves. Discord's own errors still get handled centrally.
 */
export function postableChannel(guild: Guild, channelId: string | null | undefined, actor?: GuildMember | null, extra: bigint[] = []): GuildTextBasedChannel {
  const channel = channelId ? guild.channels.cache.get(channelId) : undefined;
  if (!channel) throw new UserError('That channel no longer exists, or I cannot see it.');
  if (!POSTABLE.has(channel.type)) throw new UserError(`<#${channel.id}> is not a channel I can post messages in. Choose a text channel.`);
  const send = channel.isThread() ? P.SendMessagesInThreads : P.SendMessages;
  const me = guild.members.me;
  if (!me) throw new UserError('I could not load my own permissions. Please try again in a moment.');
  const mine = channel.permissionsFor(me);
  const missing = [P.ViewChannel, send, P.EmbedLinks, ...extra].filter((bit) => !mine.has(bit));
  if (missing.length) throw new UserError(`I cannot post in <#${channel.id}>. I am missing: **${names(missing)}**. Check my role and that channel's permissions.`);
  if (actor) {
    const theirs = channel.permissionsFor(actor);
    const lacking = [P.ViewChannel, send].filter((bit) => !theirs.has(bit));
    if (lacking.length) throw new UserError(`You cannot post in <#${channel.id}> yourself, so I cannot do it for you.`);
  }
  return channel as GuildTextBasedChannel;
}
