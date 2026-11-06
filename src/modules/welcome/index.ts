import { MessageFlags } from 'discord.js';
import {
  ActionRowBuilder, AttachmentBuilder, ChannelType, ModalBuilder, PermissionFlagsBits, SlashCommandBuilder, TextInputBuilder, TextInputStyle,
  type EmbedBuilder, type GuildMember, type PartialGuildMember,
} from 'discord.js';
import { WelcomeTemplateSchema, type WelcomeTemplate } from '../../config/guildConfig.js';
import { postableChannel } from '../../core/channels.js';
import { getConfig, updateConfig } from '../../core/configService.js';
import { logger } from '../../core/logger.js';
import { on, UserError, type SlashCommand, type VortexModule } from '../../core/types.js';
import { hexToInt, safeMentions, truncate } from '../../core/util.js';
import { memberVars, renderVars, VARIABLE_HELP, type Vars } from '../../core/variables.js';
import { baseEmbed, panelEmbed, replyEmbed, replyOk } from '../../ui/theme.js';
import { getTextChannel } from '../logging/service.js';
import { BACKGROUND_PRESETS, renderCard } from './card.js';

async function avatarBuffer(member: GuildMember | PartialGuildMember): Promise<Buffer | null> {
  try {
    const res = await fetch(member.displayAvatarURL({ extension: 'png', size: 256 }), { signal: AbortSignal.timeout(5000) });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

export interface BuiltWelcome { content?: string; embeds: EmbedBuilder[]; files: AttachmentBuilder[]; allowedMentions: { parse: ('users')[] } }

export async function buildMessage(template: WelcomeTemplate, member: GuildMember | PartialGuildMember, vars: Vars): Promise<BuiltWelcome> {
  const embed = baseEmbed(hexToInt(template.color))
    .setTitle(truncate(renderVars(template.title, vars), 256) || null)
    .setDescription(truncate(renderVars(template.description, vars), 4000) || null)
    .setFooter(template.footer ? { text: truncate(renderVars(template.footer, vars), 200) } : null);
  const files: AttachmentBuilder[] = [];
  if (template.card.enabled) {
    try {
      const png = await renderCard({
        background: template.card.background, accent: template.card.accent, headline: renderVars(template.card.headline, vars),
        title: String(vars.username), subline: renderVars(template.card.subline, vars), avatar: await avatarBuffer(member), seed: member.id,
      });
      files.push(new AttachmentBuilder(png, { name: 'zytheron-card.png' }));
      embed.setImage('attachment://zytheron-card.png');
    } catch (err) {
      logger.warn({ err }, 'Welcome card failed; sending the embed without an image');
    }
  } else {
    embed.setThumbnail(member.displayAvatarURL({ size: 256 }));
  }
  const content = template.content ? renderVars(template.content, vars) : undefined;
  return { content, embeds: [embed], files, allowedMentions: safeMentions as { parse: ('users')[] } };
}

function activeTemplate(welcome: Awaited<ReturnType<typeof getConfig>>['welcome']): WelcomeTemplate {
  return welcome.templates.find((t) => t.id === welcome.activeTemplate) ?? welcome.templates[0]!;
}

export async function onMemberJoin(member: GuildMember): Promise<void> {
  const { welcome } = await getConfig(member.guild.id);
  if (member.user.bot) return;
  const vars = memberVars(member, { newcomer: true });
  if (welcome.enabled) {
    const channel = getTextChannel(member.guild, welcome.channelId);
    if (channel) await channel.send(await buildMessage(activeTemplate(welcome), member, vars)).catch((err) => logger.debug({ err }, 'Welcome send failed'));
  }
  if (welcome.dmEnabled) {
    await member.send({ embeds: [baseEmbed().setTitle(member.guild.name).setDescription(truncate(renderVars(welcome.dmMessage, vars), 4000))] }).catch(() => undefined);
  }
}

export async function onMemberLeave(member: GuildMember | PartialGuildMember): Promise<void> {
  const { welcome } = await getConfig(member.guild.id);
  if (!welcome.goodbyeEnabled || member.user?.bot || !member.user) return;
  const channel = getTextChannel(member.guild, welcome.goodbyeChannelId ?? welcome.channelId);
  if (channel) await channel.send(await buildMessage(welcome.goodbye, member, memberVars(member, { newcomer: true }))).catch((err) => logger.debug({ err }, 'Goodbye send failed'));
}

const validBackground = (value: string): string => {
  if (value.startsWith('https://') || BACKGROUND_PRESETS[value]) return value;
  throw new UserError(`Background must be an HTTPS image URL or one of: ${Object.keys(BACKGROUND_PRESETS).map((b) => `\`${b}\``).join(', ')}.`);
};

const templateAutocomplete = async (i: Parameters<NonNullable<SlashCommand['autocomplete']>>[0]) => {
  const { welcome } = await getConfig(i.guildId);
  const query = String(i.options.getFocused()).toLowerCase();
  await i.respond(welcome.templates.filter((t) => t.id.includes(query)).slice(0, 25).map((t) => ({ name: t.id, value: t.id })));
};

const welcomeCommand: SlashCommand = {
  cooldownSec: 3,
  perms: { '*': [PermissionFlagsBits.ManageGuild] },
  autocomplete: templateAutocomplete,
  data: new SlashCommandBuilder().setName('welcome').setDescription('Welcome and goodbye system').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('setup').setDescription('Turn on welcome messages').addChannelOption((o) => o.setName('channel').setDescription('Welcome channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
    .addSubcommand((s) => s.setName('test').setDescription('Send the welcome message to the channel using yourself'))
    .addSubcommand((s) => s.setName('preview').setDescription('Preview a template privately').addStringOption((o) => o.setName('template').setDescription('Template').setAutocomplete(true)).addBooleanOption((o) => o.setName('goodbye').setDescription('Preview the goodbye message')))
    .addSubcommand((s) => s.setName('edit').setDescription('Edit a template text. Creates it if new.').addStringOption((o) => o.setName('template').setDescription('Template name').setAutocomplete(true).setRequired(true).setMaxLength(32)))
    .addSubcommand((s) => s.setName('edit-goodbye').setDescription('Edit the goodbye message'))
    .addSubcommand((s) => s.setName('use').setDescription('Choose the active template').addStringOption((o) => o.setName('template').setDescription('Template').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Delete a template').addStringOption((o) => o.setName('template').setDescription('Template').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) => s.setName('card').setDescription('Style the welcome image of a template')
      .addStringOption((o) => o.setName('template').setDescription('Template').setAutocomplete(true).setRequired(true))
      .addBooleanOption((o) => o.setName('enabled').setDescription('Attach the image'))
      .addStringOption((o) => o.setName('background').setDescription('zytheron, aurora, nebula, midnight, ember, or an HTTPS image URL').setMaxLength(500))
      .addStringOption((o) => o.setName('accent').setDescription('Hex color, e.g. #7c3aed').setMaxLength(7)))
    .addSubcommand((s) => s.setName('goodbye').setDescription('Configure goodbye messages').addBooleanOption((o) => o.setName('enabled').setDescription('Enabled').setRequired(true)).addChannelOption((o) => o.setName('channel').setDescription('Channel (default: the welcome channel)').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('dm').setDescription('Send a welcome DM').addBooleanOption((o) => o.setName('enabled').setDescription('Enabled').setRequired(true)).addStringOption((o) => o.setName('message').setDescription('Message text. Variables are supported.').setMaxLength(2000)))
    .addSubcommand((s) => s.setName('status').setDescription('Show the welcome configuration'))
    .toJSON(),

  async execute(i) {
    const sub = i.options.getSubcommand();
    const { welcome } = await getConfig(i.guildId);

    if (sub === 'setup') {
      const channel = i.options.getChannel('channel', true);
      postableChannel(i.guild, channel.id, null, [PermissionFlagsBits.AttachFiles]);
      await updateConfig(i.guildId, 'welcome', { enabled: true, channelId: channel.id });
      return replyOk(i, `Welcome messages are on in <#${channel.id}>. Try \`/welcome test\`.`);
    }
    if (sub === 'test') {
      if (!welcome.channelId) throw new UserError('Set a welcome channel first with `/welcome setup`.');
      const channel = postableChannel(i.guild, welcome.channelId, null, [PermissionFlagsBits.AttachFiles]);
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await channel.send(await buildMessage(activeTemplate(welcome), i.member, memberVars(i.member)));
      await i.editReply({ embeds: [baseEmbed().setDescription(`Sent to <#${channel.id}>.`)] });
      return;
    }
    if (sub === 'preview') {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const id = i.options.getString('template');
      const template = i.options.getBoolean('goodbye') ? welcome.goodbye : id ? welcome.templates.find((t) => t.id === id) : activeTemplate(welcome);
      if (!template) throw new UserError('That template does not exist.');
      const built = await buildMessage(template, i.member, memberVars(i.member));
      await i.editReply({ content: built.content ?? '', embeds: built.embeds, files: built.files });
      return;
    }
    if (sub === 'edit' || sub === 'edit-goodbye') {
      const goodbye = sub === 'edit-goodbye';
      const id = goodbye ? 'goodbye' : i.options.getString('template', true).toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const current = goodbye ? welcome.goodbye : (welcome.templates.find((t) => t.id === id) ?? WelcomeTemplateSchema.parse({ id }));
      const modal = new ModalBuilder().setCustomId(`welcome:edit:${goodbye ? 'g' : 't'}:${id}`).setTitle(`Template: ${id}`).addComponents(
        ...[
          new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setMaxLength(256).setRequired(false).setValue(current.title),
          new TextInputBuilder().setCustomId('description').setLabel('Description').setPlaceholder('Use {user} {server} {membercount} ...').setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(false).setValue(current.description),
          new TextInputBuilder().setCustomId('content').setLabel('Text above the embed (optional)').setStyle(TextInputStyle.Paragraph).setMaxLength(2000).setRequired(false).setValue(current.content),
          new TextInputBuilder().setCustomId('footer').setLabel('Footer').setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(false).setValue(current.footer),
          new TextInputBuilder().setCustomId('color').setLabel('Color (hex)').setStyle(TextInputStyle.Short).setMinLength(7).setMaxLength(7).setValue(current.color),
        ].map((input) => new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
      );
      return i.showModal(modal);
    }
    if (sub === 'use') {
      const id = i.options.getString('template', true);
      if (!welcome.templates.some((t) => t.id === id)) throw new UserError('That template does not exist.');
      await updateConfig(i.guildId, 'welcome', { activeTemplate: id });
      return replyOk(i, `**${id}** is now the active welcome template.`);
    }
    if (sub === 'remove') {
      const id = i.options.getString('template', true);
      if (welcome.templates.length <= 1) throw new UserError('Keep at least one template.');
      const templates = welcome.templates.filter((t) => t.id !== id);
      await updateConfig(i.guildId, 'welcome', { templates, activeTemplate: welcome.activeTemplate === id ? templates[0]!.id : welcome.activeTemplate });
      return replyOk(i, `Template **${id}** removed.`);
    }
    if (sub === 'card') {
      const id = i.options.getString('template', true);
      const enabled = i.options.getBoolean('enabled');
      const background = i.options.getString('background');
      const accent = i.options.getString('accent');
      if (!welcome.templates.some((t) => t.id === id)) throw new UserError('That template does not exist.');
      const templates = welcome.templates.map((t) => (t.id === id ? { ...t, card: { ...t.card, ...(enabled === null ? {} : { enabled }), ...(background ? { background: validBackground(background) } : {}), ...(accent ? { accent } : {}) } } : t));
      await updateConfig(i.guildId, 'welcome', { templates });
      return replyOk(i, 'Card updated. See it with `/welcome preview`.');
    }
    if (sub === 'goodbye') {
      const channel = i.options.getChannel('channel');
      await updateConfig(i.guildId, 'welcome', { goodbyeEnabled: i.options.getBoolean('enabled', true), ...(channel ? { goodbyeChannelId: channel.id } : {}) });
      return replyOk(i, 'Goodbye settings updated.');
    }
    if (sub === 'dm') {
      const message = i.options.getString('message');
      await updateConfig(i.guildId, 'welcome', { dmEnabled: i.options.getBoolean('enabled', true), ...(message ? { dmMessage: message } : {}) });
      return replyOk(i, 'Welcome DM updated.');
    }
    await replyEmbed(i, panelEmbed('Welcome System').addFields(
      { name: 'Welcome', value: `${welcome.enabled ? 'On' : 'Off'}${welcome.channelId ? ` in <#${welcome.channelId}>` : ''}`, inline: true },
      { name: 'Goodbye', value: `${welcome.goodbyeEnabled ? 'On' : 'Off'}${welcome.goodbyeChannelId ? ` in <#${welcome.goodbyeChannelId}>` : ''}`, inline: true },
      { name: 'DM', value: welcome.dmEnabled ? 'On' : 'Off', inline: true },
      { name: 'Templates', value: welcome.templates.map((t) => `${t.id === welcome.activeTemplate ? '**›** ' : ''}\`${t.id}\``).join('  ') },
      { name: 'Variables', value: VARIABLE_HELP },
    ));
  },
};

export const welcomeModule: VortexModule = {
  name: 'welcome',
  commands: [welcomeCommand],
  components: [
    {
      prefix: 'welcome:edit',
      async run(i, [kind, id]) {
        if (!i.isModalSubmit() || !i.inCachedGuild() || !id) return;
        if (!i.member.permissions.has(PermissionFlagsBits.ManageGuild)) throw new UserError('You need Manage Server to edit templates.');
        const fields = { title: i.fields.getTextInputValue('title'), description: i.fields.getTextInputValue('description'), content: i.fields.getTextInputValue('content'), footer: i.fields.getTextInputValue('footer'), color: i.fields.getTextInputValue('color') };
        const { welcome } = await getConfig(i.guildId);
        if (kind === 'g') {
          await updateConfig(i.guildId, 'welcome', { goodbye: { ...welcome.goodbye, ...fields } });
        } else {
          const existing = welcome.templates.find((t) => t.id === id);
          const next = WelcomeTemplateSchema.parse({ ...(existing ?? { id }), ...fields });
          const templates = existing ? welcome.templates.map((t) => (t.id === id ? next : t)) : [...welcome.templates, next];
          await updateConfig(i.guildId, 'welcome', { templates });
        }
        await replyOk(i, `Template **${id}** saved. See it with \`/welcome preview\`.`);
      },
    },
  ],
  events: [on('guildMemberAdd', onMemberJoin), on('guildMemberRemove', onMemberLeave)],
};
