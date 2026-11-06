import { MessageFlags } from 'discord.js';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, OverwriteType, PermissionFlagsBits, SlashCommandBuilder,
  type Guild, type GuildBasedChannel, type GuildMember, type SlashCommandStringOption, type SlashCommandUserOption, type GuildTextBasedChannel, type Message, type TextChannel,
} from 'discord.js';
import { postableChannel } from '../../core/channels.js';
import { getConfig, updateConfig } from '../../core/configService.js';
import { logger } from '../../core/logger.js';
import { hasDangerousPermissions, moderationBlock } from '../../core/permissions.js';
import { UserError, type GuildCommand, type SlashCommand, type VortexModule } from '../../core/types.js';
import { discordTime, extractIds, formatDuration, parseDuration, truncate } from '../../core/util.js';
import { Case, type ICase } from '../../db/models.js';
import { baseEmbed, COLORS, ICONS, okEmbed, panelEmbed, replyEmbed, replyFail, replyOk } from '../../ui/theme.js';
import {
  applyWarnThresholds, banUser, caseEmbed, jailMember, kickMember, modJobs, notifyUser, recordCase, timeoutMember, unbanUser, unjailMember, type Actor,
} from './service.js';

const P = PermissionFlagsBits;
const actorOf = (i: GuildCommand): Actor => ({ id: i.user.id, tag: i.user.tag, member: i.member });
const reasonOf = (i: GuildCommand): string => i.options.getString('reason') ?? 'No reason provided';

async function requireMember(i: GuildCommand, option = 'user') {
  const user = i.options.getUser(option, true);
  const member = i.options.getMember(option) ?? (await i.guild.members.fetch(user.id).catch(() => null));
  if (!member) throw new UserError(`${user.tag} is not in this server.`);
  return member;
}

function parseTime(input: string): number {
  const ms = parseDuration(input);
  if (!ms) throw new UserError('Invalid duration. Examples: `30m`, `2h`, `7d`, `1w 2d`.');
  return ms;
}

function textChannel(i: GuildCommand): Exclude<GuildBasedChannel, { type: ChannelType.GuildCategory }> {
  // Look it up in the cache: the option can hold a partial channel, or one that was just deleted.
  const channel = i.guild.channels.cache.get(i.options.getChannel('channel')?.id ?? i.channelId);
  if (!channel) throw new UserError('That channel no longer exists, or I cannot see it.');
  if (channel.isThread() || !('permissionOverwrites' in channel)) throw new UserError('Choose a text or voice channel.');
  return channel as never;
}

const reasonOpt = (o: SlashCommandStringOption) => o.setName('reason').setDescription('Reason').setMaxLength(450);
const userOpt = (o: SlashCommandUserOption) => o.setName('user').setDescription('Member').setRequired(true);

const moderationCommand: SlashCommand = {
  cooldownSec: 1,
  perms: {
    ban: [P.BanMembers], unban: [P.BanMembers], tempban: [P.BanMembers], massban: [P.BanMembers], kick: [P.KickMembers], masskick: [P.KickMembers],
    timeout: [P.ModerateMembers], untimeout: [P.ModerateMembers], warn: [P.ModerateMembers], warnings: [P.ModerateMembers], clearwarnings: [P.ModerateMembers],
    purge: [P.ManageMessages], slowmode: [P.ManageChannels], lock: [P.ManageChannels], unlock: [P.ManageChannels], hide: [P.ManageChannels], unhide: [P.ManageChannels],
    nickname: [P.ManageNicknames], voicemute: [P.MuteMembers], voicedeafen: [P.DeafenMembers], jail: [P.ModerateMembers, P.ManageRoles], unjail: [P.ModerateMembers, P.ManageRoles],
    history: [P.ModerateMembers], note: [P.ModerateMembers], notes: [P.ModerateMembers],
  },
  botPerms: {
    ban: [P.BanMembers], unban: [P.BanMembers], tempban: [P.BanMembers], massban: [P.BanMembers], kick: [P.KickMembers], masskick: [P.KickMembers],
    timeout: [P.ModerateMembers], untimeout: [P.ModerateMembers], purge: [P.ManageMessages, P.ReadMessageHistory], slowmode: [P.ManageChannels],
    lock: [P.ManageChannels], unlock: [P.ManageChannels], hide: [P.ManageChannels], unhide: [P.ManageChannels], nickname: [P.ManageNicknames],
    voicemute: [P.MuteMembers], voicedeafen: [P.DeafenMembers], jail: [P.ManageRoles], unjail: [P.ManageRoles],
  },
  data: new SlashCommandBuilder().setName('moderation').setDescription('Moderation tools')
    .setDefaultMemberPermissions(P.ModerateMembers).setDMPermission(false)
    .addSubcommand((s) => s.setName('ban').setDescription('Ban a user').addUserOption(userOpt).addStringOption(reasonOpt)
      .addIntegerOption((o) => o.setName('delete_days').setDescription('Delete their last N days of messages').setMinValue(0).setMaxValue(7)))
    .addSubcommand((s) => s.setName('tempban').setDescription('Ban a user for a limited time').addUserOption(userOpt)
      .addStringOption((o) => o.setName('duration').setDescription('e.g. 7d, 12h').setRequired(true)).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('unban').setDescription('Unban a user').addStringOption((o) => o.setName('user_id').setDescription('User ID').setRequired(true)).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('kick').setDescription('Kick a member').addUserOption(userOpt).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('timeout').setDescription('Time out a member').addUserOption(userOpt)
      .addStringOption((o) => o.setName('duration').setDescription('e.g. 10m, 2h, 7d (max 28d)').setRequired(true)).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('untimeout').setDescription('Remove a timeout').addUserOption(userOpt).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('warn').setDescription('Warn a member').addUserOption(userOpt).addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(450)))
    .addSubcommand((s) => s.setName('warnings').setDescription('Show active warnings').addUserOption(userOpt))
    .addSubcommand((s) => s.setName('clearwarnings').setDescription('Clear all active warnings').addUserOption(userOpt).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('purge').setDescription('Bulk delete messages')
      .addIntegerOption((o) => o.setName('amount').setDescription('Messages to scan (1-100)').setMinValue(1).setMaxValue(100).setRequired(true))
      .addUserOption((o) => o.setName('user').setDescription('Only this user'))
      .addStringOption((o) => o.setName('contains').setDescription('Only messages containing this text'))
      .addBooleanOption((o) => o.setName('bots').setDescription('Only bot messages')))
    .addSubcommand((s) => s.setName('slowmode').setDescription('Set channel slowmode')
      .addStringOption((o) => o.setName('duration').setDescription('e.g. 10s, 5m, or off').setRequired(true))
      .addChannelOption((o) => o.setName('channel').setDescription('Channel (default: here)').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('lock').setDescription('Stop @everyone sending messages').addChannelOption((o) => o.setName('channel').setDescription('Channel (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement)).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('unlock').setDescription('Undo /moderation lock').addChannelOption((o) => o.setName('channel').setDescription('Channel (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement)).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('hide').setDescription('Hide a channel from @everyone').addChannelOption((o) => o.setName('channel').setDescription('Channel (default: here)')).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('unhide').setDescription('Undo /moderation hide').addChannelOption((o) => o.setName('channel').setDescription('Channel (default: here)')).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('nickname').setDescription('Change or reset a nickname').addUserOption(userOpt).addStringOption((o) => o.setName('nickname').setDescription('New nickname. Leave empty to reset').setMaxLength(32)))
    .addSubcommand((s) => s.setName('voicemute').setDescription('Server mute or unmute in voice').addUserOption(userOpt).addBooleanOption((o) => o.setName('muted').setDescription('Mute or unmute').setRequired(true)).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('voicedeafen').setDescription('Server deafen or undeafen in voice').addUserOption(userOpt).addBooleanOption((o) => o.setName('deafened').setDescription('Deafen or undeafen').setRequired(true)).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('jail').setDescription('Move a member to the jail role').addUserOption(userOpt).addStringOption((o) => o.setName('duration').setDescription('e.g. 2h (empty = until unjailed)')).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('unjail').setDescription('Release from jail and restore roles').addUserOption(userOpt).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('massban').setDescription('Ban several users after confirmation').addStringOption((o) => o.setName('users').setDescription('IDs or mentions').setRequired(true)).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('masskick').setDescription('Kick several members after confirmation').addStringOption((o) => o.setName('users').setDescription('IDs or mentions').setRequired(true)).addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName('history').setDescription('Show a user\'s moderation history').addUserOption(userOpt))
    .addSubcommand((s) => s.setName('note').setDescription('Add a private staff note').addUserOption(userOpt).addStringOption((o) => o.setName('text').setDescription('Note').setRequired(true).setMaxLength(450)))
    .addSubcommand((s) => s.setName('notes').setDescription('Show staff notes').addUserOption(userOpt))
    .toJSON(),

  async execute(i) {
    const sub = i.options.getSubcommand();
    const handler = HANDLERS[sub];
    if (!handler) throw new UserError('Unknown subcommand.');
    // DMs and Discord calls can pass the 3 second reply limit, so acknowledge first.
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await handler(i);
  },
};

const done = (i: GuildCommand, c: Pick<ICase, 'number'>, text: string) => replyOk(i, `${text} ${ICONS.dot} Case **#${c.number}**`);

const HANDLERS: Record<string, (i: GuildCommand) => Promise<unknown>> = {
  async ban(i) {
    const user = i.options.getUser('user', true);
    const c = await banUser(i.guild, actorOf(i), user, reasonOf(i), { deleteMessageDays: i.options.getInteger('delete_days') ?? 0 });
    await done(i, c, `**${user.tag}** was banned.`);
  },
  async tempban(i) {
    const user = i.options.getUser('user', true);
    const ms = parseTime(i.options.getString('duration', true));
    const c = await banUser(i.guild, actorOf(i), user, reasonOf(i), { durationMs: ms });
    await done(i, c, `**${user.tag}** was banned for ${formatDuration(ms)}.`);
  },
  async unban(i) {
    const id = i.options.getString('user_id', true).match(/\d{17,20}/)?.[0];
    if (!id) throw new UserError('That is not a valid user ID.');
    const c = await unbanUser(i.guild, actorOf(i), id, reasonOf(i));
    await done(i, c, `**${c.targetTag}** was unbanned.`);
  },
  async kick(i) {
    const member = await requireMember(i);
    const c = await kickMember(i.guild, actorOf(i), member, reasonOf(i));
    await done(i, c, `**${member.user.tag}** was kicked.`);
  },
  async timeout(i) {
    const member = await requireMember(i);
    const ms = parseTime(i.options.getString('duration', true));
    const c = await timeoutMember(i.guild, actorOf(i), member, ms, reasonOf(i));
    await done(i, c, `**${member.user.tag}** was timed out for ${formatDuration(ms)}.`);
  },
  async untimeout(i) {
    const member = await requireMember(i);
    if (!member.isCommunicationDisabled()) throw new UserError('That member is not timed out.');
    const reason = reasonOf(i);
    await member.timeout(null, `${i.user.tag}: ${reason}`.slice(0, 512));
    const c = await recordCase({ guild: i.guild, type: 'untimeout', targetId: member.id, targetTag: member.user.tag, moderatorId: i.user.id, moderatorTag: i.user.tag, reason });
    await done(i, c, `**${member.user.tag}**'s timeout was removed.`);
  },
  async warn(i) {
    const member = await requireMember(i);
    const block = moderationBlock(i.member, member, i.guild.members.me!);
    if (block) throw new UserError(block);
    const reason = reasonOf(i);
    const c = await recordCase({ guild: i.guild, type: 'warn', targetId: member.id, targetTag: member.user.tag, moderatorId: i.user.id, moderatorTag: i.user.tag, reason });
    const delivered = await notifyUser(i.guild, member, 'warning', reason);
    const active = await Case.countDocuments({ guildId: i.guildId, targetId: member.id, type: 'warn', active: true });
    const auto = await applyWarnThresholds(i.guild, actorOf(i), member, active);
    await done(i, c, `**${member.user.tag}** was warned (${active} active).${delivered ? '' : ' They could not be DMed.'}${auto ? ` Automatic **${auto}** applied.` : ''}`);
  },
  async warnings(i) {
    const user = i.options.getUser('user', true);
    const list = await Case.find({ guildId: i.guildId, targetId: user.id, type: 'warn', active: true }).sort({ number: -1 }).limit(15);
    await replyEmbed(i, panelEmbed(`Warnings ${'·'} ${user.tag}`, list.length ? list.map((c) => `**#${c.number}** ${discordTime(c.createdAt)} by <@${c.moderatorId}>\n${truncate(c.reason, 150)}`).join('\n\n') : 'No active warnings.', list.length ? COLORS.warning : COLORS.success));
  },
  async clearwarnings(i) {
    const user = i.options.getUser('user', true);
    const res = await Case.updateMany({ guildId: i.guildId, targetId: user.id, type: 'warn', active: true }, { $set: { active: false } });
    await replyOk(i, `Cleared **${res.modifiedCount}** warnings for **${user.tag}**.`);
  },
  async purge(i) {
    const channel = i.channel as TextChannel | null;
    if (!channel || !('bulkDelete' in channel)) throw new UserError('Messages cannot be purged in this channel.');
    const amount = i.options.getInteger('amount', true);
    const user = i.options.getUser('user');
    const contains = i.options.getString('contains')?.toLowerCase();
    const bots = i.options.getBoolean('bots');
    const filtered = user || contains || bots;
    const fetched = await channel.messages.fetch({ limit: filtered ? 100 : amount });
    const matches = [...fetched.values()]
      .filter((m: Message) => (!user || m.author.id === user.id) && (!contains || m.content.toLowerCase().includes(contains)) && (!bots || m.author.bot) && !m.pinned)
      .slice(0, amount);
    const deleted = await channel.bulkDelete(matches, true);
    await recordCase({ guild: i.guild, type: 'purge', targetId: channel.id, targetTag: `#${channel.name}`, moderatorId: i.user.id, moderatorTag: i.user.tag, reason: `Purged ${deleted.size} messages${user ? ` from ${user.tag}` : ''}`, meta: { count: deleted.size } });
    const skipped = matches.length - deleted.size;
    await i.editReply({ embeds: [okEmbed(`Deleted **${deleted.size}** messages.${skipped ? ` ${skipped} were older than 14 days, which Discord cannot bulk delete.` : ''}`)] });
  },
  async slowmode(i) {
    const channel = textChannel(i);
    const value = i.options.getString('duration', true);
    const ms = /^(off|0)$/i.test(value) ? 0 : parseTime(value);
    if (ms > 21_600_000) throw new UserError('Discord limits slowmode to 6 hours.');
    await (channel as TextChannel).setRateLimitPerUser(Math.floor(ms / 1000), `${i.user.tag}`);
    await recordCase({ guild: i.guild, type: 'slowmode', targetId: channel.id, targetTag: `#${channel.name}`, moderatorId: i.user.id, moderatorTag: i.user.tag, reason: ms ? `Set to ${formatDuration(ms)}` : 'Turned off' });
    await replyOk(i, ms ? `Slowmode in <#${channel.id}> is now **${formatDuration(ms)}**.` : `Slowmode in <#${channel.id}> is off.`);
  },
  lock: (i) => setChannelGate(i, 'lock', { SendMessages: false, SendMessagesInThreads: false, CreatePublicThreads: false, AddReactions: false, Connect: false }),
  unlock: (i) => setChannelGate(i, 'unlock', { SendMessages: null, SendMessagesInThreads: null, CreatePublicThreads: null, AddReactions: null, Connect: null }),
  hide: (i) => setChannelGate(i, 'hide', { ViewChannel: false }),
  unhide: (i) => setChannelGate(i, 'unhide', { ViewChannel: null }),
  async nickname(i) {
    const member = await requireMember(i);
    const block = moderationBlock(i.member, member, i.guild.members.me!);
    if (block) throw new UserError(block);
    const nickname = i.options.getString('nickname');
    const before = member.displayName;
    await member.setNickname(nickname, `By ${i.user.tag}`);
    const c = await recordCase({ guild: i.guild, type: 'nickname', targetId: member.id, targetTag: member.user.tag, moderatorId: i.user.id, moderatorTag: i.user.tag, reason: `${before} ${ICONS.arrow} ${nickname ?? '(reset)'}` });
    await done(i, c, `Nickname updated for **${member.user.tag}**.`);
  },
  voicemute: (i) => voiceAction(i, 'muted', 'voicemute', 'voiceunmute', (m, v, r) => m.voice.setMute(v, r)),
  voicedeafen: (i) => voiceAction(i, 'deafened', 'voicedeafen', 'voiceundeafen', (m, v, r) => m.voice.setDeaf(v, r)),
  async jail(i) {
    const member = await requireMember(i);
    const raw = i.options.getString('duration');
    const ms = raw ? parseTime(raw) : null;
    const c = await jailMember(i.guild, actorOf(i), member, reasonOf(i), ms);
    await done(i, c, `**${member.user.tag}** is in jail${ms ? ` for ${formatDuration(ms)}` : ''}.`);
  },
  async unjail(i) {
    const user = i.options.getUser('user', true);
    const c = await unjailMember(i.guild, actorOf(i), user.id, reasonOf(i));
    await done(i, c, `**${user.tag}** was released and their roles restored.`);
  },
  massban: (i) => promptMass(i, 'ban'),
  masskick: (i) => promptMass(i, 'kick'),
  async history(i) {
    const user = i.options.getUser('user', true);
    await replyEmbed(i, await historyEmbed(i.guildId, user.id, user.tag, 0), { components: await historyButtons(i.guildId, user.id, 0) });
  },
  async note(i) {
    const user = i.options.getUser('user', true);
    const c = await recordCase({ guild: i.guild, type: 'note', targetId: user.id, targetTag: user.tag, moderatorId: i.user.id, moderatorTag: i.user.tag, reason: i.options.getString('text', true) });
    await done(i, c, `Note added for **${user.tag}**.`);
  },
  async notes(i) {
    const user = i.options.getUser('user', true);
    const list = await Case.find({ guildId: i.guildId, targetId: user.id, type: 'note' }).sort({ number: -1 }).limit(15);
    await replyEmbed(i, panelEmbed(`Staff notes ${'·'} ${user.tag}`, list.length ? list.map((c) => `**#${c.number}** ${discordTime(c.createdAt)} by <@${c.moderatorId}>\n${truncate(c.reason, 200)}`).join('\n\n') : 'No notes.'));
  },
};

async function setChannelGate(i: GuildCommand, type: 'lock' | 'unlock' | 'hide' | 'unhide', overwrite: Record<string, boolean | null>): Promise<void> {
  const channel = textChannel(i) as TextChannel;
  const reason = reasonOf(i);
  await channel.permissionOverwrites.edit(i.guild.roles.everyone, overwrite, { reason: `${i.user.tag}: ${reason}`.slice(0, 512), type: OverwriteType.Role });
  await recordCase({ guild: i.guild, type, targetId: channel.id, targetTag: `#${channel.name}`, moderatorId: i.user.id, moderatorTag: i.user.tag, reason });
  await replyOk(i, `<#${channel.id}> ${{ lock: 'is locked', unlock: 'is unlocked', hide: 'is hidden from @everyone', unhide: 'is visible again' }[type]}.`);
}

async function voiceAction(i: GuildCommand, option: string, onType: 'voicemute' | 'voicedeafen', offType: 'voiceunmute' | 'voiceundeafen', apply: (m: GuildMember, v: boolean, r: string) => Promise<unknown>): Promise<void> {
  const member = await requireMember(i);
  const block = moderationBlock(i.member, member, i.guild.members.me!);
  if (block) throw new UserError(block);
  if (!member.voice.channelId) throw new UserError('That member is not in a voice channel.');
  const value = i.options.getBoolean(option, true);
  const reason = reasonOf(i);
  await apply(member, value, `${i.user.tag}: ${reason}`.slice(0, 512));
  const c = await recordCase({ guild: i.guild, type: value ? onType : offType, targetId: member.id, targetTag: member.user.tag, moderatorId: i.user.id, moderatorTag: i.user.tag, reason });
  await done(i, c, `Voice state updated for **${member.user.tag}**.`);
}

// ---------- Mass moderation ----------
interface MassRequest { action: 'ban' | 'kick'; ids: string[]; reason: string; moderatorId: string; expires: number }
const massRequests = new Map<string, MassRequest>();
const MASS_LIMIT = 50;

async function promptMass(i: GuildCommand, action: 'ban' | 'kick'): Promise<void> {
  const ids = extractIds(i.options.getString('users', true));
  if (!ids.length) throw new UserError('I could not find any user IDs in that list.');
  if (ids.length > MASS_LIMIT) throw new UserError(`Up to ${MASS_LIMIT} users at a time.`);
  massRequests.set(i.id, { action, ids, reason: reasonOf(i), moderatorId: i.user.id, expires: Date.now() + 120_000 });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`mod:mass:confirm:${i.id}`).setLabel(`Confirm ${action} of ${ids.length}`).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`mod:mass:cancel:${i.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  await replyEmbed(i, baseEmbed(COLORS.warning).setTitle(`${ICONS.warn}  Confirm mass ${action}`).setDescription(`This will ${action} **${ids.length}** users:\n${truncate(ids.map((id) => `<@${id}>`).join(' '), 1500)}\n\nReason: ${reasonOf(i)}\nThis request expires in 2 minutes.`), { components: [row] });
}

export async function runMass(guild: Guild, actor: Actor, request: MassRequest): Promise<{ ok: number; failed: Array<{ id: string; why: string }> }> {
  let ok = 0;
  const failed: Array<{ id: string; why: string }> = [];
  for (const id of request.ids) {
    try {
      if (request.action === 'ban') {
        const user = await guild.client.users.fetch(id);
        await banUser(guild, actor, user, request.reason);
      } else {
        const member = await guild.members.fetch(id);
        await kickMember(guild, actor, member, request.reason);
      }
      ok++;
    } catch (err) {
      failed.push({ id, why: err instanceof UserError ? err.message : 'Not found or not allowed' });
    }
  }
  return { ok, failed };
}

// ---------- History pagination ----------
const PAGE = 6;

async function historyEmbed(guildId: string, userId: string, tag: string, page: number) {
  const filter = { guildId, targetId: userId, type: { $ne: 'note' as const } };
  const [total, list] = await Promise.all([Case.countDocuments(filter), Case.find(filter).sort({ number: -1 }).skip(page * PAGE).limit(PAGE)]);
  return panelEmbed(`History ${'·'} ${tag}`, list.length ? list.map((c) => `**#${c.number} ${c.type.toUpperCase()}** ${discordTime(c.createdAt)}${c.durationMs ? ` for ${formatDuration(c.durationMs)}` : ''}\n${truncate(c.reason, 140)}\nby <@${c.moderatorId}>`).join('\n\n') : 'Clean record.', list.length ? COLORS.primary : COLORS.success)
    .setAuthor({ name: `${total} total ${total === 1 ? 'case' : 'cases'} ${ICONS.dot} page ${page + 1}/${Math.max(1, Math.ceil(total / PAGE))}` });
}

async function historyButtons(guildId: string, userId: string, page: number) {
  const total = await Case.countDocuments({ guildId, targetId: userId, type: { $ne: 'note' as const } });
  if (total <= PAGE) return [];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`mod:hist:${userId}:${page - 1}`).setLabel('Newer').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`mod:hist:${userId}:${page + 1}`).setLabel('Older').setStyle(ButtonStyle.Secondary).setDisabled((page + 1) * PAGE >= total),
  )];
}

// ---------- Configuration ----------
const modConfigCommand: SlashCommand = {
  perms: { '*': [P.ManageGuild] },
  botPerms: { 'jail-setup': [P.ManageRoles, P.ManageChannels] },
  data: new SlashCommandBuilder().setName('modconfig').setDescription('Moderation settings').setDefaultMemberPermissions(P.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('modlog').setDescription('Set the moderation log channel').addChannelOption((o) => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((s) => s.setName('dm').setDescription('DM members about actions against them').addBooleanOption((o) => o.setName('enabled').setDescription('Enabled').setRequired(true)))
    .addSubcommand((s) => s.setName('jail-setup').setDescription('Create or link the jail role and apply it to every channel').addRoleOption((o) => o.setName('role').setDescription('Existing role (optional)')).addChannelOption((o) => o.setName('jail_channel').setDescription('The one channel jailed members can see').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('warn-threshold').setDescription('Apply an action automatically at N warnings')
      .addIntegerOption((o) => o.setName('warnings').setDescription('Warning count').setMinValue(1).setMaxValue(100).setRequired(true))
      .addStringOption((o) => o.setName('action').setDescription('Action, or remove').setRequired(true).addChoices({ name: 'Timeout', value: 'timeout' }, { name: 'Jail', value: 'jail' }, { name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' }, { name: 'Remove this threshold', value: 'remove' }))
      .addIntegerOption((o) => o.setName('minutes').setDescription('Duration for timeout or jail').setMinValue(1).setMaxValue(40320)))
    .toJSON(),
  async execute(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'modlog') {
      const channel = i.options.getChannel('channel', true);
      postableChannel(i.guild, channel.id);
      await updateConfig(i.guildId, 'moderation', { modLogChannelId: channel.id });
      return replyOk(i, `Moderation actions will be logged in <#${channel.id}>.`);
    }
    if (sub === 'dm') {
      await updateConfig(i.guildId, 'moderation', { dmOnAction: i.options.getBoolean('enabled', true) });
      return replyOk(i, 'DM setting updated.');
    }
    if (sub === 'warn-threshold') {
      const warnings = i.options.getInteger('warnings', true);
      const action = i.options.getString('action', true);
      const { moderation } = await getConfig(i.guildId);
      const others = moderation.warnThresholds.filter((t) => t.warnings !== warnings);
      const next = action === 'remove' ? others : [...others, { warnings, action, durationMinutes: i.options.getInteger('minutes') ?? 60 }];
      await updateConfig(i.guildId, 'moderation', { warnThresholds: next });
      return replyOk(i, action === 'remove' ? `Threshold at ${warnings} warnings removed.` : `At **${warnings}** warnings members will get **${action}**.`);
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const given = i.options.getRole('role');
    const role = given ?? (await i.guild.roles.create({ name: 'Jailed', colors: { primaryColor: 0x4b5563 }, permissions: [], reason: 'ZYTHERON jail setup' }));
    if (role.position >= i.guild.members.me!.roles.highest.position) throw new UserError('That role is above mine. Move my role above it first.');
    if (hasDangerousPermissions(role.permissions.bitfield)) throw new UserError('The jail role cannot have moderator or admin permissions.');
    const jailChannel = i.options.getChannel('jail_channel');
    let applied = 0;
    for (const channel of i.guild.channels.cache.values()) {
      if (channel.isThread() || !('permissionOverwrites' in channel)) continue;
      const isJail = channel.id === jailChannel?.id;
      await (channel as GuildTextBasedChannel & TextChannel).permissionOverwrites
        .edit(role.id, isJail ? { ViewChannel: true, SendMessages: true } : { ViewChannel: false, SendMessages: false, Connect: false, AddReactions: false }, { reason: 'ZYTHERON jail setup' })
        .then(() => applied++)
        .catch((err: unknown) => logger.debug({ err }, 'Jail overwrite failed'));
    }
    await updateConfig(i.guildId, 'moderation', { jailRoleId: role.id });
    await i.editReply({ embeds: [okEmbed(`Jail role is <@&${role.id}>, applied to **${applied}** channels.${jailChannel ? ` Jailed members can only see <#${jailChannel.id}>.` : ''}`)] });
  },
};

export const moderationModule: VortexModule = {
  name: 'moderation',
  commands: [moderationCommand, modConfigCommand],
  jobs: modJobs,
  components: [
    {
      prefix: 'mod:mass',
      async run(i, [verb, id]) {
        if (!i.isButton() || !i.inCachedGuild()) return;
        const request = id ? massRequests.get(id) : undefined;
        if (!request || request.expires < Date.now()) return i.update({ embeds: [baseEmbed(COLORS.muted).setDescription('This request expired.')], components: [] });
        if (request.moderatorId !== i.user.id) return replyFail(i, 'Only the moderator who started this can confirm it.');
        massRequests.delete(id!);
        if (verb === 'cancel') return i.update({ embeds: [baseEmbed(COLORS.muted).setDescription('Cancelled. Nothing was changed.')], components: [] });
        await i.update({ embeds: [baseEmbed(COLORS.accent).setDescription(`Working through ${request.ids.length} users...`)], components: [] });
        // Re-check at execution time: permissions may have changed since the prompt.
        const needed = request.action === 'ban' ? P.BanMembers : P.KickMembers;
        if (!i.member.permissions.has(needed)) return void i.editReply({ embeds: [baseEmbed(COLORS.danger).setDescription('You no longer have permission for this.')] });
        const r = await runMass(i.guild, { id: i.user.id, tag: i.user.tag, member: i.member }, request);
        await i.editReply({ embeds: [panelEmbed(`Mass ${request.action} complete`, `**${r.ok}** done, **${r.failed.length}** failed.${r.failed.length ? `\n\n${truncate(r.failed.map((f) => `<@${f.id}>: ${f.why}`).join('\n'), 1500)}` : ''}`, r.failed.length ? COLORS.warning : COLORS.success)] });
      },
    },
    {
      prefix: 'mod:hist',
      async run(i, [userId, page]) {
        if (!i.isButton() || !i.inCachedGuild() || !userId) return;
        if (!i.member.permissions.has(P.ModerateMembers)) return replyFail(i, 'You cannot view moderation history.');
        const p = Math.max(0, Number(page) || 0);
        await i.deferUpdate();
        const user = await i.client.users.fetch(userId);
        await i.editReply({ embeds: [await historyEmbed(i.guildId, userId, user.tag, p)], components: await historyButtons(i.guildId, userId, p) });
      },
    },
  ],
};

export { caseEmbed };
