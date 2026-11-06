import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, Events, MessageFlags, ModalBuilder, OverwriteType, PermissionFlagsBits, SlashCommandBuilder, SnowflakeUtil, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
  type Client, type Collection, type Guild, type SlashCommandStringOption, type GuildMember, type Message, type TextChannel,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { postableChannel } from '../../core/channels.js';
import { getConfig, updateConfig } from '../../core/configService.js';
import { logger } from '../../core/logger.js';
import { scheduleJob } from '../../core/scheduler.js';
import { on, UserError, type ComponentInteraction, type SlashCommand, type VortexModule } from '../../core/types.js';
import { chunk, hexToInt, truncate } from '../../core/util.js';
import { renderVars } from '../../core/variables.js';
import { nextSequence, StaffEvent, Ticket, TicketPanel, type IStaffEvent, type ITicket, type ITicketCategory, type ITicketPanel } from '../../db/models.js';
import type { Doc } from '../../db/store.js';
import { baseEmbed, COLORS, panelEmbed, replyEmbed, replyFail, replyOk } from '../../ui/theme.js';
import { getTextChannel } from '../logging/service.js';
import { toEmoji } from '../embeds/spec.js';
import { renderTranscript, type TranscriptMessage } from './transcript.js';

const P = PermissionFlagsBits;
const TICKET_MEMBER_PERMS = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];

async function isStaff(member: GuildMember, category?: ITicketCategory | null): Promise<boolean> {
  if (member.permissions.has(P.ManageChannels)) return true;
  const { tickets } = await getConfig(member.guild.id);
  const roles = [...tickets.staffRoleIds, ...(category?.staffRoleIds ?? [])];
  return roles.some((r) => member.roles.cache.has(r));
}

const controlRow = (ticket: Pick<ITicket, 'claimedBy' | 'status'>) => new ActionRowBuilder<ButtonBuilder>().addComponents(
  ...(ticket.status === 'open'
    ? [
        new ButtonBuilder().setCustomId('ticket:claim').setLabel(ticket.claimedBy ? 'Claimed' : 'Claim').setStyle(ButtonStyle.Primary).setDisabled(Boolean(ticket.claimedBy)),
        new ButtonBuilder().setCustomId('ticket:close').setLabel('Close').setStyle(ButtonStyle.Danger),
      ]
    : [
        new ButtonBuilder().setCustomId('ticket:reopen').setLabel('Reopen').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('ticket:delete').setLabel('Delete channel').setStyle(ButtonStyle.Danger),
      ]),
);

function panelPayload(panel: { _id: unknown; title: string; description: string; color: string; style: string; categories: ITicketCategory[] }) {
  const id = String(panel._id);
  const embed = baseEmbed(hexToInt(panel.color)).setTitle(panel.title).setDescription(panel.description);
  if (panel.style === 'select') {
    return { embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`ticket:pick:${id}`).setPlaceholder('What do you need help with?').addOptions(panel.categories.map((c) => ({ label: c.label, value: c.id, description: c.description ?? undefined, emoji: toEmoji(c.emoji ?? undefined) }))))] };
  }
  return { embeds: [embed], components: chunk(panel.categories.slice(0, 25), 5).map((row) => new ActionRowBuilder<ButtonBuilder>().addComponents(row.map((c) => {
    const b = new ButtonBuilder().setCustomId(`ticket:open:${id}:${c.id}`).setLabel(c.label).setStyle(ButtonStyle.Primary);
    const emoji = toEmoji(c.emoji ?? undefined);
    return emoji ? b.setEmoji(emoji as never) : b;
  }))) };
}

/** Posts a panel, or refreshes it if it is already in that channel. */
export async function publishTicketPanel(guild: Guild, panel: Doc<ITicketPanel>, channelId: string): Promise<Message> {
  if (!panel.categories.length) throw new UserError('Add at least one category first.');
  const channel = postableChannel(guild, channelId);
  const existing = panel.messageId && panel.channelId === channel.id ? await channel.messages.fetch(panel.messageId).catch(() => null) : null;
  const message = existing ? await existing.edit(panelPayload(panel)) : await channel.send(panelPayload(panel));
  panel.channelId = channel.id;
  panel.messageId = message.id;
  await panel.save();
  return message;
}

const textRow = (id: string, label: string) => new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Paragraph).setMinLength(1).setMaxLength(500).setRequired(true));

/** Asks this category's own questions, or simply how we can help. */
const subjectModal = (panelId: string, categoryId: string, questions: string[] = []) => new ModalBuilder().setCustomId(`ticket:create:${panelId}:${categoryId}`).setTitle('Open a ticket').addComponents(
  ...(questions.length ? questions.slice(0, 5).map((q, n) => textRow(`q${n}`, q)) : [textRow('subject', 'How can we help?')]),
);

async function askQuestions(guildId: string, panelId: string, categoryId: string) {
  const panel = await TicketPanel.findOne({ _id: panelId, guildId });
  return subjectModal(panelId, categoryId, panel?.categories.find((c) => c.id === categoryId)?.questions ?? []);
}

/** A channel name from the server's template, in the form Discord allows. */
export function ticketChannelName(template: string, number: number, username: string): string {
  const name = template.replace(/\{number\}/g, String(number).padStart(4, '0')).replace(/\{username\}/g, username).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
  return name || `ticket-${String(number).padStart(4, '0')}`;
}

export async function openTicket(guild: Guild, member: GuildMember, panelName: string, category: ITicketCategory, subject: string, answers: Array<{ question: string; answer: string }> = []): Promise<{ ticket: ITicket; channel: TextChannel }> {
  const { tickets } = await getConfig(guild.id);
  if (!tickets.enabled) throw new UserError('Tickets are currently turned off.');
  const open = await Ticket.countDocuments({ guildId: guild.id, ownerId: member.id, status: 'open' });
  if (open >= tickets.maxOpenPerUser) throw new UserError(`You already have ${open} open ticket(s). Please use those first.`);
  const number = await nextSequence(guild.id, 'ticket');
  const staffRoles = [...new Set([...tickets.staffRoleIds, ...category.staffRoleIds])].filter((r) => guild.roles.cache.has(r));
  const parentId = category.parentCategoryId ?? tickets.parentCategoryId;
  const channel = await guild.channels.create({
    name: ticketChannelName(tickets.channelName, number, member.user.username),
    type: ChannelType.GuildText,
    parent: parentId && guild.channels.cache.has(parentId) ? parentId : undefined,
    topic: `Ticket #${number} for ${member.user.tag}: ${truncate(subject, 200)}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [P.ViewChannel], type: OverwriteType.Role },
      { id: guild.client.user.id, allow: [...TICKET_MEMBER_PERMS, P.ManageChannels, P.ManageMessages], type: OverwriteType.Member },
      { id: member.id, allow: TICKET_MEMBER_PERMS, type: OverwriteType.Member },
      ...staffRoles.map((r) => ({ id: r, allow: TICKET_MEMBER_PERMS, type: OverwriteType.Role })),
    ],
    reason: `Ticket #${number} opened by ${member.user.tag}`,
  });
  const ticket = await Ticket.create({ guildId: guild.id, number, channelId: channel.id, ownerId: member.id, ownerTag: member.user.tag, panelName, categoryLabel: category.label, subject });
  const message = renderVars(category.welcomeMessage ?? tickets.welcomeMessage, { user: `<@${member.id}>`, username: member.displayName, server: guild.name });
  await channel.send({
    content: `${member}${staffRoles.length ? ` ${staffRoles.map((r) => `<@&${r}>`).join(' ')}` : ''}`,
    embeds: [baseEmbed(hexToInt(tickets.color)).setTitle(`Ticket #${number} ${'·'} ${category.label}`).setDescription(message).addFields(answers.length ? answers.map((a) => ({ name: truncate(a.question, 256), value: truncate(a.answer, 1000) })) : [{ name: 'Subject', value: truncate(subject, 1000) }])],
    components: [controlRow(ticket)],
    allowedMentions: { users: [member.id], roles: staffRoles },
  });
  const notify = getTextChannel(guild, tickets.notifyChannelId);
  if (notify) await notify.send({ embeds: [baseEmbed(COLORS.accent).setTitle(`New ticket #${number}`).setDescription(`${member} opened <#${channel.id}>\n**${category.label}**: ${truncate(subject, 300)}`)], allowedMentions: { parse: [] } }).catch(() => undefined);
  return { ticket, channel };
}

async function fetchAll(channel: TextChannel, limit = 2000): Promise<Message[]> {
  const all: Message[] = [];
  let before: string | undefined;
  while (all.length < limit) {
    const batch: Collection<string, Message> = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    all.push(...batch.values());
    before = batch.last()?.id;
  }
  return all.reverse();
}

const staffEvent = (guildId: string, userId: string, type: IStaffEvent['type']) => StaffEvent.create({ guildId, userId, type }).catch((err) => logger.debug({ err }, 'Could not record a staff event'));

/** A ticket is resolved once, by its first real close. Closing it again after a reopen changes nothing. An automatic close resolves nothing. */
async function recordResolution(guild: Guild, ticket: ITicket, closerId: string): Promise<void> {
  await staffEvent(guild.id, closerId, 'ticket_close');
  if (closerId === guild.client.user.id) return;
  const resolver = closerId === ticket.ownerId ? ticket.claimedBy : closerId;
  if (resolver) await Ticket.updateOne({ _id: ticket._id, resolvedAt: null }, { $set: { resolvedAt: new Date(), resolvedBy: resolver } });
}

/** Records staff replies in ticket channels. Only that a reply happened and when, never what it said. */
export async function onTicketMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || !message.member) return;
  const ticket = await Ticket.findOne({ channelId: message.channelId, guildId: message.guildId, status: 'open' });
  if (!ticket || ticket.ownerId === message.author.id || !(await isStaff(message.member))) return;
  await staffEvent(message.guildId, message.author.id, 'ticket_reply');
  await Ticket.updateOne({ _id: ticket._id, firstResponseAt: null }, { $set: { firstResponseAt: new Date(), firstResponderId: message.author.id } });
}

async function closeTicket(guild: Guild, ticket: ITicket, channel: TextChannel, closedBy: GuildMember): Promise<void> {
  const { tickets } = await getConfig(guild.id);
  const messages = await fetchAll(channel);
  const transcript = renderTranscript(
    { guildName: guild.name, number: ticket.number, subject: ticket.subject, owner: ticket.ownerTag, closedBy: closedBy.user.tag },
    messages.map<TranscriptMessage>((m) => ({ author: m.author.tag, authorId: m.author.id, at: m.createdAt, content: m.content, attachments: m.attachments.map((a) => a.url), embeds: m.embeds.length, bot: m.author.bot })),
  );
  const plainText = messages.map((m) => `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content}${m.attachments.size ? ` (${m.attachments.map((a) => a.url).join(', ')})` : ''}`).join('\n');
  const asText = tickets.transcriptFormat === 'text';
  const file = () => new AttachmentBuilder(Buffer.from(asText ? `Ticket #${ticket.number}: ${ticket.subject}\nOpened by ${ticket.ownerTag}\nClosed by ${closedBy.user.tag}\n\n${plainText}` : transcript, 'utf8'), { name: `ticket-${ticket.number}.${asText ? 'txt' : 'html'}` });

  await Ticket.updateOne({ _id: ticket._id }, { $set: { status: 'closed', closedBy: closedBy.id, closedAt: new Date(), messageCount: messages.length } });
  await recordResolution(guild, ticket, closedBy.id);
  const owner = await guild.members.fetch(ticket.ownerId).catch(() => null);
  await channel.permissionOverwrites.edit(ticket.ownerId, { SendMessages: false, ViewChannel: false }, { reason: 'Ticket closed' }).catch(() => undefined);
  for (const id of ticket.addedUsers) await channel.permissionOverwrites.delete(id, 'Ticket closed').catch(() => undefined);
  // Not awaited: Discord allows 2 renames per 10 minutes, and waiting would hold up the close.
  void channel.setName(`closed-${String(ticket.number).padStart(4, '0')}`).catch((err: unknown) => logger.debug({ err }, 'Could not rename ticket'));
  await channel.send({ embeds: [baseEmbed(COLORS.warning).setTitle(`Ticket #${ticket.number} closed`).setDescription(`Closed by ${closedBy}. ${messages.length} messages saved.`)], components: [controlRow({ status: 'closed', claimedBy: ticket.claimedBy })], allowedMentions: { parse: [] } });

  const log = getTextChannel(guild, tickets.transcriptChannelId);
  if (log) await log.send({ embeds: [baseEmbed(COLORS.accent).setTitle(`Transcript ${'·'} ticket #${ticket.number}`).addFields({ name: 'Opened by', value: `<@${ticket.ownerId}>`, inline: true }, { name: 'Closed by', value: `${closedBy}`, inline: true }, { name: 'Claimed by', value: ticket.claimedBy ? `<@${ticket.claimedBy}>` : 'Nobody', inline: true }, { name: 'Subject', value: truncate(ticket.subject, 1000) })], files: [file()], allowedMentions: { parse: [] } }).catch((err) => logger.warn({ err }, 'Could not post transcript'));

  if (owner) {
    const rating = tickets.ratingsEnabled ? [new ActionRowBuilder<ButtonBuilder>().addComponents([1, 2, 3, 4, 5].map((n) => new ButtonBuilder().setCustomId(`ticket:rate:${ticket._id}:${n}`).setLabel('★'.repeat(n)).setStyle(n >= 4 ? ButtonStyle.Success : ButtonStyle.Secondary)))] : [];
    await owner.send({ embeds: [baseEmbed().setTitle(`Your ticket in ${guild.name} was closed`).setDescription(`**#${ticket.number}**: ${truncate(ticket.subject, 500)}${rating.length ? '\n\nHow did we do?' : ''}`)], files: [file()], components: rating }).catch(() => undefined);
  }
}

async function currentTicket(i: ComponentInteraction | { channelId: string | null; guildId: string | null }) {
  const ticket = await Ticket.findOne({ channelId: i.channelId ?? '', guildId: i.guildId ?? '' });
  if (!ticket) throw new UserError('This is not a ticket channel.');
  return ticket;
}

async function requireStaffFor(member: GuildMember): Promise<void> {
  if (!(await isStaff(member))) throw new UserError('Only ticket staff can do that.');
}

const panelAuto: SlashCommand['autocomplete'] = async (i) => {
  const q = String(i.options.getFocused()).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '');
  const list = await TicketPanel.find({ guildId: i.guildId, name: { $regex: q } }).limit(25);
  await i.respond(list.map((p) => ({ name: p.name, value: p.name })));
};
const panelOpt = (o: SlashCommandStringOption) => o.setName('panel').setDescription('Panel').setAutocomplete(true).setRequired(true);

const ticketCommand: SlashCommand = {
  cooldownSec: 2,
  autocomplete: panelAuto,
  perms: { setup: [P.ManageGuild], 'panel-create': [P.ManageGuild], 'panel-category': [P.ManageGuild], 'panel-publish': [P.ManageGuild], stats: [P.ManageGuild] },
  botPerms: { setup: [P.ManageChannels], add: [P.ManageChannels], remove: [P.ManageChannels], close: [P.ManageChannels] },
  data: new SlashCommandBuilder().setName('ticket').setDescription('Support tickets').setDMPermission(false)
    .addSubcommand((s) => s.setName('setup').setDescription('Turn tickets on')
      .addRoleOption((o) => o.setName('staff').setDescription('Staff role').setRequired(true))
      .addChannelOption((o) => o.setName('category').setDescription('Discord category for new tickets').addChannelTypes(ChannelType.GuildCategory))
      .addChannelOption((o) => o.setName('transcripts').setDescription('Channel for transcripts').addChannelTypes(ChannelType.GuildText))
      .addChannelOption((o) => o.setName('notify').setDescription('Channel notified of new tickets').addChannelTypes(ChannelType.GuildText))
      .addIntegerOption((o) => o.setName('max_open').setDescription('Open tickets allowed per user').setMinValue(1).setMaxValue(10))
      .addBooleanOption((o) => o.setName('ratings').setDescription('Ask for a rating after closing')))
    .addSubcommand((s) => s.setName('panel-create').setDescription('Create a ticket panel')
      .addStringOption((o) => o.setName('name').setDescription('Internal name').setRequired(true).setMaxLength(40))
      .addStringOption((o) => o.setName('title').setDescription('Embed title').setRequired(true).setMaxLength(200))
      .addStringOption((o) => o.setName('description').setDescription('Embed description').setMaxLength(1500))
      .addStringOption((o) => o.setName('style').setDescription('Style').addChoices({ name: 'Buttons', value: 'buttons' }, { name: 'Select menu', value: 'select' }))
      .addStringOption((o) => o.setName('color').setDescription('Hex color').setMaxLength(7)))
    .addSubcommand((s) => s.setName('panel-category').setDescription('Add a ticket category to a panel').addStringOption(panelOpt)
      .addStringOption((o) => o.setName('label').setDescription('Label').setRequired(true).setMaxLength(80))
      .addStringOption((o) => o.setName('description').setDescription('Short description').setMaxLength(100))
      .addStringOption((o) => o.setName('emoji').setDescription('Emoji'))
      .addRoleOption((o) => o.setName('staff').setDescription('Extra staff role for this category'))
      .addChannelOption((o) => o.setName('discord_category').setDescription('Where these tickets are created').addChannelTypes(ChannelType.GuildCategory))
      .addStringOption((o) => o.setName('welcome').setDescription('Custom first message').setMaxLength(1500)))
    .addSubcommand((s) => s.setName('panel-publish').setDescription('Post or refresh a panel').addStringOption(panelOpt).addChannelOption((o) => o.setName('channel').setDescription('Channel (default: here)').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('add').setDescription('Add someone to this ticket').addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove someone from this ticket').addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand((s) => s.setName('claim').setDescription('Claim this ticket'))
    .addSubcommand((s) => s.setName('close').setDescription('Close this ticket'))
    .addSubcommand((s) => s.setName('reopen').setDescription('Reopen this ticket'))
    .addSubcommand((s) => s.setName('stats').setDescription('Ticket statistics'))
    .toJSON(),

  async execute(i) {
    const sub = i.options.getSubcommand();
    await i.deferReply({ flags: MessageFlags.Ephemeral }); // nearly everything here calls Discord
    if (sub === 'setup') {
      const staff = i.options.getRole('staff', true);
      const patch: Record<string, unknown> = { enabled: true, staffRoleIds: [staff.id] };
      const category = i.options.getChannel('category');
      const transcripts = i.options.getChannel('transcripts');
      const notify = i.options.getChannel('notify');
      const max = i.options.getInteger('max_open');
      const ratings = i.options.getBoolean('ratings');
      if (category) patch.parentCategoryId = category.id;
      if (transcripts) { postableChannel(i.guild, transcripts.id, null, [P.AttachFiles]); patch.transcriptChannelId = transcripts.id; }
      if (notify) { postableChannel(i.guild, notify.id); patch.notifyChannelId = notify.id; }
      if (max) patch.maxOpenPerUser = max;
      if (ratings !== null) patch.ratingsEnabled = ratings;
      await updateConfig(i.guildId, 'tickets', patch);
      return replyOk(i, 'Tickets are on. Next: `/ticket panel-create`, then `/ticket panel-category`, then `/ticket panel-publish`.');
    }
    if (sub === 'panel-create') {
      await TicketPanel.create({ guildId: i.guildId, name: i.options.getString('name', true).trim(), title: i.options.getString('title', true), description: i.options.getString('description') ?? 'Open a ticket and our team will help you privately.', style: (i.options.getString('style') ?? 'buttons') as 'buttons' | 'select', color: /^#[0-9a-f]{6}$/i.test(i.options.getString('color') ?? '') ? i.options.getString('color')! : '#7c3aed' });
      return replyOk(i, 'Panel created. Add categories with `/ticket panel-category`.');
    }
    if (sub === 'panel-category' || sub === 'panel-publish') {
      const panel = await TicketPanel.findOne({ guildId: i.guildId, name: i.options.getString('panel', true) });
      if (!panel) throw new UserError('That panel does not exist.');
      if (sub === 'panel-category') {
        if (panel.categories.length >= 25) throw new UserError('A panel can hold up to 25 categories.');
        const staff = i.options.getRole('staff');
        panel.categories.push({ id: randomUUID().slice(0, 8), label: i.options.getString('label', true), description: i.options.getString('description'), emoji: i.options.getString('emoji'), staffRoleIds: staff ? [staff.id] : [], parentCategoryId: i.options.getChannel('discord_category')?.id ?? null, welcomeMessage: i.options.getString('welcome') });
        await panel.save();
        return replyOk(i, `Category added to **${panel.name}**. Post it with \`/ticket panel-publish\`.`);
      }
      const message = await publishTicketPanel(i.guild, panel, i.options.getChannel('channel')?.id ?? panel.channelId ?? i.channelId);
      return replyOk(i, `Published: ${message.url}`);
    }
    if (sub === 'stats') {
      const [open, closed, rated] = await Promise.all([
        Ticket.countDocuments({ guildId: i.guildId, status: 'open' }),
        Ticket.countDocuments({ guildId: i.guildId, status: { $in: ['closed', 'deleted'] } }),
        Ticket.find({ guildId: i.guildId, rating: { $ne: null } }),
      ]);
      const average = rated.length ? rated.reduce((sum, t) => sum + t.rating!, 0) / rated.length : null;
      return replyEmbed(i, panelEmbed('Ticket Statistics').addFields({ name: 'Open', value: String(open), inline: true }, { name: 'Closed', value: String(closed), inline: true }, { name: 'Average rating', value: average === null ? 'No ratings yet' : `${average.toFixed(1)} / 5 (${rated.length})`, inline: true }));
    }

    const ticket = await currentTicket({ channelId: i.channelId, guildId: i.guildId });
    const channel = i.channel as TextChannel;
    if (sub === 'add' || sub === 'remove') {
      await requireStaffFor(i.member);
      const user = i.options.getUser('user', true);
      if (user.id === ticket.ownerId) throw new UserError('That is the ticket owner.');
      if (sub === 'add') {
        await channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        await Ticket.updateOne({ _id: ticket._id }, { $addToSet: { addedUsers: user.id } });
        await channel.send({ embeds: [baseEmbed(COLORS.accent).setDescription(`${user} was added by ${i.user}.`)], allowedMentions: { users: [user.id] } });
      } else {
        await channel.permissionOverwrites.delete(user.id);
        await Ticket.updateOne({ _id: ticket._id }, { $pull: { addedUsers: user.id } });
      }
      return replyOk(i, `${user} ${sub === 'add' ? 'can now see' : 'can no longer see'} this ticket.`);
    }
    if (sub === 'claim') return claim(i.member, ticket, channel, (t) => replyOk(i, t));
    if (sub === 'reopen') return reopen(i.member, ticket, channel, (t) => replyOk(i, t));
    if (ticket.status !== 'open') throw new UserError('This ticket is already closed.');
    await requireCloseAccess(i.member, ticket);
    await closeTicket(i.guild, ticket, channel, i.member);
    await i.editReply({ embeds: [baseEmbed(COLORS.success).setDescription('Ticket closed.')] });
  },
};

async function requireCloseAccess(member: GuildMember, ticket: ITicket): Promise<void> {
  if (member.id !== ticket.ownerId && !(await isStaff(member))) throw new UserError('Only the ticket owner or staff can close this.');
}

async function claim(member: GuildMember, ticket: ITicket, channel: TextChannel, respond: (text: string) => Promise<unknown>): Promise<void> {
  await requireStaffFor(member);
  // Atomic: two staff clicking together cannot both win.
  const res = await Ticket.updateOne({ _id: ticket._id, claimedBy: null, status: 'open' }, { $set: { claimedBy: member.id, claimedAt: new Date() } });
  if (!res.modifiedCount) throw new UserError('This ticket has already been claimed.');
  await staffEvent(member.guild.id, member.id, 'ticket_claim');
  await channel.send({ embeds: [baseEmbed(COLORS.accent).setDescription(`${member} is handling this ticket.`)], allowedMentions: { parse: [] } });
  await respond('You claimed this ticket.');
}

async function reopen(member: GuildMember, ticket: ITicket, channel: TextChannel, respond: (text: string) => Promise<unknown>): Promise<void> {
  await requireStaffFor(member);
  if (ticket.status === 'open') throw new UserError('This ticket is already open.');
  await channel.permissionOverwrites.edit(ticket.ownerId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }, { reason: 'Ticket reopened' });
  const { tickets } = await getConfig(member.guild.id);
  void channel.setName(ticketChannelName(tickets.channelName, ticket.number, ticket.ownerTag)).catch((err: unknown) => logger.debug({ err }, 'Could not rename ticket'));
  await Ticket.updateOne({ _id: ticket._id }, { $set: { status: 'open', closedBy: null, closedAt: null } });
  await channel.send({ content: `<@${ticket.ownerId}>`, embeds: [baseEmbed(COLORS.success).setDescription(`Ticket reopened by ${member}.`)], components: [controlRow({ status: 'open', claimedBy: ticket.claimedBy })], allowedMentions: { users: [ticket.ownerId] } });
  await respond('Ticket reopened.');
}

/** The same ticket actions as in Discord, for the dashboard. The person's own Discord access is checked. */
export async function dashboardTicketAction(guild: Guild, ticketId: string, action: 'close' | 'reopen' | 'assign' | 'add' | 'remove', userId: string, targetId?: string): Promise<void> {
  const ticket = await Ticket.findOne({ _id: ticketId, guildId: guild.id });
  if (!ticket) throw new UserError('That ticket no longer exists.');
  const channel = guild.channels.cache.get(ticket.channelId) as TextChannel | undefined;
  if (!channel) throw new UserError('That ticket channel no longer exists.');
  const member = await guild.members.fetch(userId);
  await requireStaffFor(member);
  if (action === 'close') {
    if (ticket.status !== 'open') throw new UserError('This ticket is already closed.');
    return closeTicket(guild, ticket, channel, member);
  }
  if (action === 'reopen') return reopen(member, ticket, channel, async () => undefined);
  const target = targetId ? await guild.members.fetch(targetId).catch(() => null) : null;
  if (!target) throw new UserError('That person is not in this server.');
  if (action === 'assign') {
    if (!(await isStaff(target))) throw new UserError('That person is not ticket staff.');
    await Ticket.updateOne({ _id: ticket._id }, { $set: { claimedBy: target.id, claimedAt: new Date(), assignedAt: new Date(), assignedBy: member.id } });
    await channel.send({ embeds: [baseEmbed(COLORS.accent).setDescription(`${member} assigned this ticket to ${target}.`)], allowedMentions: { users: [target.id] } });
    return;
  }
  if (target.id === ticket.ownerId) throw new UserError('That is the ticket owner.');
  if (action === 'add') {
    await channel.permissionOverwrites.edit(target.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
    await Ticket.updateOne({ _id: ticket._id }, { $addToSet: { addedUsers: target.id } });
  } else {
    await channel.permissionOverwrites.delete(target.id);
    await Ticket.updateOne({ _id: ticket._id }, { $pull: { addedUsers: target.id } });
  }
}

/** Closes tickets with no messages for the server's chosen time. */
export async function autoCloseTickets(client: Client, now = Date.now()): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    const { tickets } = await getConfig(guild.id);
    const me = guild.members.me;
    if (!tickets.enabled || !tickets.autoCloseHours || !me) continue;
    for (const ticket of await Ticket.find({ guildId: guild.id, status: 'open' })) {
      const channel = guild.channels.cache.get(ticket.channelId) as TextChannel | undefined;
      if (!channel) continue;
      const last = channel.lastMessageId ? SnowflakeUtil.timestampFrom(channel.lastMessageId) : new Date(ticket.createdAt).getTime();
      if (now - last < tickets.autoCloseHours * 3_600_000) continue;
      await closeTicket(guild, ticket, channel, me).catch((err) => logger.warn({ err, ticket: ticket.number }, 'Could not auto-close a ticket'));
    }
  }
}

export const ticketsModule: VortexModule = {
  name: 'tickets',
  intervals: [{ name: 'ticket-auto-close', everyMs: 15 * 60_000, run: autoCloseTickets }],
  events: [on(Events.MessageCreate, onTicketMessage)],
  commands: [ticketCommand],
  components: [
    {
      prefix: 'ticket:open',
      async run(i, [panelId, categoryId]) {
        if (!i.isButton() || !panelId || !categoryId) return;
        if (!i.inCachedGuild()) return;
        await i.showModal(await askQuestions(i.guildId, panelId, categoryId));
      },
    },
    {
      prefix: 'ticket:pick',
      async run(i, [panelId]) {
        if (!i.isStringSelectMenu() || !panelId) return;
        if (!i.inCachedGuild()) return;
        await i.showModal(await askQuestions(i.guildId, panelId, i.values[0]!));
      },
    },
    {
      prefix: 'ticket:create',
      async run(i, [panelId, categoryId]) {
        if (!i.isModalSubmit() || !i.inCachedGuild()) return;
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const panel = await TicketPanel.findOne({ _id: panelId, guildId: i.guildId });
        const category = panel?.categories.find((c) => c.id === categoryId);
        if (!panel || !category) throw new UserError('This panel is out of date.');
        const answers = (category.questions ?? []).slice(0, 5).map((question, n) => ({ question, answer: i.fields.getTextInputValue(`q${n}`) }));
        const subject = answers.length ? answers[0]!.answer : i.fields.getTextInputValue('subject');
        const { channel } = await openTicket(i.guild, i.member, panel.name, category, subject, answers);
        await i.editReply({ embeds: [baseEmbed(COLORS.success).setDescription(`Your ticket is ready: <#${channel.id}>`)] });
      },
    },
    {
      prefix: 'ticket:claim',
      async run(i) {
        if (!i.isButton() || !i.inCachedGuild()) return;
        const ticket = await currentTicket(i);
        await i.deferUpdate();
        await claim(i.member, ticket, i.channel as TextChannel, () => i.editReply({ components: [controlRow({ status: 'open', claimedBy: i.user.id })] }));
      },
    },
    {
      prefix: 'ticket:close',
      async run(i, [step]) {
        if (!i.isButton() || !i.inCachedGuild()) return;
        const ticket = await currentTicket(i);
        await requireCloseAccess(i.member, ticket);
        if (step !== 'yes') {
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('ticket:close:yes').setLabel('Yes, close it').setStyle(ButtonStyle.Danger));
          return void (await i.reply({ embeds: [baseEmbed(COLORS.warning).setDescription('Close this ticket? A transcript will be saved.')], components: [row], flags: MessageFlags.Ephemeral }));
        }
        if (ticket.status !== 'open') throw new UserError('This ticket is already closed.');
        await i.deferUpdate();
        await closeTicket(i.guild, ticket, i.channel as TextChannel, i.member);
        await i.editReply({ embeds: [baseEmbed(COLORS.success).setDescription('Ticket closed.')], components: [] });
      },
    },
    {
      prefix: 'ticket:reopen',
      async run(i) {
        if (!i.isButton() || !i.inCachedGuild()) return;
        const ticket = await currentTicket(i);
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        await reopen(i.member, ticket, i.channel as TextChannel, (t) => replyOk(i, t));
      },
    },
    {
      prefix: 'ticket:delete',
      async run(i) {
        if (!i.isButton() || !i.inCachedGuild()) return;
        await requireStaffFor(i.member);
        const ticket = await currentTicket(i);
        if (ticket.status === 'open') throw new UserError('Close the ticket first.');
        await replyOk(i, 'This channel will be deleted in 10 seconds.');
        await scheduleJob('ticket.delete', i.guildId, new Date(Date.now() + 10_000), { channelId: i.channelId, ticketId: ticket._id.toString() });
      },
    },
    {
      prefix: 'ticket:rate',
      dm: true,
      async run(i, [ticketId, value]) {
        if (!i.isButton() || !ticketId) return;
        const rating = Number(value);
        if (!(rating >= 1 && rating <= 5)) return;
        // Bound to the owner, and only written once.
        const res = await Ticket.updateOne({ _id: ticketId, ownerId: i.user.id, rating: null }, { $set: { rating } });
        if (!res.modifiedCount) return replyFail(i, 'This ticket has already been rated.');
        await i.update({ components: [], embeds: [baseEmbed(COLORS.success).setDescription(`Thanks for your feedback: ${'★'.repeat(rating)}`)] });
      },
    },
  ],
  jobs: {
    'ticket.delete': async (client, guildId, payload) => {
      const channel = client.guilds.cache.get(guildId)?.channels.cache.get(payload.channelId);
      await channel?.delete('ZYTHERON ticket deleted');
      await Ticket.updateOne({ _id: payload.ticketId }, { $set: { status: 'deleted' } });
    },
  },
};


