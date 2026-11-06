import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder } from 'discord.js';
import { getEnv } from '../../config/env.js';
import { getConfig } from '../../core/configService.js';
import type { SlashCommand, VortexModule } from '../../core/types.js';
import { formatDuration } from '../../core/util.js';
import { BRAND, ICONS, panelEmbed, replyEmbed } from '../../ui/theme.js';

const HELP: Record<string, { label: string; description: string; body: string }> = {
  security: { label: 'Security', description: 'Anti-nuke, raids, spam, scams, lockdown', body: '`/security setup` arm protection (starts in monitor mode)\n`/security config` interactive panel\n`/security limit` anti-nuke thresholds\n`/security punishment` what happens to attackers\n`/security raid` join rate limiter\n`/security accounts` suspicious accounts\n`/security whitelist` `/security trusted` who is exempt\n`/security lockdown on|off` emergency lockdown\n`/security events` recent events\n`/automod` banned words, caps, invites, domains' },
  moderation: { label: 'Moderation', description: 'Bans, timeouts, warnings, jail', body: '`/moderation ban tempban unban kick timeout untimeout`\n`/moderation warn warnings clearwarnings`\n`/moderation purge slowmode lock unlock hide unhide`\n`/moderation nickname voicemute voicedeafen`\n`/moderation jail unjail massban masskick`\n`/moderation history note notes`\n`/modconfig` mod log, DMs, jail role, warning thresholds' },
  welcome: { label: 'Welcome', description: 'Greetings, goodbye, image cards', body: '`/welcome setup test preview status`\n`/welcome edit edit-goodbye use remove card`\n`/welcome goodbye dm`\nVariables: `{user} {username} {server} {membercount} {avatar} {userid} {createdat} {joinposition}`' },
  embeds: { label: 'Embed builder', description: 'Interactive embed editor and templates', body: '`/embed create` opens the live editor\n`/embed edit delete` for messages ZYTHERON posted\n`/embed save load duplicate remove-template templates`\n`/embed library` ready-made designs\n`/embed export import` JSON' },
  roles: { label: 'Roles', description: 'Auto roles and role panels', body: '`/autorole setup add remove list` human and bot roles\n`/rolepanel create add remove publish delete list` reaction, button, select\n`/temprole add remove`\n`/selfrole list get drop allow deny`' },
  tickets: { label: 'Tickets', description: 'Support panels and transcripts', body: '`/ticket setup`\n`/ticket panel-create panel-category panel-publish`\n`/ticket add remove claim close reopen stats`' },
  automation: { label: 'Automation', description: 'Auto replies, commands, schedules, rules', body: '`/autoresponse add remove list`\n`/cc create edit delete list run prefix` custom commands\n`/schedule recurring once list toggle delete`\n`/rule create add-action list toggle delete` triggers and actions' },
  community: { label: 'Community', description: 'Levels, giveaways, polls and more', body: '`/level setup rank leaderboard reward set-xp ignore`\n`/giveaway create end reroll list`\n`/poll create close`\n`/suggest` `/suggestions setup approve deny`\n`/starboard setup off`\n`/invites user leaderboard`\n`/serverstats view counter counter-remove`\n`/birthday set remove upcoming setup`\n`/afk` `/profile view edit` `/challenge setup off`' },
  utility: { label: 'Utility', description: 'User and server info, dice, moving voice channels', body: 'These also work with `v!`, such as `v!user`\n`/user` `/avatar` information about someone\n`/server` `/roles` information about this server\n`/moveme` move yourself to another voice channel\n`/roll` roll dice' },
  music: { label: 'Music', description: 'Play songs in voice with a live player', body: 'Every command also works with `v!`, such as `v!play lofi`\n`/play` a song name, or a YouTube, Spotify, Audius or direct audio link\n`/pause` `/resume` `/skip` `/stop` `/leave` `/previous`\n`/queue` `/nowplaying` `/remove` `/clearqueue` `/shuffle`\n`/volume` `/loop` `/seek` `/lyrics`\n`/youtube` search YouTube, or watch it together in voice' },
  logging: { label: 'Logging', description: 'Audit trail for your server', body: '`/logs setup status route toggle ignore off`' },
};

const helpRow = () => new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
  new StringSelectMenuBuilder().setCustomId('help:section').setPlaceholder('Choose a system').addOptions(Object.entries(HELP).map(([value, h]) => ({ value, label: h.label, description: h.description }))),
);

const helpCommand: SlashCommand = {
  data: new SlashCommandBuilder().setName('help').setDescription('See everything ZYTHERON can do').setDMPermission(false).toJSON(),
  async execute(i) {
    const env = getEnv();
    const buttons = new ActionRowBuilder<ButtonBuilder>();
    if (env.DASHBOARD_ENABLED && /^https:/.test(env.DASHBOARD_URL)) buttons.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open dashboard').setURL(env.DASHBOARD_URL));
    await replyEmbed(i, panelEmbed(BRAND.name, `**${BRAND.tagline}**\n\nChoose a system below to see its commands.`), { components: buttons.components.length ? [helpRow(), buttons] : [helpRow()] });
  },
};

const pingCommand: SlashCommand = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Check bot health').setDMPermission(false).toJSON(),
  async execute(i) {
    await replyEmbed(i, panelEmbed('Status').addFields(
      { name: 'Gateway', value: `${Math.round(i.client.ws.ping)} ms`, inline: true },
      { name: 'Uptime', value: formatDuration(i.client.uptime), inline: true },
      { name: 'Servers', value: String(i.client.guilds.cache.size), inline: true },
    ));
  },
};

const line = (ok: boolean, text: string) => `${ok ? ICONS.ok : ICONS.fail}  ${text}`;

const setupCommand: SlashCommand = {
  perms: { '*': [PermissionFlagsBits.ManageGuild] },
  data: new SlashCommandBuilder().setName('setup').setDescription('Checklist of what is configured on this server').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false).toJSON(),
  async execute(i) {
    const c = await getConfig(i.guildId);
    const me = i.guild.members.me!;
    const P = PermissionFlagsBits;
    const need: Array<[bigint, string]> = [[P.ViewAuditLog, 'View Audit Log'], [P.ManageRoles, 'Manage Roles'], [P.ManageChannels, 'Manage Channels'], [P.BanMembers, 'Ban Members'], [P.KickMembers, 'Kick Members'], [P.ModerateMembers, 'Moderate Members'], [P.ManageMessages, 'Manage Messages'], [P.ManageWebhooks, 'Manage Webhooks'], [P.ManageGuild, 'Manage Server'], [P.MuteMembers, 'Mute Members'], [P.DeafenMembers, 'Deafen Members'], [P.ManageNicknames, 'Manage Nicknames'], [P.Connect, 'Connect'], [P.Speak, 'Speak'], [P.MoveMembers, 'Move Members'], [P.CreateInstantInvite, 'Create Invite']];
    const missing = need.filter(([bit]) => !me.permissions.has(bit)).map(([, name]) => name);
    const top = i.guild.roles.cache.filter((r) => !r.managed).sort((a, b) => b.position - a.position).first();
    const atTop = !top || me.roles.highest.position > top.position;
    await replyEmbed(i, panelEmbed('Setup Checklist', [
      line(missing.length === 0, missing.length ? `Missing permissions: ${missing.join(', ')}` : 'All permissions granted'),
      line(atTop, atTop ? 'ZYTHERON role is at the top' : `ZYTHERON role is below ${top?.name}. Move it to the top`),
      line(c.security.enabled, `Security ${c.security.enabled ? `on (${c.security.mode})` : 'off. Run /security setup'}`),
      line(c.logging.enabled, `Logging ${c.logging.enabled ? 'on' : 'off. Run /logs setup'}`),
      line(Boolean(c.moderation.modLogChannelId), `Mod log ${c.moderation.modLogChannelId ? 'set' : 'not set. Run /modconfig modlog'}`),
      line(c.welcome.enabled, `Welcome ${c.welcome.enabled ? 'on' : 'off. Run /welcome setup'}`),
      line(c.tickets.enabled, `Tickets ${c.tickets.enabled ? 'on' : 'off. Run /ticket setup'}`),
      line(c.community.levels.enabled, `Leveling ${c.community.levels.enabled ? 'on' : 'off. Run /level setup'}`),
    ].join('\n')));
  },
};

export const generalModule: VortexModule = {
  name: 'general',
  commands: [helpCommand, pingCommand, setupCommand],
  components: [{
    prefix: 'help:section',
    async run(i) {
      if (!i.isStringSelectMenu()) return;
      const h = HELP[i.values[0]!];
      if (h) await i.update({ embeds: [panelEmbed(h.label, h.body)] });
    },
  }],
};
