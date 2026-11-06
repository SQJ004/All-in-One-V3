import { ChannelType, PermissionFlagsBits, SlashCommandBuilder, type Message } from 'discord.js';
import { postableChannel } from '../../core/channels.js';
import { getConfig, updateConfig } from '../../core/configService.js';
import { logger } from '../../core/logger.js';
import { roleAssignBlock } from '../../core/permissions.js';
import { on, UserError, type VortexModule } from '../../core/types.js';
import { progressBar, safeMentions } from '../../core/util.js';
import { renderVars, userVars } from '../../core/variables.js';
import { MemberLevel } from '../../db/models.js';
import { panelEmbed, replyEmbed, replyOk } from '../../ui/theme.js';
import { getTextChannel } from '../logging/service.js';

/** Total XP required to reach `level`. */
export const xpForLevel = (level: number): number => Math.round((5 / 3) * level ** 3 + 22.5 * level ** 2 + 75.8 * level);

export function levelForXp(xp: number): number {
  let level = 0;
  while (xpForLevel(level + 1) <= xp) level++;
  return level;
}

export function levelProgress(xp: number) {
  const level = levelForXp(xp);
  const start = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return { level, current: xp - start, needed: next - start, ratio: (xp - start) / (next - start) };
}

/** Atomic award: the lastXpAt guard means concurrent messages cannot double-award during the cooldown. */
export async function awardXp(guildId: string, userId: string, amount: number, cooldownSec: number, now = new Date()) {
  const cutoff = new Date(now.getTime() - cooldownSec * 1000);
  await MemberLevel.updateOne({ guildId, userId }, { $setOnInsert: { xp: 0, level: 0, messages: 0 } }, { upsert: true });
  const doc = await MemberLevel.findOneAndUpdate(
    { guildId, userId, $or: [{ lastXpAt: null }, { lastXpAt: { $lte: cutoff } }] },
    { $inc: { xp: amount, messages: 1 }, $set: { lastXpAt: now } },
  );
  if (!doc) {
    await MemberLevel.updateOne({ guildId, userId }, { $inc: { messages: 1 } });
    return null;
  }
  const level = levelForXp(doc.xp);
  if (level > doc.level) {
    await MemberLevel.updateOne({ _id: doc._id }, { $set: { level } });
    return { leveledUp: true, level, xp: doc.xp };
  }
  return { leveledUp: false, level, xp: doc.xp };
}

async function onMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || message.webhookId || !message.member) return;
  const { community } = await getConfig(message.guildId);
  const cfg = community.levels;
  if (!cfg.enabled || cfg.ignoredChannels.includes(message.channelId) || cfg.ignoredRoles.some((r) => message.member!.roles.cache.has(r))) return;
  const low = Math.min(cfg.xpMin, cfg.xpMax);
  const high = Math.max(cfg.xpMin, cfg.xpMax);
  const amount = Math.round((low + Math.random() * (high - low)) * cfg.multiplier);
  const result = await awardXp(message.guildId, message.author.id, amount, cfg.cooldownSec);
  if (!result?.leveledUp) return;

  const earned = cfg.rewards.filter((r) => r.level <= result.level).map((r) => r.roleId).filter((id) => {
    const role = message.guild.roles.cache.get(id);
    return role && !roleAssignBlock(role, message.guild.members.me!) && !message.member!.roles.cache.has(id);
  });
  if (earned.length) await message.member.roles.add(earned, `ZYTHERON level ${result.level} reward`).catch((err) => logger.debug({ err }, 'Level reward failed'));

  if (cfg.announce) {
    const text = renderVars(cfg.announceMessage, { ...userVars(message.author, message.guild), level: result.level });
    const channel = getTextChannel(message.guild, cfg.announceChannelId) ?? message.channel;
    await channel.send({ embeds: [panelEmbed('Level up', text)], allowedMentions: safeMentions }).catch(() => undefined);
  }
}

export const levelsModule: VortexModule = {
  name: 'levels',
  commands: [{
    perms: { setup: [PermissionFlagsBits.ManageGuild], reward: [PermissionFlagsBits.ManageGuild], 'set-xp': [PermissionFlagsBits.ManageGuild], ignore: [PermissionFlagsBits.ManageGuild] },
    data: new SlashCommandBuilder().setName('level').setDescription('Leveling system').setDMPermission(false)
      .addSubcommand((s) => s.setName('setup').setDescription('Turn leveling on or off').addBooleanOption((o) => o.setName('enabled').setDescription('Enabled').setRequired(true))
        .addChannelOption((o) => o.setName('announce_channel').setDescription('Level-up channel (default: where it happened)').addChannelTypes(ChannelType.GuildText))
        .addBooleanOption((o) => o.setName('announce').setDescription('Announce level ups'))
        .addIntegerOption((o) => o.setName('cooldown').setDescription('Seconds between XP awards').setMinValue(0).setMaxValue(3600))
        .addNumberOption((o) => o.setName('multiplier').setDescription('XP multiplier').setMinValue(0.1).setMaxValue(10)))
      .addSubcommand((s) => s.setName('rank').setDescription('Show a rank card').addUserOption((o) => o.setName('user').setDescription('Member')))
      .addSubcommand((s) => s.setName('leaderboard').setDescription('Top members'))
      .addSubcommand((s) => s.setName('reward').setDescription('Give a role at a level').addIntegerOption((o) => o.setName('level').setDescription('Level').setMinValue(1).setMaxValue(1000).setRequired(true)).addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)).addBooleanOption((o) => o.setName('remove').setDescription('Remove this reward')))
      .addSubcommand((s) => s.setName('set-xp').setDescription('Set a member\'s XP').addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)).addIntegerOption((o) => o.setName('xp').setDescription('XP').setMinValue(0).setMaxValue(100_000_000).setRequired(true)))
      .addSubcommand((s) => s.setName('ignore').setDescription('Stop or resume XP in a channel').addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText)).addBooleanOption((o) => o.setName('remove').setDescription('Resume XP here')))
      .toJSON(),
    async execute(i) {
      const sub = i.options.getSubcommand();
      const { community } = await getConfig(i.guildId);
      const cfg = community.levels;
      if (sub === 'setup') {
        const patch: Record<string, unknown> = { enabled: i.options.getBoolean('enabled', true) };
        const channel = i.options.getChannel('announce_channel');
        const announce = i.options.getBoolean('announce');
        const cooldown = i.options.getInteger('cooldown');
        const multiplier = i.options.getNumber('multiplier');
        if (channel) { postableChannel(i.guild, channel.id); patch.announceChannelId = channel.id; }
        if (announce !== null) patch.announce = announce;
        if (cooldown !== null) patch.cooldownSec = cooldown;
        if (multiplier !== null) patch.multiplier = multiplier;
        await updateConfig(i.guildId, 'community', { levels: patch });
        return replyOk(i, `Leveling is ${patch.enabled ? 'on' : 'off'}.`);
      }
      if (sub === 'rank') {
        const user = i.options.getUser('user') ?? i.user;
        const doc = await MemberLevel.findOne({ guildId: i.guildId, userId: user.id });
        const xp = doc?.xp ?? 0;
        const p = levelProgress(xp);
        const rank = (await MemberLevel.countDocuments({ guildId: i.guildId, xp: { $gt: xp } })) + 1;
        return replyEmbed(i, panelEmbed(user.displayName).setThumbnail(user.displayAvatarURL({ size: 128 })).addFields(
          { name: 'Level', value: `**${p.level}**`, inline: true }, { name: 'Rank', value: `#${rank}`, inline: true }, { name: 'Messages', value: String(doc?.messages ?? 0), inline: true },
          { name: 'Progress', value: `\`${progressBar(p.ratio, 20)}\`\n${p.current.toLocaleString()} / ${p.needed.toLocaleString()} XP` },
        ));
      }
      if (sub === 'leaderboard') {
        const top = await MemberLevel.find({ guildId: i.guildId }).sort({ xp: -1 }).limit(10);
        return replyEmbed(i, panelEmbed('Leaderboard', top.length ? top.map((d, n) => `**${n + 1}.** <@${d.userId}> ${'·'} level ${levelForXp(d.xp)} ${'·'} ${d.xp.toLocaleString()} XP`).join('\n') : 'Nobody has earned XP yet.'));
      }
      if (sub === 'reward') {
        const level = i.options.getInteger('level', true);
        const role = i.options.getRole('role', true);
        const others = cfg.rewards.filter((r) => !(r.level === level && r.roleId === role.id));
        if (i.options.getBoolean('remove')) {
          await updateConfig(i.guildId, 'community', { levels: { rewards: others } });
          return replyOk(i, 'Reward removed.');
        }
        const block = roleAssignBlock(i.guild.roles.cache.get(role.id)!, i.guild.members.me!, i.member);
        if (block) throw new UserError(block);
        await updateConfig(i.guildId, 'community', { levels: { rewards: [...others, { level, roleId: role.id }] } });
        return replyOk(i, `Members reaching level **${level}** get <@&${role.id}>.`);
      }
      if (sub === 'set-xp') {
        const user = i.options.getUser('user', true);
        const xp = i.options.getInteger('xp', true);
        await MemberLevel.updateOne({ guildId: i.guildId, userId: user.id }, { $set: { xp, level: levelForXp(xp) } }, { upsert: true });
        return replyOk(i, `${user} now has **${xp.toLocaleString()}** XP (level ${levelForXp(xp)}).`);
      }
      const channel = i.options.getChannel('channel', true);
      const next = i.options.getBoolean('remove') ? cfg.ignoredChannels.filter((c) => c !== channel.id) : [...new Set([...cfg.ignoredChannels, channel.id])];
      await updateConfig(i.guildId, 'community', { levels: { ignoredChannels: next } });
      await replyOk(i, 'XP channels updated.');
    },
  }],
  events: [on('messageCreate', onMessage)],
};
