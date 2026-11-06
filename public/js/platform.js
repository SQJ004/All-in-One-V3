import { api, confirmDialog, fmtAgo, fmtDate, guard, h, icon, modal, showError, toast } from './lib.js';
import { configForm, dataTable, fieldGrid, section } from './forms.js';
import { channelTag, miniBars, pageHead, pill, tile } from './protection.js';

const fmtSize = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

// ---------- Backup & Restore ----------
const RESTORE_LIMITS = 'Discord does not let any bot restore everything. Deleted messages, who had which role, members, bans, and the server\'s old invites cannot come back. A restore adds what is missing and resets what you tick. It never deletes anything.';

export const backupPage = (ctx) => configForm(ctx, 'backup', async (state, dirty) => {
  const overview = await api(`/api/guilds/${ctx.guildId}/overview`);
  const trusted = overview.access.isTrusted;
  const holder = h('div');
  let timer = null;
  const stop = () => { if (timer) clearTimeout(timer); timer = null; };
  ctx.cleanups.push(stop);

  const restore = async (b) => {
    const choice = { roles: true, channels: true, permissions: false, settings: false, emojis: false };
    const started = await modal(`Restore backup ${b.backupId}?`, () => ({
      node: h('div', {}, h('p', { class: 'notice' }, RESTORE_LIMITS), fieldGrid([
        { path: 'roles', label: 'Missing roles', type: 'toggle' },
        { path: 'channels', label: 'Missing channels and categories', type: 'toggle' },
        { path: 'permissions', label: 'Reset permissions to this backup', type: 'toggle', help: 'Overwrites current role and channel permissions' },
        { path: 'settings', label: 'Server settings', type: 'toggle', help: 'Verification level, notifications, content filter, AFK and system channels' },
        { path: 'emojis', label: 'Missing emojis', type: 'toggle', help: 'Only while Discord still has the image' },
      ], choice, ctx)),
      submit: () => api(`/api/guilds/${ctx.guildId}/backups/${b.backupId}/restore`, { method: 'POST', body: choice }),
    }), { submitLabel: 'Restore' });
    if (started) { toast('Restore started. Progress shows below.'); load(); }
  };
  const remove = async (b) => {
    if (!(await confirmDialog('Delete this backup?', 'This cannot be undone.', 'Delete'))) return;
    await guard(null, async () => { await api(`/api/guilds/${ctx.guildId}/backups/${b.backupId}`, { method: 'DELETE' }); toast('Backup deleted.'); load(); })();
  };
  const lastResult = (b) => {
    const r = b.lastRestore;
    if (!r) return '';
    const text = `${fmtAgo(r.at)}: ${r.created} created, ${r.updated} updated, ${r.failed} failed`;
    return r.notes.length ? h('span', { title: r.notes.join('\n') }, `${text} (hover for details)`) : text;
  };
  const load = guard(null, async () => {
    stop();
    const items = await api(`/api/guilds/${ctx.guildId}/backups`);
    holder.replaceChildren(dataTable([
      { label: 'Identifier', render: (b) => h('code', {}, b.backupId) },
      { label: 'Created', render: (b) => h('span', { title: `By ${b.createdBy}` }, fmtDate(b.createdAt)) },
      { label: 'Contains', render: (b) => `${fmtSize(b.sizeBytes)}: ${b.counts.roles} roles, ${b.counts.categories + b.counts.channels} channels, ${b.counts.emojis} emojis` },
      { label: 'Status', render: (b) => pill(b.status === 'restoring' ? 'Restoring' : b.kind === 'auto' ? 'Ready (scheduled)' : 'Ready', b.status === 'restoring' ? 'warn' : 'good') },
      { label: 'Last restore', render: lastResult },
      { label: '', render: (b) => h('div', { class: 'row actions' },
        trusted ? h('a', { class: 'btn small', href: `/api/guilds/${ctx.guildId}/backups/${b.backupId}/download`, download: '' }, 'Download') : null,
        h('button', { class: 'btn small', disabled: !trusted || b.status === 'restoring', onclick: () => restore(b) }, 'Restore'),
        h('button', { class: 'btn small danger', disabled: !trusted || b.status === 'restoring', onclick: () => remove(b) }, 'Delete')) },
    ], items, 'No backups yet. Create your first one.'));
    if (items.some((b) => b.status === 'restoring')) timer = setTimeout(load, 3000);
  });
  await load();
  const create = h('button', { class: 'btn primary', disabled: !trusted }, 'Create backup');
  create.addEventListener('click', guard(create, async () => {
    await api(`/api/guilds/${ctx.guildId}/backups`, { method: 'POST' });
    toast('Backup created.');
    await load();
  }));
  return h('div', {}, pageHead('Server Backup & Restore', 'Saves your roles, channels, permissions, settings and emojis.', create),
    h('div', { class: 'notice' }, RESTORE_LIMITS),
    trusted ? null : h('div', { class: 'notice' }, 'Only the server owner or a trusted admin can create, download or restore backups.'),
    section('Backup history', null, holder),
    section('Backup schedule', 'Scheduled backups run while the bot is online.', fieldGrid([
      { path: 'autoEnabled', label: 'Automatic backups', type: 'toggle' },
      { path: 'everyHours', label: 'Every (hours)', type: 'number', min: 1, max: 168 },
      { path: 'keep', label: 'Keep the newest', type: 'number', min: 1, max: 25, help: 'Older ones are deleted, counted separately for manual and scheduled backups' },
    ], state, ctx, dirty)));
});

// ---------- Audit Logs ----------
const LOG_FILTERS = [['', 'All categories'], ['member', 'Member Logs'], ['message', 'Message Logs'], ['channel', 'Channel Logs'], ['role', 'Role Logs'], ['voice', 'Voice Logs'], ['moderation', 'Moderation Logs'], ['security', 'Security Logs'], ['webhook', 'Webhook Logs'], ['server', 'Server Update Logs'], ['ban', 'Ban Logs'], ['invite', 'Invite Logs']];
const LIVE_MS = 10_000;

export async function auditLogsPage(ctx) {
  const filter = { q: '', user: '', category: '', from: '', to: '' };
  let page = 0;
  let timer = null;
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  ctx.cleanups.push(stop);
  const params = () => {
    const p = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
      if (!value) continue;
      p.set(key, key === 'to' ? `${value}T23:59:59.999` : value);
    }
    return p;
  };
  const holder = h('div');
  const pager = h('div', { class: 'row pager' });
  const exportLink = h('a', { class: 'btn', download: '' }, 'Export CSV');
  const load = guard(null, async () => {
    const p = params();
    exportLink.href = `/api/guilds/${ctx.guildId}/audit-logs/export?${p}`;
    p.set('page', String(page));
    const data = await api(`/api/guilds/${ctx.guildId}/audit-logs?${p}`);
    holder.replaceChildren(dataTable([
      { label: 'Time', render: (r) => fmtDate(r.createdAt) },
      { label: 'User', render: (r) => r.userName ?? r.userId ?? 'Unknown' },
      { label: 'Action', render: (r) => r.action },
      { label: 'Target', clip: true, render: (r) => r.target ?? '' },
      { label: 'Channel', render: (r) => (r.channelId ? channelTag(ctx, r.channelId) : '') },
      { label: 'Status', render: (r) => pill(r.status === 'monitor' ? 'Monitor only' : r.status === 'enforced' ? 'Enforced' : 'Logged', r.status === 'enforced' ? 'good' : r.status === 'monitor' ? 'warn' : '') },
      { label: 'Details', clip: true, render: (r) => r.details ?? '' },
    ], data.items, 'Nothing matches. New events appear here as they happen.'));
    const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
    pager.replaceChildren(
      h('button', { class: 'btn small', disabled: page === 0, onclick: () => { page -= 1; load(); } }, 'Previous'),
      h('span', { class: 'hint-text' }, `Page ${page + 1} of ${pages} · ${data.total.toLocaleString()} ${data.total === 1 ? 'entry' : 'entries'}`),
      h('button', { class: 'btn small', disabled: page + 1 >= pages, onclick: () => { page += 1; load(); } }, 'Next'));
  });
  const apply = () => { page = 0; load(); };
  let typing = null;
  const textFilter = (key, label, placeholder) => h('div', { class: 'field' }, h('label', {}, label), h('input', { type: 'text', placeholder, 'aria-label': label, maxLength: key === 'user' ? 40 : 100, oninput: (e) => { filter[key] = e.target.value.trim(); clearTimeout(typing); typing = setTimeout(apply, 300); } }));
  const dateFilter = (key, label) => h('div', { class: 'field' }, h('label', {}, label), h('input', { type: 'date', 'aria-label': label, onchange: (e) => { filter[key] = e.target.value; apply(); } }));
  const live = h('input', { type: 'checkbox', checked: true, onchange: (e) => { stop(); if (e.target.checked) timer = setInterval(load, LIVE_MS); } });
  timer = setInterval(load, LIVE_MS);
  await load();
  return h('div', {}, pageHead('Advanced Audit Logs', 'A searchable record of what happens in your server, kept for 30 days.', exportLink),
    h('div', { class: 'notice' }, 'Message text is never kept here. It only goes to the log channel you choose under Logs. Entries start from when this page was added, because Discord does not give bots a full history.'),
    h('section', { class: 'card' }, h('div', { class: 'fields audit-filters' },
      textFilter('q', 'Search', 'Action, target or details'),
      textFilter('user', 'User', 'Name or ID'),
      h('div', { class: 'field' }, h('label', {}, 'Category'), h('select', { 'aria-label': 'Category', onchange: (e) => { filter.category = e.target.value; apply(); } }, LOG_FILTERS.map(([value, label]) => h('option', { value }, label)))),
      dateFilter('from', 'From'), dateFilter('to', 'To'),
      h('label', { class: 'toggle' }, h('span', { class: 't' }, 'Live updates', h('span', { class: 'help' }, 'Refreshes every 10 seconds')), live, h('span', { class: 'sw' }))),
    holder, pager));
}

// ---------- AI Moderation ----------
const CATEGORY_LABEL = { toxicity: 'Toxicity', harassment: 'Harassment', spam: 'Spam', scam: 'Scam', phishing: 'Phishing', suspicious: 'Suspicious' };
const STATUS = { actioned: ['Actioned', 'good'], dismissed: ['Dismissed', ''], false_positive: ['False positive', 'warn'], pending: ['Waiting', 'accent'] };

export const aiModerationPage = (ctx) => configForm(ctx, 'aiModeration', async (state, dirty) => {
  const [data, overview] = await Promise.all([api(`/api/guilds/${ctx.guildId}/ai/overview`), api(`/api/guilds/${ctx.guildId}/overview`)]);
  const trusted = overview.access.isTrusted;
  const review = (flag, decision, label, cls = '') => {
    const button = h('button', { class: `btn small ${cls}` }, label);
    button.addEventListener('click', guard(button, async () => {
      if ((decision === 'warn' || decision === 'timeout') && !(await confirmDialog(`${label} ${flag.authorTag}?`, flag.reason, label))) return;
      await api(`/api/guilds/${ctx.guildId}/ai/flags/${flag._id}/review`, { method: 'POST', body: { decision } });
      toast('Review saved.');
      ctx.rerender();
    }));
    return button;
  };
  const flagColumns = [
    { label: 'When', render: (f) => fmtAgo(f.createdAt) },
    { label: 'Member', render: (f) => f.authorTag },
    { label: 'Category', render: (f) => pill(CATEGORY_LABEL[f.category] ?? f.category, f.category === 'phishing' || f.category === 'scam' ? 'bad' : 'warn') },
    { label: 'Confidence', render: (f) => `${f.confidence}%` },
    { label: 'Reason', clip: true, render: (f) => f.reason },
    { label: 'Message', clip: true, render: (f) => f.excerpt },
    { label: 'Source', render: (f) => (f.source === 'link_scanner' ? 'Link scanner' : 'AI') },
  ];
  const testInput = h('textarea', { rows: 2, maxLength: 1000, placeholder: 'Type a sample message', 'aria-label': 'Sample message' });
  const testResult = h('p', { class: 'hint-text' });
  const testButton = h('button', { class: 'btn', type: 'button', disabled: !data.connected || !trusted }, 'Test');
  testButton.addEventListener('click', guard(testButton, async () => {
    const text = testInput.value.trim();
    if (!text) return toast('Type a sample message first.', 'err');
    const { verdict } = await api(`/api/guilds/${ctx.guildId}/ai/test`, { method: 'POST', body: { text } });
    testResult.textContent = verdict ? `Flagged as ${verdict.category}, ${verdict.confidence}% sure. ${verdict.reason}` : 'Not flagged.';
  }));
  return h('div', {}, pageHead('AI Moderation', 'Flags harmful messages with a confidence score and a reason. Moderators make the serious calls.', pill(data.connected ? 'AI connected' : 'AI not connected', data.connected ? 'good' : 'warn')),
    data.connected ? null : h('div', { class: 'notice' }, 'AI checks are not running, because no API key is set. Add ANTHROPIC_API_KEY to the .env file and restart the bot. The link scanner below works without it.'),
    state.enabled && data.connected ? h('div', { class: 'notice' }, `The text of messages in this server is sent to Anthropic for review, using ${data.model}. Tell your members about this in your server rules.`) : null,
    trusted ? null : h('div', { class: 'notice' }, 'Only the server owner or a trusted admin can change these settings.'),
    h('div', { class: 'grid tiles' },
      tile('Messages analyzed', data.totals.analyzed.toLocaleString(), 'Last 14 days'),
      tile('Messages flagged', data.totals.flagged.toLocaleString()),
      tile('Warnings issued', data.totals.warned.toLocaleString()),
      tile('Timeouts', data.totals.timedOut.toLocaleString()),
      tile('False positives', data.totals.falsePositive.toLocaleString()),
      tile('Waiting for review', data.pending.length)),
    section('Moderation activity', 'Messages flagged per day.', data.days.length ? miniBars(data.days.map((d) => ({ label: d.date, value: d.flagged })), 'Messages flagged per day') : h('p', { class: 'empty' }, 'No activity yet.')),
    section('Human review', 'Anything between your two confidence lines waits here for a moderator.', dataTable([...flagColumns, { label: '', render: (f) => h('div', { class: 'row actions' },
      review(f, 'warn', 'Warn'), review(f, 'timeout', 'Timeout', 'danger'), review(f, 'false_positive', 'False positive'), review(f, 'dismiss', 'Dismiss')) }], data.pending, 'Nothing is waiting for review.')),
    section('Settings', null, fieldGrid([
      { path: 'enabled', label: 'AI moderation enabled', type: 'toggle' },
      { path: 'linkProtection', label: 'Link protection', type: 'toggle', help: 'Spots known scam and phishing links on this computer, with nothing sent to AI' },
      { path: 'reviewThreshold', label: 'Send to review at (% confidence)', type: 'number', min: 1, max: 100, help: 'Lower is more sensitive' },
      { path: 'actionThreshold', label: 'Allow automatic steps at (% confidence)', type: 'number', min: 1, max: 100 },
      { path: 'logChannelId', label: 'AI moderation log channel', type: 'channel' },
      { path: 'dailyLimit', label: 'Most messages to analyze per day', type: 'number', min: 1, max: 100000, help: 'Limits how much the API can cost' },
    ], state, ctx, dirty)),
    section('Detection', null, fieldGrid(Object.entries(CATEGORY_LABEL).map(([key, label]) => ({ path: `categories.${key}`, label: `${label} detection`, type: 'toggle' })), state, ctx, dirty)),
    section('Automatic steps', 'All off by default. They run only above the automatic confidence line. AI can never kick or ban anyone, and warnings from AI do not count toward your warn punishments.', fieldGrid([
      { path: 'autoDelete', label: 'Delete the message', type: 'toggle' },
      { path: 'autoWarn', label: 'Auto warn', type: 'toggle' },
      { path: 'autoTimeout', label: 'Auto timeout', type: 'toggle' },
      { path: 'timeoutMinutes', label: 'Timeout length (minutes)', type: 'number', min: 1, max: 60 },
    ], state, ctx, dirty)),
    section('Exemptions and rules', 'Server owners and people with Manage Server are always exempt.', fieldGrid([
      { path: 'exemptRoles', label: 'Exempt roles', type: 'roles' },
      { path: 'exemptChannels', label: 'Exempt channels', type: 'channels' },
      { path: 'customRules', label: 'Custom moderation rules', type: 'list', wide: true, placeholder: 'No advertising other servers, then press Enter', help: 'Plain sentences. AI uses them as this server\'s rules.' },
    ], state, ctx, dirty)),
    section('Try it', 'Sends your sample to AI and shows the result. It changes nothing and costs a small API charge.', testInput, h('div', { class: 'row', style: 'margin-top:8px' }, testButton), testResult),
    section('AI moderation reports', null, dataTable([...flagColumns, { label: 'Result', render: (f) => pill(...(STATUS[f.status] ?? [f.status, ''])) }, { label: 'Action', clip: true, render: (f) => f.action ?? '' }, { label: 'Reviewed by', render: (f) => f.reviewedBy ?? 'Automatic' }], data.recent, 'No reports yet.')));
});

// ---------- Bot Identity ----------
const MAX_IMAGE_BYTES = 180 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif'];
const STATUS_LABEL = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', invisible: 'Invisible' };
const ACTIVITY_LABEL = { playing: 'Playing', listening: 'Listening to', watching: 'Watching', competing: 'Competing in', custom: '' };

export async function botIdentityPage(ctx) {
  const saved = await api(`/api/guilds/${ctx.guildId}/identity`);
  const state = { status: saved.status, activityType: saved.activityType, activityText: saved.activityText, embedColor: saved.embedColor, username: saved.username };
  const images = {};
  const name = h('strong', {}, saved.username);
  const statusDot = h('span', { class: 'status-dot' });
  const statusText = h('span', {});
  const activity = h('p', { class: 'identity-activity' });
  const embed = h('div', { class: 'identity-embed' }, h('b', {}, 'Example message'), h('span', {}, 'This is how embeds from ZYTHERON look.'));
  const refresh = () => {
    name.textContent = state.username || saved.username;
    statusDot.dataset.status = state.status;
    statusText.textContent = STATUS_LABEL[state.status];
    activity.textContent = state.activityType === 'none' || !state.activityText ? '' : `${ACTIVITY_LABEL[state.activityType]} ${state.activityText}`.trim();
    embed.style.borderLeftColor = state.embedColor;
  };
  const spot = (kind, label, current) => {
    const picture = h('span', { class: 'profile-picture' }, current ? h('img', { src: current, alt: '' }) : null);
    const input = h('input', { class: 'profile-file', type: 'file', accept: IMAGE_TYPES.join(','), tabIndex: -1, 'aria-hidden': 'true' });
    input.addEventListener('change', () => {
      const file = input.files[0];
      input.value = '';
      if (!file) return;
      if (!IMAGE_TYPES.includes(file.type)) return toast('Choose a PNG, JPG or GIF image.', 'err');
      if (file.size > MAX_IMAGE_BYTES) return toast('That image is too large. The limit is 180 KB.', 'err');
      const reader = new FileReader();
      reader.onload = () => { images[kind] = reader.result; picture.replaceChildren(h('img', { src: reader.result, alt: '' })); };
      reader.onerror = () => toast('That image could not be read.', 'err');
      reader.readAsDataURL(file);
    });
    return h('div', { class: `profile-spot ${kind}` },
      h('button', { class: 'profile-pick', type: 'button', disabled: !saved.canEdit, 'aria-label': `Change ${label}`, title: `Change ${label}`, onclick: () => input.click() }, picture, h('span', { class: 'profile-overlay' }, icon('camera'), kind === 'banner' ? h('span', {}, 'Change banner') : null)),
      input);
  };
  const form = fieldGrid([
    { path: 'username', label: 'Bot username', max: 32, help: 'Discord allows about 2 changes per hour' },
    { path: 'embedColor', label: 'Embed color', type: 'color' },
    { path: 'status', label: 'Status', type: 'select', options: Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })) },
    { path: 'activityType', label: 'Activity', type: 'select', options: [{ value: 'none', label: 'None' }, { value: 'playing', label: 'Playing' }, { value: 'listening', label: 'Listening to' }, { value: 'watching', label: 'Watching' }, { value: 'competing', label: 'Competing in' }, { value: 'custom', label: 'Custom status' }] },
    { path: 'activityText', label: 'Activity text', wide: true, max: 120 },
  ], state, ctx, refresh);
  const save = h('button', { class: 'btn primary', type: 'button', disabled: !saved.canEdit }, 'Save changes');
  save.addEventListener('click', guard(save, async () => {
    const username = state.username.trim();
    if (!(await confirmDialog('Change the bot everywhere?', 'This changes ZYTHERON in every server it is in. Other servers will see the new look too.', 'Save changes'))) return;
    const body = { status: state.status, activityType: state.activityType, activityText: state.activityText, embedColor: state.embedColor, ...(username && username !== saved.username ? { username } : {}), ...images };
    await api(`/api/guilds/${ctx.guildId}/identity`, { method: 'PUT', body });
    toast('Saved. Discord can take a moment to show it.');
    ctx.rerender();
  }));
  refresh();
  return h('div', {}, pageHead('Custom Bot Identity', 'The name, picture, status and color of ZYTHERON everywhere.', save),
    saved.canEdit ? null : h('div', { class: 'notice' }, "Only the bot's owner in the Discord Developer Portal can change this, because it affects every server."),
    h('section', { class: 'card profile-card' }, spot('banner', 'banner', saved.bannerUrl), spot('avatar', 'avatar', saved.avatarUrl),
      h('div', { class: 'profile-body' },
        h('p', { class: 'profile-name' }, name, h('span', { class: 'profile-tag' }, 'BOT')),
        h('p', { class: 'identity-status' }, statusDot, statusText), activity, embed,
        h('p', { class: 'profile-help' }, 'This is a live preview. Click the banner or avatar to choose a new one. PNG, JPG or GIF, up to 180 KB. Nothing changes until you save.'))),
    section('Details', null, form));
}

// ---------- Premium ----------
const PREMIUM_FEATURES = [
  { id: 'anti-nuke', title: 'Anti-Nuke', text: 'Stops one account from destroying your server, and rebuilds what it can.' },
  { id: 'anti-raid', title: 'Anti-Raid', text: 'Spots waves of new accounts and responds before they reach your members.' },
  { id: 'anti-webhook', title: 'Anti-Webhook', text: 'Finds webhook abuse and shows every webhook in your server.' },
  { id: 'backup', title: 'Server Backup & Restore', text: 'Saves your roles, channels, permissions and settings.' },
  { id: 'tickets', title: 'Advanced Ticket System', text: 'Private support channels with questions, transcripts and ratings.' },
  { id: 'bot-identity', title: 'Custom Bot Identity', text: 'The name, picture, status and color of your bot.' },
  { id: 'audit-logs', title: 'Advanced Audit Logs', text: 'A searchable record of what happens, with filters and CSV export.' },
  { id: 'staff', title: 'Staff Performance', text: 'Leaderboard, profiles, goals and history, from real cases and tickets.' },
];

/** Every status comes from this server's saved settings. A failed check says Unknown, never Active. */
export async function premiumPage(ctx) {
  const base = `/api/guilds/${ctx.guildId}`;
  const quiet = (path) => api(`${base}/${path}`).catch(() => null);
  const [security, tickets, backup, identity, backups] = await Promise.all([quiet('config/security'), quiet('config/tickets'), quiet('config/backup'), quiet('identity'), quiet('backups')]);
  const guarded = (on) => (security ? { on: security.enabled && on(security), hint: security.enabled && on(security) && security.mode === 'monitor' ? 'Monitor mode: logging only' : '' } : null);
  const status = {
    'anti-nuke': guarded((s) => s.antiNuke.enabled),
    'anti-raid': guarded((s) => s.antiRaid.enabled),
    'anti-webhook': guarded((s) => s.antiWebhook.enabled),
    backup: backup && backups ? { on: backup.autoEnabled || backups.length > 0, hint: backup.autoEnabled ? `Automatic every ${backup.everyHours} hours` : backups.length ? `${backups.length} saved` : '' } : null,
    tickets: tickets ? { on: tickets.enabled } : null,
    'bot-identity': identity ? { on: identity.status !== 'online' || identity.activityType !== 'none' || identity.embedColor.toLowerCase() !== '#7c3aed', hint: '' } : null,
    'audit-logs': { on: true, hint: 'Always recording' },
    staff: { on: true, hint: 'Counted from your records' },
  };
  const card = (f) => {
    const s = status[f.id];
    return h('article', { class: 'card premium-card' },
      h('div', { class: 'premium-card-top' }, h('span', { class: 'premium-card-icon' }, icon(f.id)), pill(s ? (s.on ? 'Active' : 'Inactive') : 'Unknown', s?.on ? 'good' : '')),
      h('h2', {}, f.title),
      h('p', {}, f.text),
      s?.hint ? h('p', { class: 'premium-card-hint' }, s.hint) : null,
      h('a', { class: 'btn primary small', href: `#/g/${ctx.guildId}/${f.id}` }, 'Configure'));
  };
  return h('div', {},
    h('header', { class: 'page-head premium-head' }, h('div', {}, h('span', { class: 'premium-badge' }, icon('premium'), 'Premium'), h('h1', {}, 'Premium features'), h('p', {}, 'Everything for protecting and running your server, in one place.'))),
    h('p', { class: 'notice' }, 'Included free for now. ZYTHERON has no paid plan yet.'),
    h('div', { class: 'premium-grid' }, PREMIUM_FEATURES.map(card)));
}
