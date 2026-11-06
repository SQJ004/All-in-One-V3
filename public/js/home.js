import { api, h, icon } from './lib.js';

const initials = (name) => (name || '?').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase() || '?';

/**
 * The module cards. `on` reads this server's saved settings. Tools with no on or off state,
 * such as the embed builder, are simply available, so they count as active.
 * If a setting could not be read, the row shows no status and is not counted.
 */
const MODULES = (s) => [
  { title: 'Moderation', text: 'Keep your server safe and tidy', ic: 'moderation', tone: '#f87171', rows: [
    ['security', 'Security', 'Spam, mentions, scam and phishing links', s.security && s.security.enabled],
    ['moderation', 'Mod Actions', 'Ban, kick, timeout, warn and case history', true],
    ['logging', 'Logs', 'Activity and moderation logs', s.logging && s.logging.enabled],
  ] },
  { title: 'Protection', text: 'Stop attacks before they spread', ic: 'anti-nuke', tone: '#a78bfa', rows: [
    ['anti-nuke', 'Anti-Nuke', 'Limits destructive actions per person', s.security && s.security.enabled && s.security.antiNuke.enabled],
    ['anti-raid', 'Anti-Raid', 'Join limits, account age and lockdown', s.security && s.security.enabled && s.security.antiRaid.enabled],
    ['anti-webhook', 'Anti-Webhook', 'Webhook abuse and trusted webhooks', s.security && s.security.enabled && s.security.antiWebhook.enabled],
    ['backup', 'Server Backup', 'Save and restore roles and channels', s.backup && s.backup.autoEnabled],
  ] },
  { title: 'Messaging', text: 'Welcome messages, embeds and roles', ic: 'welcome', tone: '#60a5fa', rows: [
    ['welcome', 'Welcome & Goodbye', 'Greet new members automatically', s.welcome && s.welcome.enabled],
    ['embeds', 'Embed Builder', 'Design and post rich messages', true],
    ['roles', 'Auto Roles', 'Roles on join and role panels', s.roles && (s.roles.humanRoles.length > 0 || s.roles.botRoles.length > 0)],
  ] },
  { title: 'Engagement', text: 'Keep your community active', ic: 'fun', tone: '#34d399', rows: [
    ['settings', 'Levels & Community', 'Levels, starboard, birthdays and more', s.community && s.community.levels.enabled],
    ['music', 'Music', 'Play music in voice channels', s.category('Music')],
    ['fun', 'Fun', 'Games and fun commands', s.category('Fun')],
  ] },
  { title: 'Tickets', text: 'Private support for your members', ic: 'tickets', tone: '#fbbf24', rows: [
    ['tickets', 'Ticket System', 'Panels, questions, transcripts and ratings', s.tickets && s.tickets.enabled],
    ['staff', 'Staff Performance', 'Leaderboard, goals and staff history', true],
  ] },
  { title: 'Utilities', text: 'Handy tools and bot setup', ic: 'utility', tone: '#c084fc', rows: [
    ['utility', 'Utility', 'User, server and role information', s.category('Utility')],
    ['bot-settings', 'Bot Settings', 'Nickname, prefixes and recent changes', true],
    ['bot-identity', 'Bot Identity', 'Name, picture, status and color', true],
  ] },
  { title: 'Commands', text: 'Everything your bot can run', ic: 'commands', tone: '#818cf8', rows: [
    ['bot-commands', 'All Commands', 'Switches, limits and aliases', true],
    ['commands', 'Custom Commands', 'Your own commands and replies', true],
    ['automation', 'Automation', 'Auto responses, schedules and rules', true],
  ] },
  { title: 'Analytics', text: 'See what is happening', ic: 'sx-chart', tone: '#fb923c', rows: [
    ['overview', 'Overview', 'Activity, protection and recent events', true],
    ['audit-logs', 'Audit Logs', 'Search, filter and export', true],
    ['premium', 'All Premium Features', 'Status of every premium feature', true],
  ] },
];

function moduleCard(ctx, m) {
  const known = m.rows.filter((r) => r[3] !== null && r[3] !== undefined);
  const active = known.filter((r) => r[3]).length;
  const chip = h('span', { class: 'sx-stat-icon' }, icon(m.ic));
  chip.style.setProperty('--tone', m.tone);
  return h('article', { class: 'hm-card' },
    h('div', { class: 'hm-card-top' }, chip, known.length ? h('span', { class: `hm-count ${active ? 'on' : ''}` }, `${active}/${known.length} active`) : null),
    h('h2', {}, m.title),
    h('p', {}, m.text),
    h('div', { class: 'hm-rows' }, m.rows.map(([id, title, text, on]) => h('a', { class: 'hm-row', href: `#/g/${ctx.guildId}/${id}` },
      h('span', { class: 'hm-row-text' }, h('b', {}, title), h('small', {}, text)),
      on === null || on === undefined ? null : h('i', { class: `hm-dot ${on ? 'on' : ''}`, title: on ? 'Active' : 'Inactive' }),
      h('span', { class: 'hm-arrow', 'aria-hidden': 'true' }, '›')))));
}

export async function serverHomePage(ctx) {
  const base = `/api/guilds/${ctx.guildId}`;
  const quiet = (path) => api(`${base}/${path}`).catch(() => null);
  const [overview, security, logging, welcome, roles, community, tickets, backup, commands, list] = await Promise.all([ctx.overview, quiet('config/security'), quiet('config/logging'), quiet('config/welcome'), quiet('config/roles'), quiet('config/community'), quiet('config/tickets'), quiet('config/backup'), quiet('config/commands'), quiet('command-list')]);
  const category = (name) => (commands && list ? list.some((c) => c.category === name && !commands.disabled.includes(c.name)) : null);
  const info = overview.guild;
  return h('div', { class: 'hm' },
    h('header', { class: 'hm-head' },
      h('a', { class: 'hm-back', href: '#/', 'aria-label': 'All servers', title: 'All servers' }, '‹'),
      info.icon ? h('img', { class: 'hm-icon', src: info.icon, alt: '' }) : h('span', { class: 'hm-icon' }, initials(info.name)),
      h('div', {}, h('h1', {}, info.name), h('p', {}, `ZYTHERON · ${info.memberCount.toLocaleString()} ${info.memberCount === 1 ? 'member' : 'members'}`))),
    overview.status.locked ? h('div', { class: 'sx-note danger' }, 'This server is in emergency lockdown.') : null,
    h('div', { class: 'hm-grid' }, MODULES({ security, logging, welcome, roles, community, tickets, backup, category }).map((m) => moduleCard(ctx, m))));
}
