import {
  AuditLogEvent, ChannelType, PermissionFlagsBits, PermissionsBitField, SlashCommandBuilder,
  type Collection, type EmbedBuilder, type Guild, type GuildAuditLogsEntry, type GuildMember, type Message, type PartialGuildMember, type PartialMessage, type Snowflake, type VoiceState,
} from 'discord.js';
import { LOG_CATEGORIES, type LogCategory } from '../../config/guildConfig.js';
import { postableChannel } from '../../core/channels.js';
import { getConfig, updateConfig } from '../../core/configService.js';
import { on, type SlashCommand, type VortexModule } from '../../core/types.js';
import { discordTime, truncate } from '../../core/util.js';
import { baseEmbed, COLORS, panelEmbed, replyEmbed, replyOk } from '../../ui/theme.js';
import { sendLog } from './service.js';

const clean = (text: string | null | undefined, max = 1000): string => truncate(text?.trim() || '(empty)', max);

async function channelIgnored(guildId: string, channelId: string | null): Promise<boolean> {
  if (!channelId) return false;
  return (await getConfig(guildId)).logging.ignoredChannels.includes(channelId);
}

/** The names Discord shows in its own settings, where they differ from the API's. */
const PERMISSION_NAMES: Record<string, string> = {
  ViewChannel: 'View Channels', ManageGuild: 'Manage Server', CreateInstantInvite: 'Create Invite', ModerateMembers: 'Timeout Members', ManageGuildExpressions: 'Manage Expressions', ManageEmojisAndStickers: 'Manage Expressions',
  CreateGuildExpressions: 'Create Expressions', SendTTSMessages: 'Send Text-to-Speech Messages', MentionEveryone: 'Mention @everyone, @here and All Roles', UseExternalEmojis: 'Use External Emoji', UseVAD: 'Use Voice Activity',
  Stream: 'Video', ViewGuildInsights: 'View Server Insights', ManageRoles: 'Manage Roles', Connect: 'Connect', Speak: 'Speak', Administrator: 'Administrator',
};

export function permissionNames(bits: bigint): string[] {
  const known = new PermissionsBitField(bits & PermissionsBitField.All);
  const names = [...new Set(known.toArray().map((flag) => PERMISSION_NAMES[flag] ?? flag.replace(/([a-z])([A-Z])/g, '$1 $2')))];
  return bits & ~PermissionsBitField.All ? [...names, 'A permission newer than this bot'] : names;
}

const toBits = (value: unknown): bigint | null => {
  if (value === undefined || value === null || value === '') return 0n;
  try {
    return BigInt(value as string);
  } catch {
    return null;
  }
};

/** Discord reports permissions as one large number, which says nothing to a person reading the log. */
function renderPermissionChange(c: { key: string; old?: unknown; new?: unknown }): string | null {
  const heading = { permissions: 'Permissions', allow: 'Allowed permissions', deny: 'Denied permissions' }[c.key];
  if (!heading) return null;
  const before = toBits(c.old);
  const after = toBits(c.new);
  if (before === null || after === null) return null;
  const added = permissionNames(after & ~before);
  const removed = permissionNames(before & ~after);
  return [
    added.length ? `**${heading} added**: ${added.join(', ')}` : '',
    removed.length ? `**${heading} removed**: ${removed.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

export function renderChange(c: { key: string; old?: unknown; new?: unknown }): string {
  const permissions = renderPermissionChange(c);
  if (permissions !== null) return permissions;
  // Discord stores colours as plain numbers.
  if ((c.key === 'color' || c.key === 'colors') && (typeof c.old === 'number' || typeof c.new === 'number')) {
    const hex = (v: unknown) => (typeof v === 'number' && v > 0 ? `#${v.toString(16).padStart(6, '0')}` : 'none');
    return `**color**: ${hex(c.old)} › ${hex(c.new)}`;
  }
  const fmt = (v: unknown): string => {
    if (v === undefined || v === null || v === '') return 'none';
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x && 'name' in x ? String((x as { name: unknown }).name) : JSON.stringify(x))).join(', ') || 'none';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  const key = c.key.replace(/^\$/, '').replace(/_/g, ' ');
  return `**${key}**: ${truncate(fmt(c.old), 120)} › ${truncate(fmt(c.new), 120)}`;
}

/** Audit log entries are the source for structural changes because they name who did it. */
const AUDIT_MAP: Partial<Record<AuditLogEvent, { category: LogCategory; title: string; color: number }>> = {
  [AuditLogEvent.RoleCreate]: { category: 'role', title: 'Role created', color: COLORS.success },
  [AuditLogEvent.RoleDelete]: { category: 'role', title: 'Role deleted', color: COLORS.danger },
  [AuditLogEvent.RoleUpdate]: { category: 'role', title: 'Role updated', color: COLORS.accent },
  [AuditLogEvent.ChannelCreate]: { category: 'channel', title: 'Channel created', color: COLORS.success },
  [AuditLogEvent.ChannelDelete]: { category: 'channel', title: 'Channel deleted', color: COLORS.danger },
  [AuditLogEvent.ChannelUpdate]: { category: 'channel', title: 'Channel updated', color: COLORS.accent },
  [AuditLogEvent.ChannelOverwriteCreate]: { category: 'channel', title: 'Channel permissions added', color: COLORS.accent },
  [AuditLogEvent.ChannelOverwriteUpdate]: { category: 'channel', title: 'Channel permissions updated', color: COLORS.accent },
  [AuditLogEvent.ChannelOverwriteDelete]: { category: 'channel', title: 'Channel permissions removed', color: COLORS.accent },
  [AuditLogEvent.MemberBanAdd]: { category: 'ban', title: 'Member banned', color: COLORS.danger },
  [AuditLogEvent.MemberBanRemove]: { category: 'ban', title: 'Member unbanned', color: COLORS.success },
  [AuditLogEvent.MemberKick]: { category: 'member', title: 'Member kicked', color: COLORS.danger },
  [AuditLogEvent.MemberUpdate]: { category: 'member', title: 'Member updated', color: COLORS.accent },
  [AuditLogEvent.MemberRoleUpdate]: { category: 'member', title: 'Member roles updated', color: COLORS.accent },
  [AuditLogEvent.WebhookCreate]: { category: 'webhook', title: 'Webhook created', color: COLORS.warning },
  [AuditLogEvent.WebhookUpdate]: { category: 'webhook', title: 'Webhook updated', color: COLORS.accent },
  [AuditLogEvent.WebhookDelete]: { category: 'webhook', title: 'Webhook deleted', color: COLORS.warning },
  [AuditLogEvent.GuildUpdate]: { category: 'server', title: 'Server updated', color: COLORS.accent },
};

function targetLabel(entry: GuildAuditLogsEntry): string {
  const nameChange = entry.changes.find((c) => c.key === 'name');
  const target = entry.target as { name?: string; tag?: string } | null;
  const name = target?.tag ?? target?.name ?? (nameChange?.old as string) ?? (nameChange?.new as string);
  const mention = entry.targetType === 'User' ? `<@${entry.targetId}>` : '';
  return [mention, name ? `\`${name}\`` : '', entry.targetId ? `(${entry.targetId})` : ''].filter(Boolean).join(' ') || 'Unknown';
}

/** Role and channel logs share one layout: what it is, what changed, and who did it. */
const READABLE_LOGS: Partial<Record<AuditLogEvent, { kind: 'role' | 'channel'; happened: string; details: boolean }>> = {
  [AuditLogEvent.RoleCreate]: { kind: 'role', happened: 'role has been created.', details: false },
  [AuditLogEvent.RoleUpdate]: { kind: 'role', happened: 'role has been updated.', details: true },
  [AuditLogEvent.RoleDelete]: { kind: 'role', happened: 'role has been deleted.', details: false },
  [AuditLogEvent.ChannelCreate]: { kind: 'channel', happened: 'channel has been created.', details: false },
  [AuditLogEvent.ChannelUpdate]: { kind: 'channel', happened: 'channel has been updated.', details: true },
  [AuditLogEvent.ChannelDelete]: { kind: 'channel', happened: 'channel has been deleted.', details: false },
  [AuditLogEvent.ChannelOverwriteCreate]: { kind: 'channel', happened: 'channel permissions have been added.', details: false },
  [AuditLogEvent.ChannelOverwriteUpdate]: { kind: 'channel', happened: 'channel permissions have been updated.', details: false },
  [AuditLogEvent.ChannelOverwriteDelete]: { kind: 'channel', happened: 'channel permissions have been removed.', details: false },
};

const OVERWRITE_TITLES: Partial<Record<AuditLogEvent, string>> = {
  [AuditLogEvent.ChannelOverwriteCreate]: 'Channel Permissions Added',
  [AuditLogEvent.ChannelOverwriteUpdate]: 'Channel Permissions Updated',
  [AuditLogEvent.ChannelOverwriteDelete]: 'Channel Permissions Removed',
};

/** ✅ allowed or added, ⛔ denied or removed, ➖ back to the default for a channel. */
function permissionLines(changes: GuildAuditLogsEntry['changes']): string[] {
  const between = (key: string): [string[], string[]] => {
    const change = changes.find((c) => c.key === key);
    const before = toBits(change?.old);
    const after = toBits(change?.new);
    if (!change || before === null || after === null) return [[], []];
    return [permissionNames(after & ~before), permissionNames(before & ~after)];
  };
  const [added, removed] = between('permissions');
  const [allowed, unallowed] = between('allow');
  const [denied, undenied] = between('deny');
  const decided = new Set([...allowed, ...denied]);
  return [
    ...[...added, ...allowed].map((n) => `✅ ${n}`),
    ...[...removed, ...denied].map((n) => `⛔ ${n}`),
    ...[...new Set([...unallowed, ...undenied])].filter((n) => !decided.has(n)).map((n) => `➖ ${n}`),
  ];
}

/** Discord shows roles with no colour in this grey. */
const DEFAULT_ROLE_COLOR = '#99AAB5';

function colorHex(value: unknown): string {
  const number = typeof value === 'object' && value ? (value as { primary_color?: unknown }).primary_color : value;
  return typeof number === 'number' && number > 0 ? `#${number.toString(16).padStart(6, '0').toUpperCase()}` : DEFAULT_ROLE_COLOR;
}

/** Newer role updates report the colour twice, as color and as colors. */
function colorChange(changes: GuildAuditLogsEntry['changes']): { from: string; to: string } | null {
  const change = changes.find((c) => c.key === 'color') ?? changes.find((c) => (c.key as string) === 'colors');
  if (!change) return null;
  const from = colorHex(change.old);
  const to = colorHex(change.new);
  return from === to ? null : { from, to };
}

export function readableLogEmbed(entry: GuildAuditLogsEntry, guild: Guild): EmbedBuilder {
  const layout = READABLE_LOGS[entry.action]!;
  const target = entry.target as { name?: string } | null;
  const nameChange = entry.changes.find((c) => c.key === 'name');
  const name = target?.name ?? (nameChange?.new as string | undefined) ?? (nameChange?.old as string | undefined) ?? 'Unknown';
  const label = `${layout.kind === 'channel' ? '#' : ''}${truncate(name, 80)}`.replace(/`/g, "'");
  const embed = baseEmbed(COLORS.accent)
    .setAuthor({ name: guild.name, iconURL: guild.iconURL() ?? undefined })
    .setDescription(`${layout.kind === 'role' ? '👥' : '💬'} \`${label}\` **${layout.happened}**`);

  const lines = entry.action === AuditLogEvent.RoleDelete ? [] : permissionLines(entry.changes);
  const appliesTo = (entry.extra as { id?: string } | null)?.id;
  if (OVERWRITE_TITLES[entry.action]) {
    // A link to the channel, then who the permissions are for, with what each permission now does.
    embed.setDescription(`🏠 **${OVERWRITE_TITLES[entry.action]}:** ${entry.targetId ? `<#${entry.targetId}>` : `\`${label}\``}`);
    const who = !appliesTo ? 'Unknown' : appliesTo === guild.id ? '@everyone' : guild.roles.cache.has(appliesTo) ? `<@&${appliesTo}>` : `<@${appliesTo}>`;
    embed.addFields({ name: 'Permissions', value: truncate([`↘️ ${who}`, ...lines].join('\n'), 1000) });
  } else if (lines.length) {
    embed.addFields({ name: 'New permissions', value: truncate(lines.join('\n'), 1000) });
  }
  if (layout.details) {
    const others = entry.changes.filter((c) => !['permissions', 'allow', 'deny', 'permission_overwrites', 'color', 'colors'].includes(c.key)).map(renderChange).filter(Boolean).join('\n');
    if (others) embed.addFields({ name: 'Other changes', value: truncate(others, 1000) });
  }
  if (entry.reason) embed.addFields({ name: 'Reason', value: clean(entry.reason, 500) });
  const recolored = layout.kind === 'role' && layout.details ? colorChange(entry.changes) : null;
  if (recolored) embed.addFields({ name: 'Old color', value: recolored.from, inline: true }, { name: 'New color', value: recolored.to, inline: true });
  embed.addFields({ name: 'Responsible Moderator', value: entry.executorId ? `<@${entry.executorId}>` : 'Unknown', inline: Boolean(recolored) });
  const executor = entry.executor ?? (entry.executorId ? guild.client.users.cache.get(entry.executorId) : null);
  if (executor) embed.setFooter({ text: executor.username ?? 'Unknown', iconURL: executor.displayAvatarURL() });
  return embed;
}

async function handleAudit(entry: GuildAuditLogsEntry, guild: Guild): Promise<void> {
  const mapped = AUDIT_MAP[entry.action];
  if (!mapped) return;
  if (READABLE_LOGS[entry.action]) {
    await sendLog(guild, mapped.category, readableLogEmbed(entry, guild));
    return;
  }
  const embed = baseEmbed(mapped.color).setTitle(mapped.title).addFields(
    { name: 'Target', value: targetLabel(entry), inline: true },
    { name: 'By', value: entry.executorId ? `<@${entry.executorId}>` : 'Unknown', inline: true },
  );
  if (entry.reason) embed.addFields({ name: 'Reason', value: clean(entry.reason, 500) });
  const changes = entry.changes.map(renderChange).filter(Boolean).join('\n');
  if (changes) embed.setDescription(truncate(changes, 3500));
  await sendLog(guild, mapped.category, embed);
}

const logCommand: SlashCommand = {
  perms: { '*': [PermissionFlagsBits.ManageGuild] },
  data: new SlashCommandBuilder().setName('logs').setDescription('Server logging').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('setup').setDescription('Turn logging on and set the default channel').addChannelOption((o) => o.setName('channel').setDescription('Default log channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((s) => s.setName('status').setDescription('Show the logging configuration'))
    .addSubcommand((s) => s.setName('route').setDescription('Send one category to its own channel')
      .addStringOption((o) => o.setName('category').setDescription('Category').setRequired(true).addChoices(...LOG_CATEGORIES.map((c) => ({ name: c, value: c }))))
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((s) => s.setName('toggle').setDescription('Enable or disable one category')
      .addStringOption((o) => o.setName('category').setDescription('Category').setRequired(true).addChoices(...LOG_CATEGORIES.map((c) => ({ name: c, value: c }))))
      .addBooleanOption((o) => o.setName('enabled').setDescription('Enabled').setRequired(true)))
    .addSubcommand((s) => s.setName('ignore').setDescription('Ignore or stop ignoring a channel for message and voice logs')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true))
      .addBooleanOption((o) => o.setName('remove').setDescription('Stop ignoring')))
    .addSubcommand((s) => s.setName('off').setDescription('Turn logging off'))
    .toJSON(),
  async execute(i) {
    const sub = i.options.getSubcommand();
    const { logging } = await getConfig(i.guildId);
    if (sub === 'setup') {
      const channel = i.options.getChannel('channel', true);
      postableChannel(i.guild, channel.id);
      await updateConfig(i.guildId, 'logging', { enabled: true, defaultChannelId: channel.id });
      return replyOk(i, `Logging is on. Events go to <#${channel.id}>. I need **View Audit Log** to report who made each change.`);
    }
    if (sub === 'route') {
      const category = i.options.getString('category', true);
      const channel = i.options.getChannel('channel', true);
      postableChannel(i.guild, channel.id);
      // Choosing a channel means logs are wanted, so a switched-off main setting must not silently block them.
      await updateConfig(i.guildId, 'logging', { enabled: true, channels: { [category]: channel.id } });
      const turnedOn = logging.enabled ? '' : ' Logging is now on.';
      const noDefault = logging.defaultChannelId ? '' : ' Other events have no channel yet, so use `/logs setup` to send them somewhere too.';
      return replyOk(i, `**${category}** events now go to <#${channel.id}>.${turnedOn}${noDefault}`);
    }
    if (sub === 'toggle') {
      const category = i.options.getString('category', true) as LogCategory;
      const enabled = i.options.getBoolean('enabled', true);
      const disabled = enabled ? logging.disabled.filter((c) => c !== category) : [...new Set([...logging.disabled, category])];
      await updateConfig(i.guildId, 'logging', { disabled });
      return replyOk(i, `**${category}** logging is ${enabled ? 'on' : 'off'}.`);
    }
    if (sub === 'ignore') {
      const channel = i.options.getChannel('channel', true);
      const next = i.options.getBoolean('remove') ? logging.ignoredChannels.filter((c) => c !== channel.id) : [...new Set([...logging.ignoredChannels, channel.id])];
      await updateConfig(i.guildId, 'logging', { ignoredChannels: next });
      return replyOk(i, 'Ignored channels updated.');
    }
    if (sub === 'off') {
      await updateConfig(i.guildId, 'logging', { enabled: false });
      return replyOk(i, 'Logging is off.');
    }
    const warning = !logging.enabled
      ? '\n\n**Logging is off, so nothing is being posted.** Use `/logs setup` to turn it on.'
      : logging.defaultChannelId ? '' : '\n\nEvents without a channel are not posted. Use `/logs setup` to set a default channel.';
    await replyEmbed(i, panelEmbed('Logging', `Status: **${logging.enabled ? 'On' : 'Off'}**\nDefault channel: ${logging.defaultChannelId ? `<#${logging.defaultChannelId}>` : 'not set'}${warning}`).addFields({
      name: 'Categories',
      value: LOG_CATEGORIES.map((c) => `${logging.disabled.includes(c) ? '`OFF`' : '`ON `'} ${c}${logging.channels[c] ? ` › <#${logging.channels[c]}>` : ''}`).join('\n'),
    }));
  },
};

async function onMessageDelete(message: Message | PartialMessage): Promise<void> {
  if (!message.guild || message.author?.bot || (await channelIgnored(message.guild.id, message.channelId))) return;
  const embed: EmbedBuilder = baseEmbed(COLORS.danger).setTitle('Message deleted').addFields(
    { name: 'Author', value: message.author ? `<@${message.author.id}> (${message.author.id})` : 'Not cached', inline: true },
    { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
    { name: 'Content', value: message.partial ? 'The message was sent before I started caching it.' : clean(message.content) },
  );
  const attachments = message.attachments?.map((a) => a.name).join(', ');
  if (attachments) embed.addFields({ name: 'Attachments', value: truncate(attachments, 500) });
  await sendLog(message.guild, 'message', embed);
}

async function onMessageBulkDelete(messages: Collection<Snowflake, Message | PartialMessage>, channelId: string, guild: Guild): Promise<void> {
  if (await channelIgnored(guild.id, channelId)) return;
  await sendLog(guild, 'message', baseEmbed(COLORS.danger).setTitle('Messages bulk deleted').setDescription(`**${messages.size}** messages removed in <#${channelId}>.`));
}

async function onMessageEdit(before: Message | PartialMessage, after: Message | PartialMessage): Promise<void> {
  if (!after.guild || after.author?.bot || before.content === after.content || (await channelIgnored(after.guild.id, after.channelId))) return;
  await sendLog(after.guild, 'message', baseEmbed(COLORS.accent).setTitle('Message edited').setURL(after.url).addFields(
    { name: 'Author', value: after.author ? `<@${after.author.id}>` : 'Unknown', inline: true },
    { name: 'Channel', value: `<#${after.channelId}>`, inline: true },
    { name: 'Before', value: before.partial ? 'Not cached' : clean(before.content) },
    { name: 'After', value: clean(after.content) },
  ));
}

async function onJoin(member: GuildMember): Promise<void> {
  await sendLog(member.guild, 'member', baseEmbed(COLORS.success).setTitle('Member joined').setThumbnail(member.displayAvatarURL()).setDescription(`<@${member.id}> \`${member.user.tag}\` (${member.id})`).addFields(
    { name: 'Account created', value: discordTime(member.user.createdAt), inline: true },
    { name: 'Member count', value: String(member.guild.memberCount), inline: true },
  ));
}

async function onLeave(member: GuildMember | PartialGuildMember): Promise<void> {
  const roles = member.roles?.cache.filter((r) => r.id !== member.guild.id).map((r) => r.toString()).join(' ');
  await sendLog(member.guild, 'member', baseEmbed(COLORS.warning).setTitle('Member left').setThumbnail(member.displayAvatarURL()).setDescription(`<@${member.id}> \`${member.user?.tag ?? 'unknown'}\` (${member.id})`).addFields(
    { name: 'Joined', value: member.joinedAt ? discordTime(member.joinedAt) : 'Unknown', inline: true },
    { name: 'Roles', value: truncate(roles || 'None', 1000), inline: true },
  ));
}

async function onVoice(before: VoiceState, after: VoiceState): Promise<void> {
  if (before.channelId === after.channelId) return;
  const channelId = after.channelId ?? before.channelId;
  if (await channelIgnored(after.guild.id, channelId)) return;
  const who = `<@${after.id}>`;
  const [title, text, color] = !before.channelId
    ? ['Voice join', `${who} joined <#${after.channelId}>`, COLORS.success]
    : !after.channelId
      ? ['Voice leave', `${who} left <#${before.channelId}>`, COLORS.warning]
      : ['Voice move', `${who} moved from <#${before.channelId}> to <#${after.channelId}>`, COLORS.accent];
  await sendLog(after.guild, 'voice', baseEmbed(color).setTitle(title).setDescription(text));
}

export const loggingModule: VortexModule = {
  name: 'logging',
  commands: [logCommand],
  events: [
    on('guildAuditLogEntryCreate', handleAudit),
    on('messageDelete', onMessageDelete),
    on('messageDeleteBulk', (messages, channel) => onMessageBulkDelete(messages as never, channel.id, channel.guild)),
    on('messageUpdate', onMessageEdit),
    on('guildMemberAdd', onJoin),
    on('guildMemberRemove', onLeave),
    on('voiceStateUpdate', onVoice),
    on('inviteCreate', async (invite) => {
      if (!invite.guild || !('members' in invite.guild)) return;
      await sendLog(invite.guild as Guild, 'invite', baseEmbed(COLORS.accent).setTitle('Invite created').addFields(
        { name: 'Code', value: `\`${invite.code}\``, inline: true },
        { name: 'By', value: invite.inviterId ? `<@${invite.inviterId}>` : 'Unknown', inline: true },
        { name: 'Channel', value: invite.channelId ? `<#${invite.channelId}>` : 'Unknown', inline: true },
        { name: 'Limits', value: `${invite.maxUses || 'Unlimited'} uses ${'·'} ${invite.maxAge ? `expires in ${Math.round(invite.maxAge / 3600)}h` : 'never expires'}` },
      ));
    }),
  ],
};
