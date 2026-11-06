import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, ModalBuilder, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
  type SlashCommandChannelOption, type SlashCommandSubcommandBuilder,
  type ButtonInteraction, type Guild, type GuildMember, type GuildTextBasedChannel, type Message, type ModalSubmitInteraction,
} from 'discord.js';
import { postableChannel } from '../../core/channels.js';
import { logger } from '../../core/logger.js';
import { roleAssignBlock } from '../../core/permissions.js';
import { UserError, type ComponentInteraction, type GuildCommand, type SlashCommand, type VortexModule } from '../../core/types.js';
import { discordTime, parseMessageLink, truncate } from '../../core/util.js';
import { EmbedDraft, EmbedTemplate, PostedEmbed, type IEmbedDraft } from '../../db/models.js';
import { COLORS, ICONS, okEmbed, panelEmbed, replyEmbed, replyOk, baseEmbed } from '../../ui/theme.js';
import { emptySpec, EmbedSpecSchema, importJson, isEmbedEmpty, LIBRARY, MessageSpecSchema, renderEmbed, renderMessage, type EmbedSpec, type MessageSpec } from './spec.js';

const P = PermissionFlagsBits;
const MAX_TEMPLATES = 100;

// ---------- Draft persistence ----------
async function saveDraft(guildId: string, userId: string, spec: MessageSpec, extra: Partial<Pick<IEmbedDraft, 'activeIndex' | 'channelId' | 'messageId' | 'templateName'>> = {}) {
  const validated = MessageSpecSchema.parse(spec); // every edit is validated against Discord limits
  return EmbedDraft.findOneAndUpdate({ guildId, userId }, { $set: { spec: validated, ...extra } }, { upsert: true });
}

async function loadDraft(guildId: string, userId: string) {
  const draft = await EmbedDraft.findOne({ guildId, userId });
  if (!draft) throw new UserError('Your editor session expired. Start again with `/embed create`.');
  return { ...draft, spec: MessageSpecSchema.parse(draft.spec) };
}

// ---------- Editor UI ----------
const SECTIONS = [
  { value: 'body', label: 'Title and description', description: 'Title, link, description' },
  { value: 'color', label: 'Color and timestamp', description: 'Hex color and timestamp on or off' },
  { value: 'author', label: 'Author', description: 'Name and icon' },
  { value: 'footer', label: 'Footer', description: 'Text and icon' },
  { value: 'images', label: 'Thumbnail and image', description: 'Image URLs' },
  { value: 'field_add', label: 'Add field', description: 'Name, value, inline' },
  { value: 'field_edit', label: 'Edit field', description: 'Choose by number' },
  { value: 'field_remove', label: 'Remove field', description: 'Choose by number' },
  { value: 'content', label: 'Message text', description: 'Text above the embeds' },
] as const;

export function editorView(draft: { spec: MessageSpec; activeIndex: number; channelId?: string | null; messageId?: string | null; templateName?: string | null }) {
  const { spec } = draft;
  const index = Math.min(draft.activeIndex, Math.max(0, spec.embeds.length - 1));
  const preview = spec.embeds.map((e) => (isEmbedEmpty(e) ? { ...renderEmbed(e), description: '*Empty embed. Use the menu to add content.*' } : renderEmbed(e)));
  const header = [`**ZYTHERON Embed Builder** ${'·'} editing embed **${index + 1}/${spec.embeds.length || 1}**`, draft.messageId ? `Editing a posted message in <#${draft.channelId}>` : draft.channelId ? `Posting to <#${draft.channelId}>` : '', spec.buttons.length ? `${spec.buttons.length} button(s)` : '', spec.roleMenu ? `Role menu with ${spec.roleMenu.options.length} option(s)` : '', spec.content ? `Text: ${truncate(spec.content, 100)}` : ''].filter(Boolean).join(' · ');

  const rows: ActionRowBuilder<any>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId('embed:ed:section').setPlaceholder('Edit this embed...').addOptions(SECTIONS.map((s) => ({ ...s })))),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId('embed:ed:pick').setPlaceholder('Choose which embed to edit').addOptions(
        spec.embeds.length ? spec.embeds.map((e, n) => ({ label: `Embed ${n + 1}${e.title ? `: ${truncate(e.title, 60)}` : ''}`, value: String(n), default: n === index })) : [{ label: 'No embeds', value: '0' }],
      ),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('embed:ed:add').setLabel('Add embed').setStyle(ButtonStyle.Secondary).setDisabled(spec.embeds.length >= 10),
      new ButtonBuilder().setCustomId('embed:ed:dup').setLabel('Duplicate').setStyle(ButtonStyle.Secondary).setDisabled(spec.embeds.length >= 10 || !spec.embeds.length),
      new ButtonBuilder().setCustomId('embed:ed:del').setLabel('Remove embed').setStyle(ButtonStyle.Secondary).setDisabled(spec.embeds.length <= 1 && !spec.content),
      new ButtonBuilder().setCustomId('embed:ed:time').setLabel(spec.embeds[index]?.timestamp ? 'Timestamp: on' : 'Timestamp: off').setStyle(ButtonStyle.Secondary).setDisabled(!spec.embeds.length),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('embed:ed:btnlink').setLabel('Link button').setStyle(ButtonStyle.Secondary).setDisabled(spec.buttons.length >= 20),
      new ButtonBuilder().setCustomId('embed:ed:btnrole').setLabel('Role button').setStyle(ButtonStyle.Secondary).setDisabled(spec.buttons.length >= 20),
      new ButtonBuilder().setCustomId('embed:ed:menu').setLabel('Role menu').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('embed:ed:clear').setLabel('Clear components').setStyle(ButtonStyle.Secondary).setDisabled(!spec.buttons.length && !spec.roleMenu),
      new ButtonBuilder().setCustomId('embed:ed:json').setLabel('JSON').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('embed:ed:post').setLabel(draft.messageId ? 'Update message' : 'Post').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('embed:ed:save').setLabel('Save template').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('embed:ed:import').setLabel('Import JSON').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('embed:ed:close').setLabel('Close').setStyle(ButtonStyle.Danger),
    ),
  ];
  return { content: header, embeds: preview, components: rows, allowedMentions: { parse: [] } };
}

const refresh = async (i: ComponentInteraction, draft: Parameters<typeof editorView>[0]) => {
  // A modal opened from a component can update the message it came from.
  if (i.isModalSubmit() && !i.isFromMessage()) return void (await i.reply({ ...editorView(draft), flags: MessageFlags.Ephemeral } as never));
  await (i as ButtonInteraction).update(editorView(draft) as never);
};

function input(id: string, label: string, opts: { value?: string; style?: TextInputStyle; required?: boolean; max?: number; placeholder?: string } = {}) {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(opts.style ?? TextInputStyle.Short).setRequired(opts.required ?? false);
  if (opts.max) t.setMaxLength(opts.max);
  if (opts.value) t.setValue(opts.value.slice(0, opts.max ?? 4000));
  if (opts.placeholder) t.setPlaceholder(opts.placeholder);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(t);
}
const modal = (id: string, title: string, ...rows: ActionRowBuilder<TextInputBuilder>[]) => new ModalBuilder().setCustomId(id).setTitle(title).addComponents(...rows);

const sectionModals: Record<string, (e: EmbedSpec, spec: MessageSpec) => ModalBuilder> = {
  body: (e) => modal('embed:md:body', 'Title and description', input('title', 'Title', { value: e.title, max: 256 }), input('url', 'Title link', { value: e.url, placeholder: 'https://...' }), input('description', 'Description', { value: e.description, style: TextInputStyle.Paragraph, max: 4000, placeholder: 'Variables work when posted by welcome or automation' })),
  color: (e) => modal('embed:md:color', 'Color', input('color', 'Hex color', { value: e.color, required: true, max: 7, placeholder: '#7c3aed' })),
  author: (e) => modal('embed:md:author', 'Author', input('authorName', 'Name', { value: e.authorName, max: 256 }), input('authorIcon', 'Icon URL', { value: e.authorIcon })),
  footer: (e) => modal('embed:md:footer', 'Footer', input('footerText', 'Text', { value: e.footerText, style: TextInputStyle.Paragraph, max: 2048 }), input('footerIcon', 'Icon URL', { value: e.footerIcon })),
  images: (e) => modal('embed:md:images', 'Images', input('thumbnail', 'Thumbnail URL', { value: e.thumbnail }), input('image', 'Main image URL', { value: e.image })),
  field_add: () => modal('embed:md:field_add', 'Add field', input('name', 'Name', { required: true, max: 256 }), input('value', 'Value', { required: true, style: TextInputStyle.Paragraph, max: 1024 }), input('inline', 'Inline? (yes or no)', { value: 'no', max: 3 })),
  field_edit: (e) => modal('embed:md:field_edit', 'Edit field', input('number', `Field number (1-${e.fields.length})`, { required: true, max: 2 }), input('name', 'New name (empty keeps it)', { max: 256 }), input('value', 'New value (empty keeps it)', { style: TextInputStyle.Paragraph, max: 1024 }), input('inline', 'Inline? (yes, no, or empty)', { max: 3 })),
  field_remove: (e) => modal('embed:md:field_remove', 'Remove field', input('number', `Field number (1-${e.fields.length})`, { required: true, max: 2 })),
  content: (_e, spec) => modal('embed:md:content', 'Message text', input('content', 'Text above the embeds', { value: spec.content, style: TextInputStyle.Paragraph, max: 2000 })),
};

const opt = (v: string): string | undefined => v.trim() || undefined;

function applyModal(kind: string, i: ModalSubmitInteraction, embed: EmbedSpec, spec: MessageSpec): void {
  const f = (id: string) => i.fields.getTextInputValue(id);
  switch (kind) {
    case 'body': embed.title = opt(f('title')); embed.url = opt(f('url')); embed.description = opt(f('description')); break;
    case 'color': embed.color = f('color').trim().toLowerCase(); break;
    case 'author': embed.authorName = opt(f('authorName')); embed.authorIcon = opt(f('authorIcon')); break;
    case 'footer': embed.footerText = opt(f('footerText')); embed.footerIcon = opt(f('footerIcon')); break;
    case 'images': embed.thumbnail = opt(f('thumbnail')); embed.image = opt(f('image')); break;
    case 'field_add':
      if (embed.fields.length >= 25) throw new UserError('An embed can hold up to 25 fields.');
      embed.fields.push({ name: f('name'), value: f('value'), inline: /^y/i.test(f('inline')) });
      break;
    case 'field_edit': case 'field_remove': {
      const n = Number(f('number')) - 1;
      const field = embed.fields[n];
      if (!field) throw new UserError('There is no field with that number.');
      if (kind === 'field_remove') embed.fields.splice(n, 1);
      else {
        field.name = opt(f('name')) ?? field.name;
        field.value = opt(f('value')) ?? field.value;
        if (f('inline').trim()) field.inline = /^y/i.test(f('inline'));
      }
      break;
    }
    case 'content': spec.content = opt(f('content')); break;
  }
}

/** Anyone who may grant a role through a posted message must be allowed to manage that role themselves. */
function assertRoleAllowed(guild: Guild, roleId: string, actor: GuildMember): void {
  const role = guild.roles.cache.get(roleId);
  if (!role) throw new UserError('I cannot find that role.');
  const block = roleAssignBlock(role, guild.members.me!, actor);
  if (block) throw new UserError(block);
}

function resolveRole(guild: Guild, text: string): string {
  const id = text.match(/\d{17,20}/)?.[0];
  const role = id ? guild.roles.cache.get(id) : guild.roles.cache.find((r) => r.name.toLowerCase() === text.trim().toLowerCase().replace(/^@/, ''));
  if (!role) throw new UserError(`I cannot find a role called "${truncate(text, 50)}". Use its exact name or ID.`);
  return role.id;
}

/** Validates the channel and any role components, then publishes and remembers the message. */
async function publishSpec(guild: Guild, spec: MessageSpec, channelId: string | null | undefined, actor: GuildMember): Promise<Message> {
  const channel = postableChannel(guild, channelId, actor);
  for (const b of spec.buttons) if (b.kind === 'role') assertRoleAllowed(guild, b.roleId, actor);
  for (const o of spec.roleMenu?.options ?? []) assertRoleAllowed(guild, o.roleId, actor);
  const message = await channel.send({ ...renderMessage(spec, { server: guild.name, membercount: guild.memberCount }), allowedMentions: { parse: [] } });
  await PostedEmbed.updateOne({ messageId: message.id }, { $set: { guildId: guild.id, channelId: channel.id, spec, createdBy: actor.id } }, { upsert: true });
  return message;
}

async function postDraft(guild: Guild, actor: GuildMember, draft: Awaited<ReturnType<typeof loadDraft>>, fallbackChannelId: string | null): Promise<Message> {
  if (!draft.spec.embeds.length && !draft.spec.content) throw new UserError('There is nothing to post yet.');
  if (draft.spec.embeds.some(isEmbedEmpty)) throw new UserError('One of your embeds is empty. Add content or remove it first.');
  const channelId = draft.channelId ?? fallbackChannelId;
  if (!draft.messageId) return publishSpec(guild, draft.spec, channelId, actor);
  const channel = postableChannel(guild, channelId, actor);
  const existing = await channel.messages.fetch(draft.messageId);
  if (existing.author.id !== guild.client.user.id) throw new UserError('I can only edit messages I posted.');
  const payload = renderMessage(draft.spec, { server: guild.name, membercount: guild.memberCount });
  const message = await existing.edit({ ...payload, content: payload.content ?? '', allowedMentions: { parse: [] } });
  await PostedEmbed.updateOne({ messageId: message.id }, { $set: { guildId: guild.id, channelId: channel.id, spec: draft.spec, createdBy: actor.id } }, { upsert: true });
  return message;
}

function assertEditor(i: ComponentInteraction): void {
  if (!i.inCachedGuild() || !i.member.permissions.has(P.ManageMessages)) throw new UserError('You need Manage Messages to use the embed builder.');
}

// ---------- Commands ----------
const nameAutocomplete: SlashCommand['autocomplete'] = async (i) => {
  const q = String(i.options.getFocused()).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '');
  const list = await EmbedTemplate.find({ guildId: i.guildId, name: { $regex: q } }).limit(25);
  await i.respond(list.map((t) => ({ name: t.name, value: t.name })));
};

const cleanName = (name: string): string => {
  const out = name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  if (!out) throw new UserError('Template names can use letters, numbers, dashes and underscores.');
  return out;
};

async function saveTemplate(guildId: string, name: string, spec: MessageSpec, userId: string): Promise<void> {
  const exists = await EmbedTemplate.exists({ guildId, name });
  if (!exists && (await EmbedTemplate.countDocuments({ guildId })) >= MAX_TEMPLATES) throw new UserError(`This server has reached ${MAX_TEMPLATES} templates. Delete one first.`);
  await EmbedTemplate.updateOne({ guildId, name }, { $set: { spec, createdBy: userId } }, { upsert: true });
}

async function openEditor(i: GuildCommand, spec: MessageSpec, extra: { channelId?: string | null; messageId?: string | null; templateName?: string | null } = {}): Promise<void> {
  const draft = await saveDraft(i.guildId, i.user.id, spec, { activeIndex: 0, channelId: extra.channelId ?? i.channelId, messageId: extra.messageId ?? null, templateName: extra.templateName ?? null });
  const view = editorView({ ...draft!, spec }) as never;
  if (i.deferred) await i.editReply(view);
  else await i.reply({ ...(view as object), flags: MessageFlags.Ephemeral } as never);
}

async function messageFromLink(i: GuildCommand, link: string): Promise<Message> {
  const parsed = parseMessageLink(link);
  if (!parsed || parsed.guildId !== i.guildId) throw new UserError('Paste a message link from this server (right click the message, then Copy Message Link).');
  const channel = i.guild.channels.cache.get(parsed.channelId) as GuildTextBasedChannel | undefined;
  if (!channel || !('messages' in channel)) throw new UserError('I cannot read that channel.');
  return channel.messages.fetch(parsed.messageId);
}

// ---------- Building an embed from slash options ----------
const embedOptions = (s: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder => s
  .addStringOption((o) => o.setName('title').setDescription('Title').setMaxLength(256))
  .addStringOption((o) => o.setName('description').setDescription('Text. Use \\n for a new line').setMaxLength(4000))
  .addStringOption((o) => o.setName('color').setDescription('Hex color, e.g. #8B5CF6').setMaxLength(7))
  .addStringOption((o) => o.setName('image').setDescription('Main image URL'))
  .addStringOption((o) => o.setName('thumbnail').setDescription('Thumbnail URL'))
  .addStringOption((o) => o.setName('footer').setDescription('Footer text').setMaxLength(2048))
  .addStringOption((o) => o.setName('footer_icon').setDescription('Footer icon URL'))
  .addStringOption((o) => o.setName('author').setDescription('Author name').setMaxLength(256))
  .addStringOption((o) => o.setName('author_icon').setDescription('Author icon URL'))
  .addStringOption((o) => o.setName('url').setDescription('Link for the title'))
  .addBooleanOption((o) => o.setName('timestamp').setDescription('Show the current time'));

/** Slash option name -> embed property. */
const TEXT_OPTIONS: Array<[string, keyof EmbedSpec]> = [['title', 'title'], ['description', 'description'], ['image', 'image'], ['thumbnail', 'thumbnail'], ['footer', 'footerText'], ['footer_icon', 'footerIcon'], ['author', 'authorName'], ['author_icon', 'authorIcon'], ['url', 'url']];

const normalizeColor = (value: string): string => {
  const hex = value.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) throw new UserError('**color** must be a hex color such as `#8B5CF6`.');
  return `#${hex.toLowerCase()}`;
};

/** Applies whichever options were given onto an embed. Returns null when none were. */
function applyEmbedOptions(i: GuildCommand, base: EmbedSpec): EmbedSpec | null {
  const next: Record<string, unknown> = { ...base };
  let changed = false;
  for (const [option, key] of TEXT_OPTIONS) {
    const value = i.options.getString(option);
    if (value === null) continue;
    next[key] = key === 'description' ? value.replace(/\\n/g, '\n') : value.trim();
    changed = true;
  }
  const color = i.options.getString('color');
  if (color !== null) { next.color = normalizeColor(color); changed = true; }
  const timestamp = i.options.getBoolean('timestamp');
  if (timestamp !== null) { next.timestamp = timestamp; changed = true; }
  if (!changed) return null;
  const parsed = EmbedSpecSchema.safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new UserError(`**${String(issue.path[0] ?? 'value')}**: ${issue.message}.`);
  }
  return parsed.data;
}

const blankEmbed = (): EmbedSpec => EmbedSpecSchema.parse({ color: '#8b5cf6' });
const jumpLink = (guildId: string, channelId: string, messageId: string): string => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

const publishedEmbed = (verb: string, message: Message) => baseEmbed(COLORS.success)
  .setTitle(`${ICONS.ok}  ${verb}`)
  .addFields({ name: 'Channel', value: `<#${message.channelId}>`, inline: true }, { name: 'Message', value: `[Jump to it](${message.url})`, inline: true });

async function specOfMessage(message: Message): Promise<MessageSpec> {
  const tracked = await PostedEmbed.findOne({ messageId: message.id });
  return tracked ? MessageSpecSchema.parse(tracked.spec) : importJson(JSON.stringify({ content: message.content || undefined, embeds: message.embeds.map((e) => e.toJSON()) }));
}

function assertBotOwned(i: GuildCommand, message: Message, verb: string): void {
  if (message.author.id !== i.client.user.id) throw new UserError(`I can only ${verb} messages I posted.`);
}

const channelOption = (description: string) => (o: SlashCommandChannelOption) => o.setName('channel').setDescription(description).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

const embedCommand: SlashCommand = {
  cooldownSec: 2,
  perms: { '*': [P.ManageMessages] },
  autocomplete: nameAutocomplete,
  data: new SlashCommandBuilder().setName('embed').setDescription('Create and manage embeds').setDefaultMemberPermissions(P.ManageMessages).setDMPermission(false)
    .addSubcommand((s) => embedOptions(s.setName('create').setDescription('Publish an embed. With no content, opens the builder').addChannelOption(channelOption('Where to publish it (default: here)'))))
    .addSubcommand((s) => embedOptions(s.setName('preview').setDescription('See an embed privately, without publishing').addStringOption((o) => o.setName('template').setDescription('Or preview a saved template').setAutocomplete(true))))
    .addSubcommand((s) => embedOptions(s.setName('edit').setDescription('Change a published embed. With no changes, opens the builder').addStringOption((o) => o.setName('message_link').setDescription('Message link').setRequired(true)).addIntegerOption((o) => o.setName('embed_number').setDescription('Which embed in the message (default 1)').setMinValue(1).setMaxValue(10))))
    .addSubcommand((s) => s.setName('delete').setDescription('Delete a message that ZYTHERON posted').addStringOption((o) => o.setName('message_link').setDescription('Message link').setRequired(true)))
    .addSubcommand((s) => s.setName('duplicate').setDescription('Repost a published embed, or copy a template')
      .addStringOption((o) => o.setName('message_link').setDescription('Message to repost'))
      .addChannelOption(channelOption('Where to repost it (default: same channel)'))
      .addStringOption((o) => o.setName('template').setDescription('Or a template to copy').setAutocomplete(true))
      .addStringOption((o) => o.setName('new_name').setDescription('Name for the template copy').setMaxLength(40)))
    .addSubcommand((s) => s.setName('list').setDescription('List templates and published embeds'))
    .addSubcommand((s) => s.setName('builder').setDescription('Open the interactive builder').addChannelOption(channelOption('Where to post it (default: here)')))
    .addSubcommand((s) => s.setName('library').setDescription('Start from a ready-made design'))
    .addSubcommand((s) => s.setName('export').setDescription('Export a template or posted message as JSON').addStringOption((o) => o.setName('name').setDescription('Template').setAutocomplete(true)).addStringOption((o) => o.setName('message_link').setDescription('Or a message link')))
    .addSubcommand((s) => s.setName('import').setDescription('Open a JSON file in the builder').addAttachmentOption((o) => o.setName('file').setDescription('.json file').setRequired(true)))
    .addSubcommandGroup((g) => g.setName('template').setDescription('Saved embed templates')
      .addSubcommand((s) => s.setName('save').setDescription('Save your builder draft or a published message').addStringOption((o) => o.setName('name').setDescription('Template name').setRequired(true).setMaxLength(40)).addStringOption((o) => o.setName('message_link').setDescription('Save this message instead of your draft')))
      .addSubcommand((s) => s.setName('load').setDescription('Open a template, or publish it right away').addStringOption((o) => o.setName('name').setDescription('Template').setAutocomplete(true).setRequired(true)).addChannelOption(channelOption('Where to post it')).addBooleanOption((o) => o.setName('publish').setDescription('Publish now instead of opening the builder')))
      .addSubcommand((s) => s.setName('delete').setDescription('Delete a template').addStringOption((o) => o.setName('name').setDescription('Template').setAutocomplete(true).setRequired(true)))
      .addSubcommand((s) => s.setName('list').setDescription('List saved templates')))
    .toJSON(),

  async execute(i) {
    const group = i.options.getSubcommandGroup(false);
    const sub = i.options.getSubcommand();

    if (group === 'template') {
      if (sub === 'list') {
        const list = await EmbedTemplate.find({ guildId: i.guildId }).sort({ name: 1 });
        return replyEmbed(i, panelEmbed('Embed Templates', list.length ? list.map((t) => `\`${t.name}\``).join('  ') : 'None yet. Build one with `/embed builder`, then press **Save template**.'));
      }
      if (sub === 'delete') {
        const res = await EmbedTemplate.deleteOne({ guildId: i.guildId, name: i.options.getString('name', true) });
        if (!res.deletedCount) throw new UserError('That template does not exist.');
        return replyOk(i, 'Template deleted.');
      }
      if (sub === 'save') {
        const name = cleanName(i.options.getString('name', true));
        const link = i.options.getString('message_link');
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const spec = link ? await specOfMessage(await messageFromLink(i, link)) : (await loadDraft(i.guildId, i.user.id)).spec;
        await saveTemplate(i.guildId, name, spec, i.user.id);
        return replyOk(i, `Template **${name}** saved.`);
      }
      const name = i.options.getString('name', true);
      const t = await EmbedTemplate.findOne({ guildId: i.guildId, name });
      if (!t) throw new UserError('That template does not exist.');
      const spec = MessageSpecSchema.parse(t.spec);
      const channelId = i.options.getChannel('channel')?.id;
      if (i.options.getBoolean('publish')) {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const message = await publishSpec(i.guild, spec, channelId ?? i.channelId, i.member);
        return i.editReply({ embeds: [publishedEmbed('Template published', message)] });
      }
      return openEditor(i, spec, { channelId, templateName: name });
    }

    if (sub === 'create') {
      const embed = applyEmbedOptions(i, blankEmbed());
      const channelId = i.options.getChannel('channel')?.id ?? i.channelId;
      // Only a channel, a color or nothing at all: there is nothing to publish yet.
      if (!embed || isEmbedEmpty(embed)) return openEditor(i, embed ? MessageSpecSchema.parse({ embeds: [{ ...embed, title: 'New embed', description: 'Use the menu below to edit me.' }] }) : emptySpec(), { channelId });
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const message = await publishSpec(i.guild, MessageSpecSchema.parse({ embeds: [embed] }), channelId, i.member);
      return i.editReply({ embeds: [publishedEmbed('Embed published', message)] });
    }
    if (sub === 'builder') return openEditor(i, emptySpec(), { channelId: i.options.getChannel('channel')?.id });
    if (sub === 'preview') {
      const name = i.options.getString('template');
      let spec: MessageSpec;
      if (name) {
        const t = await EmbedTemplate.findOne({ guildId: i.guildId, name });
        if (!t) throw new UserError('That template does not exist.');
        spec = MessageSpecSchema.parse(t.spec);
      } else {
        const embed = applyEmbedOptions(i, blankEmbed());
        if (!embed || isEmbedEmpty(embed)) throw new UserError('Give me something to preview: a **title**, **description**, **image** or a **template**.');
        spec = MessageSpecSchema.parse({ embeds: [embed] });
      }
      const payload = renderMessage(spec, { server: i.guild.name, membercount: i.guild.memberCount });
      return i.reply({ content: `**Preview only.** Nothing was published.${payload.content ? `\n\n${payload.content}` : ''}`, embeds: payload.embeds, components: payload.components, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    if (sub === 'list') {
      const [templates, posted] = await Promise.all([EmbedTemplate.find({ guildId: i.guildId }).sort({ name: 1 }).limit(40), PostedEmbed.find({ guildId: i.guildId }).sort({ createdAt: -1 }).limit(10)]);
      return replyEmbed(i, panelEmbed('Embeds').addFields(
        { name: `Templates (${templates.length})`, value: truncate(templates.map((t) => `\`${t.name}\``).join('  ') || 'None yet.', 1000) },
        { name: 'Recently published', value: truncate(posted.map((p) => `<#${p.channelId}> ${ICONS.dot} [open](${jumpLink(i.guildId, p.channelId, p.messageId)}) ${ICONS.dot} ${discordTime(p.createdAt)}`).join('\n') || 'None yet.', 1000) },
      ));
    }
    if (sub === 'edit') {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const message = await messageFromLink(i, i.options.getString('message_link', true));
      assertBotOwned(i, message, 'edit');
      const spec = await specOfMessage(message);
      const index = (i.options.getInteger('embed_number') ?? 1) - 1;
      const changed = applyEmbedOptions(i, spec.embeds[index] ?? blankEmbed());
      if (!changed) return openEditor(i, spec, { channelId: message.channelId, messageId: message.id });
      if (index > spec.embeds.length) throw new UserError(`That message only has ${spec.embeds.length} embed(s).`);
      spec.embeds[index] = changed;
      const validated = MessageSpecSchema.parse(spec);
      const payload = renderMessage(validated, { server: i.guild.name, membercount: i.guild.memberCount });
      const updated = await message.edit({ ...payload, content: payload.content ?? '', allowedMentions: { parse: [] } });
      await PostedEmbed.updateOne({ messageId: message.id }, { $set: { guildId: i.guildId, channelId: message.channelId, spec: validated, createdBy: i.user.id } }, { upsert: true });
      return i.editReply({ embeds: [publishedEmbed('Embed updated', updated)] });
    }
    if (sub === 'delete') {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const message = await messageFromLink(i, i.options.getString('message_link', true));
      assertBotOwned(i, message, 'delete');
      await message.delete();
      await PostedEmbed.deleteOne({ messageId: message.id });
      return replyOk(i, 'Message deleted.');
    }
    if (sub === 'duplicate') {
      const link = i.options.getString('message_link');
      const template = i.options.getString('template');
      if (link) {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const message = await messageFromLink(i, link);
        assertBotOwned(i, message, 'duplicate');
        const copy = await publishSpec(i.guild, await specOfMessage(message), i.options.getChannel('channel')?.id ?? message.channelId, i.member);
        return i.editReply({ embeds: [publishedEmbed('Embed duplicated', copy)] });
      }
      if (!template) throw new UserError('Give me a **message_link** to repost, or a **template** with a **new_name** to copy.');
      const t = await EmbedTemplate.findOne({ guildId: i.guildId, name: template });
      if (!t) throw new UserError('That template does not exist.');
      const raw = i.options.getString('new_name');
      if (!raw) throw new UserError('Give the copy a **new_name**.');
      const name = cleanName(raw);
      if (await EmbedTemplate.exists({ guildId: i.guildId, name })) throw new UserError('A template with that name already exists.');
      await saveTemplate(i.guildId, name, MessageSpecSchema.parse(t.spec), i.user.id);
      return replyOk(i, `Copied to **${name}**.`);
    }
    if (sub === 'library') {
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId('embed:lib').setPlaceholder('Choose a design').addOptions(Object.entries(LIBRARY).map(([value, l]) => ({ value, label: l.label, description: l.description }))));
      return replyEmbed(i, panelEmbed('Embed Library', 'Pick a starting point. It opens in the builder, so you can change everything.'), { components: [row] });
    }
    if (sub === 'export') {
      const name = i.options.getString('name');
      const link = i.options.getString('message_link');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      let spec: unknown;
      if (name) spec = (await EmbedTemplate.findOne({ guildId: i.guildId, name }))?.spec;
      else if (link) spec = await specOfMessage(await messageFromLink(i, link));
      else spec = (await loadDraft(i.guildId, i.user.id)).spec;
      if (!spec) throw new UserError('Nothing found to export.');
      return replyEmbed(i, okEmbed('Exported.'), { files: [new AttachmentBuilder(Buffer.from(JSON.stringify(spec, null, 2)), { name: `${name ?? 'embed'}.json` })] });
    }
    // import
    const file = i.options.getAttachment('file', true);
    if (file.size > 64_000) throw new UserError('That file is too large (64 KB max).');
    if (!/^https:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(file.url)) throw new UserError('Unexpected file location.');
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const res = await fetch(file.url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new UserError('I could not download that file.');
    await openEditor(i, importJson(await res.text()));
  },
};

// ---------- Posted-message role toggles ----------
async function toggleRole(member: GuildMember, roleId: string): Promise<'added' | 'removed'> {
  const role = member.guild.roles.cache.get(roleId);
  if (!role) throw new UserError('That role no longer exists.');
  const block = roleAssignBlock(role, member.guild.members.me!);
  if (block) throw new UserError(block);
  if (member.roles.cache.has(roleId)) {
    await member.roles.remove(role, 'ZYTHERON embed role button');
    return 'removed';
  }
  await member.roles.add(role, 'ZYTHERON embed role button');
  return 'added';
}

export const embedsModule: VortexModule = {
  name: 'embeds',
  commands: [embedCommand],
  components: [
    {
      prefix: 'embed:lib',
      async run(i) {
        assertEditor(i);
        if (!i.isStringSelectMenu()) return;
        const entry = LIBRARY[i.values[0]!];
        if (!entry) return;
        const spec = entry.spec();
        const draft = await saveDraft(i.guildId!, i.user.id, spec, { activeIndex: 0, channelId: i.channelId, messageId: null, templateName: null });
        await i.update(editorView({ ...draft!, spec }) as never);
      },
    },
    {
      prefix: 'embed:ed',
      async run(i, [action]) {
        assertEditor(i);
        const guild = i.guild as Guild;
        const member = i.member as GuildMember;
        const draft = await loadDraft(guild.id, i.user.id);
        const spec = draft.spec;
        const index = Math.min(draft.activeIndex, Math.max(0, spec.embeds.length - 1));
        const embed = spec.embeds[index];

        if (action === 'section' && i.isStringSelectMenu()) {
          const section = i.values[0]!;
          if (!embed && section !== 'content') throw new UserError('Add an embed first.');
          if ((section === 'field_edit' || section === 'field_remove') && !embed?.fields.length) throw new UserError('This embed has no fields yet.');
          return i.showModal(sectionModals[section]!(embed ?? EmbedSpecSchema.parse({}), spec));
        }
        if (action === 'pick' && i.isStringSelectMenu()) {
          const updated = await saveDraft(guild.id, i.user.id, spec, { activeIndex: Number(i.values[0]) });
          return refresh(i, { ...updated!, spec });
        }
        if (action === 'add') spec.embeds.push(EmbedSpecSchema.parse({ title: `Embed ${spec.embeds.length + 1}` }));
        if (action === 'dup' && embed) spec.embeds.splice(index + 1, 0, structuredClone(embed));
        if (action === 'del') spec.embeds.splice(index, 1);
        if (action === 'time' && embed) embed.timestamp = !embed.timestamp;
        if (action === 'clear') { spec.buttons = []; spec.roleMenu = null; }
        if (action === 'add' || action === 'dup' || action === 'del' || action === 'time' || action === 'clear') {
          const updated = await saveDraft(guild.id, i.user.id, spec, { activeIndex: action === 'add' ? spec.embeds.length - 1 : action === 'dup' ? index + 1 : Math.min(index, Math.max(0, spec.embeds.length - 1)) });
          return refresh(i, { ...updated!, spec });
        }
        if (action === 'btnlink') return (i as ButtonInteraction).showModal(modal('embed:md:btnlink', 'Link button', input('label', 'Label', { required: true, max: 80 }), input('url', 'URL', { required: true, placeholder: 'https://...' }), input('emoji', 'Emoji (optional)', { placeholder: 'Unicode, or <:name:id> for a custom one' })));
        if (action === 'btnrole') return (i as ButtonInteraction).showModal(modal('embed:md:btnrole', 'Role button', input('label', 'Label', { required: true, max: 80 }), input('role', 'Role name or ID', { required: true }), input('style', 'Style', { value: 'primary', placeholder: 'primary, secondary, success or danger', max: 9 }), input('emoji', 'Emoji (optional)')));
        if (action === 'menu') return (i as ButtonInteraction).showModal(modal('embed:md:menu', 'Role select menu', input('placeholder', 'Placeholder', { value: spec.roleMenu?.placeholder ?? 'Choose your roles', max: 150 }), input('roles', 'Roles, one per line', { required: true, style: TextInputStyle.Paragraph, placeholder: 'Role name or ID', value: spec.roleMenu?.options.map((o) => o.roleId).join('\n') })));
        if (action === 'json') {
          const json = JSON.stringify(spec, null, 2);
          return void (await i.reply({ embeds: [okEmbed('Exported the current draft.')], files: [new AttachmentBuilder(Buffer.from(json), { name: 'embed.json' })], flags: MessageFlags.Ephemeral }));
        }
        if (action === 'import') return (i as ButtonInteraction).showModal(modal('embed:md:import', 'Import JSON', input('json', 'ZYTHERON or Discord message JSON', { required: true, style: TextInputStyle.Paragraph, max: 4000 })));
        if (action === 'save') return (i as ButtonInteraction).showModal(modal('embed:md:save', 'Save template', input('name', 'Template name', { required: true, max: 40, value: draft.templateName ?? undefined })));
        if (action === 'close') {
          await EmbedDraft.deleteOne({ guildId: guild.id, userId: i.user.id });
          return void (await (i as ButtonInteraction).update({ content: 'Editor closed.', embeds: [], components: [] }));
        }
        if (action === 'post') {
          for (const b of spec.buttons) if (b.kind === 'role') assertRoleAllowed(guild, b.roleId, member);
          for (const o of spec.roleMenu?.options ?? []) assertRoleAllowed(guild, o.roleId, member);
          await (i as ButtonInteraction).deferUpdate(); // publishing calls Discord, which can pass the reply deadline
          const message = await postDraft(guild, member, draft, i.channelId);
          const verb = draft.messageId ? 'Embed updated' : 'Embed published';
          await EmbedDraft.deleteOne({ guildId: guild.id, userId: i.user.id });
          return void (await (i as ButtonInteraction).editReply({ content: '', embeds: [publishedEmbed(verb, message)], components: [] }));
        }
      },
    },
    {
      prefix: 'embed:md',
      async run(i, [kind]) {
        assertEditor(i);
        if (!i.isModalSubmit() || !kind) return;
        const guild = i.guild as Guild;
        const draft = await loadDraft(guild.id, i.user.id);
        const spec = draft.spec;
        const index = Math.min(draft.activeIndex, Math.max(0, spec.embeds.length - 1));
        const f = (id: string) => i.fields.getTextInputValue(id);

        if (kind === 'save') {
          const name = cleanName(f('name'));
          await saveTemplate(guild.id, name, spec, i.user.id);
          await EmbedDraft.updateOne({ _id: draft._id }, { $set: { templateName: name } });
          return replyOk(i, `Template **${name}** saved.`);
        }
        let next = spec;
        if (kind === 'import') {
          next = importJson(f('json'));
        } else if (kind === 'btnlink') {
          spec.buttons.push({ kind: 'link', label: f('label'), url: f('url').trim(), emoji: opt(f('emoji')) });
        } else if (kind === 'btnrole') {
          const roleId = resolveRole(guild, f('role'));
          assertRoleAllowed(guild, roleId, i.member as GuildMember);
          const style = f('style').trim().toLowerCase() || 'primary';
          spec.buttons.push({ kind: 'role', label: f('label'), roleId, style: style as 'primary', emoji: opt(f('emoji')) });
        } else if (kind === 'menu') {
          const options = f('roles').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 25).map((line) => {
            const roleId = resolveRole(guild, line);
            assertRoleAllowed(guild, roleId, i.member as GuildMember);
            return { label: guild.roles.cache.get(roleId)!.name.slice(0, 100), roleId };
          });
          spec.roleMenu = { placeholder: f('placeholder') || 'Choose your roles', options };
        } else {
          const embed = spec.embeds[index] ?? EmbedSpecSchema.parse({});
          if (!spec.embeds[index] && kind !== 'content') spec.embeds.push(embed);
          applyModal(kind, i, embed, spec);
        }
        const updated = await saveDraft(guild.id, i.user.id, next, kind === 'import' ? { activeIndex: 0 } : {});
        await refresh(i, { ...updated!, spec: next });
      },
    },
    {
      prefix: 'embed:role',
      async run(i, [roleId]) {
        if (!i.inCachedGuild() || !i.isButton() || !roleId) return;
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await toggleRole(i.member, roleId);
        await replyOk(i, `${result === 'added' ? 'Added' : 'Removed'} <@&${roleId}>.`);
      },
    },
    {
      prefix: 'embed:rolemenu',
      async run(i) {
        if (!i.inCachedGuild() || !i.isStringSelectMenu()) return;
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const offered = i.component.options.map((o) => o.value);
        const chosen = new Set(i.values);
        const changes: string[] = [];
        for (const roleId of offered) {
          const has = i.member.roles.cache.has(roleId);
          if (has === chosen.has(roleId)) continue;
          try {
            const r = await toggleRole(i.member, roleId);
            changes.push(`${r === 'added' ? '+' : '-'} <@&${roleId}>`);
          } catch (err) {
            logger.debug({ err }, 'Role menu toggle failed');
            changes.push(`Could not change <@&${roleId}>`);
          }
        }
        await i.editReply({ embeds: [changes.length ? baseEmbed(COLORS.success).setDescription(changes.join('\n')) : baseEmbed(COLORS.muted).setDescription('No changes.')] });
      },
    },
  ],
};


