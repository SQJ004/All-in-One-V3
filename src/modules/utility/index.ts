import { randomInt } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Events, PermissionFlagsBits as P, type BaseMessageOptions, type Guild, type GuildMember, type User, type VoiceBasedChannel } from 'discord.js';
import { deleteReplyToMessage, textCommandListener, toSlashCommand, type CommandOption, type DualCommand } from '../../core/textCommands.js';
import { on, UserError, type VortexModule } from '../../core/types.js';
import { discordTime, truncate } from '../../core/util.js';
import { okEmbed, panelEmbed } from '../../ui/theme.js';

const MAX_ROLE_LINES = 60;
const MAX_DICE = 20;
const MAX_SIDES = 1000;

const USER_OPTION: CommandOption = { name: 'user', description: 'Who to look at. Leave empty for yourself', kind: 'user', shown: '[@user]' };

/** Slash commands pass an ID. v! commands pass whatever was typed, so this accepts a mention or an ID. */
function userIdFrom(arg: string | null, fallback: string): string {
  if (!arg) return fallback;
  const id = /^(?:<@!?)?(\d{17,20})>?$/.exec(arg)?.[1];
  if (!id) throw new UserError('Mention someone, or use their user ID.');
  return id;
}

async function findPerson(guild: Guild, id: string): Promise<{ user: User; member: GuildMember | null }> {
  const member = await guild.members.fetch(id).catch(() => null);
  const user = member?.user ?? await guild.client.users.fetch(id).catch(() => null);
  if (!user) throw new UserError('I could not find that user.');
  return { user, member };
}

const NONE: BaseMessageOptions['allowedMentions'] = { parse: [] };

const userCommand: DualCommand = {
  name: 'user', description: 'Show information about a user', aliases: ['whois', 'ui'], option: USER_OPTION,
  async run(ctx, arg) {
    const { user, member } = await findPerson(ctx.guild, userIdFrom(arg, ctx.userId));
    const roles = member ? member.roles.cache.filter((r) => r.id !== ctx.guild.id) : null;
    const embed = panelEmbed(user.tag ?? user.username)
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: 'ID', value: user.id, inline: true },
        { name: 'Account type', value: user.bot ? 'Bot' : 'Member', inline: true },
        { name: 'Account created', value: discordTime(user.createdAt, 'D'), inline: true },
        { name: 'Joined this server', value: member?.joinedAt ? discordTime(member.joinedAt, 'D') : 'Not in this server', inline: true },
      );
    if (roles) embed.addFields({ name: `Roles (${roles.size})`, value: truncate([...roles.values()].sort((a, b) => b.position - a.position).map((r) => `<@&${r.id}>`).join(' ') || 'None', 1000) });
    return { embeds: [embed], allowedMentions: NONE };
  },
};

const avatarCommand: DualCommand = {
  name: 'avatar', description: "Get a user's avatar", aliases: ['av', 'pfp'], option: USER_OPTION,
  async run(ctx, arg) {
    const { user } = await findPerson(ctx.guild, userIdFrom(arg, ctx.userId));
    const url = user.displayAvatarURL({ size: 1024 });
    return {
      embeds: [panelEmbed(`${user.username}'s avatar`).setImage(url)],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open full size').setURL(url))],
      allowedMentions: NONE,
    };
  },
};

const serverCommand: DualCommand = {
  name: 'server', description: 'Show information about this server', aliases: ['si', 'serverinfo'],
  run({ guild }) {
    const channels = [...guild.channels.cache.values()];
    const count = (...types: ChannelType[]) => channels.filter((c) => types.includes(c.type)).length;
    const embed = panelEmbed(guild.name).addFields(
      { name: 'ID', value: guild.id, inline: true },
      { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
      { name: 'Created', value: discordTime(guild.createdAt, 'D'), inline: true },
      { name: 'Members', value: guild.memberCount.toLocaleString('en'), inline: true },
      { name: 'Roles', value: String(Math.max(0, guild.roles.cache.size - 1)), inline: true },
      { name: 'Boosts', value: `${guild.premiumSubscriptionCount ?? 0} (level ${guild.premiumTier})`, inline: true },
      { name: 'Channels', value: `${count(ChannelType.GuildText, ChannelType.GuildAnnouncement)} text, ${count(ChannelType.GuildVoice, ChannelType.GuildStageVoice)} voice`, inline: true },
    );
    const icon = guild.iconURL({ size: 256 });
    if (icon) embed.setThumbnail(icon);
    return { embeds: [embed], allowedMentions: NONE };
  },
};

const rolesCommand: DualCommand = {
  name: 'roles', description: 'List the server roles and how many members have each', cooldownSec: 5,
  async run({ guild, working }) {
    await working();
    await guild.members.fetch().catch(() => null); // counts come from the member list, so make it complete
    const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position);
    if (!roles.length) return { embeds: [panelEmbed('Server Roles', 'This server has no roles yet.')] };
    const lines = roles.slice(0, MAX_ROLE_LINES).map((r) => `<@&${r.id}> ${r.members.size.toLocaleString('en')}`);
    if (roles.length > MAX_ROLE_LINES) lines.push(`and ${roles.length - MAX_ROLE_LINES} more`);
    return { embeds: [panelEmbed(`Server Roles (${roles.length})`, truncate(lines.join('\n'), 4000))], allowedMentions: NONE };
  },
};

/** Reads 20 (one 20-sided die) or 2d6 (two 6-sided dice). */
export function parseDice(input: string | null): { dice: number; sides: number } {
  const match = /^(?:(\d{1,3})?d)?(\d{1,5})$/i.exec((input ?? 'd6').trim());
  if (!match) throw new UserError('Use dice like `20` or `2d6`.');
  const dice = Number(match[1] ?? 1);
  const sides = Number(match[2]);
  if (dice < 1 || dice > MAX_DICE) throw new UserError(`Roll from 1 to ${MAX_DICE} dice.`);
  if (sides < 2 || sides > MAX_SIDES) throw new UserError(`Dice can have from 2 to ${MAX_SIDES} sides.`);
  return { dice, sides };
}

const rollCommand: DualCommand = {
  name: 'roll', description: 'Roll dice', aliases: ['dice'],
  option: { name: 'dice', description: 'For example 20 or 2d6. Leave empty for one 6-sided die', kind: 'string', maxLength: 10, shown: '[dice]' },
  run(_ctx, arg) {
    const { dice, sides } = parseDice(arg);
    const results = Array.from({ length: dice }, () => randomInt(1, sides + 1));
    const total = results.reduce((sum, n) => sum + n, 0);
    return { embeds: [okEmbed(dice === 1 ? `Rolled a ${sides}-sided die: **${total}**` : `Rolled ${dice}d${sides}: ${results.join(' + ')} = **${total}**`)] };
  },
};

function findVoiceChannel(guild: Guild, text: string): VoiceBasedChannel | null {
  const id = /^(?:<#)?(\d{17,20})>?$/.exec(text)?.[1];
  const voice = [...guild.channels.cache.values()].filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice) as VoiceBasedChannel[];
  return voice.find((c) => (id ? c.id === id : c.name.toLowerCase() === text.toLowerCase())) ?? null;
}

const moveMeCommand: DualCommand = {
  name: 'moveme', description: 'Move yourself to another voice channel', aliases: ['move'],
  option: { name: 'channel', description: 'The voice channel to move to', kind: 'channel', required: true, shown: '<channel name>' },
  async run({ guild, member }, arg) {
    const here = member.voice?.channel;
    if (!here) throw new UserError('Join a voice channel first, then I can move you.');
    const target = findVoiceChannel(guild, arg ?? '');
    if (!target) throw new UserError('I could not find that voice channel.');
    if (target.id === here.id) throw new UserError('You are already in that channel.');
    // Moving must never get someone into a channel they could not join themselves.
    if (!target.permissionsFor(member).has([P.ViewChannel, P.Connect])) throw new UserError(`You do not have access to <#${target.id}>.`);
    if (target.userLimit && target.members.size >= target.userLimit && !target.permissionsFor(member).has(P.MoveMembers)) throw new UserError(`<#${target.id}> is full.`);
    const me = guild.members.me;
    const mine = me ? target.permissionsFor(me) : null;
    if (!mine?.has([P.ViewChannel, P.Connect, P.MoveMembers])) throw new UserError(`I need **View Channel**, **Connect** and **Move Members** in <#${target.id}>. Ask an admin to give me those permissions.`);
    await member.voice.setChannel(target, 'Used /moveme');
    return { embeds: [okEmbed(`Moved you to <#${target.id}>.`)] };
  },
};

const DEFINITIONS = [userCommand, avatarCommand, serverCommand, rolesCommand, rollCommand, moveMeCommand];

export const utilityModule: VortexModule = {
  name: 'utility',
  commands: DEFINITIONS.map(toSlashCommand),
  events: [
    on(Events.MessageCreate, textCommandListener(DEFINITIONS)),
    on(Events.MessageDelete, (message) => deleteReplyToMessage(message.id)),
  ],
};
