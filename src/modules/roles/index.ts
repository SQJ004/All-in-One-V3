import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, parseEmoji, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder,
  type Guild, type GuildMember, type Message, type MessageReaction, type SlashCommandStringOption, type PartialMessageReaction, type PartialUser, type User,
} from 'discord.js';
import { postableChannel } from '../../core/channels.js';
import { getConfig, updateConfig } from '../../core/configService.js';
import { logger } from '../../core/logger.js';
import { roleAssignBlock } from '../../core/permissions.js';
import { scheduleJob, cancelJobs } from '../../core/scheduler.js';
import { on, UserError, type SlashCommand, type VortexModule } from '../../core/types.js';
import { chunk, formatDuration, hexToInt, parseDuration } from '../../core/util.js';
import { RolePanel, type IRolePanel } from '../../db/models.js';
import type { Doc } from '../../db/store.js';
import { baseEmbed, panelEmbed, replyEmbed, replyFail, replyOk } from '../../ui/theme.js';
import { getTextChannel } from '../logging/service.js';
import { toEmoji } from '../embeds/spec.js';

const P = PermissionFlagsBits;
const reactionKey = (emoji: { id: string | null; name: string | null }): string => emoji.id ?? emoji.name ?? '';
const itemKey = (emoji: string | null | undefined): string => {
  if (!emoji) return '';
  const parsed = parseEmoji(emoji);
  return parsed?.id ?? emoji;
};

function validateRole(guild: Guild, roleId: string, actor?: GuildMember): void {
  const role = guild.roles.cache.get(roleId);
  if (!role) throw new UserError('That role no longer exists.');
  const block = roleAssignBlock(role, guild.members.me!, actor);
  if (block) throw new UserError(block);
}

export interface PanelDecision { add: string[]; remove: string[]; denied?: string }

/** Pure panel behaviour: what should change when `roleId` is chosen. */
export function decidePanelChange(panel: Pick<IRolePanel, 'behavior' | 'items' | 'requiredRoleId'>, memberRoles: Set<string>, roleId: string): PanelDecision {
  if (panel.requiredRoleId && !memberRoles.has(panel.requiredRoleId)) return { add: [], remove: [], denied: 'You need another role before you can use this panel.' };
  const has = memberRoles.has(roleId);
  switch (panel.behavior) {
    case 'add_only': return { add: has ? [] : [roleId], remove: [] };
    case 'remove_only': return { add: [], remove: has ? [roleId] : [] };
    case 'unique': {
      const others = panel.items.map((x) => x.roleId).filter((id) => id !== roleId && memberRoles.has(id));
      return has ? { add: [], remove: [roleId] } : { add: [roleId], remove: others };
    }
    default: return has ? { add: [], remove: [roleId] } : { add: [roleId], remove: [] };
  }
}

async function applyDecision(member: GuildMember, panel: IRolePanel, decision: PanelDecision): Promise<void> {
  for (const id of [...decision.add, ...decision.remove]) validateRole(member.guild, id);
  if (decision.remove.length) await member.roles.remove(decision.remove, `ZYTHERON role panel ${panel.name}`);
  if (decision.add.length) {
    await member.roles.add(decision.add, `ZYTHERON role panel ${panel.name}`);
    if (panel.tempMinutes) {
      for (const id of decision.add) await scheduleJob('role.expire', member.guild.id, new Date(Date.now() + panel.tempMinutes * 60_000), { userId: member.id, roleId: id }, `temprole:${member.guild.id}:${member.id}:${id}`);
    }
  }
}

function panelMessage(panel: IRolePanel) {
  const embed = baseEmbed(hexToInt(panel.color)).setTitle(panel.title).setDescription(`${panel.description}\n\n${panel.items.map((x) => `${x.emoji ?? '›'} <@&${x.roleId}>${x.description ? ` ${x.description}` : ''}`).join('\n')}`);
  if (panel.tempMinutes) embed.setFooter({ text: `Roles from this panel last ${formatDuration(panel.tempMinutes * 60_000)}` });
  const id = panel._id.toString();
  if (panel.kind === 'button') {
    return { embeds: [embed], components: chunk(panel.items.slice(0, 25), 5).map((row) => new ActionRowBuilder<ButtonBuilder>().addComponents(row.map((x) => {
      const b = new ButtonBuilder().setCustomId(`roles:btn:${id}:${x.roleId}`).setLabel(x.label).setStyle(ButtonStyle.Secondary);
      const emoji = toEmoji(x.emoji ?? undefined);
      return emoji ? b.setEmoji(emoji as never) : b;
    }))) };
  }
  if (panel.kind === 'select') {
    return { embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(`roles:sel:${id}`).setPlaceholder('Choose your roles').setMinValues(0).setMaxValues(panel.behavior === 'unique' ? 1 : panel.items.length)
        .addOptions(panel.items.slice(0, 25).map((x) => ({ label: x.label, value: x.roleId, description: x.description ?? undefined, emoji: toEmoji(x.emoji ?? undefined) }))),
    )] };
  }
  return { embeds: [embed], components: [] };
}

/** Posts a panel, or refreshes it if it is already in that channel. */
export async function publishRolePanel(guild: Guild, panel: Doc<IRolePanel>, channelId: string, actor: GuildMember): Promise<Message> {
  if (!panel.items.length) throw new UserError('Add at least one role first.');
  for (const item of panel.items) validateRole(guild, item.roleId, actor);
  const channel = postableChannel(guild, channelId, actor, panel.kind === 'reaction' ? [PermissionFlagsBits.AddReactions, PermissionFlagsBits.ReadMessageHistory] : []);
  const payload = panelMessage(panel);
  const existing = panel.messageId && panel.channelId === channel.id ? await channel.messages.fetch(panel.messageId).catch(() => null) : null;
  const message = existing ? await existing.edit(payload) : await channel.send(payload);
  if (panel.kind === 'reaction') {
    for (const item of panel.items) await message.react(item.emoji!).catch((err) => logger.debug({ err }, 'Could not add reaction'));
  }
  panel.channelId = channel.id;
  panel.messageId = message.id;
  await panel.save();
  return message;
}

const panelAutocomplete: SlashCommand['autocomplete'] = async (i) => {
  const focused = i.options.getFocused(true);
  if (focused.name !== 'panel') return i.respond([]);
  const q = String(focused.value).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '');
  const list = await RolePanel.find({ guildId: i.guildId, name: { $regex: q } }).limit(25);
  await i.respond(list.map((p) => ({ name: p.name, value: p.name })));
};

const panelOpt = (o: SlashCommandStringOption) => o.setName('panel').setDescription('Panel').setAutocomplete(true).setRequired(true);

async function requirePanel(guildId: string, name: string) {
  const panel = await RolePanel.findOne({ guildId, name });
  if (!panel) throw new UserError('That panel does not exist.');
  return panel;
}

const rolePanelCommand: SlashCommand = {
  perms: { '*': [P.ManageRoles] },
  botPerms: { publish: [P.ManageRoles] },
  autocomplete: panelAutocomplete,
  data: new SlashCommandBuilder().setName('rolepanel').setDescription('Reaction, button and select menu role panels').setDefaultMemberPermissions(P.ManageRoles).setDMPermission(false)
    .addSubcommand((s) => s.setName('create').setDescription('Create a role panel')
      .addStringOption((o) => o.setName('name').setDescription('Internal name').setRequired(true).setMaxLength(40))
      .addStringOption((o) => o.setName('kind').setDescription('Type').setRequired(true).addChoices({ name: 'Buttons', value: 'button' }, { name: 'Select menu', value: 'select' }, { name: 'Reactions', value: 'reaction' }))
      .addStringOption((o) => o.setName('title').setDescription('Embed title').setRequired(true).setMaxLength(200))
      .addStringOption((o) => o.setName('description').setDescription('Embed description').setMaxLength(1500))
      .addStringOption((o) => o.setName('behavior').setDescription('How it behaves').addChoices({ name: 'Toggle', value: 'toggle' }, { name: 'One role only', value: 'unique' }, { name: 'Add only', value: 'add_only' }, { name: 'Remove only', value: 'remove_only' }))
      .addStringOption((o) => o.setName('temporary').setDescription('Roles expire after, e.g. 7d'))
      .addRoleOption((o) => o.setName('required_role').setDescription('Only members with this role can use it')))
    .addSubcommand((s) => s.setName('add').setDescription('Add a role to a panel').addStringOption(panelOpt)
      .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))
      .addStringOption((o) => o.setName('label').setDescription('Label (default: the role name)').setMaxLength(80))
      .addStringOption((o) => o.setName('emoji').setDescription('Emoji (required for reaction panels)'))
      .addStringOption((o) => o.setName('description').setDescription('Short description').setMaxLength(100)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove a role from a panel').addStringOption(panelOpt).addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((s) => s.setName('publish').setDescription('Post or refresh a panel').addStringOption(panelOpt).addChannelOption((o) => o.setName('channel').setDescription('Channel (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName('delete').setDescription('Delete a panel and its message').addStringOption(panelOpt))
    .addSubcommand((s) => s.setName('list').setDescription('List panels'))
    .toJSON(),

  async execute(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
      const list = await RolePanel.find({ guildId: i.guildId });
      return replyEmbed(i, panelEmbed('Role Panels', list.length ? list.map((p) => `**${p.name}** ${'·'} ${p.kind} ${'·'} ${p.items.length} roles ${p.messageId ? `${'·'} [posted](https://discord.com/channels/${i.guildId}/${p.channelId}/${p.messageId})` : `${'·'} not posted`}`).join('\n') : 'None yet. Start with `/rolepanel create`.'));
    }
    if (sub === 'create') {
      const raw = i.options.getString('temporary');
      const ms = raw ? parseDuration(raw) : null;
      if (raw && !ms) throw new UserError('Invalid duration. Examples: `12h`, `7d`.');
      await RolePanel.create({ guildId: i.guildId, name: i.options.getString('name', true).trim(), kind: i.options.getString('kind', true) as IRolePanel['kind'], behavior: (i.options.getString('behavior') ?? 'toggle') as IRolePanel['behavior'], title: i.options.getString('title', true), description: i.options.getString('description') ?? 'Choose below.', tempMinutes: ms ? Math.ceil(ms / 60_000) : null, requiredRoleId: i.options.getRole('required_role')?.id ?? null });
      return replyOk(i, `Panel created. Add roles with \`/rolepanel add\`, then post it with \`/rolepanel publish\`.`);
    }
    const panel = await requirePanel(i.guildId, i.options.getString('panel', true));
    if (sub === 'add') {
      const role = i.options.getRole('role', true);
      validateRole(i.guild, role.id, i.member);
      const emoji = i.options.getString('emoji');
      if (panel.kind === 'reaction' && !emoji) throw new UserError('Reaction panels need an emoji for each role.');
      if (panel.items.length >= 25) throw new UserError('A panel can hold up to 25 roles.');
      if (panel.items.some((x) => x.roleId === role.id)) throw new UserError('That role is already on this panel.');
      panel.items.push({ roleId: role.id, label: i.options.getString('label') ?? role.name.slice(0, 80), emoji, description: i.options.getString('description') });
      await panel.save();
      return replyOk(i, `Added <@&${role.id}> to **${panel.name}**. Run \`/rolepanel publish\` to refresh it.`);
    }
    if (sub === 'remove') {
      const role = i.options.getRole('role', true);
      panel.items = panel.items.filter((x) => x.roleId !== role.id);
      await panel.save();
      return replyOk(i, 'Role removed. Run `/rolepanel publish` to refresh it.');
    }
    if (sub === 'delete') {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      if (panel.channelId && panel.messageId) await getTextChannel(i.guild, panel.channelId)?.messages.delete(panel.messageId).catch(() => undefined);
      await panel.deleteOne();
      return replyOk(i, 'Panel deleted.');
    }
    // publish
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const message = await publishRolePanel(i.guild, panel, i.options.getChannel('channel')?.id ?? panel.channelId ?? i.channelId, i.member);
    await i.editReply({ embeds: [baseEmbed().setDescription(`Published: ${message.url}`)] });
  },
};

const autoRoleCommand: SlashCommand = {
  perms: { '*': [P.ManageRoles] },
  botPerms: { setup: [P.ManageRoles], add: [P.ManageRoles] },
  data: new SlashCommandBuilder().setName('autorole').setDescription('Roles given automatically on join').setDefaultMemberPermissions(P.ManageRoles).setDMPermission(false)
    .addSubcommand((s) => s.setName('setup').setDescription('Set the main role for new humans and, optionally, bots').addRoleOption((o) => o.setName('human').setDescription('Role for people').setRequired(true)).addRoleOption((o) => o.setName('bot').setDescription('Role for bots')))
    .addSubcommand((s) => s.setName('add').setDescription('Add another auto role').addStringOption((o) => o.setName('for').setDescription('Who gets it').setRequired(true).addChoices({ name: 'Humans', value: 'humanRoles' }, { name: 'Bots', value: 'botRoles' })).addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove an auto role').addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Show auto roles'))
    .toJSON(),
  async execute(i) {
    const sub = i.options.getSubcommand();
    const { roles } = await getConfig(i.guildId);
    if (sub === 'list') return replyEmbed(i, panelEmbed('Auto Roles', `**Humans**\n${roles.humanRoles.map((r) => `<@&${r}>`).join(' ') || 'None'}\n\n**Bots**\n${roles.botRoles.map((r) => `<@&${r}>`).join(' ') || 'None'}`));
    if (sub === 'setup') {
      const human = i.options.getRole('human', true);
      const bot = i.options.getRole('bot');
      validateRole(i.guild, human.id, i.member);
      if (bot) validateRole(i.guild, bot.id, i.member);
      await updateConfig(i.guildId, 'roles', { humanRoles: [...new Set([...roles.humanRoles, human.id])], ...(bot ? { botRoles: [...new Set([...roles.botRoles, bot.id])] } : {}) });
      return replyOk(i, `New members get <@&${human.id}>${bot ? `, and new bots get <@&${bot.id}>` : ''}.`);
    }
    const role = i.options.getRole('role', true);
    if (sub === 'add') {
      validateRole(i.guild, role.id, i.member);
      const key = i.options.getString('for', true) as 'humanRoles' | 'botRoles';
      await updateConfig(i.guildId, 'roles', { [key]: [...new Set([...roles[key], role.id])] });
      return replyOk(i, `Added <@&${role.id}>.`);
    }
    await updateConfig(i.guildId, 'roles', { humanRoles: roles.humanRoles.filter((r) => r !== role.id), botRoles: roles.botRoles.filter((r) => r !== role.id) });
    await replyOk(i, `Removed <@&${role.id}>.`);
  },
};

const tempRoleCommand: SlashCommand = {
  perms: { '*': [P.ManageRoles] },
  botPerms: { '*': [P.ManageRoles] },
  data: new SlashCommandBuilder().setName('temprole').setDescription('Give a role for a limited time').setDefaultMemberPermissions(P.ManageRoles).setDMPermission(false)
    .addSubcommand((s) => s.setName('add').setDescription('Give a temporary role').addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)).addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)).addStringOption((o) => o.setName('duration').setDescription('e.g. 2h, 7d').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove it early').addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)).addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .toJSON(),
  async execute(i) {
    const member = i.options.getMember('user');
    const role = i.options.getRole('role', true);
    if (!member) throw new UserError('That user is not in this server.');
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const key = `temprole:${i.guildId}:${member.id}:${role.id}`;
    if (i.options.getSubcommand() === 'remove') {
      await member.roles.remove(role.id, `Removed early by ${i.user.tag}`);
      await cancelJobs(key);
      return replyOk(i, `Removed <@&${role.id}> from ${member}.`);
    }
    const block = roleAssignBlock(i.guild.roles.cache.get(role.id)!, i.guild.members.me!, i.member, { allowDangerous: i.user.id === i.guild.ownerId });
    if (block) throw new UserError(block);
    const ms = parseDuration(i.options.getString('duration', true));
    if (!ms) throw new UserError('Invalid duration. Examples: `2h`, `7d`.');
    await member.roles.add(role.id, `Temporary role by ${i.user.tag}`);
    await scheduleJob('role.expire', i.guildId, new Date(Date.now() + ms), { userId: member.id, roleId: role.id }, key);
    await replyOk(i, `${member} has <@&${role.id}> for **${formatDuration(ms)}**.`);
  },
};

const selfRoleCommand: SlashCommand = {
  perms: { allow: [P.ManageRoles], deny: [P.ManageRoles] },
  botPerms: { get: [P.ManageRoles], drop: [P.ManageRoles] },
  autocomplete: async (i) => {
    const { roles } = await getConfig(i.guildId);
    const q = String(i.options.getFocused()).toLowerCase();
    await i.respond(roles.selfRoles.map((id) => i.guild.roles.cache.get(id)).filter((r) => r && r.name.toLowerCase().includes(q)).slice(0, 25).map((r) => ({ name: r!.name, value: r!.id })));
  },
  data: new SlashCommandBuilder().setName('selfrole').setDescription('Roles members can give themselves').setDMPermission(false)
    .addSubcommand((s) => s.setName('list').setDescription('See available self roles'))
    .addSubcommand((s) => s.setName('get').setDescription('Give yourself a role').addStringOption((o) => o.setName('role').setDescription('Role').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) => s.setName('drop').setDescription('Remove a self role').addStringOption((o) => o.setName('role').setDescription('Role').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) => s.setName('allow').setDescription('Staff: make a role self-assignable').addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((s) => s.setName('deny').setDescription('Staff: stop a role being self-assignable').addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .toJSON(),
  async execute(i) {
    const sub = i.options.getSubcommand();
    const { roles } = await getConfig(i.guildId);
    if (sub === 'list') return replyEmbed(i, panelEmbed('Self Roles', roles.selfRoles.map((r) => `<@&${r}>`).join('\n') || 'None configured.'));
    if (sub === 'allow') {
      const role = i.options.getRole('role', true);
      validateRole(i.guild, role.id, i.member);
      await updateConfig(i.guildId, 'roles', { selfRoles: [...new Set([...roles.selfRoles, role.id])] });
      return replyOk(i, `<@&${role.id}> is now self-assignable.`);
    }
    if (sub === 'deny') {
      const role = i.options.getRole('role', true);
      await updateConfig(i.guildId, 'roles', { selfRoles: roles.selfRoles.filter((r) => r !== role.id) });
      return replyOk(i, `<@&${role.id}> is no longer self-assignable.`);
    }
    const roleId = i.options.getString('role', true);
    if (!roles.selfRoles.includes(roleId)) throw new UserError('That role is not self-assignable.');
    validateRole(i.guild, roleId);
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'get') await i.member.roles.add(roleId, 'ZYTHERON self role');
    else await i.member.roles.remove(roleId, 'ZYTHERON self role');
    await replyOk(i, `${sub === 'get' ? 'Added' : 'Removed'} <@&${roleId}>.`);
  },
};

async function reactionChange(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, added: boolean): Promise<void> {
  if (user.bot) return;
  const guild = reaction.message.guild;
  if (!guild) return;
  const panel = await RolePanel.findOne({ messageId: reaction.message.id, kind: 'reaction' });
  if (!panel) return;
  const item = panel.items.find((x) => itemKey(x.emoji) === reactionKey(reaction.emoji));
  if (!item) return;
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;
  const roles = new Set(member.roles.cache.keys());
  // A reaction add means "I want this"; removing it means "I do not". Toggle logic would fight the UI.
  if (added && roles.has(item.roleId)) return;
  if (!added && !roles.has(item.roleId)) return;
  const decision = added ? decidePanelChange({ items: panel.items, requiredRoleId: panel.requiredRoleId, behavior: panel.behavior === 'unique' ? 'unique' : 'toggle' }, roles, item.roleId) : { add: [], remove: [item.roleId] };
  if (decision.denied || (added && panel.behavior === 'remove_only') || (!added && panel.behavior === 'add_only')) return;
  await applyDecision(member, panel, decision).catch((err) => logger.debug({ err }, 'Reaction role failed'));
}

export const rolesModule: VortexModule = {
  name: 'roles',
  commands: [rolePanelCommand, autoRoleCommand, tempRoleCommand, selfRoleCommand],
  components: [
    {
      prefix: 'roles:btn',
      async run(i, [panelId, roleId]) {
        if (!i.inCachedGuild() || !i.isButton() || !panelId || !roleId) return;
        const panel = await RolePanel.findOne({ _id: panelId, guildId: i.guildId });
        if (!panel || !panel.items.some((x) => x.roleId === roleId)) return replyFail(i, 'This panel is out of date.');
        const decision = decidePanelChange(panel, new Set(i.member.roles.cache.keys()), roleId);
        if (decision.denied) return replyFail(i, decision.denied);
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        await applyDecision(i.member, panel, decision);
        const parts = [...decision.add.map((r) => `Added <@&${r}>`), ...decision.remove.map((r) => `Removed <@&${r}>`)];
        await replyOk(i, parts.join('\n') || 'Nothing to change.');
      },
    },
    {
      prefix: 'roles:sel',
      async run(i, [panelId]) {
        if (!i.inCachedGuild() || !i.isStringSelectMenu() || !panelId) return;
        const panel = await RolePanel.findOne({ _id: panelId, guildId: i.guildId });
        if (!panel) return replyFail(i, 'This panel is out of date.');
        if (panel.requiredRoleId && !i.member.roles.cache.has(panel.requiredRoleId)) return replyFail(i, 'You need another role before you can use this panel.');
        const chosen = new Set(i.values);
        const add = panel.behavior === 'remove_only' ? [] : panel.items.filter((x) => chosen.has(x.roleId) && !i.member.roles.cache.has(x.roleId)).map((x) => x.roleId);
        const remove = panel.behavior === 'add_only' ? [] : panel.items.filter((x) => !chosen.has(x.roleId) && i.member.roles.cache.has(x.roleId)).map((x) => x.roleId);
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        await applyDecision(i.member, panel, { add, remove });
        await replyOk(i, [...add.map((r) => `Added <@&${r}>`), ...remove.map((r) => `Removed <@&${r}>`)].join('\n') || 'No changes.');
      },
    },
  ],
  jobs: {
    'role.expire': async (client, guildId, payload) => {
      const guild = client.guilds.cache.get(guildId);
      const member = await guild?.members.fetch(payload.userId).catch(() => null);
      if (member?.roles.cache.has(payload.roleId)) await member.roles.remove(payload.roleId, 'Temporary role expired');
    },
  },
  events: [
    on('guildMemberAdd', async (member) => {
      const { roles } = await getConfig(member.guild.id);
      const ids = (member.user.bot ? roles.botRoles : roles.humanRoles).filter((id) => {
        const role = member.guild.roles.cache.get(id);
        return role && !roleAssignBlock(role, member.guild.members.me!);
      });
      if (ids.length) await member.roles.add(ids, 'ZYTHERON auto role').catch((err) => logger.debug({ err }, 'Auto role failed'));
    }),
    on('messageReactionAdd', (reaction, user) => reactionChange(reaction, user, true)),
    on('messageReactionRemove', (reaction, user) => reactionChange(reaction, user, false)),
  ],
};
