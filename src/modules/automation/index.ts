import {
  ActionRowBuilder, ChannelType, MessageFlags, ModalBuilder, PermissionFlagsBits, SlashCommandBuilder, TextInputBuilder, TextInputStyle,
  type Client, type GuildMember, type GuildTextBasedChannel, type Message,
} from 'discord.js';
import { postableChannel } from '../../core/channels.js';
import { getConfig, updateConfig } from '../../core/configService.js';
import { logger } from '../../core/logger.js';
import { roleAssignBlock } from '../../core/permissions.js';
import { Cooldown } from '../../core/rateLimit.js';
import { on, UserError, type SlashCommand, type VortexModule } from '../../core/types.js';
import { discordTime, parseDuration, safeMentions, truncate } from '../../core/util.js';
import { renderVars, userVars, type Vars } from '../../core/variables.js';
import { AutoResponse, AutomationRule, CustomCommand, EmbedTemplate, ScheduledMessage, type IAutomationRule, type IRuleAction, type MatchType } from '../../db/models.js';
import { baseEmbed, COLORS, panelEmbed, replyEmbed, replyOk } from '../../ui/theme.js';
import { getTextChannel, sendLog } from '../logging/service.js';
import { MessageSpecSchema, renderMessage } from '../embeds/spec.js';
import { compileUserRegex, matchesTrigger, nextCronRun } from './rules.js';

const P = PermissionFlagsBits;
const cooldown = new Cooldown();
const MAX_ITEMS = 100;

// A small TTL cache: these lists are read on every single message.
const listCache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, load: () => PromiseLike<T>): Promise<T> {
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.value as T;
  const value = await load();
  listCache.set(key, { at: Date.now(), value });
  return value;
}
export const invalidateAutomation = (guildId: string): void => { for (const prefix of ['ar', 'rules']) listCache.delete(`${prefix}:${guildId}`); };

const activeResponses = (guildId: string) => cached(`ar:${guildId}`, () => AutoResponse.find({ guildId, enabled: true }));
const activeRules = (guildId: string) => cached(`rules:${guildId}`, () => AutomationRule.find({ guildId, enabled: true }));

async function templatePayload(guildId: string, name: string, vars: Vars) {
  const t = await EmbedTemplate.findOne({ guildId, name });
  return t ? renderMessage(MessageSpecSchema.parse(t.spec), vars) : null;
}

// ---------- Actions ----------
export async function runRuleActions(rule: Pick<IAutomationRule, 'actions' | 'name' | 'guildId'>, member: GuildMember, message: Message | null, vars: Vars): Promise<void> {
  const guild = member.guild;
  for (const action of rule.actions) {
    try {
      const text = action.value ? truncate(renderVars(action.value, vars), 1900) : '';
      switch (action.type) {
        case 'reply': if (message && text) await message.reply({ content: text, allowedMentions: { ...safeMentions, repliedUser: false } }); break;
        case 'send_channel': { const c = getTextChannel(guild, action.channelId); if (c && text) await c.send({ content: text, allowedMentions: safeMentions }); break; }
        case 'dm': if (text) await member.send(text).catch(() => undefined); break;
        case 'delete_message': await message?.delete(); break;
        case 'add_role': case 'remove_role': {
          const role = action.value ? guild.roles.cache.get(action.value) : undefined;
          if (!role || roleAssignBlock(role, guild.members.me!)) break;
          if (action.type === 'add_role') await member.roles.add(role, `ZYTHERON rule ${rule.name}`);
          else await member.roles.remove(role, `ZYTHERON rule ${rule.name}`);
          break;
        }
        case 'timeout': if (member.moderatable) await member.timeout((action.minutes ?? 5) * 60_000, `ZYTHERON rule ${rule.name}`); break;
        case 'log': await sendLog(guild, 'moderation', baseEmbed(COLORS.accent).setTitle(`Rule fired ${'·'} ${rule.name}`).setDescription(`${member}${message ? ` in <#${message.channelId}>` : ''}\n${text}`)); break;
      }
    } catch (err) {
      logger.debug({ err, action: action.type, rule: rule.name }, 'Rule action failed');
    }
  }
}

// ---------- Message listener ----------
async function handleMessage(message: Message): Promise<void> {
  if (!message.inGuild() || message.author.bot || message.webhookId || !message.member) return;
  const guildId = message.guildId;
  const vars: Vars = { ...userVars(message.author, message.guild), channel: `<#${message.channelId}>` };

  const { automation } = await getConfig(guildId);
  if (message.content.startsWith(automation.customCommandPrefix)) {
    const name = message.content.slice(automation.customCommandPrefix.length).split(/\s+/)[0]?.toLowerCase();
    if (name) {
      const cmd = await CustomCommand.findOne({ guildId, name });
      if (cmd && (!cmd.allowedRoles.length || cmd.allowedRoles.some((r) => message.member!.roles.cache.has(r))) && cooldown.allow(`cc:${guildId}:${message.author.id}`, 3000) === 0) {
        const payload = cmd.templateName ? await templatePayload(guildId, cmd.templateName, vars) : null;
        await message.channel.send({ ...(payload ?? { content: truncate(renderVars(cmd.response, vars), 2000) }), allowedMentions: safeMentions });
        await CustomCommand.updateOne({ _id: cmd._id }, { $inc: { uses: 1 } });
        return;
      }
    }
  }

  for (const ar of await activeResponses(guildId)) {
    if (ar.channels.length && !ar.channels.includes(message.channelId)) continue;
    if (!matchesTrigger(message.content, ar.trigger, ar.matchType)) continue;
    if (cooldown.allow(`ar:${ar._id}:${message.channelId}`, ar.cooldownSec * 1000) > 0) continue;
    await message.reply({ content: truncate(renderVars(ar.response, vars), 2000), allowedMentions: { ...safeMentions, repliedUser: false } }).catch((err) => logger.debug({ err }, 'Auto response failed'));
    if (ar.deleteTrigger) await message.delete().catch(() => undefined);
  }

  for (const rule of await activeRules(guildId)) {
    if (rule.trigger.type !== 'keyword' && rule.trigger.type !== 'regex') continue;
    if (rule.channels.length && !rule.channels.includes(message.channelId)) continue;
    const hit = rule.trigger.type === 'regex' ? matchesTrigger(message.content, rule.trigger.value ?? '', 'regex') : matchesTrigger(message.content, rule.trigger.value ?? '', 'word');
    if (!hit || cooldown.allow(`rule:${rule._id}:${message.author.id}`, rule.cooldownSec * 1000) > 0) continue;
    await runRuleActions(rule, message.member, message, vars);
    await AutomationRule.updateOne({ _id: rule._id }, { $inc: { runs: 1 } });
  }
}

async function fireMemberRules(member: GuildMember, type: 'member_join' | 'role_added', roleId?: string): Promise<void> {
  for (const rule of await activeRules(member.guild.id)) {
    if (rule.trigger.type !== type) continue;
    if (type === 'role_added' && rule.trigger.value !== roleId) continue;
    await runRuleActions(rule, member, null, userVars(member.user, member.guild));
    await AutomationRule.updateOne({ _id: rule._id }, { $inc: { runs: 1 } });
  }
}

// ---------- Scheduler ----------
export async function runDueSchedules(client: Client<true>, now = new Date()): Promise<number> {
  let sent = 0;
  for (let n = 0; n < 50; n++) {
    // Claim atomically by moving nextRunAt, so a crash or second instance cannot double-post.
    const claim = await ScheduledMessage.findOne({ enabled: true, nextRunAt: { $lte: now } });
    if (!claim) break;
    const next = claim.cron ? nextCronRun(claim.cron, claim.timezone, now) : null;
    const res = await ScheduledMessage.updateOne({ _id: claim._id, nextRunAt: claim.nextRunAt }, { $set: { nextRunAt: next, lastRunAt: now, enabled: Boolean(next) } });
    if (!res.modifiedCount) continue;
    const guild = client.guilds.cache.get(claim.guildId);
    const channel = guild ? getTextChannel(guild, claim.channelId) : null;
    if (!guild || !channel) continue;
    try {
      const vars = { server: guild.name, membercount: guild.memberCount };
      const payload = claim.templateName ? await templatePayload(guild.id, claim.templateName, vars) : null;
      await channel.send({ ...(payload ?? { content: truncate(renderVars(claim.content, vars), 2000) }), allowedMentions: safeMentions });
      sent++;
    } catch (err) {
      logger.warn({ err, schedule: claim.name }, 'Scheduled message failed');
    }
  }
  return sent;
}

// ---------- Commands ----------
const nameAuto = (load: (guildId: string, q: string) => PromiseLike<Array<{ name: string }>>): SlashCommand['autocomplete'] => async (i) => {
  const q = String(i.options.getFocused()).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '');
  await i.respond((await load(i.guildId, q)).map((x) => ({ name: x.name, value: x.name })));
};

const ccCommand: SlashCommand = {
  perms: { create: [P.ManageGuild], edit: [P.ManageGuild], delete: [P.ManageGuild], prefix: [P.ManageGuild] },
  autocomplete: nameAuto((guildId, q) => CustomCommand.find({ guildId, name: { $regex: q } }).limit(25)),
  data: new SlashCommandBuilder().setName('cc').setDescription('Custom commands').setDMPermission(false)
    .addSubcommand((s) => s.setName('create').setDescription('Create a custom command').addStringOption((o) => o.setName('name').setDescription('Name, without the prefix').setRequired(true).setMaxLength(32)).addStringOption((o) => o.setName('embed_template').setDescription('Reply with a saved embed template')).addRoleOption((o) => o.setName('role').setDescription('Limit to this role')))
    .addSubcommand((s) => s.setName('edit').setDescription('Edit a custom command').addStringOption((o) => o.setName('name').setDescription('Command').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) => s.setName('delete').setDescription('Delete a custom command').addStringOption((o) => o.setName('name').setDescription('Command').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('List custom commands'))
    .addSubcommand((s) => s.setName('run').setDescription('Run a custom command').addStringOption((o) => o.setName('name').setDescription('Command').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) => s.setName('prefix').setDescription('Change the text prefix').addStringOption((o) => o.setName('prefix').setDescription('For example !').setRequired(true).setMaxLength(5)))
    .toJSON(),
  async execute(i) {
    const sub = i.options.getSubcommand();
    const guildId = i.guildId;
    const { automation } = await getConfig(guildId);
    if (sub === 'prefix') {
      await updateConfig(guildId, 'automation', { customCommandPrefix: i.options.getString('prefix', true) });
      return replyOk(i, 'Prefix updated.');
    }
    if (sub === 'list') {
      const list = await CustomCommand.find({ guildId }).sort({ name: 1 });
      return replyEmbed(i, panelEmbed('Custom Commands', list.length ? list.map((c) => `\`${automation.customCommandPrefix}${c.name}\` ${'·'} ${c.uses} uses`).join('\n') : 'None yet.'));
    }
    const name = i.options.getString('name', true).toLowerCase().trim();
    if (sub === 'delete') {
      const res = await CustomCommand.deleteOne({ guildId, name });
      if (!res.deletedCount) throw new UserError('That command does not exist.');
      return replyOk(i, 'Command deleted.');
    }
    if (sub === 'run') {
      const cmd = await CustomCommand.findOne({ guildId, name });
      if (!cmd) throw new UserError('That command does not exist.');
      if (cmd.allowedRoles.length && !cmd.allowedRoles.some((r) => i.member.roles.cache.has(r))) throw new UserError('You cannot use this command.');
      const vars: Vars = { ...userVars(i.user, i.guild), channel: `<#${i.channelId}>` };
      const payload = cmd.templateName ? await templatePayload(guildId, cmd.templateName, vars) : null;
      await i.reply({ ...(payload ?? { content: truncate(renderVars(cmd.response, vars), 2000) }), allowedMentions: safeMentions });
      await CustomCommand.updateOne({ _id: cmd._id }, { $inc: { uses: 1 } });
      return;
    }
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw new UserError('Names can use lowercase letters, numbers, dashes and underscores.');
    const existing = await CustomCommand.findOne({ guildId, name });
    if (sub === 'create') {
      if (existing) throw new UserError('That command already exists. Use `/cc edit`.');
      if ((await CustomCommand.countDocuments({ guildId })) >= MAX_ITEMS) throw new UserError(`This server has reached ${MAX_ITEMS} custom commands.`);
      const template = i.options.getString('embed_template');
      const role = i.options.getRole('role');
      if (template) {
        if (!(await EmbedTemplate.exists({ guildId, name: template }))) throw new UserError('That embed template does not exist.');
        await CustomCommand.create({ guildId, name, templateName: template, allowedRoles: role ? [role.id] : [], createdBy: i.user.id });
        return replyOk(i, `Created \`${automation.customCommandPrefix}${name}\`.`);
      }
      return i.showModal(responseModal(`cc:save:${name}:${role?.id ?? '0'}`, `Command: ${name}`, ''));
    }
    if (!existing) throw new UserError('That command does not exist.');
    await i.showModal(responseModal(`cc:save:${name}:keep`, `Command: ${name}`, existing.response));
  },
};

const responseModal = (id: string, title: string, value: string) => new ModalBuilder().setCustomId(id).setTitle(title.slice(0, 45)).addComponents(
  new ActionRowBuilder<TextInputBuilder>().addComponents((() => {
    const t = new TextInputBuilder().setCustomId('response').setLabel('Response').setPlaceholder('Variables: {user} {username} {server} {channel} ...').setStyle(TextInputStyle.Paragraph).setMaxLength(2000).setRequired(true);
    return value ? t.setValue(value) : t;
  })()),
);

const autoResponseCommand: SlashCommand = {
  perms: { '*': [P.ManageGuild] },
  autocomplete: async (i) => {
    const q = String(i.options.getFocused()).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '');
    const list = await AutoResponse.find({ guildId: i.guildId, trigger: { $regex: q } }).limit(25);
    await i.respond(list.map((a) => ({ name: truncate(a.trigger, 100), value: a.trigger.slice(0, 100) })));
  },
  data: new SlashCommandBuilder().setName('autoresponse').setDescription('Automatic replies to keywords').setDefaultMemberPermissions(P.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('add').setDescription('Add an auto response')
      .addStringOption((o) => o.setName('trigger').setDescription('Word, phrase or regex').setRequired(true).setMaxLength(200))
      .addStringOption((o) => o.setName('response').setDescription('Reply. Variables are supported.').setRequired(true).setMaxLength(2000))
      .addStringOption((o) => o.setName('match').setDescription('How to match').addChoices({ name: 'Contains', value: 'contains' }, { name: 'Whole word', value: 'word' }, { name: 'Exact message', value: 'exact' }, { name: 'Starts with', value: 'startsWith' }, { name: 'Regex', value: 'regex' }))
      .addChannelOption((o) => o.setName('channel').setDescription('Only in this channel').addChannelTypes(ChannelType.GuildText))
      .addIntegerOption((o) => o.setName('cooldown').setDescription('Seconds between replies').setMinValue(0).setMaxValue(3600))
      .addBooleanOption((o) => o.setName('delete_trigger').setDescription('Also delete the triggering message')))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove an auto response').addStringOption((o) => o.setName('trigger').setDescription('Trigger').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('List auto responses'))
    .toJSON(),
  async execute(i) {
    const sub = i.options.getSubcommand();
    const guildId = i.guildId;
    if (sub === 'list') {
      const list = await AutoResponse.find({ guildId });
      return replyEmbed(i, panelEmbed('Auto Responses', list.length ? list.map((a) => `\`${truncate(a.trigger, 40)}\` (${a.matchType}) ${'›'} ${truncate(a.response, 60)}`).join('\n') : 'None yet.'));
    }
    const trigger = i.options.getString('trigger', true);
    if (sub === 'remove') {
      const res = await AutoResponse.deleteOne({ guildId, trigger });
      if (!res.deletedCount) throw new UserError('That trigger does not exist.');
      invalidateAutomation(guildId);
      return replyOk(i, 'Auto response removed.');
    }
    const match = (i.options.getString('match') ?? 'contains') as MatchType;
    if (match === 'regex') compileUserRegex(trigger);
    if ((await AutoResponse.countDocuments({ guildId })) >= MAX_ITEMS) throw new UserError(`This server has reached ${MAX_ITEMS} auto responses.`);
    const channel = i.options.getChannel('channel');
    await AutoResponse.create({ guildId, trigger, matchType: match, response: i.options.getString('response', true), channels: channel ? [channel.id] : [], cooldownSec: i.options.getInteger('cooldown') ?? 10, deleteTrigger: i.options.getBoolean('delete_trigger') ?? false });
    invalidateAutomation(guildId);
    await replyOk(i, 'Auto response added.');
  },
};

const scheduleCommand: SlashCommand = {
  perms: { '*': [P.ManageGuild] },
  autocomplete: nameAuto((guildId, q) => ScheduledMessage.find({ guildId, name: { $regex: q } }).limit(25)),
  data: new SlashCommandBuilder().setName('schedule').setDescription('Scheduled messages and announcements').setDefaultMemberPermissions(P.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('recurring').setDescription('Send on a repeating schedule')
      .addStringOption((o) => o.setName('name').setDescription('Name').setRequired(true).setMaxLength(40))
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
      .addStringOption((o) => o.setName('cron').setDescription('Cron, e.g. 0 9 * * 1 is Mondays at 09:00').setRequired(true))
      .addStringOption((o) => o.setName('message').setDescription('Text').setMaxLength(2000))
      .addStringOption((o) => o.setName('embed_template').setDescription('Or a saved embed template'))
      .addStringOption((o) => o.setName('timezone').setDescription('For example Europe/Paris (default UTC)')))
    .addSubcommand((s) => s.setName('once').setDescription('Announce once, later')
      .addStringOption((o) => o.setName('name').setDescription('Name').setRequired(true).setMaxLength(40))
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
      .addStringOption((o) => o.setName('in').setDescription('For example 2h 30m').setRequired(true))
      .addStringOption((o) => o.setName('message').setDescription('Text').setMaxLength(2000))
      .addStringOption((o) => o.setName('embed_template').setDescription('Or a saved embed template')))
    .addSubcommand((s) => s.setName('list').setDescription('List schedules'))
    .addSubcommand((s) => s.setName('toggle').setDescription('Pause or resume').addStringOption((o) => o.setName('name').setDescription('Schedule').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) => s.setName('delete').setDescription('Delete a schedule').addStringOption((o) => o.setName('name').setDescription('Schedule').setAutocomplete(true).setRequired(true)))
    .toJSON(),
  async execute(i) {
    const sub = i.options.getSubcommand();
    const guildId = i.guildId;
    if (sub === 'list') {
      const list = await ScheduledMessage.find({ guildId }).sort({ nextRunAt: 1 });
      return replyEmbed(i, panelEmbed('Schedules', list.length ? list.map((s) => `**${s.name}** ${s.enabled ? '' : '(paused) '}in <#${s.channelId}>\n${s.cron ? `\`${s.cron}\` ${s.timezone}` : 'One time'}${s.nextRunAt ? ` ${'·'} next ${discordTime(s.nextRunAt)}` : ''}`).join('\n\n') : 'None yet.'));
    }
    const name = i.options.getString('name', true).trim();
    if (sub === 'delete') {
      const res = await ScheduledMessage.deleteOne({ guildId, name });
      if (!res.deletedCount) throw new UserError('That schedule does not exist.');
      return replyOk(i, 'Schedule deleted.');
    }
    if (sub === 'toggle') {
      const s = await ScheduledMessage.findOne({ guildId, name });
      if (!s) throw new UserError('That schedule does not exist.');
      s.enabled = !s.enabled;
      if (s.enabled && s.cron) s.nextRunAt = nextCronRun(s.cron, s.timezone);
      await s.save();
      return replyOk(i, `**${name}** is now ${s.enabled ? 'running' : 'paused'}.`);
    }
    const message = i.options.getString('message');
    const template = i.options.getString('embed_template');
    if (!message && !template) throw new UserError('Provide a message or an embed template.');
    if (template && !(await EmbedTemplate.exists({ guildId, name: template }))) throw new UserError('That embed template does not exist.');
    if ((await ScheduledMessage.countDocuments({ guildId })) >= 50) throw new UserError('This server has reached 50 schedules.');
    const channelId = postableChannel(i.guild, i.options.getChannel('channel', true).id, i.member).id;
    const base = { guildId, name, channelId, content: message ?? '', templateName: template, createdBy: i.user.id };
    if (sub === 'once') {
      const ms = parseDuration(i.options.getString('in', true));
      if (!ms) throw new UserError('Invalid time. Examples: `30m`, `2h`, `1d 6h`.');
      const when = new Date(Date.now() + ms);
      await ScheduledMessage.create({ ...base, cron: null, nextRunAt: when });
      return replyOk(i, `Scheduled for ${discordTime(when, 'f')}.`);
    }
    const cron = i.options.getString('cron', true);
    const timezone = i.options.getString('timezone') ?? 'UTC';
    const nextRunAt = nextCronRun(cron, timezone);
    await ScheduledMessage.create({ ...base, cron, timezone, nextRunAt });
    await replyOk(i, `Scheduled. First run ${discordTime(nextRunAt, 'f')}.`);
  },
};

const ruleCommand: SlashCommand = {
  perms: { '*': [P.ManageGuild] },
  autocomplete: nameAuto((guildId, q) => AutomationRule.find({ guildId, name: { $regex: q } }).limit(25)),
  data: new SlashCommandBuilder().setName('rule').setDescription('Automation rules: triggers and actions').setDefaultMemberPermissions(P.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('create').setDescription('Create a rule')
      .addStringOption((o) => o.setName('name').setDescription('Name').setRequired(true).setMaxLength(40))
      .addStringOption((o) => o.setName('trigger').setDescription('When').setRequired(true).addChoices({ name: 'Message has keyword', value: 'keyword' }, { name: 'Message matches regex', value: 'regex' }, { name: 'Member joins', value: 'member_join' }, { name: 'Member receives a role', value: 'role_added' }))
      .addStringOption((o) => o.setName('action').setDescription('Then').setRequired(true).addChoices({ name: 'Reply', value: 'reply' }, { name: 'Send to a channel', value: 'send_channel' }, { name: 'DM the member', value: 'dm' }, { name: 'Add a role', value: 'add_role' }, { name: 'Remove a role', value: 'remove_role' }, { name: 'Delete the message', value: 'delete_message' }, { name: 'Timeout', value: 'timeout' }, { name: 'Write to the log', value: 'log' }))
      .addStringOption((o) => o.setName('keyword').setDescription('Keyword or regex').setMaxLength(200))
      .addRoleOption((o) => o.setName('trigger_role').setDescription('For the role-received trigger'))
      .addStringOption((o) => o.setName('text').setDescription('Text for reply, send, DM and log').setMaxLength(1900))
      .addRoleOption((o) => o.setName('role').setDescription('Role to add or remove'))
      .addChannelOption((o) => o.setName('channel').setDescription('Channel for send').addChannelTypes(ChannelType.GuildText))
      .addIntegerOption((o) => o.setName('minutes').setDescription('Timeout length').setMinValue(1).setMaxValue(40320)))
    .addSubcommand((s) => s.setName('add-action').setDescription('Add another action to a rule')
      .addStringOption((o) => o.setName('name').setDescription('Rule').setAutocomplete(true).setRequired(true))
      .addStringOption((o) => o.setName('action').setDescription('Action').setRequired(true).addChoices({ name: 'Reply', value: 'reply' }, { name: 'Send to a channel', value: 'send_channel' }, { name: 'DM the member', value: 'dm' }, { name: 'Add a role', value: 'add_role' }, { name: 'Remove a role', value: 'remove_role' }, { name: 'Delete the message', value: 'delete_message' }, { name: 'Timeout', value: 'timeout' }, { name: 'Write to the log', value: 'log' }))
      .addStringOption((o) => o.setName('text').setDescription('Text').setMaxLength(1900))
      .addRoleOption((o) => o.setName('role').setDescription('Role'))
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText))
      .addIntegerOption((o) => o.setName('minutes').setDescription('Timeout length').setMinValue(1).setMaxValue(40320)))
    .addSubcommand((s) => s.setName('list').setDescription('List rules'))
    .addSubcommand((s) => s.setName('toggle').setDescription('Enable or disable a rule').addStringOption((o) => o.setName('name').setDescription('Rule').setAutocomplete(true).setRequired(true)))
    .addSubcommand((s) => s.setName('delete').setDescription('Delete a rule').addStringOption((o) => o.setName('name').setDescription('Rule').setAutocomplete(true).setRequired(true)))
    .toJSON(),
  async execute(i) {
    const sub = i.options.getSubcommand();
    const guildId = i.guildId;
    if (sub === 'list') {
      const list = await AutomationRule.find({ guildId });
      return replyEmbed(i, panelEmbed('Automation Rules', list.length ? list.map((r) => `**${r.name}** ${r.enabled ? '' : '(off) '}${'·'} ${r.trigger.type}${r.trigger.value ? ` \`${truncate(r.trigger.value, 30)}\`` : ''} ${'›'} ${r.actions.map((a) => a.type).join(', ')} ${'·'} ${r.runs} runs`).join('\n') : 'None yet.'));
    }
    const name = i.options.getString('name', true).trim();
    const buildAction = (): IRuleAction => {
      const type = i.options.getString('action', true) as IRuleAction['type'];
      const text = i.options.getString('text') ?? undefined;
      const role = i.options.getRole('role');
      const channel = i.options.getChannel('channel');
      if (['reply', 'send_channel', 'dm', 'log'].includes(type) && !text) throw new UserError('This action needs `text`.');
      if (type === 'send_channel' && !channel) throw new UserError('This action needs `channel`.');
      if (type === 'add_role' || type === 'remove_role') {
        if (!role) throw new UserError('This action needs `role`.');
        const block = roleAssignBlock(i.guild.roles.cache.get(role.id)!, i.guild.members.me!, i.member);
        if (block) throw new UserError(block);
        return { type, value: role.id };
      }
      return { type, value: text, channelId: channel?.id, minutes: i.options.getInteger('minutes') ?? undefined };
    };
    if (sub === 'create') {
      const trigger = i.options.getString('trigger', true) as IAutomationRule['trigger']['type'];
      const keyword = i.options.getString('keyword') ?? undefined;
      if ((trigger === 'keyword' || trigger === 'regex') && !keyword) throw new UserError('This trigger needs `keyword`.');
      if (trigger === 'regex') compileUserRegex(keyword!);
      const triggerRole = i.options.getRole('trigger_role');
      if (trigger === 'role_added' && !triggerRole) throw new UserError('This trigger needs `trigger_role`.');
      const action = buildAction();
      if (action.type === 'reply' || action.type === 'delete_message') {
        if (trigger === 'member_join' || trigger === 'role_added') throw new UserError('Reply and delete only work with message triggers.');
      }
      if ((await AutomationRule.countDocuments({ guildId })) >= MAX_ITEMS) throw new UserError(`This server has reached ${MAX_ITEMS} rules.`);
      await AutomationRule.create({ guildId, name, trigger: { type: trigger, value: trigger === 'role_added' ? triggerRole!.id : keyword }, actions: [action] });
    } else if (sub === 'add-action') {
      const rule = await AutomationRule.findOne({ guildId, name });
      if (!rule) throw new UserError('That rule does not exist.');
      if (rule.actions.length >= 5) throw new UserError('A rule can have up to 5 actions.');
      rule.actions.push(buildAction());
      await rule.save();
    } else if (sub === 'toggle') {
      const rule = await AutomationRule.findOne({ guildId, name });
      if (!rule) throw new UserError('That rule does not exist.');
      rule.enabled = !rule.enabled;
      await rule.save();
    } else {
      const res = await AutomationRule.deleteOne({ guildId, name });
      if (!res.deletedCount) throw new UserError('That rule does not exist.');
    }
    invalidateAutomation(guildId);
    await replyOk(i, `Rule **${name}** updated.`);
  },
};

export const automationModule: VortexModule = {
  name: 'automation',
  commands: [ccCommand, autoResponseCommand, scheduleCommand, ruleCommand],
  components: [
    {
      prefix: 'cc:save',
      async run(i, [name, role]) {
        if (!i.isModalSubmit() || !i.inCachedGuild() || !name) return;
        if (!i.member.permissions.has(P.ManageGuild)) throw new UserError('You need Manage Server.');
        const response = i.fields.getTextInputValue('response');
        await CustomCommand.updateOne({ guildId: i.guildId, name }, { $set: { response, ...(role !== 'keep' ? { allowedRoles: role && role !== '0' ? [role] : [], createdBy: i.user.id } : {}) } }, { upsert: true });
        await i.reply({ embeds: [baseEmbed(COLORS.success).setDescription(`Saved \`${name}\`.`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  events: [
    on('messageCreate', handleMessage),
    on('guildMemberAdd', (member) => fireMemberRules(member, 'member_join')),
    on('guildMemberUpdate', async (before, after) => {
      if (before.partial) return;
      for (const id of after.roles.cache.keys()) if (!before.roles.cache.has(id)) await fireMemberRules(after, 'role_added', id);
    }),
  ],
  intervals: [{ name: 'scheduled-messages', everyMs: 30_000, run: async (client) => { await runDueSchedules(client); } }],
};

export type { GuildTextBasedChannel };
