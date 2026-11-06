import { randomInt } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
  type Client, type Guild, type MessageReaction, type PartialMessageReaction,
} from 'discord.js';
import { postableChannel } from '../../core/channels.js';
import { getConfig, updateConfig } from '../../core/configService.js';
import { cancelJobs, scheduleJob } from '../../core/scheduler.js';
import { on, UserError, type SlashCommand, type VortexModule } from '../../core/types.js';
import { chunk, discordTime, formatDuration, parseDuration, progressBar, truncate } from '../../core/util.js';
import { Giveaway, nextSequence, Poll, StarEntry, Suggestion, type IGiveaway, type IPoll, type ISuggestion } from '../../db/models.js';
import { baseEmbed, COLORS, panelEmbed, replyEmbed, replyFail, replyOk } from '../../ui/theme.js';
import { getTextChannel } from '../logging/service.js';

const P = PermissionFlagsBits;

// ---------- Giveaways ----------
/** Unbiased draw using a CSPRNG (partial Fisher-Yates). */
export function pickWinners(entrants: string[], count: number): string[] {
  const pool = [...new Set(entrants)];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const j = randomInt(i, pool.length);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, n);
}

function giveawayEmbed(g: Pick<IGiveaway, 'prize' | 'winnersCount' | 'hostId' | 'endsAt' | 'requiredRoleId' | 'entrants' | 'winners' | 'ended'>) {
  const lines = g.ended
    ? [g.winners.length ? `**Winner${g.winners.length > 1 ? 's' : ''}:** ${g.winners.map((w) => `<@${w}>`).join(' ')}` : 'Nobody entered, so there is no winner.', `Hosted by <@${g.hostId}>`, `${g.entrants.length} entries`]
    : [`Press the button to enter.`, `**Ends** ${discordTime(g.endsAt)}`, `**Winners** ${g.winnersCount}`, `**Hosted by** <@${g.hostId}>`, ...(g.requiredRoleId ? [`**Requires** <@&${g.requiredRoleId}>`] : []), `**Entries** ${g.entrants.length}`];
  return baseEmbed(g.ended ? COLORS.muted : COLORS.primary).setTitle(`${g.ended ? 'Giveaway ended' : 'Giveaway'} ${'·'} ${truncate(g.prize, 200)}`).setDescription(lines.join('\n'));
}

const giveawayRow = (id: string, ended: boolean) => new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`gw:enter:${id}`).setLabel(ended ? 'Ended' : 'Enter giveaway').setStyle(ended ? ButtonStyle.Secondary : ButtonStyle.Primary).setDisabled(ended));

async function endGiveaway(client: Client<true>, id: string): Promise<void> {
  // The ended flag flips atomically, so a manual end and the timer cannot both draw.
  const g = await Giveaway.findOneAndUpdate({ _id: id, ended: false }, { $set: { ended: true } });
  if (!g) return;
  g.winners = pickWinners(g.entrants, g.winnersCount);
  await g.save();
  await cancelJobs(`giveaway:${id}`);
  const guild = client.guilds.cache.get(g.guildId);
  const channel = guild ? getTextChannel(guild, g.channelId) : null;
  if (!channel || !g.messageId) return;
  const message = await channel.messages.fetch(g.messageId).catch(() => null);
  await message?.edit({ embeds: [giveawayEmbed(g)], components: [giveawayRow(id, true)] });
  await channel.send({ content: g.winners.length ? `Congratulations ${g.winners.map((w) => `<@${w}>`).join(' ')}! You won **${truncate(g.prize, 200)}**.` : `No valid entries for **${truncate(g.prize, 200)}**.`, allowedMentions: { users: g.winners }, ...(message ? { reply: { messageReference: message.id, failIfNotExists: false } } : {}) });
}

const giveawayCommand: SlashCommand = {
  perms: { '*': [P.ManageGuild] },
  autocomplete: async (i) => {
    const list = await Giveaway.find({ guildId: i.guildId }).sort({ createdAt: -1 }).limit(25);
    await i.respond(list.map((g) => ({ name: truncate(`${g.ended ? '[ended] ' : ''}${g.prize}`, 100), value: g._id.toString() })));
  },
  data: new SlashCommandBuilder().setName('giveaway').setDescription('Giveaways').setDefaultMemberPermissions(P.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('create').setDescription('Start a giveaway')
      .addStringOption((o) => o.setName('prize').setDescription('Prize').setRequired(true).setMaxLength(200))
      .addStringOption((o) => o.setName('duration').setDescription('For example 1d, 2h 30m').setRequired(true))
      .addIntegerOption((o) => o.setName('winners').setDescription('Number of winners').setMinValue(1).setMaxValue(50))
      .addChannelOption((o) => o.setName('channel').setDescription('Channel (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addRoleOption((o) => o.setName('required_role').setDescription('Only this role can enter')))
    .addSubcommand((s) => s.setName('end').setDescription('End early and draw').addStringOption((o) => o.setName('giveaway').setDescription('Giveaway').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) => s.setName('reroll').setDescription('Draw new winners').addStringOption((o) => o.setName('giveaway').setDescription('Giveaway').setAutocomplete(true).setRequired(true)).addIntegerOption((o) => o.setName('winners').setDescription('How many').setMinValue(1).setMaxValue(50)))
    .addSubcommand((s) => s.setName('list').setDescription('List active giveaways'))
    .toJSON(),
  async execute(i) {
    const sub = i.options.getSubcommand();
    await i.deferReply({ flags: MessageFlags.Ephemeral }); // creating, ending and rerolling all call Discord
    if (sub === 'list') {
      const list = await Giveaway.find({ guildId: i.guildId, ended: false });
      return replyEmbed(i, panelEmbed('Active Giveaways', list.length ? list.map((g) => `**${truncate(g.prize, 80)}** in <#${g.channelId}> ${'·'} ends ${discordTime(g.endsAt)} ${'·'} ${g.entrants.length} entries`).join('\n') : 'None running.'));
    }
    if (sub === 'create') {
      const ms = parseDuration(i.options.getString('duration', true));
      if (!ms || ms < 10_000) throw new UserError('Use a duration of at least 10 seconds, for example `30m` or `1d`.');
      if (ms > 60 * 86_400_000) throw new UserError('Giveaways can last up to 60 days.');
      const channel = postableChannel(i.guild, i.options.getChannel('channel')?.id ?? i.channelId, i.member);
      const g = await Giveaway.create({ guildId: i.guildId, channelId: channel.id, prize: i.options.getString('prize', true), winnersCount: i.options.getInteger('winners') ?? 1, hostId: i.user.id, endsAt: new Date(Date.now() + ms), requiredRoleId: i.options.getRole('required_role')?.id ?? null });
      const message = await channel.send({ embeds: [giveawayEmbed(g)], components: [giveawayRow(g._id.toString(), false)] });
      g.messageId = message.id;
      await g.save();
      await scheduleJob('giveaway.end', i.guildId, g.endsAt, { id: g._id.toString() }, `giveaway:${g._id}`);
      return replyOk(i, `Giveaway started in <#${channel.id}> for ${formatDuration(ms)}.`);
    }
    const id = i.options.getString('giveaway', true);
    const g = await Giveaway.findOne({ _id: id, guildId: i.guildId }).catch(() => null);
    if (!g) throw new UserError('Choose a giveaway from the list.');
    if (sub === 'end') {
      if (g.ended) throw new UserError('That giveaway has already ended.');
      await endGiveaway(i.client, id);
      return replyOk(i, 'Giveaway ended.');
    }
    if (!g.ended) throw new UserError('End the giveaway before rerolling.');
    const pool = g.entrants.filter((e) => !g.winners.includes(e));
    const winners = pickWinners(pool, i.options.getInteger('winners') ?? g.winnersCount);
    if (!winners.length) throw new UserError('There is nobody left to draw.');
    g.winners = [...g.winners, ...winners];
    await g.save();
    const channel = getTextChannel(i.guild, g.channelId);
    await channel?.send({ content: `New winner${winners.length > 1 ? 's' : ''}: ${winners.map((w) => `<@${w}>`).join(' ')}. You won **${truncate(g.prize, 200)}**!`, allowedMentions: { users: winners } });
    await replyOk(i, 'Rerolled.');
  },
};

// ---------- Polls ----------
export function tallyPoll(poll: Pick<IPoll, 'options' | 'votes'>) {
  const counts = poll.options.map((_, n) => poll.votes.filter((v) => v.option === n).length);
  const total = counts.reduce((a, b) => a + b, 0);
  return { counts, total };
}

function pollEmbed(poll: Pick<IPoll, 'question' | 'options' | 'votes' | 'multi' | 'authorId' | 'endsAt' | 'ended'>) {
  const { counts, total } = tallyPoll(poll);
  const voters = new Set(poll.votes.map((v) => v.userId)).size;
  const winner = Math.max(...counts);
  const body = poll.options.map((o, n) => {
    const count = counts[n]!;
    const pct = total ? Math.round((count / total) * 100) : 0;
    return `${poll.ended && count === winner && count > 0 ? '**' : ''}${n + 1}. ${o}${poll.ended && count === winner && count > 0 ? '**' : ''}\n\`${progressBar(total ? count / total : 0)}\` ${pct}% (${count})`;
  }).join('\n\n');
  return baseEmbed(poll.ended ? COLORS.muted : COLORS.accent).setTitle(`${poll.ended ? 'Poll closed' : 'Poll'} ${'·'} ${truncate(poll.question, 230)}`).setDescription(`${body}\n\n${voters} voter${voters === 1 ? '' : 's'}${poll.multi ? ' · multiple choice' : ''}${poll.endsAt && !poll.ended ? ` · ends ${discordTime(poll.endsAt)}` : ''}`);
}

const pollRows = (poll: { _id: unknown; options: string[]; ended: boolean }) => chunk(poll.options.map((o, n) => new ButtonBuilder().setCustomId(`poll:vote:${poll._id}:${n}`).setLabel(truncate(`${n + 1}. ${o}`, 80)).setStyle(ButtonStyle.Secondary).setDisabled(poll.ended)), 5).map((row) => new ActionRowBuilder<ButtonBuilder>().addComponents(row));

async function closePoll(client: Client<true>, id: string): Promise<void> {
  const poll = await Poll.findOneAndUpdate({ _id: id, ended: false }, { $set: { ended: true } });
  if (!poll) return;
  const guild = client.guilds.cache.get(poll.guildId);
  const channel = guild ? getTextChannel(guild, poll.channelId) : null;
  const message = poll.messageId ? await channel?.messages.fetch(poll.messageId).catch(() => null) : null;
  await message?.edit({ embeds: [pollEmbed(poll)], components: pollRows(poll) });
}

const pollCommand: SlashCommand = {
  cooldownSec: 5,
  perms: { create: [P.ManageMessages], close: [P.ManageMessages] },
  data: new SlashCommandBuilder().setName('poll').setDescription('Polls').setDefaultMemberPermissions(P.ManageMessages).setDMPermission(false)
    .addSubcommand((s) => s.setName('create').setDescription('Create a poll')
      .addStringOption((o) => o.setName('question').setDescription('Question').setRequired(true).setMaxLength(230))
      .addStringOption((o) => o.setName('options').setDescription('Options separated by | (2 to 10)').setRequired(true).setMaxLength(1000))
      .addStringOption((o) => o.setName('duration').setDescription('For example 1d. Empty means until closed.'))
      .addBooleanOption((o) => o.setName('multiple').setDescription('Allow several choices')))
    .addSubcommand((s) => s.setName('close').setDescription('Close a poll').addStringOption((o) => o.setName('message_id').setDescription('Poll message ID').setRequired(true)))
    .toJSON(),
  async execute(i) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    if (i.options.getSubcommand() === 'close') {
      const poll = await Poll.findOne({ guildId: i.guildId, messageId: i.options.getString('message_id', true).trim() });
      if (!poll) throw new UserError('I cannot find a poll with that message ID.');
      await closePoll(i.client, poll._id.toString());
      return replyOk(i, 'Poll closed.');
    }
    const options = i.options.getString('options', true).split('|').map((o) => o.trim()).filter(Boolean);
    if (options.length < 2 || options.length > 10) throw new UserError('Provide 2 to 10 options separated by `|`.');
    if (new Set(options).size !== options.length) throw new UserError('Poll options must be different.');
    const raw = i.options.getString('duration');
    const ms = raw ? parseDuration(raw) : null;
    if (raw && !ms) throw new UserError('Invalid duration. Examples: `30m`, `1d`.');
    const channel = postableChannel(i.guild, i.channelId, i.member);
    const poll = await Poll.create({ guildId: i.guildId, channelId: channel.id, question: i.options.getString('question', true), options, multi: i.options.getBoolean('multiple') ?? false, authorId: i.user.id, endsAt: ms ? new Date(Date.now() + ms) : null });
    const message = await channel.send({ embeds: [pollEmbed(poll)], components: pollRows(poll), allowedMentions: { parse: [] } });
    poll.messageId = message.id;
    await poll.save();
    if (poll.endsAt) await scheduleJob('poll.end', i.guildId, poll.endsAt, { id: poll._id.toString() });
    await replyOk(i, 'Poll posted.');
  },
};

// ---------- Suggestions ----------
function suggestionEmbed(s: Pick<ISuggestion, 'number' | 'authorId' | 'content' | 'status' | 'up' | 'down' | 'staffReason'>) {
  const color = s.status === 'approved' ? COLORS.success : s.status === 'denied' ? COLORS.danger : COLORS.accent;
  const embed = baseEmbed(color).setTitle(`Suggestion #${s.number}${s.status === 'open' ? '' : ` ${'·'} ${s.status}`}`).setDescription(s.content).addFields({ name: 'From', value: `<@${s.authorId}>`, inline: true }, { name: 'Votes', value: `▲ ${s.up.length}   ▼ ${s.down.length}`, inline: true });
  if (s.staffReason) embed.addFields({ name: 'Staff response', value: s.staffReason });
  return embed;
}
const suggestionRow = (s: { _id: unknown; status: string; up: string[]; down: string[] }) => new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId(`sg:vote:${s._id}:up`).setLabel(`▲ ${s.up.length}`).setStyle(ButtonStyle.Success).setDisabled(s.status !== 'open'),
  new ButtonBuilder().setCustomId(`sg:vote:${s._id}:down`).setLabel(`▼ ${s.down.length}`).setStyle(ButtonStyle.Danger).setDisabled(s.status !== 'open'),
);

const suggestCommand: SlashCommand = {
  cooldownSec: 30,
  data: new SlashCommandBuilder().setName('suggest').setDescription('Send a suggestion to the server').setDMPermission(false).addStringOption((o) => o.setName('idea').setDescription('Your idea').setRequired(true).setMaxLength(1500)).toJSON(),
  async execute(i) {
    const { community } = await getConfig(i.guildId);
    if (!community.suggestions.enabled) throw new UserError('Suggestions are not set up on this server.');
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = postableChannel(i.guild, community.suggestions.channelId);
    const number = await nextSequence(i.guildId, 'suggestion');
    const s = await Suggestion.create({ guildId: i.guildId, number, channelId: channel.id, authorId: i.user.id, content: i.options.getString('idea', true) });
    const message = await channel.send({ embeds: [suggestionEmbed(s)], components: [suggestionRow(s)], allowedMentions: { parse: [] } });
    s.messageId = message.id;
    await s.save();
    await replyOk(i, `Thanks! Your suggestion is **#${number}**.`);
  },
};

const suggestionAdminCommand: SlashCommand = {
  perms: { '*': [P.ManageGuild] },
  data: new SlashCommandBuilder().setName('suggestions').setDescription('Manage suggestions').setDefaultMemberPermissions(P.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('setup').setDescription('Choose the suggestion channel').addChannelOption((o) => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((s) => s.setName('approve').setDescription('Approve a suggestion').addIntegerOption((o) => o.setName('number').setDescription('Suggestion number').setRequired(true).setMinValue(1)).addStringOption((o) => o.setName('reason').setDescription('Response').setMaxLength(1000)))
    .addSubcommand((s) => s.setName('deny').setDescription('Deny a suggestion').addIntegerOption((o) => o.setName('number').setDescription('Suggestion number').setRequired(true).setMinValue(1)).addStringOption((o) => o.setName('reason').setDescription('Response').setMaxLength(1000)))
    .toJSON(),
  async execute(i) {
    const sub = i.options.getSubcommand();
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'setup') {
      const channel = i.options.getChannel('channel', true);
      postableChannel(i.guild, channel.id);
      await updateConfig(i.guildId, 'community', { suggestions: { enabled: true, channelId: channel.id } });
      return replyOk(i, `Suggestions go to <#${channel.id}>.`);
    }
    const s = await Suggestion.findOne({ guildId: i.guildId, number: i.options.getInteger('number', true) });
    if (!s) throw new UserError('I cannot find that suggestion.');
    s.status = sub === 'approve' ? 'approved' : 'denied';
    s.staffReason = i.options.getString('reason');
    await s.save();
    const message = s.messageId ? await getTextChannel(i.guild, s.channelId)?.messages.fetch(s.messageId).catch(() => null) : null;
    await message?.edit({ embeds: [suggestionEmbed(s)], components: [suggestionRow(s)] });
    await replyOk(i, `Suggestion #${s.number} ${s.status}.`);
  },
};

// ---------- Starboard ----------
const emojiMatches = (reaction: MessageReaction | PartialMessageReaction, configured: string): boolean => {
  const id = configured.match(/:(\d{17,20})>$/)?.[1];
  return id ? reaction.emoji.id === id : reaction.emoji.name === configured;
};

async function starboardUpdate(reaction: MessageReaction | PartialMessageReaction): Promise<void> {
  const guild = reaction.message.guild as Guild | null;
  if (!guild) return;
  const { community } = await getConfig(guild.id);
  const cfg = community.starboard;
  if (!cfg.enabled || !cfg.channelId || !emojiMatches(reaction, cfg.emoji) || reaction.message.channelId === cfg.channelId || cfg.ignoredChannels.includes(reaction.message.channelId)) return;
  if (reaction.partial) await reaction.fetch();
  const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  if (message.author?.bot) return;
  const users = await reaction.users.fetch();
  const count = users.filter((u) => !u.bot && (cfg.allowSelfStar || u.id !== message.author?.id)).size;
  const board = getTextChannel(guild, cfg.channelId);
  if (!board) return;
  const entry = await StarEntry.findOne({ messageId: message.id });
  const label = `${cfg.emoji} **${count}** in <#${message.channelId}>`;

  if (count < cfg.threshold) {
    if (entry?.starboardMessageId) {
      await board.messages.delete(entry.starboardMessageId).catch(() => undefined);
      await entry.deleteOne();
    }
    return;
  }
  if (entry?.starboardMessageId) {
    const posted = await board.messages.fetch(entry.starboardMessageId).catch(() => null);
    await posted?.edit({ content: label, allowedMentions: { parse: [] } });
    entry.count = count;
    await entry.save();
    return;
  }
  const embed = baseEmbed(COLORS.warning).setAuthor({ name: message.author?.tag ?? 'Unknown', iconURL: message.author?.displayAvatarURL() }).setDescription(`${truncate(message.content || '*No text*', 3900)}\n\n[Jump to message](${message.url})`);
  const image = message.attachments.find((a) => a.contentType?.startsWith('image/'));
  if (image) embed.setImage(image.url);
  const posted = await board.send({ content: label, embeds: [embed], allowedMentions: { parse: [] } });
  await StarEntry.updateOne({ messageId: message.id }, { $set: { guildId: guild.id, channelId: message.channelId, starboardMessageId: posted.id, count } }, { upsert: true });
}

const starboardCommand: SlashCommand = {
  perms: { '*': [P.ManageGuild] },
  data: new SlashCommandBuilder().setName('starboard').setDescription('Highlight popular messages').setDefaultMemberPermissions(P.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('setup').setDescription('Turn the starboard on').addChannelOption((o) => o.setName('channel').setDescription('Starboard channel').addChannelTypes(ChannelType.GuildText).setRequired(true)).addIntegerOption((o) => o.setName('threshold').setDescription('Reactions needed').setMinValue(1).setMaxValue(100)).addStringOption((o) => o.setName('emoji').setDescription('Emoji (default: star)')).addBooleanOption((o) => o.setName('self_star').setDescription('Count people starring their own messages')))
    .addSubcommand((s) => s.setName('off').setDescription('Turn the starboard off'))
    .toJSON(),
  async execute(i) {
    if (i.options.getSubcommand() === 'off') {
      await updateConfig(i.guildId, 'community', { starboard: { enabled: false } });
      return replyOk(i, 'Starboard is off.');
    }
    const channel = i.options.getChannel('channel', true);
    postableChannel(i.guild, channel.id);
    const threshold = i.options.getInteger('threshold');
    const emoji = i.options.getString('emoji');
    const self = i.options.getBoolean('self_star');
    await updateConfig(i.guildId, 'community', { starboard: { enabled: true, channelId: channel.id, ...(threshold ? { threshold } : {}), ...(emoji ? { emoji } : {}), ...(self === null ? {} : { allowSelfStar: self }) } });
    await replyOk(i, `Starboard is on in <#${channel.id}>.`);
  },
};

export const engagementModule: VortexModule = {
  name: 'engagement',
  commands: [giveawayCommand, pollCommand, suggestCommand, suggestionAdminCommand, starboardCommand],
  jobs: {
    'giveaway.end': async (client, _guildId, payload) => endGiveaway(client, payload.id),
    'poll.end': async (client, _guildId, payload) => closePoll(client, payload.id),
  },
  components: [
    {
      prefix: 'gw:enter',
      async run(i, [id]) {
        if (!i.isButton() || !i.inCachedGuild() || !id) return;
        const g = await Giveaway.findOne({ _id: id, guildId: i.guildId });
        if (!g || g.ended) return replyFail(i, 'This giveaway has ended.');
        if (g.requiredRoleId && !i.member.roles.cache.has(g.requiredRoleId)) return replyFail(i, `You need <@&${g.requiredRoleId}> to enter.`);
        const entered = g.entrants.includes(i.user.id);
        const updated = await Giveaway.findOneAndUpdate({ _id: id, ended: false }, entered ? { $pull: { entrants: i.user.id } } : { $addToSet: { entrants: i.user.id } });
        if (!updated) return replyFail(i, 'This giveaway has ended.');
        await i.update({ embeds: [giveawayEmbed(updated)] });
        await replyOk(i, entered ? 'You left the giveaway.' : 'You are in. Good luck!');
      },
    },
    {
      prefix: 'poll:vote',
      async run(i, [id, option]) {
        if (!i.isButton() || !i.inCachedGuild() || !id) return;
        const n = Number(option);
        const poll = await Poll.findOne({ _id: id, guildId: i.guildId });
        if (!poll || poll.ended || !poll.options[n]) return replyFail(i, 'This poll has closed.');
        const had = poll.votes.some((v) => v.userId === i.user.id && v.option === n);
        // Conditional pulls and pushes stay safe when several members vote at the same moment.
        if (had) await Poll.updateOne({ _id: id }, { $pull: { votes: { userId: i.user.id, option: n } } });
        else {
          if (!poll.multi) await Poll.updateOne({ _id: id }, { $pull: { votes: { userId: i.user.id } } });
          await Poll.updateOne({ _id: id }, { $push: { votes: { userId: i.user.id, option: n } } });
        }
        const fresh = await Poll.findById(id);
        await i.update({ embeds: [pollEmbed(fresh!)] });
      },
    },
    {
      prefix: 'sg:vote',
      async run(i, [id, dir]) {
        if (!i.isButton() || !i.inCachedGuild() || !id) return;
        const s = await Suggestion.findOne({ _id: id, guildId: i.guildId });
        if (!s || s.status !== 'open') return replyFail(i, 'Voting on this suggestion has closed.');
        const key = dir === 'up' ? 'up' : 'down';
        const other = key === 'up' ? 'down' : 'up';
        const has = s[key].includes(i.user.id);
        const fresh = await Suggestion.findByIdAndUpdate(id, has ? { $pull: { [key]: i.user.id } } : { $addToSet: { [key]: i.user.id }, $pull: { [other]: i.user.id } });
        await i.update({ embeds: [suggestionEmbed(fresh!)], components: [suggestionRow(fresh!)] });
      },
    },
  ],
  events: [on('messageReactionAdd', (r) => starboardUpdate(r)), on('messageReactionRemove', (r) => starboardUpdate(r))],
};


