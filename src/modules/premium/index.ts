import { ChannelType, Events, PermissionFlagsBits as P, type Client, type Guild, type GuildBasedChannel, type Message, type TextChannel, type VoiceState } from 'discord.js';
import { getConfig } from '../../core/configService.js';
import { logger } from '../../core/logger.js';
import { roleAssignBlock } from '../../core/permissions.js';
import { on, type VortexModule } from '../../core/types.js';
import { Meta } from '../../db/models.js';
import { panelEmbed } from '../../ui/theme.js';

/** Sticky messages, auto purge and voice link. They are set up on the dashboard. */
const STICKY_DELAY_MS = 5000;
const PURGE_EVERY_MS = 5 * 60_000;
const DISCORD_BULK_LIMIT_MS = 14 * 86_400_000 - 60_000; // Discord cannot bulk delete older messages

const stickyKey = (channelId: string) => `sticky:${channelId}`;
const stickyTimers = new Map<string, NodeJS.Timeout>();

/** Moves a channel's sticky message back to the bottom. */
export async function repostSticky(guild: Guild, channelId: string): Promise<void> {
  const item = (await getConfig(guild.id)).sticky.items.find((s) => s.channelId === channelId);
  if (!item) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isTextBased() || !('send' in channel)) return;
  const previous = await Meta.findById(stickyKey(channelId));
  if (previous?.value) await channel.messages.delete(previous.value).catch(() => undefined);
  const sent = await channel.send({ embeds: [panelEmbed('Pinned message', item.content)], allowedMentions: { parse: [] } });
  await Meta.updateOne({ _id: stickyKey(channelId) }, { $set: { value: sent.id } }, { upsert: true });
}

/** Waits for a quiet moment, so a busy channel does not see the sticky jump on every message. */
export async function onStickyMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.id === message.client.user?.id) return;
  const { sticky } = await getConfig(message.guild.id);
  if (!sticky.items.some((s) => s.channelId === message.channelId)) return;
  const waiting = stickyTimers.get(message.channelId);
  if (waiting) clearTimeout(waiting);
  const { guild, channelId } = message;
  const timer = setTimeout(() => {
    stickyTimers.delete(channelId);
    repostSticky(guild, channelId).catch((err) => logger.warn({ err, channelId }, 'Could not repost a sticky message'));
  }, STICKY_DELAY_MS);
  timer.unref();
  stickyTimers.set(channelId, timer);
}

/** Gives a role while someone is in a voice channel, and takes it away when they leave. */
export async function onVoiceLink(before: VoiceState, after: VoiceState): Promise<void> {
  if (before.channelId === after.channelId) return;
  const member = after.member ?? before.member;
  const me = after.guild.members.me;
  if (!member || member.user.bot || !me) return;
  const { items } = (await getConfig(after.guild.id)).voiceLink;
  const give = new Set(items.filter((v) => v.channelId === after.channelId).map((v) => v.roleId));
  const take = items.filter((v) => v.channelId === before.channelId && !give.has(v.roleId)).map((v) => v.roleId);
  for (const [roleId, add] of [...[...give].map((id) => [id, true] as const), ...take.map((id) => [id, false] as const)]) {
    const role = after.guild.roles.cache.get(roleId);
    // Checked again here, because a role's permissions can change after it was linked.
    const blocked = role ? roleAssignBlock(role, me) : 'That role no longer exists.';
    if (blocked || !role) {
      logger.warn({ guildId: after.guild.id, roleId, blocked }, 'Voice link could not change a role');
      continue;
    }
    await (add ? member.roles.add(role, 'Voice link') : member.roles.remove(role, 'Voice link')).catch((err) => logger.warn({ err, roleId }, 'Voice link could not change a role'));
  }
}

const canPurge = (channel: GuildBasedChannel | undefined, guild: Guild): channel is TextChannel => {
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) return false;
  const me = guild.members.me;
  return Boolean(me && channel.permissionsFor(me).has([P.ViewChannel, P.ReadMessageHistory, P.ManageMessages]));
};

/** Deletes old messages in chosen channels, always leaving pinned ones. */
export async function runAutoPurge(client: Client, now = Date.now()): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    const { items } = (await getConfig(guild.id)).autoPurge;
    for (const item of items) {
      const channel = guild.channels.cache.get(item.channelId);
      if (!canPurge(channel, guild)) {
        logger.warn({ guildId: guild.id, channelId: item.channelId }, 'Auto purge skipped a channel: it is missing, or I lack Manage Messages or Read Message History there');
        continue;
      }
      try {
        const messages = await channel.messages.fetch({ limit: 100 });
        const old = messages.filter((m) => !m.pinned && now - m.createdTimestamp > item.afterMinutes * 60_000 && now - m.createdTimestamp < DISCORD_BULK_LIMIT_MS);
        if (old.size) await channel.bulkDelete(old, true);
      } catch (err) {
        logger.warn({ err, channelId: item.channelId }, 'Auto purge could not clean a channel');
      }
    }
  }
}

export const premiumModule: VortexModule = {
  name: 'premium',
  events: [
    on(Events.MessageCreate, onStickyMessage),
    on(Events.VoiceStateUpdate, onVoiceLink),
  ],
  intervals: [{ name: 'auto-purge', everyMs: PURGE_EVERY_MS, run: runAutoPurge }],
};
