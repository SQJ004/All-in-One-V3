import { randomInt } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, ModalBuilder, PermissionFlagsBits, SlashCommandBuilder, TextInputBuilder, TextInputStyle,
  type Client, type Collection, type Guild, type GuildMember, type Invite, type Message, type PartialGuildMember,
} from 'discord.js';
import { postableChannel } from '../../core/channels.js';
import { getConfig, updateConfig } from '../../core/configService.js';
import { logger } from '../../core/logger.js';
import { roleAssignBlock } from '../../core/permissions.js';
import { Cooldown } from '../../core/rateLimit.js';
import { cancelJobs, scheduleJob } from '../../core/scheduler.js';
import { on, UserError, type SlashCommand, type VortexModule } from '../../core/types.js';
import { discordTime, formatDuration, hexToInt, safeMentions, truncate, utcDate } from '../../core/util.js';
import { renderVars, userVars } from '../../core/variables.js';
import { Afk, Birthday, Case, DailyStat, InviteRecord, MemberLevel, Profile } from '../../db/models.js';
import { baseEmbed, COLORS, panelEmbed, replyEmbed, replyOk } from '../../ui/theme.js';
import { getTextChannel } from '../logging/service.js';
import { levelForXp } from './levels.js';

const P = PermissionFlagsBits;

// ---------- Invite tracking ----------
const inviteCache = new Map<string, Map<string, number>>();

async function refreshInvites(guild: Guild): Promise<Collection<string, Invite> | null> {
  if (!guild.members.me?.permissions.has(P.ManageGuild)) return null;
  const invites = await guild.invites.fetch().catch(() => null);
  if (invites) inviteCache.set(guild.id, new Map(invites.map((x) => [x.code, x.uses ?? 0])));
  return invites;
}

/** Loads members and invites, so counters, role recovery and invite tracking see everyone from the start. */
async function prepareGuild(guild: Guild): Promise<void> {
  await guild.members.fetch().catch((err) => logger.warn({ err, guild: guild.id }, 'Could not load the member list'));
  await refreshInvites(guild);
}

/** Finds the invite whose use count went up. Null when ambiguous, rather than crediting the wrong person. */
export function detectUsedInvite(before: Map<string, number>, after: Array<{ code: string; uses: number; inviterId: string | null }>): { code: string; inviterId: string | null } | null {
  const used = after.filter((x) => x.uses > (before.get(x.code) ?? 0));
  return used.length === 1 ? { code: used[0]!.code, inviterId: used[0]!.inviterId } : null;
}

async function trackJoin(member: GuildMember): Promise<void> {
  const { community } = await getConfig(member.guild.id);
  if (!community.invites.enabled) return;
  const before = inviteCache.get(member.guild.id) ?? new Map<string, number>();
  const invites = await refreshInvites(member.guild);
  if (!invites) return;
  const hit = detectUsedInvite(before, invites.map((x) => ({ code: x.code, uses: x.uses ?? 0, inviterId: x.inviterId })));
  await InviteRecord.updateOne({ guildId: member.guild.id, memberId: member.id }, { $set: { inviterId: hit?.inviterId ?? null, code: hit?.code ?? null, left: false } }, { upsert: true });
}

const invitesCommand: SlashCommand = {
  data: new SlashCommandBuilder().setName('invites').setDescription('Invite tracking').setDMPermission(false)
    .addSubcommand((s) => s.setName('user').setDescription('See invites for a member').addUserOption((o) => o.setName('user').setDescription('Member')))
    .addSubcommand((s) => s.setName('leaderboard').setDescription('Top inviters'))
    .toJSON(),
  async execute(i) {
    if (i.options.getSubcommand() === 'leaderboard') {
      const totals = new Map<string, { _id: string; total: number; left: number }>();
      for (const r of await InviteRecord.find({ guildId: i.guildId, inviterId: { $ne: null } })) {
        const t = totals.get(r.inviterId!) ?? { _id: r.inviterId!, total: 0, left: 0 };
        t.total++;
        if (r.left) t.left++;
        totals.set(r.inviterId!, t);
      }
      const top = [...totals.values()].sort((a, b) => b.total - a.total).slice(0, 10);
      return replyEmbed(i, panelEmbed('Top Inviters', top.length ? top.map((t, n) => `**${n + 1}.** <@${t._id}> ${'·'} ${t.total - t.left} current (${t.total} total)`).join('\n') : 'No tracked invites yet.'));
    }
    const user = i.options.getUser('user') ?? i.user;
    const [total, left, by] = await Promise.all([
      InviteRecord.countDocuments({ guildId: i.guildId, inviterId: user.id }),
      InviteRecord.countDocuments({ guildId: i.guildId, inviterId: user.id, left: true }),
      InviteRecord.findOne({ guildId: i.guildId, memberId: user.id }),
    ]);
    await replyEmbed(i, panelEmbed(`Invites ${'·'} ${user.displayName}`).addFields({ name: 'Current', value: String(total - left), inline: true }, { name: 'Left', value: String(left), inline: true }, { name: 'Invited by', value: by?.inviterId ? `<@${by.inviterId}>` : 'Unknown', inline: true }));
  },
};

// ---------- Daily stats ----------
const pendingStats = new Map<string, { messages: number; joins: number; leaves: number }>();
const bump = (guildId: string, key: 'messages' | 'joins' | 'leaves') => {
  const s = pendingStats.get(guildId) ?? { messages: 0, joins: 0, leaves: 0 };
  s[key]++;
  pendingStats.set(guildId, s);
};

export async function flushStats(): Promise<void> {
  const date = utcDate();
  const batch = [...pendingStats.entries()];
  pendingStats.clear();
  for (const [guildId, s] of batch) await DailyStat.updateOne({ guildId, date }, { $inc: s }, { upsert: true });
}

const METRICS: Record<string, (g: Guild) => number> = {
  members: (g) => g.memberCount,
  humans: (g) => g.members.cache.filter((m) => !m.user.bot).size,
  bots: (g) => g.members.cache.filter((m) => m.user.bot).size,
  channels: (g) => g.channels.cache.size,
  roles: (g) => g.roles.cache.size - 1,
  boosts: (g) => g.premiumSubscriptionCount ?? 0,
};

async function updateStatChannels(client: Client<true>): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    const { community } = await getConfig(guild.id);
    for (const stat of community.statsChannels) {
      const channel = guild.channels.cache.get(stat.channelId);
      if (!channel || channel.isThread()) continue;
      const name = truncate(stat.template.replace('{count}', METRICS[stat.metric]!(guild).toLocaleString()), 100);
      // Discord allows 2 renames per 10 minutes, so unchanged names are skipped.
      if (channel.name !== name) await channel.setName(name, 'ZYTHERON statistics').catch((err) => logger.debug({ err }, 'Stat channel rename failed'));
    }
  }
}

const statsCommand: SlashCommand = {
  perms: { counter: [P.ManageChannels], 'counter-remove': [P.ManageChannels] },
  botPerms: { counter: [P.ManageChannels] },
  data: new SlashCommandBuilder().setName('serverstats').setDescription('Server statistics').setDMPermission(false)
    .addSubcommand((s) => s.setName('view').setDescription('Show server statistics'))
    .addSubcommand((s) => s.setName('counter').setDescription('Create a live counter voice channel')
      .addStringOption((o) => o.setName('metric').setDescription('What to count').setRequired(true).addChoices(...Object.keys(METRICS).map((m) => ({ name: m, value: m }))))
      .addStringOption((o) => o.setName('label').setDescription('Label before the number, e.g. Members').setMaxLength(60)))
    .addSubcommand((s) => s.setName('counter-remove').setDescription('Stop updating a counter').addChannelOption((o) => o.setName('channel').setDescription('Counter channel').addChannelTypes(ChannelType.GuildVoice).setRequired(true)))
    .toJSON(),
  async execute(i) {
    const sub = i.options.getSubcommand();
    const { community } = await getConfig(i.guildId);
    if (sub === 'counter') {
      if (community.statsChannels.length >= 5) throw new UserError('Up to 5 counters per server.');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const metric = i.options.getString('metric', true);
      const label = i.options.getString('label') ?? metric[0]!.toUpperCase() + metric.slice(1);
      const template = `${label}: {count}`;
      const channel = await i.guild.channels.create({ name: truncate(template.replace('{count}', METRICS[metric]!(i.guild).toLocaleString()), 100), type: ChannelType.GuildVoice, permissionOverwrites: [{ id: i.guild.roles.everyone.id, deny: [P.Connect] }], reason: 'ZYTHERON statistics' });
      await updateConfig(i.guildId, 'community', { statsChannels: [...community.statsChannels, { channelId: channel.id, template, metric }] });
      return replyOk(i, `Counter created: <#${channel.id}>. It refreshes every 10 minutes.`);
    }
    if (sub === 'counter-remove') {
      const channel = i.options.getChannel('channel', true);
      await updateConfig(i.guildId, 'community', { statsChannels: community.statsChannels.filter((s) => s.channelId !== channel.id) });
      return replyOk(i, 'Counter removed. You can now delete the channel.');
    }
    const g = i.guild;
    const days = await DailyStat.find({ guildId: g.id }).sort({ date: -1 }).limit(7);
    const sum = (k: 'messages' | 'joins' | 'leaves') => days.reduce((n, d) => n + d[k], 0);
    await replyEmbed(i, panelEmbed(g.name).setThumbnail(g.iconURL()).addFields(
      { name: 'Members', value: g.memberCount.toLocaleString(), inline: true },
      { name: 'Channels', value: String(g.channels.cache.size), inline: true },
      { name: 'Roles', value: String(g.roles.cache.size - 1), inline: true },
      { name: 'Boosts', value: `${g.premiumSubscriptionCount ?? 0} (tier ${g.premiumTier})`, inline: true },
      { name: 'Created', value: discordTime(g.createdAt, 'D'), inline: true },
      { name: 'Owner', value: `<@${g.ownerId}>`, inline: true },
      { name: 'Last 7 days', value: `${sum('messages').toLocaleString()} messages ${'·'} ${sum('joins')} joins ${'·'} ${sum('leaves')} leaves` },
    ));
  },
};

// ---------- Birthdays ----------
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export const validBirthday = (month: number, day: number): boolean => month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1]!;

/** Birthdays due today. Feb 29 is celebrated on Feb 28 in non-leap years. */
export function birthdayDates(now: Date): Array<{ month: number; day: number }> {
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const dates = [{ month, day }];
  const year = now.getUTCFullYear();
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (!leap && month === 2 && day === 28) dates.push({ month: 2, day: 29 });
  return dates;
}

export async function runBirthdays(client: Client<true>, now = new Date()): Promise<void> {
  const year = now.getUTCFullYear();
  const due = await Birthday.find({ $or: birthdayDates(now), lastCelebratedYear: { $ne: year } });
  for (const b of due) {
    const guild = client.guilds.cache.get(b.guildId);
    if (!guild) continue;
    const { community } = await getConfig(b.guildId);
    if (!community.birthdays.enabled) continue;
    const res = await Birthday.updateOne({ _id: b._id, lastCelebratedYear: { $ne: year } }, { $set: { lastCelebratedYear: year } });
    if (!res.modifiedCount) continue;
    const member = await guild.members.fetch(b.userId).catch(() => null);
    if (!member) continue;
    const channel = getTextChannel(guild, community.birthdays.channelId);
    await channel?.send({ embeds: [panelEmbed('Happy Birthday', renderVars(community.birthdays.message, userVars(member.user, guild)), COLORS.primary)], content: `${member}`, allowedMentions: safeMentions }).catch(() => undefined);
    const roleId = community.birthdays.roleId;
    const role = roleId ? guild.roles.cache.get(roleId) : undefined;
    if (role && !roleAssignBlock(role, guild.members.me!)) {
      await member.roles.add(role, 'Birthday').catch(() => undefined);
      await scheduleJob('role.expire', guild.id, new Date(now.getTime() + 86_400_000), { userId: member.id, roleId: role.id }, `birthday:${guild.id}:${member.id}`);
    }
  }
}

const birthdayCommand: SlashCommand = {
  perms: { setup: [P.ManageGuild] },
  data: new SlashCommandBuilder().setName('birthday').setDescription('Birthday system').setDMPermission(false)
    .addSubcommand((s) => s.setName('set').setDescription('Save your birthday').addIntegerOption((o) => o.setName('month').setDescription('Month').setMinValue(1).setMaxValue(12).setRequired(true)).addIntegerOption((o) => o.setName('day').setDescription('Day').setMinValue(1).setMaxValue(31).setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove your birthday'))
    .addSubcommand((s) => s.setName('upcoming').setDescription('See upcoming birthdays'))
    .addSubcommand((s) => s.setName('setup').setDescription('Set up announcements').addChannelOption((o) => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true)).addRoleOption((o) => o.setName('role').setDescription('Role to wear for the day')))
    .toJSON(),
  async execute(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'setup') {
      const role = i.options.getRole('role');
      postableChannel(i.guild, i.options.getChannel('channel', true).id);
      await updateConfig(i.guildId, 'community', { birthdays: { enabled: true, channelId: i.options.getChannel('channel', true).id, ...(role ? { roleId: role.id } : {}) } });
      return replyOk(i, 'Birthdays are on. Members can add theirs with `/birthday set`.');
    }
    if (sub === 'set') {
      const month = i.options.getInteger('month', true);
      const day = i.options.getInteger('day', true);
      if (!validBirthday(month, day)) throw new UserError('That date does not exist.');
      await Birthday.updateOne({ guildId: i.guildId, userId: i.user.id }, { $set: { month, day } }, { upsert: true });
      return replyOk(i, 'Birthday saved.');
    }
    if (sub === 'remove') {
      await Birthday.deleteOne({ guildId: i.guildId, userId: i.user.id });
      return replyOk(i, 'Birthday removed.');
    }
    const all = await Birthday.find({ guildId: i.guildId });
    const now = new Date();
    const key = (b: { month: number; day: number }) => {
      const thisYear = Date.UTC(now.getUTCFullYear(), b.month - 1, b.day);
      return thisYear >= Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) ? thisYear : Date.UTC(now.getUTCFullYear() + 1, b.month - 1, b.day);
    };
    const next = all.sort((a, b) => key(a) - key(b)).slice(0, 10);
    await replyEmbed(i, panelEmbed('Upcoming Birthdays', next.length ? next.map((b) => `${discordTime(key(b), 'D')} <@${b.userId}>`).join('\n') : 'Nobody has added a birthday yet.'));
  },
};

// ---------- AFK ----------
const afkNotice = new Cooldown();

async function handleAfk(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot) return;
  const { community } = await getConfig(message.guildId);
  if (!community.afk.enabled) return;
  const back = await Afk.findOneAndDelete({ guildId: message.guildId, userId: message.author.id });
  if (back) {
    const notice = await message.reply({ embeds: [baseEmbed(COLORS.accent).setDescription(`Welcome back. You were AFK for ${formatDuration(Date.now() - back.createdAt.getTime())}.`)], allowedMentions: { repliedUser: false } }).catch(() => null);
    if (notice) setTimeout(() => void notice.delete().catch(() => undefined), 6000).unref();
    const member = message.member;
    if (member?.nickname?.startsWith('[AFK] ') && member.manageable) await member.setNickname(member.nickname.slice(6) || null, 'AFK ended').catch(() => undefined);
  }
  const mentioned = [...message.mentions.users.keys()].filter((id) => id !== message.author.id).slice(0, 5);
  if (!mentioned.length) return;
  const afk = await Afk.find({ guildId: message.guildId, userId: { $in: mentioned } });
  const lines = afk.filter((a) => afkNotice.allow(`${message.channelId}:${a.userId}`, 30_000) === 0).map((a) => `<@${a.userId}> is AFK: ${truncate(a.reason, 200)} (${discordTime(a.createdAt)})`);
  if (lines.length) await message.reply({ embeds: [baseEmbed(COLORS.muted).setDescription(lines.join('\n'))], allowedMentions: { parse: [], repliedUser: false } }).catch(() => undefined);
}

const afkCommand: SlashCommand = {
  cooldownSec: 5,
  data: new SlashCommandBuilder().setName('afk').setDescription('Mark yourself as away').setDMPermission(false).addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(200)).toJSON(),
  async execute(i) {
    const { community } = await getConfig(i.guildId);
    if (!community.afk.enabled) throw new UserError('AFK is turned off on this server.');
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const reason = i.options.getString('reason')?.replace(/@(everyone|here)/g, '@​$1') ?? 'Away';
    await Afk.deleteOne({ guildId: i.guildId, userId: i.user.id });
    await Afk.create({ guildId: i.guildId, userId: i.user.id, reason });
    if (i.member.manageable && !i.member.displayName.startsWith('[AFK] ')) await i.member.setNickname(`[AFK] ${i.member.displayName}`.slice(0, 32), 'AFK').catch(() => undefined);
    await replyOk(i, `You are AFK: ${reason}`);
  },
};

// ---------- Welcome challenge ----------
export function mathChallenge(): { question: string; answer: number } {
  const a = randomInt(2, 13);
  const b = randomInt(2, 13);
  return randomInt(0, 2) === 0 ? { question: `${a} + ${b}`, answer: a + b } : { question: `${a} x ${b}`, answer: a * b };
}

const pendingChallenges = new Map<string, { answer: number; expires: number; attempts: number }>();

async function passChallenge(member: GuildMember): Promise<void> {
  const { community } = await getConfig(member.guild.id);
  const roleId = community.challenge.verifiedRoleId;
  if (!roleId) throw new UserError('Verification is not fully set up. Please tell a moderator.');
  const role = member.guild.roles.cache.get(roleId);
  if (!role) throw new UserError('Verification is not fully set up. Please tell a moderator.');
  const block = roleAssignBlock(role, member.guild.members.me!);
  if (block) throw new UserError('Verification is not fully set up. Please tell a moderator.');
  await member.roles.add(role, 'Passed the ZYTHERON welcome challenge');
  await cancelJobs(`challenge:${member.guild.id}:${member.id}`);
}

const challengeCommand: SlashCommand = {
  perms: { '*': [P.ManageGuild] },
  botPerms: { setup: [P.ManageRoles] },
  data: new SlashCommandBuilder().setName('challenge').setDescription('Verify new members').setDefaultMemberPermissions(P.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('setup').setDescription('Post a verification panel')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addRoleOption((o) => o.setName('verified_role').setDescription('Role given after passing').setRequired(true))
      .addStringOption((o) => o.setName('type').setDescription('Type').addChoices({ name: 'Math question', value: 'math' }, { name: 'Button only', value: 'button' }))
      .addIntegerOption((o) => o.setName('kick_after').setDescription('Kick after N minutes if unverified. 0 never kicks.').setMinValue(0).setMaxValue(1440)))
    .addSubcommand((s) => s.setName('off').setDescription('Turn verification off'))
    .toJSON(),
  async execute(i) {
    if (i.options.getSubcommand() === 'off') {
      await updateConfig(i.guildId, 'community', { challenge: { enabled: false } });
      return replyOk(i, 'Verification is off.');
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const channelOpt = i.options.getChannel('channel', true);
    const channel = postableChannel(i.guild, channelOpt.id);
    const role = i.options.getRole('verified_role', true);
    const block = roleAssignBlock(i.guild.roles.cache.get(role.id)!, i.guild.members.me!, i.member);
    if (block) throw new UserError(block);
    const type = i.options.getString('type') ?? 'math';
    await updateConfig(i.guildId, 'community', { challenge: { enabled: true, channelId: channelOpt.id, verifiedRoleId: role.id, type, timeoutMinutes: i.options.getInteger('kick_after') ?? 0 } });
    await channel.send({
      embeds: [panelEmbed('Verification', `Welcome to **${i.guild.name}**. Press the button below to prove you are a real person and unlock the server.`)],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('challenge:start').setLabel('Verify').setStyle(ButtonStyle.Success))],
    });
    await replyOk(i, `Verification panel posted. Passing grants <@&${role.id}>. Remember to hide your channels from @everyone so only verified members can see them.`);
  },
};

// ---------- Profiles ----------
const profileCommand: SlashCommand = {
  cooldownSec: 3,
  data: new SlashCommandBuilder().setName('profile').setDescription('Member profiles').setDMPermission(false)
    .addSubcommand((s) => s.setName('view').setDescription('View a profile').addUserOption((o) => o.setName('user').setDescription('Member')))
    .addSubcommand((s) => s.setName('edit').setDescription('Edit your profile'))
    .toJSON(),
  async execute(i) {
    if (i.options.getSubcommand() === 'edit') {
      const p = await Profile.findOne({ guildId: i.guildId, userId: i.user.id });
      const row = (id: string, label: string, value: string | undefined, style: TextInputStyle, max: number, placeholder?: string) => {
        const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(false);
        if (value) t.setValue(value);
        if (placeholder) t.setPlaceholder(placeholder);
        return new ActionRowBuilder<TextInputBuilder>().addComponents(t);
      };
      return i.showModal(new ModalBuilder().setCustomId('profile:save').setTitle('Your profile').addComponents(
        row('bio', 'About you', p?.bio, TextInputStyle.Paragraph, 500),
        row('pronouns', 'Pronouns', p?.pronouns, TextInputStyle.Short, 30),
        row('color', 'Color', p?.color, TextInputStyle.Short, 7, '#7c3aed'),
        row('link', 'Link', p?.link, TextInputStyle.Short, 200, 'https://...'),
      ));
    }
    const user = i.options.getUser('user') ?? i.user;
    const member = i.options.getMember('user') ?? (user.id === i.user.id ? i.member : null);
    const [p, level, invites, warnings] = await Promise.all([
      Profile.findOne({ guildId: i.guildId, userId: user.id }),
      MemberLevel.findOne({ guildId: i.guildId, userId: user.id }),
      InviteRecord.countDocuments({ guildId: i.guildId, inviterId: user.id, left: false }),
      Case.countDocuments({ guildId: i.guildId, targetId: user.id, type: 'warn', active: true }),
    ]);
    const birthday = await Birthday.findOne({ guildId: i.guildId, userId: user.id });
    const embed = baseEmbed(p?.color ? hexToInt(p.color) : COLORS.primary).setTitle(user.displayName).setThumbnail(user.displayAvatarURL({ size: 256 })).setDescription(p?.bio || '*No bio yet.*').addFields(
      { name: 'Level', value: String(levelForXp(level?.xp ?? 0)), inline: true },
      { name: 'Messages', value: String(level?.messages ?? 0), inline: true },
      { name: 'Invites', value: String(invites), inline: true },
    );
    if (p?.pronouns) embed.addFields({ name: 'Pronouns', value: p.pronouns, inline: true });
    if (birthday) embed.addFields({ name: 'Birthday', value: `${birthday.day}/${birthday.month}`, inline: true });
    if (member?.joinedAt) embed.addFields({ name: 'Joined', value: discordTime(member.joinedAt, 'D'), inline: true });
    if (p?.link) embed.addFields({ name: 'Link', value: p.link });
    // Warnings are staff-only information.
    if (i.member.permissions.has(P.ModerateMembers)) embed.addFields({ name: 'Active warnings (staff only)', value: String(warnings), inline: true });
    await replyEmbed(i, embed);
  },
};

export const membersModule: VortexModule = {
  name: 'members',
  commands: [invitesCommand, statsCommand, birthdayCommand, afkCommand, challengeCommand, profileCommand],
  components: [
    {
      prefix: 'challenge:start',
      async run(i) {
        if (!i.isButton() || !i.inCachedGuild()) return;
        const { community } = await getConfig(i.guildId);
        if (!community.challenge.enabled) throw new UserError('Verification is turned off.');
        if (community.challenge.verifiedRoleId && i.member.roles.cache.has(community.challenge.verifiedRoleId)) return replyOk(i, 'You are already verified.');
        if (community.challenge.type === 'button') {
          await i.deferReply({ flags: MessageFlags.Ephemeral });
          await passChallenge(i.member);
          return replyOk(i, 'You are verified. Welcome!');
        }
        const { question, answer } = mathChallenge();
        const key = `${i.guildId}:${i.user.id}`;
        const attempts = pendingChallenges.get(key)?.attempts ?? 0;
        if (attempts >= 5) throw new UserError('Too many wrong answers. Please contact a moderator.');
        pendingChallenges.set(key, { answer, expires: Date.now() + 300_000, attempts });
        await i.showModal(new ModalBuilder().setCustomId('challenge:answer').setTitle('Verification').addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('answer').setLabel(`What is ${question}?`).setStyle(TextInputStyle.Short).setMaxLength(5).setRequired(true))));
      },
    },
    {
      prefix: 'challenge:answer',
      async run(i) {
        if (!i.isModalSubmit() || !i.inCachedGuild()) return;
        const key = `${i.guildId}:${i.user.id}`;
        const pending = pendingChallenges.get(key);
        if (!pending || pending.expires < Date.now()) throw new UserError('That challenge expired. Press Verify again.');
        if (Number(i.fields.getTextInputValue('answer').trim()) !== pending.answer) {
          pendingChallenges.set(key, { ...pending, answer: Number.NaN, attempts: pending.attempts + 1 });
          throw new UserError('That is not right. Press Verify to try a new question.');
        }
        pendingChallenges.delete(key);
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        await passChallenge(i.member);
        await replyOk(i, 'You are verified. Welcome!');
      },
    },
    {
      prefix: 'profile:save',
      async run(i) {
        if (!i.isModalSubmit() || !i.inCachedGuild()) return;
        const color = i.fields.getTextInputValue('color').trim();
        const link = i.fields.getTextInputValue('link').trim();
        if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new UserError('Color must look like `#7c3aed`.');
        if (link && !/^https?:\/\/\S+$/.test(link)) throw new UserError('Link must start with http:// or https://.');
        await Profile.updateOne({ guildId: i.guildId, userId: i.user.id }, { $set: { bio: i.fields.getTextInputValue('bio'), pronouns: i.fields.getTextInputValue('pronouns'), color: color || '#7c3aed', link } }, { upsert: true });
        await replyOk(i, 'Profile saved.');
      },
    },
  ],
  jobs: {
    'challenge.timeout': async (client, guildId, payload) => {
      const guild = client.guilds.cache.get(guildId);
      const member = await guild?.members.fetch(payload.userId).catch(() => null);
      if (!guild || !member) return;
      const { community } = await getConfig(guildId);
      if (!community.challenge.enabled || !community.challenge.verifiedRoleId || member.roles.cache.has(community.challenge.verifiedRoleId)) return;
      if (member.kickable) await member.kick('Did not complete verification in time');
    },
  },
  events: [
    on('messageCreate', (message) => {
      if (message.inGuild() && !message.author.bot) bump(message.guildId, 'messages');
      return handleAfk(message);
    }),
    on('guildMemberAdd', async (member) => {
      bump(member.guild.id, 'joins');
      await trackJoin(member);
      const { community } = await getConfig(member.guild.id);
      if (community.challenge.enabled && community.challenge.timeoutMinutes > 0 && !member.user.bot) {
        await scheduleJob('challenge.timeout', member.guild.id, new Date(Date.now() + community.challenge.timeoutMinutes * 60_000), { userId: member.id }, `challenge:${member.guild.id}:${member.id}`);
      }
    }),
    on('guildMemberRemove', async (member: GuildMember | PartialGuildMember) => {
      bump(member.guild.id, 'leaves');
      await InviteRecord.updateOne({ guildId: member.guild.id, memberId: member.id }, { $set: { left: true } });
      await cancelJobs(`challenge:${member.guild.id}:${member.id}`);
    }),
    on('inviteCreate', async (invite) => {
      if (invite.guild?.id) inviteCache.get(invite.guild.id)?.set(invite.code, invite.uses ?? 0);
    }),
    on('inviteDelete', async (invite) => {
      if (invite.guild?.id) inviteCache.get(invite.guild.id)?.delete(invite.code);
    }),
    on('guildCreate', prepareGuild),
  ],
  intervals: [
    { name: 'flush-stats', everyMs: 30_000, run: flushStats },
    { name: 'stat-channels', everyMs: 10 * 60_000, run: updateStatChannels },
    { name: 'birthdays', everyMs: 60 * 60_000, run: runBirthdays },
  ],
  onReady: async (client) => {
    for (const guild of client.guilds.cache.values()) await prepareGuild(guild);
    await runBirthdays(client);
  },
};
