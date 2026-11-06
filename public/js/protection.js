import { api, confirmDialog, fmtAgo, fmtDate, guard, h, toast } from './lib.js';
import { configForm, dataTable, fieldGrid, section } from './forms.js';

export const pill = (text, kind = '') => h('span', { class: `pill ${kind}` }, text);
export const pageHead = (title, sub, ...actions) => h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, title), h('p', {}, sub)), actions.length ? h('div', { class: 'row' }, actions) : null);
export const tile = (label, value, hint) => h('div', { class: 'card tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), hint ? h('div', { class: 'hint' }, hint) : null);
export const severityPill = (s) => pill(s, s === 'critical' ? 'bad' : s === 'warning' ? 'warn' : 'accent');
export const channelTag = (ctx, id) => { const c = ctx.resources.channels.find((x) => x.id === id); return c ? `#${c.name}` : id ?? ''; };

/** A small bar chart. Every value it shows comes from real counts. */
export function miniBars(rows, label) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return h('div', { class: 'mini-bars', role: 'img', 'aria-label': label }, rows.map((r) => {
    const bar = h('span', { class: 'mini-bar', title: `${r.label}: ${r.value}` });
    bar.style.height = `${Math.max(r.value ? 6 : 2, Math.round((r.value / max) * 100))}%`;
    return bar;
  }));
}

const eventsTable = (rows, empty) => dataTable([
  { label: 'When', render: (e) => fmtDate(e.createdAt) },
  { label: 'Severity', render: (e) => severityPill(e.severity) },
  { label: 'Event', render: (e) => `${e.type.replace(/_/g, ' ')}${e.monitorOnly ? ' (monitor)' : ''}` },
  { label: 'Details', clip: true, render: (e) => e.summary },
  { label: 'Response', clip: true, render: (e) => e.action ?? '' },
], rows, empty);

const accessNotices = (state, trusted) => [
  trusted ? null : h('div', { class: 'notice' }, 'You can view these settings, but only the server owner or a trusted admin can change them.'),
  !state.enabled ? h('div', { class: 'notice' }, 'Security is off, so nothing here is running. Turn on Security below, then save.') : null,
  state.enabled && state.mode === 'monitor' ? h('div', { class: 'notice' }, 'Monitor mode: threats are logged but nothing is punished. Check the events first, add your trusted staff and bots, then switch to Enforce.') : null,
];

const statusFields = [
  { path: 'enabled', label: 'Security enabled', type: 'toggle' },
  { path: 'mode', label: 'Mode', type: 'select', options: [{ value: 'monitor', label: 'Monitor: log only' }, { value: 'enforce', label: 'Enforce: act automatically' }] },
  { path: 'logChannelId', label: 'Security alerts channel', type: 'channel' },
];

const lockdownButton = (ctx, locked, trusted) => {
  const button = h('button', { class: locked ? 'btn primary' : 'btn danger', disabled: !trusted }, locked ? 'Lift lockdown' : 'Lock down server');
  button.addEventListener('click', guard(button, async () => {
    const on = !locked;
    const ok = await confirmDialog(on ? 'Lock down the server?' : 'Lift lockdown?', on ? 'Every channel will be locked for @everyone and invites will be paused. Previous permissions are saved and restored when you lift it.' : 'Each channel returns to the permissions it had before the lockdown.', on ? 'Lock down' : 'Lift lockdown');
    if (!ok) return;
    const r = await api(`/api/guilds/${ctx.guildId}/security/lockdown`, { method: 'POST', body: { on, reason: 'Started from the dashboard' } });
    toast(`${on ? 'Locked' : 'Restored'} ${r.changed} channels${r.failed ? `, ${r.failed} failed` : ''}.`);
    ctx.rerender();
  }));
  return button;
};

// ---------- Anti-Nuke ----------
const NUKE_ROWS = [
  ['channelDelete', 'Anti Channel Delete', 'Channels deleted'],
  ['channelCreate', 'Anti Channel Create', 'Channels created'],
  ['roleDelete', 'Anti Role Delete', 'Roles deleted'],
  ['roleCreate', 'Anti Role Create', 'Roles created'],
  ['ban', 'Anti Member Ban', 'Members banned'],
  ['kick', 'Anti Member Kick', 'Members kicked'],
  ['serverUpdate', 'Anti Server Update', 'Server settings changed'],
  ['emojiDelete', 'Anti Emoji Delete', 'Emojis deleted'],
  ['permissionChange', 'Anti Permission Changes', 'Role or channel permissions changed'],
  ['dangerousRoleGrant', 'Dangerous role grants', 'Admin or moderator power handed out'],
  ['webhookCreate', 'Anti Webhook Create', 'Webhooks created'],
];

export const antiNukePage = (ctx) => configForm(ctx, 'security', async (state, dirty) => {
  const [events, overview] = await Promise.all([api(`/api/guilds/${ctx.guildId}/security/events`), api(`/api/guilds/${ctx.guildId}/overview`)]);
  const row = ([key, title, help]) => {
    const on = h('input', { type: 'checkbox', checked: !state.antiNuke.disabled.includes(key), onchange: (e) => { state.antiNuke.disabled = e.target.checked ? state.antiNuke.disabled.filter((k) => k !== key) : [...state.antiNuke.disabled, key]; dirty(); } });
    return h('div', { class: 'module-row' },
      h('label', { class: 'toggle' }, h('span', { class: 't' }, title, h('span', { class: 'help' }, help)), on, h('span', { class: 'sw' })),
      fieldGrid([
        { path: `antiNuke.limits.${key}.count`, label: 'Maximum actions', type: 'number', min: 1, max: 100 },
        { path: `antiNuke.limits.${key}.windowSec`, label: 'Time window (seconds)', type: 'number', min: 1, max: 3600 },
      ], state, ctx, dirty));
  };
  return h('div', {}, pageHead('Anti-Nuke', 'Stops one account from destroying your server by counting its actions in the Discord audit log.'),
    accessNotices(state, overview.access.isTrusted),
    section('Protection', null, fieldGrid([...statusFields, { path: 'antiNuke.enabled', label: 'Anti-nuke enabled', type: 'toggle' }], state, ctx, dirty)),
    section('Response', 'What happens when someone reaches a limit. Nothing is punished in Monitor mode.', fieldGrid([
      { path: 'antiNuke.punishment', label: 'Punishment', type: 'select', options: [{ value: 'strip_roles', label: 'Remove dangerous permissions (strip all roles)' }, { value: 'quarantine', label: 'Quarantine (jail role)' }, { value: 'timeout', label: 'Timeout' }, { value: 'kick', label: 'Kick' }, { value: 'ban', label: 'Ban' }], help: 'Quarantine uses the jail role from /modconfig jail-setup. Without one, it strips all roles instead.' },
      { path: 'antiNuke.recover', label: 'Automatic recovery', type: 'toggle', help: 'Rebuild channels and roles, reverse bans, and remove webhooks. Other changes are reported, not reversed.' },
    ], state, ctx, dirty)),
    section('Protection modules', 'Each one counts per person. Reaching the maximum inside the time window triggers the response.', h('div', { class: 'module-list' }, NUKE_ROWS.map(row),
      h('div', { class: 'module-row' }, fieldGrid([{ path: 'antiMention.enabled', label: 'Anti Mass Mention', type: 'toggle', help: 'Too many mentions in one message' }], state, ctx, dirty), fieldGrid([{ path: 'antiMention.maxMentions', label: 'Maximum mentions', type: 'number', min: 1, max: 100 }, { path: 'antiMention.blockEveryone', label: 'Block @everyone attempts', type: 'toggle' }], state, ctx, dirty)))),
    section('Trusted people', 'These are never punished automatically. The server owner and ZYTHERON itself are always trusted.', fieldGrid([
      { path: 'whitelistRoles', label: 'Trusted roles', type: 'roles' },
      { path: 'whitelistUsers', label: 'Trusted user IDs', type: 'list', placeholder: 'User ID' },
      { path: 'trustedAdmins', label: 'Trusted admin IDs', type: 'list', placeholder: 'User ID', help: 'They can also change security settings. Only the server owner can edit this.' },
    ], state, ctx, dirty)),
    section('Recent anti-nuke events', null, eventsTable(events.filter((e) => e.type.startsWith('anti_nuke')), 'Nothing has triggered anti-nuke.')));
});

// ---------- Anti-Raid ----------
export const antiRaidPage = (ctx) => configForm(ctx, 'security', async (state, dirty) => {
  const [stats, overview] = await Promise.all([api(`/api/guilds/${ctx.guildId}/anti-raid/stats`), api(`/api/guilds/${ctx.guildId}/overview`)]);
  return h('div', {}, pageHead('Anti-Raid', 'Spots waves of new accounts and responds before they reach your members.', lockdownButton(ctx, stats.locked, overview.access.isTrusted)),
    stats.locked ? h('div', { class: 'notice danger' }, 'This server is in lockdown.') : null,
    accessNotices(state, overview.access.isTrusted),
    h('div', { class: 'grid tiles' },
      tile('Joins, last 24 hours', stats.joins24h, 'Counted since this page was added'),
      tile('Joins today', stats.days.at(-1)?.joins ?? 0),
      tile('Left today', stats.days.at(-1)?.leaves ?? 0),
      tile('Raid alerts', stats.events.filter((e) => e.type === 'anti_raid').length, 'Most recent 20 events')),
    section('Joins per hour', 'The last 24 hours, newest on the right.', miniBars(stats.hours.map((r) => ({ label: `${r.hoursAgo} hours ago`, value: r.joins })), `Joins per hour. ${stats.joins24h} in total.`)),
    section('Protection', null, fieldGrid(statusFields, state, ctx, dirty)),
    h('div', { class: 'grid two', style: 'margin-top:14px' },
      section('Mass join detection', 'Raid mode starts when this many people join this quickly.', fieldGrid([
        { path: 'antiRaid.enabled', label: 'Enabled', type: 'toggle' },
        { path: 'antiRaid.autoLockdown', label: 'Automatic lockdown', type: 'toggle' },
        { path: 'antiRaid.joinThreshold', label: 'Maximum joins', type: 'number', min: 2, max: 200 },
        { path: 'antiRaid.windowSec', label: 'Time window (seconds)', type: 'number', min: 1, max: 600 },
        { path: 'antiRaid.action', label: 'Raid response', type: 'select', options: [{ value: 'timeout', label: 'Timeout' }, { value: 'kick', label: 'Kick' }, { value: 'ban', label: 'Ban' }] },
        { path: 'antiRaid.raidModeMinutes', label: 'Raid mode minutes', type: 'number', min: 1, max: 1440 },
        { path: 'antiRaid.raiseVerification', label: 'Raise verification level', type: 'select', wide: true, help: 'Stays raised on Discord until an admin lowers it.', options: [{ value: 'off', label: 'Do not change' }, { value: 'low', label: 'Low: verified email' }, { value: 'medium', label: 'Medium: on Discord for 5 minutes' }, { value: 'high', label: 'High: in the server for 10 minutes' }, { value: 'very_high', label: 'Highest: verified phone' }] },
      ], state, ctx, dirty)),
      section('Suspicious accounts and bots', 'Checked for each person or bot that joins.', fieldGrid([
        { path: 'suspicious.enabled', label: 'Suspicious join detection', type: 'toggle' },
        { path: 'suspicious.minAccountAgeDays', label: 'Minimum account age (days)', type: 'number', min: 0, max: 365 },
        { path: 'suspicious.scoreThreshold', label: 'Risk score threshold', type: 'number', min: 1, max: 100 },
        { path: 'suspicious.action', label: 'Action', type: 'select', options: [{ value: 'log', label: 'Log only' }, { value: 'timeout', label: 'Timeout' }, { value: 'kick', label: 'Kick' }, { value: 'ban', label: 'Ban' }] },
        { path: 'antiBot.enabled', label: 'Anti bot raid', type: 'toggle', help: 'Bots added by the owner or trusted admins are always allowed' },
        { path: 'antiBot.action', label: 'Bot action', type: 'select', options: [{ value: 'log', label: 'Log only' }, { value: 'kick', label: 'Kick' }, { value: 'ban', label: 'Ban' }] },
        { path: 'antiBot.allowedBots', label: 'Trusted bot IDs', type: 'list', wide: true, placeholder: 'Bot ID' },
        { path: 'whitelistUsers', label: 'Trusted user IDs', type: 'list', wide: true, placeholder: 'User ID' },
      ], state, ctx, dirty))),
    section('Verification system', 'New members must pass a check before they can talk. It is set up under Settings, in Welcome challenge.', h('a', { class: 'btn small', href: `#/g/${ctx.guildId}/settings` }, 'Open Settings')),
    section('Raid activity', null, eventsTable(stats.events, 'No raid activity recorded.')));
});

// ---------- Anti-Webhook ----------
export const antiWebhookPage = (ctx) => configForm(ctx, 'security', async (state, dirty) => {
  const overview = await api(`/api/guilds/${ctx.guildId}/overview`);
  const trusted = overview.access.isTrusted;
  const data = await api(`/api/guilds/${ctx.guildId}/webhooks`).catch((err) => ({ error: err.message, webhooks: [], activity: [] }));
  const holder = h('div');
  const isTrustedHook = (w) => state.antiWebhook.trustedWebhooks.includes(w.id);
  const removeHook = async (w) => {
    if (!(await confirmDialog('Remove this webhook?', `"${w.name}" will stop working, and Discord cannot bring it back.`, 'Remove'))) return;
    await guard(null, async () => {
      await api(`/api/guilds/${ctx.guildId}/webhooks/${w.id}`, { method: 'DELETE' });
      data.webhooks = data.webhooks.filter((x) => x.id !== w.id);
      toast('Webhook removed.');
      render();
    })();
  };
  const render = () => holder.replaceChildren(dataTable([
    { label: 'Name', render: (w) => w.name },
    { label: 'Channel', render: (w) => channelTag(ctx, w.channelId) },
    { label: 'Created by', render: (w) => w.createdBy ?? 'Unknown' },
    { label: 'Created', render: (w) => fmtAgo(w.createdAt) },
    { label: 'Policy', render: (w) => pill(isTrustedHook(w) ? 'Trusted' : 'Not trusted', isTrustedHook(w) ? 'good' : 'warn') },
    { label: '', render: (w) => h('div', { class: 'row actions' },
      h('button', { class: 'btn small', disabled: !trusted, onclick: () => { state.antiWebhook.trustedWebhooks = isTrustedHook(w) ? state.antiWebhook.trustedWebhooks.filter((id) => id !== w.id) : [...state.antiWebhook.trustedWebhooks, w.id]; dirty(); render(); } }, isTrustedHook(w) ? 'Untrust' : 'Trust'),
      h('button', { class: 'btn small danger', disabled: !trusted, onclick: () => removeHook(w) }, 'Remove')) },
  ], data.webhooks, 'This server has no webhooks.'));
  render();
  const cleanup = h('button', { class: 'btn danger', disabled: !trusted }, 'Remove untrusted webhooks');
  cleanup.addEventListener('click', guard(cleanup, async () => {
    const targets = data.webhooks.filter((w) => !isTrustedHook(w) && !w.application);
    if (!targets.length) return toast('There are no untrusted webhooks to remove.');
    if (!(await confirmDialog(`Remove ${targets.length} webhooks?`, 'They will stop working, and Discord cannot bring them back. Webhooks that belong to an installed app are left alone.', 'Remove them'))) return;
    let removed = 0;
    for (const w of targets) {
      await api(`/api/guilds/${ctx.guildId}/webhooks/${w.id}`, { method: 'DELETE' }).then(() => { removed += 1; data.webhooks = data.webhooks.filter((x) => x.id !== w.id); }, () => undefined);
    }
    render();
    toast(`Removed ${removed} of ${targets.length} webhooks.`, removed === targets.length ? 'ok' : 'err');
  }));
  return h('div', {}, pageHead('Anti-Webhook', 'Finds webhook abuse and shows every webhook in your server. Tokens are never shown or stored.', cleanup),
    accessNotices(state, trusted),
    data.error ? h('div', { class: 'notice danger' }, data.error) : null,
    section('Protection', null, fieldGrid([
      ...statusFields,
      { path: 'antiWebhook.enabled', label: 'Anti-webhook enabled', type: 'toggle' },
      { path: 'antiWebhook.alertCreate', label: 'Alert on webhook creation', type: 'toggle' },
      { path: 'antiWebhook.alertDelete', label: 'Alert on webhook deletion', type: 'toggle' },
      { path: 'antiWebhook.removeUnauthorized', label: 'Remove unauthorized webhooks', type: 'toggle', help: 'In Enforce mode, removes webhooks made by anyone who is not trusted' },
    ], state, ctx, dirty)),
    section('Spam limits', 'Applies to messages sent by webhooks that are not trusted.', fieldGrid([
      { path: 'antiWebhook.maxMessages', label: 'Maximum messages', type: 'number', min: 1, max: 100 },
      { path: 'antiWebhook.windowSec', label: 'Time window (seconds)', type: 'number', min: 1, max: 120 },
      { path: 'antiWebhook.blockEveryone', label: 'Block webhook @everyone', type: 'toggle' },
      { path: 'antiWebhook.deleteWebhook', label: 'Delete the webhook when it breaks a limit', type: 'toggle' },
      { path: 'antiNuke.limits.webhookCreate.count', label: 'Maximum webhooks created per person', type: 'number', min: 1, max: 100 },
      { path: 'antiNuke.limits.webhookCreate.windowSec', label: 'In seconds', type: 'number', min: 1, max: 3600 },
    ], state, ctx, dirty)),
    section('Webhooks in this server', 'Trust changes apply once you save.', holder),
    section('Webhook activity', null, eventsTable(data.activity, 'No webhook activity recorded.')));
});
