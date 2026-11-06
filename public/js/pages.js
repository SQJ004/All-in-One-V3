import { api, confirmDialog, fmtAgo, fmtDate, fmtUptime, guard, h, modal, svg, toast } from './lib.js';
import { configForm, dataTable, fieldGrid, roleColor, section } from './forms.js';
import { embedBuilderPage } from './embeds.js';

const pill = (text, kind = '') => h('span', { class: `pill ${kind}` }, text);
const pageHead = (title, sub, ...actions) => h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, title), h('p', {}, sub)), actions.length ? h('div', { class: 'row' }, actions) : null);
const channelName = (ctx, id) => { const c = ctx.resources.channels.find((x) => x.id === id); return c ? `#${c.name}` : id ?? 'None'; };
const roleName = (ctx, id) => { const r = ctx.resources.roles.find((x) => x.id === id); return r ? `@${r.name}` : id; };
/** A role's name in its server colour, for tables. */
const roleTag = (ctx, id) => {
  const r = ctx.resources.roles.find((x) => x.id === id);
  const tag = h('span', {}, r ? `@${r.name}` : id);
  tag.style.color = roleColor(r?.color) ?? '';
  return tag;
};
const roleTags = (ctx, ids, empty = '') => (ids.length ? ids.flatMap((id, n) => (n ? [', ', roleTag(ctx, id)] : [roleTag(ctx, id)])) : empty);

// ---------- Overview ----------
function activityChart(rows) {
  // Drawn narrower on phones, so labels stay readable instead of scaling down with a wide chart.
  const narrow = window.innerWidth < 600;
  const W = narrow ? 360 : 720; const H = narrow ? 200 : 190; const pad = { l: 34, r: 4, t: 8, b: 22 };
  const max = Math.max(1, ...rows.map((r) => r.messages));
  const top = max <= 5 ? 5 : Math.ceil(max / 10 ** Math.floor(Math.log10(max))) * 10 ** Math.floor(Math.log10(max));
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  const slot = (W - pad.l - pad.r) / rows.length;
  const barW = Math.min(26, slot - 2);
  const tip = h('div', { class: 'tooltip' });
  const wrap = h('div', { class: 'chart' });
  const short = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const showTip = (r, x) => {
    tip.replaceChildren(h('b', {}, r.messages.toLocaleString()), h('span', {}, `messages · ${short(r.date)}`), h('br'), h('span', {}, `${r.joins} joined · ${r.leaves} left`));
    const scale = wrap.clientWidth / W;
    tip.style.left = `${Math.min(wrap.clientWidth - 70, Math.max(70, x * scale))}px`;
    tip.style.top = '40px';
    tip.style.opacity = 1;
  };
  const hide = () => { tip.style.opacity = 0; };
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Messages per day for the last ${rows.length} days. Peak ${max.toLocaleString()}.` },
    [0, top / 2, top].map((v) => svg('g', {}, svg('line', { class: 'grid-line', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }), svg('text', { class: 'axis', x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, v >= 1000 ? `${v / 1000}k` : v))),
    rows.map((r, n) => {
      const x = pad.l + n * slot + (slot - barW) / 2;
      const by = y(r.messages);
      const bh = H - pad.b - by;
      const radius = Math.min(4, bh);
      const path = bh > 0 ? `M${x},${H - pad.b} V${by + radius} Q${x},${by} ${x + radius},${by} H${x + barW - radius} Q${x + barW},${by} ${x + barW},${by + radius} V${H - pad.b} Z` : '';
      const center = x + barW / 2;
      const col = svg('g', { class: 'col', tabindex: 0, role: 'img', 'aria-label': `${short(r.date)}: ${r.messages} messages` },
        svg('rect', { class: 'hit', x: pad.l + n * slot, y: pad.t, width: slot, height: H - pad.t - pad.b }),
        path ? svg('path', { class: 'bar', d: path }) : null,
        (narrow ? (rows.length - 1 - n) % 4 === 0 : n % 2 === 1) ? svg('text', { class: 'axis', x: center, y: H - 6, 'text-anchor': 'middle' }, short(r.date)) : null);
      col.addEventListener('mouseenter', () => showTip(r, center));
      col.addEventListener('focus', () => showTip(r, center));
      col.addEventListener('mouseleave', hide);
      col.addEventListener('blur', hide);
      return col;
    }));
  wrap.append(chart, tip);
  return wrap;
}

export async function overviewPage(ctx) {
  const root = h('div', {}, pageHead('Overview', 'A live view of your server.', h('span', { class: 'live' }, h('i'), 'Live')));
  const body = h('div');
  root.append(body);
  const tile = (label, value, hint) => h('div', { class: 'card tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), hint ? h('div', { class: 'hint' }, hint) : null);
  const render = (d) => {
    const secKind = d.status.security === 'enforce' ? 'good' : d.status.security === 'monitor' ? 'accent' : 'warn';
    const onOff = (on) => pill(on ? 'On' : 'Off', on ? 'good' : '');
    body.replaceChildren(
      d.status.locked ? h('div', { class: 'notice danger' }, 'This server is in emergency lockdown. Lift it from the Security page.') : '',
      h('div', { class: 'grid tiles' },
        tile('Server protection', d.status.locked ? 'Locked down' : d.status.security === 'enforce' ? 'Protected' : d.status.security === 'monitor' ? 'Monitoring' : 'Off', d.status.security === 'monitor' ? 'Logging threats only' : ''),
        tile('Attacks blocked', d.stats.attacksBlocked, 'Serious threats acted on, last 90 days'),
        tile('Active security modules', `${d.stats.activeModules} of ${d.stats.totalModules}`),
        tile('Total tickets', d.stats.totalTickets),
        tile('Members', d.guild.memberCount.toLocaleString(), `${d.guild.boosts} boosts`),
        tile('Suspicious events', d.stats.events24h, 'Last 24 hours'),
        tile('Moderation cases', d.stats.cases24h, 'Last 24 hours'),
        tile('Open tickets', d.stats.openTickets),
        tile('Active giveaways', d.stats.activeGiveaways),
        tile('Gateway ping', `${d.bot.ping} ms`, `Uptime ${fmtUptime(d.bot.uptimeMs)}`)),
      h('div', { class: 'grid two' },
        section('Messages per day', 'Last 14 days, in UTC.', activityChart(d.activity), h('details', { class: 'table-view' }, h('summary', {}, 'View as table'), h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Messages', 'Joins', 'Leaves'].map((t) => h('th', { scope: 'col' }, t)))), h('tbody', {}, d.activity.map((r) => h('tr', {}, h('td', {}, r.date), h('td', {}, r.messages), h('td', {}, r.joins), h('td', {}, r.leaves)))))))),
        section('Systems', null, h('div', { class: 'status-list' },
          h('div', {}, h('span', {}, 'Security'), pill(d.status.security === 'off' ? 'Off' : d.status.security === 'enforce' ? 'Enforcing' : 'Monitoring', secKind)),
          h('div', {}, h('span', {}, 'Logging'), onOff(d.status.logging)),
          h('div', {}, h('span', {}, 'Welcome'), onOff(d.status.welcome)),
          h('div', {}, h('span', {}, 'Tickets'), onOff(d.status.tickets)),
          h('div', {}, h('span', {}, 'Leveling'), onOff(d.status.levels))))),
      h('div', { class: 'card', style: 'margin-top:14px' }, h('h2', {}, 'Recent security events'), dataTable([
        { label: 'When', render: (e) => fmtAgo(e.at) },
        { label: 'Severity', render: (e) => pill(e.severity, e.severity === 'critical' ? 'bad' : e.severity === 'warning' ? 'warn' : 'accent') },
        { label: 'Event', render: (e) => e.type.replace(/_/g, ' ') },
        { label: 'Details', clip: true, render: (e) => e.summary },
      ], d.recentEvents, 'Nothing suspicious so far.')),
    );
  };
  render(await api(`/api/guilds/${ctx.guildId}/overview`));
  // Skip a refresh while someone is reading the chart or its table, so it does not change under them.
  const timer = setInterval(() => { if (!body.querySelector(".col:hover, .col:focus, details[open]")) api(`/api/guilds/${ctx.guildId}/overview`).then(render).catch(() => {}); }, 10_000);
  ctx.cleanups.push(() => clearInterval(timer));
  return root;
}

// ---------- Welcome ----------
export const welcomePage = (ctx) => configForm(ctx, 'welcome', (state, dirty) => {
  let editing = Math.max(0, state.templates.findIndex((t) => t.id === state.activeTemplate));
  const root = h('div');
  const tpl = (p) => [
    { path: `${p}.title`, label: 'Title', max: 256 },
    { path: `${p}.color`, label: 'Color', type: 'color' },
    { path: `${p}.description`, label: 'Description', type: 'textarea', wide: true, max: 4000, help: 'Variables: {user} {username} {server} {membercount} {avatar} {userid} {createdat} {joinposition}' },
    { path: `${p}.content`, label: 'Text above the embed', max: 2000 },
    { path: `${p}.footer`, label: 'Footer', max: 200 },
    { path: `${p}.card.enabled`, label: 'Attach a welcome image', type: 'toggle' },
    { path: `${p}.card.background`, label: 'Image background', help: `${ctx.resources.backgrounds.join(', ')}, or an HTTPS image URL` },
    { path: `${p}.card.accent`, label: 'Image accent', type: 'color' },
    { path: `${p}.card.headline`, label: 'Image headline', max: 80 },
    { path: `${p}.card.subline`, label: 'Image subline', max: 120 },
  ];
  const cardPreview = (id) => {
    const holder = h('div');
    const show = h('button', { class: 'btn small', type: 'button', onclick: () => {
      holder.replaceChildren(h('img', { class: 'card-preview', alt: `Preview of the ${id} image`, src: `/api/guilds/${ctx.guildId}/welcome/card/${encodeURIComponent(id)}?t=${Date.now()}`, onerror: () => toast('Save this template first, then preview it.', 'err') }));
    } }, 'Preview image');
    return h('div', { class: 'stack' }, h('div', { class: 'row' }, show, h('span', { class: 'hint-text' }, 'Shows the last saved version.')), holder);
  };
  const addTemplate = async () => {
    const form = { name: '' };
    const made = await modal('New template', () => ({
      node: fieldGrid([{ path: 'name', label: 'Name', max: 32, help: 'Letters, numbers and dashes' }], form, ctx),
      submit: () => {
        const id = form.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
        if (!id) throw new Error('Give the template a name.');
        if (state.templates.some((t) => t.id === id)) throw new Error('That name is already used.');
        state.templates.push({ ...structuredClone(state.templates[editing]), id });
        editing = state.templates.length - 1;
        return true;
      },
    }), { submitLabel: 'Create' });
    if (made) { dirty(); render(); }
  };
  const removeTemplate = () => {
    const [gone] = state.templates.splice(editing, 1);
    if (state.activeTemplate === gone.id) state.activeTemplate = state.templates[0].id;
    editing = 0;
    dirty();
    render();
  };
  const render = () => {
    const current = state.templates[editing];
    root.replaceChildren(pageHead('Welcome', 'Greet new members and say goodbye.'),
      section('Welcome messages', null, fieldGrid([
        { path: 'enabled', label: 'Enabled', type: 'toggle' },
        { path: 'channelId', label: 'Channel', type: 'channel' },
        { path: 'activeTemplate', label: 'Template in use', type: 'select', options: state.templates.map((t) => ({ value: t.id, label: t.id })) },
      ], state, ctx, dirty)),
      section('Templates', 'Build as many as you like, and choose which one is in use above.',
        h('div', { class: 'row', style: 'margin-bottom:14px' },
          h('select', { 'aria-label': 'Template to edit', style: 'width:auto;min-width:160px', onchange: (e) => { editing = Number(e.target.value); render(); } }, state.templates.map((t, n) => h('option', { value: n, selected: n === editing }, t.id))),
          h('button', { class: 'btn small', type: 'button', disabled: state.templates.length >= 15, onclick: addTemplate }, 'New template'),
          h('button', { class: 'btn small danger', type: 'button', disabled: state.templates.length <= 1, onclick: removeTemplate }, 'Delete')),
        fieldGrid(tpl(`templates.${editing}`), state, ctx, dirty), cardPreview(current.id)),
      section('Goodbye messages', null, fieldGrid([
        { path: 'goodbyeEnabled', label: 'Enabled', type: 'toggle' },
        { path: 'goodbyeChannelId', label: 'Channel', type: 'channel', placeholder: 'Same as welcome' },
        ...tpl('goodbye'),
      ], state, ctx, dirty), cardPreview('goodbye')),
      section('Direct message', 'Sent privately to each new member.', fieldGrid([
        { path: 'dmEnabled', label: 'Enabled', type: 'toggle' },
        { path: 'dmMessage', label: 'Message', type: 'textarea', wide: true, max: 2000 },
      ], state, ctx, dirty)));
  };
  render();
  return root;
});

// ---------- Security ----------
export const securityPage = (ctx) => configForm(ctx, 'security', async (state, dirty) => {
  const [events, overview] = await Promise.all([api(`/api/guilds/${ctx.guildId}/security/events`), api(`/api/guilds/${ctx.guildId}/overview`)]);
  const trusted = overview.access.isTrusted;
  const lockBtn = h('button', { class: overview.status.locked ? 'btn primary' : 'btn danger', disabled: !trusted }, overview.status.locked ? 'Lift lockdown' : 'Engage lockdown');
  lockBtn.addEventListener('click', guard(lockBtn, async () => {
    const on = !overview.status.locked;
    const ok = await confirmDialog(on ? 'Engage emergency lockdown?' : 'Lift lockdown?', on ? 'Every channel will be locked for @everyone and invites will be paused. Previous permissions are saved and restored when you lift it.' : 'Each channel returns to the permissions it had before the lockdown.', on ? 'Engage lockdown' : 'Lift lockdown');
    if (!ok) return;
    const r = await api(`/api/guilds/${ctx.guildId}/security/lockdown`, { method: 'POST', body: { on, reason: 'Started from the dashboard' } });
    toast(`${on ? 'Locked' : 'Restored'} ${r.changed} channels${r.failed ? `, ${r.failed} failed` : ''}.`);
    ctx.rerender();
  }));
  return h('div', {}, pageHead('Security', 'Stop raids, nukes and scams before they spread.', lockBtn),
    trusted ? null : h('div', { class: 'notice' }, 'You can view these settings, but only the server owner or a trusted admin can change them.'),
    state.mode === 'monitor' && state.enabled ? h('div', { class: 'notice' }, 'Monitor mode: threats are logged but nothing is punished. Review the events below, whitelist your trusted bots and staff, then switch to Enforce.') : null,
    section('Protection status', null, fieldGrid([
      { path: 'enabled', label: 'Security enabled', type: 'toggle' },
      { path: 'mode', label: 'Mode', type: 'select', options: [{ value: 'monitor', label: 'Monitor: log only' }, { value: 'enforce', label: 'Enforce: act automatically' }] },
      { path: 'logChannelId', label: 'Security log channel', type: 'channel' },
    ], state, ctx, dirty)),
    h('div', { class: 'notice' }, 'Anti-Nuke, Anti-Raid and Anti-Webhook settings are now in the Premium menu.'),
    h('div', { class: 'grid two', style: 'margin-top:14px' },
      section('Spam and mentions', null, fieldGrid([
        { path: 'antiSpam.enabled', label: 'Anti-spam', type: 'toggle' },
        { path: 'antiMention.enabled', label: 'Anti-mass mention', type: 'toggle' },
        { path: 'antiSpam.maxMessages', label: 'Max messages', type: 'number', min: 2, max: 60 },
        { path: 'antiSpam.windowSec', label: 'In seconds', type: 'number', min: 1, max: 120 },
        { path: 'antiSpam.maxDuplicates', label: 'Max duplicates', type: 'number', min: 2, max: 30 },
        { path: 'antiMention.maxMentions', label: 'Max mentions', type: 'number', min: 1, max: 100 },
        { path: 'antiMention.blockEveryone', label: 'Block @everyone attempts', type: 'toggle' },
      ], state, ctx, dirty)),
      section('Links', null, fieldGrid([
        { path: 'antiLinks.scam', label: 'Scam links', type: 'toggle' },
        { path: 'antiLinks.phishing', label: 'Phishing links', type: 'toggle' },
        { path: 'antiLinks.invites', label: 'Block server invites', type: 'toggle' },
        { path: 'antiLinks.allowedDomains', label: 'Allowed domains', type: 'list', wide: true, placeholder: 'example.com' },
        { path: 'antiLinks.blockedDomains', label: 'Blocked domains', type: 'list', wide: true, placeholder: 'example.com' },
      ], state, ctx, dirty))),
    section('Access and exemptions', 'Whitelisted people and roles are ignored by anti-nuke and automod.', fieldGrid([
      { path: 'whitelistRoles', label: 'Whitelisted roles', type: 'roles' },
      { path: 'exemptChannels', label: 'Exempt channels', type: 'channels' },
      { path: 'whitelistUsers', label: 'Whitelisted user IDs', type: 'list', placeholder: 'User ID' },
      { path: 'trustedAdmins', label: 'Trusted admin IDs', type: 'list', placeholder: 'User ID', help: 'Only the server owner can change this' },
      { path: 'automod.bannedWords', label: 'Banned words', type: 'list', wide: true },
      { path: 'automod.maxCapsPercent', label: 'Caps limit % (0 = off)', type: 'number', min: 0, max: 100 },
    ], state, ctx, dirty)),
    section('Security events', null, dataTable([
      { label: 'When', render: (e) => fmtDate(e.createdAt) },
      { label: 'Severity', render: (e) => pill(e.severity, e.severity === 'critical' ? 'bad' : e.severity === 'warning' ? 'warn' : 'accent') },
      { label: 'Event', render: (e) => `${e.type.replace(/_/g, ' ')}${e.monitorOnly ? ' (monitor)' : ''}` },
      { label: 'Details', clip: true, render: (e) => e.summary.split('\n')[0] },
      { label: 'Response', clip: true, render: (e) => e.action ?? '' },
    ], events, 'Nothing suspicious so far.')));
});

// ---------- Moderation ----------
export const moderationPage = (ctx) => configForm(ctx, 'moderation', async (state, dirty) => {
  const list = h('div');
  const filter = { type: '', user: '', page: 0 };
  const load = guard(null, async () => {
    const q = new URLSearchParams({ page: filter.page, ...(filter.type ? { type: filter.type } : {}), ...(/^\d{17,20}$/.test(filter.user) ? { user: filter.user } : {}) });
    const r = await api(`/api/guilds/${ctx.guildId}/cases?${q}`);
    list.replaceChildren(dataTable([
      { label: '#', render: (c) => c.number },
      { label: 'Action', render: (c) => pill(c.type, ['ban', 'tempban', 'kick'].includes(c.type) ? 'bad' : ['warn', 'timeout', 'jail', 'automod'].includes(c.type) ? 'warn' : 'accent') },
      { label: 'Target', render: (c) => c.targetTag },
      { label: 'Moderator', render: (c) => c.moderatorTag },
      { label: 'Reason', clip: true, render: (c) => c.reason },
      { label: 'When', render: (c) => fmtDate(c.createdAt) },
    ], r.items, 'No cases match.'), r.total > 25 ? h('div', { class: 'row', style: 'margin-top:26px' },
      h('button', { class: 'btn small', disabled: r.page === 0, onclick: () => { filter.page--; load(); } }, 'Newer'),
      h('span', { class: 'help' }, `Page ${r.page + 1} of ${Math.ceil(r.total / 25)}`),
      h('button', { class: 'btn small', disabled: (r.page + 1) * 25 >= r.total, onclick: () => { filter.page++; load(); } }, 'Older')) : null);
  });
  await load();
  return h('div', {}, pageHead('Moderation', 'Your case history and moderation settings.'),
    section('Settings', null, fieldGrid([
      { path: 'modLogChannelId', label: 'Moderation log channel', type: 'channel' },
      { path: 'dmOnAction', label: 'DM members about actions', type: 'toggle' },
      { path: 'jailRoleId', label: 'Jail role', type: 'role', help: 'Run /modconfig jail-setup to apply it to every channel' },
    ], state, ctx, dirty)),
    h('section', { class: 'card' }, h('h2', {}, 'Case history'), h('div', { class: 'row', style: 'margin:12px 0' },
      h('select', { 'aria-label': 'Filter by action', style: 'max-width:180px', onchange: (e) => { filter.type = e.target.value; filter.page = 0; load(); } }, ['', 'ban', 'tempban', 'unban', 'kick', 'timeout', 'warn', 'jail', 'automod', 'purge'].map((t) => h('option', { value: t }, t || 'All actions'))),
      h('input', { type: 'text', style: 'max-width:240px', placeholder: 'Filter by user ID', 'aria-label': 'Filter by user ID', onchange: (e) => { filter.user = e.target.value.trim(); filter.page = 0; load(); } })), list));
});

// ---------- Logging ----------
const LOG_CATEGORIES = [['message', 'Messages', 'Deleted and edited messages'], ['member', 'Members', 'Joins, leaves, role and nickname changes'], ['role', 'Roles', 'Created, deleted and updated'], ['channel', 'Channels', 'Created, deleted and updated'], ['voice', 'Voice', 'Join, leave, move'], ['ban', 'Bans', 'Bans and unbans'], ['moderation', 'Moderation', 'Actions taken through ZYTHERON'], ['invite', 'Invites', 'New invites'], ['webhook', 'Webhooks', 'Created, changed, removed'], ['server', 'Server', 'Server setting changes'], ['security', 'Security', 'Used when no security channel is set']];

export const loggingPage = (ctx) => configForm(ctx, 'logging', (state, saveBarDirty) => {
  const notice = h('div', { class: 'notice' });
  const refreshNotice = () => {
    const hasRoute = Object.values(state.channels).some(Boolean);
    const text = !state.enabled
      ? 'Logging is off, so nothing is being posted. Turn on Logging enabled, then save.'
      : !state.defaultChannelId && !hasRoute ? 'No channel is set, so nothing is being posted. Choose a default log channel, then save.'
        : !state.defaultChannelId ? 'Events without their own channel are not posted. Choose a default log channel to catch them.' : '';
    notice.textContent = text;
    notice.hidden = !text;
  };
  let chosen = JSON.stringify([state.defaultChannelId, state.channels]);
  const dirty = () => {
    // Choosing a channel means logs are wanted, so a switched-off main setting must not silently block them.
    const now = JSON.stringify([state.defaultChannelId, state.channels]);
    if (now !== chosen) {
      chosen = now;
      if (!state.enabled && (state.defaultChannelId || Object.values(state.channels).some(Boolean))) {
        state.enabled = true;
        const main = enabledToggle.querySelector('input[type=checkbox]');
        if (main) main.checked = true;
      }
    }
    refreshNotice();
    saveBarDirty();
  };
  refreshNotice();
  const rows = LOG_CATEGORIES.map(([key, label, help]) => {
    const on = h('input', { type: 'checkbox', checked: !state.disabled.includes(key), onchange: (e) => { state.disabled = e.target.checked ? state.disabled.filter((c) => c !== key) : [...state.disabled, key]; dirty(); } });
    const pick = h('select', { 'aria-label': `${label} channel`, onchange: (e) => { if (e.target.value) state.channels[key] = e.target.value; else delete state.channels[key]; dirty(); } },
      h('option', { value: '' }, 'Default channel'),
      ctx.resources.channels.filter((c) => c.type === 'text').map((c) => h('option', { value: c.id, selected: state.channels[key] === c.id }, `# ${c.name}`)));
    return h('div', { class: 'fields sub-item' }, h('label', { class: 'toggle' }, h('span', { class: 't' }, label, h('span', { class: 'help' }, help)), on, h('span', { class: 'sw' })), pick);
  });
  const enabledToggle = fieldGrid([{ path: 'enabled', label: 'Logging enabled', type: 'toggle' }], state, ctx, dirty);
  return h('div', {}, pageHead('Logging', 'A clean audit trail for everything that happens.'), notice,
    section('General', 'ZYTHERON needs View Audit Log to report who made each change.', enabledToggle, fieldGrid([
      { path: 'defaultChannelId', label: 'Default log channel', type: 'channel' },
      { path: 'ignoredChannels', label: 'Ignored channels', type: 'channels', wide: true, kinds: ['text', 'voice', 'announcement'], help: 'Message and voice events here are not logged' },
    ], state, ctx, dirty)),
    section('Categories', null, rows));
});

// ---------- Auto roles ----------
export const rolesPage = (ctx) => configForm(ctx, 'roles', (state, dirty) => {
  return h('div', {}, pageHead('Auto Roles', 'Roles given automatically, and roles members choose.'),
    h('div', { class: 'notice' }, 'Roles with moderator or admin permissions are never handed out automatically, whatever is configured here.'),
    section('Automatic roles', 'Given as soon as someone joins.', fieldGrid([
      { path: 'humanRoles', label: 'For people', type: 'roles' },
      { path: 'botRoles', label: 'For bots', type: 'roles' },
    ], state, ctx, dirty)),
    section('Self roles', 'Members can pick these with /selfrole get.', fieldGrid([{ path: 'selfRoles', label: 'Self-assignable roles', type: 'roles', wide: true }], state, ctx, dirty)),
    crudSection(ctx, ROLE_PANELS(ctx)));
});

// ---------- Tickets ----------
export const ticketsPage = (ctx) => configForm(ctx, 'tickets', async (state, dirty) => {
  const { tickets, stats } = await api(`/api/guilds/${ctx.guildId}/tickets`);
  const statTile = (label, value) => h('div', { class: 'card tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));
  const act = (t, action, label, extra = {}) => guard(null, async () => {
    await api(`/api/guilds/${ctx.guildId}/tickets/${t._id}/action`, { method: 'POST', body: { action, ...extra } });
    toast(`${label}.`);
    ctx.rerender();
  })();
  const close = async (t) => { if (await confirmDialog(`Close ticket #${t.number}?`, 'A transcript will be saved, and the member will no longer see the channel.', 'Close ticket')) act(t, 'close', 'Ticket closed'); };
  const withMember = async (t, action, title, label) => {
    const form = { userId: '' };
    const ok = await modal(title, () => ({ node: fieldGrid([{ path: 'userId', label: 'User ID', max: 20, help: 'Right-click the person in Discord, then Copy User ID' }], form, ctx), submit: () => { if (!/^\d{17,20}$/.test(form.userId.trim())) throw new Error('Enter a valid user ID.'); return true; } }));
    if (ok) act(t, action, label, { userId: form.userId.trim() });
  };
  return h('div', {}, pageHead('Advanced Ticket System', 'Private support channels with transcripts and ratings.'),
    h('div', { class: 'grid tiles' }, statTile('Open tickets', stats.open), statTile('Unclaimed', stats.unclaimed), statTile('Closed', stats.closed), statTile('Total', stats.total), statTile('Average rating', stats.averageRating === null ? 'None yet' : `${stats.averageRating.toFixed(1)} / 5`)),
    section('Settings', null, fieldGrid([
      { path: 'enabled', label: 'Tickets enabled', type: 'toggle' },
      { path: 'ratingsEnabled', label: 'Ask for a rating after closing', type: 'toggle' },
      { path: 'staffRoleIds', label: 'Staff roles', type: 'roles' },
      { path: 'parentCategoryId', label: 'Discord category for tickets', type: 'channel', kinds: ['category'] },
      { path: 'transcriptChannelId', label: 'Transcript channel', type: 'channel' },
      { path: 'notifyChannelId', label: 'Staff notification channel', type: 'channel' },
      { path: 'maxOpenPerUser', label: 'Open tickets per member', type: 'number', min: 1, max: 10 },
      { path: 'color', label: 'Embed color', type: 'color' },
      { path: 'channelName', label: 'Ticket channel name', max: 60, help: 'Variables: {number} {username}' },
      { path: 'autoCloseHours', label: 'Auto close after (hours without messages)', type: 'number', min: 0, max: 720, help: '0 means never' },
      { path: 'transcriptFormat', label: 'Transcript format', type: 'select', options: [{ value: 'html', label: 'Web page (HTML)' }, { value: 'text', label: 'Plain text' }] },
      { path: 'welcomeMessage', label: 'First message', type: 'textarea', wide: true, max: 2000, help: 'Variables: {user} {username} {server}' },
    ], state, ctx, dirty)),
    crudSection(ctx, TICKET_PANELS(ctx)),
    section('Recent tickets', null, dataTable([
      { label: '#', render: (t) => t.number },
      { label: 'Status', render: (t) => pill(t.status, t.status === 'open' ? 'good' : '') },
      { label: 'Member', render: (t) => t.ownerTag },
      { label: 'Category', render: (t) => t.categoryLabel ?? '' },
      { label: 'Subject', clip: true, render: (t) => t.subject },
      { label: 'Rating', render: (t) => (t.rating ? '★'.repeat(t.rating) : '') },
      { label: 'Opened', render: (t) => fmtDate(t.createdAt) },
      { label: 'Assigned', render: (t) => (t.claimedBy ? 'Yes' : '') },
      { label: '', render: (t) => (t.status === 'deleted' ? '' : h('div', { class: 'row actions' },
        t.status === 'open' ? [
          h('button', { class: 'btn small', onclick: () => withMember(t, 'assign', 'Assign to staff', 'Ticket assigned') }, 'Assign'),
          h('button', { class: 'btn small', onclick: () => withMember(t, 'add', 'Add a member', 'Member added') }, 'Add'),
          h('button', { class: 'btn small', onclick: () => withMember(t, 'remove', 'Remove a member', 'Member removed') }, 'Remove'),
          h('button', { class: 'btn small danger', onclick: () => close(t) }, 'Close'),
        ] : h('button', { class: 'btn small', onclick: () => act(t, 'reopen', 'Ticket reopened') }, 'Reopen'))) },
    ], tickets, 'No tickets yet.')));
});

// ---------- Generic CRUD ----------
function crudSection(ctx, cfg) {
  const holder = h('div');
  const load = guard(null, async () => {
    const items = await api(`/api/guilds/${ctx.guildId}/${cfg.path}`);
    holder.replaceChildren(dataTable([...cfg.columns, { label: '', render: (item) => h('div', { class: 'row actions' },
      cfg.actions?.(item, load),
      h('button', { class: 'btn small', onclick: () => edit(item) }, 'Edit'),
      h('button', { class: 'btn small danger', onclick: () => remove(item) }, 'Delete')) }], items, cfg.empty));
  });
  const edit = async (item) => {
    const state = cfg.toForm(item ?? null);
    const saved = await modal(item ? `Edit ${cfg.noun}` : `New ${cfg.noun}`, () => ({
      node: fieldGrid(cfg.fields(state), state, ctx),
      submit: () => api(`/api/guilds/${ctx.guildId}/${cfg.path}${item ? `/${item._id}` : ''}`, { method: item ? 'PUT' : 'POST', body: cfg.toBody(state) }),
    }));
    if (saved) { toast('Saved.'); load(); }
  };
  const remove = async (item) => {
    if (!(await confirmDialog(`Delete ${cfg.noun}?`, 'This cannot be undone.', 'Delete'))) return;
    await guard(null, () => api(`/api/guilds/${ctx.guildId}/${cfg.path}/${item._id}`, { method: 'DELETE' }))();
    load();
  };
  load();
  return section(cfg.title, cfg.sub, h('div', { class: 'row', style: 'margin-bottom:12px' }, h('button', { class: 'btn primary small', onclick: () => edit(null) }, `Add ${cfg.noun}`)), holder);
}

/** Asks for a channel, then has the bot post the panel there. */
function postButton(ctx, path, item, reload) {
  const posted = Boolean(item.messageId);
  return h('button', { class: 'btn small primary', onclick: async () => {
    const form = { channelId: item.channelId ?? null };
    const done = await modal(posted ? 'Update the posted panel' : 'Post this panel', () => ({
      node: fieldGrid([{ path: 'channelId', label: 'Channel', type: 'channel', placeholder: 'Choose a channel' }], form, ctx),
      submit: () => {
        if (!form.channelId) throw new Error('Choose a channel.');
        return api(`/api/guilds/${ctx.guildId}/${path}/${item._id}/publish`, { method: 'POST', body: { channelId: form.channelId } });
      },
    }), { submitLabel: posted ? 'Update' : 'Post' });
    if (done) { toast('Panel posted in Discord.'); reload(); }
  } }, posted ? 'Update post' : 'Post');
}

const panelLocation = (ctx, p) => (p.messageId ? channelName(ctx, p.channelId) : 'Not posted');
const COLOR_FIELD = { path: 'color', label: 'Color', type: 'color' };

const ROLE_PANELS = (ctx) => ({
  title: 'Role panels', sub: 'Messages where members pick their own roles. Create one, then post it.', noun: 'role panel', path: 'rolepanels', empty: 'No panels yet.',
  actions: (item, reload) => postButton(ctx, 'rolepanels', item, reload),
  columns: [
    { label: 'Name', render: (p) => p.name },
    { label: 'Type', render: (p) => pill(p.kind, 'accent') },
    { label: 'Roles', clip: true, render: (p) => roleTags(ctx, p.items.map((x) => x.roleId)) },
    { label: 'Channel', render: (p) => panelLocation(ctx, p) },
  ],
  toForm: (p) => ({
    name: p?.name ?? '', kind: p?.kind ?? 'button', behavior: p?.behavior ?? 'toggle', title: p?.title ?? 'Pick your roles', description: p?.description ?? 'Choose below.', color: p?.color ?? '#7c3aed',
    tempMinutes: p?.tempMinutes ?? null, requiredRoleId: p?.requiredRoleId ?? null, roles: p?.items.map((x) => x.roleId) ?? [], emojis: p?.items.map((x) => x.emoji ?? '-').join(' ') ?? '', existing: p?.items ?? [],
  }),
  toBody: (s) => {
    const emojis = s.emojis.trim().split(/\s+/);
    return {
      name: s.name, kind: s.kind, behavior: s.behavior, title: s.title, description: s.description, color: s.color, tempMinutes: s.tempMinutes, requiredRoleId: s.requiredRoleId,
      items: s.roles.map((roleId, n) => {
        const before = s.existing.find((x) => x.roleId === roleId);
        const emoji = emojis[n] && emojis[n] !== '-' ? emojis[n] : null;
        return { roleId, label: before?.label, description: before?.description ?? null, emoji };
      }),
    };
  },
  fields: () => [
    { path: 'name', label: 'Name', max: 40, help: 'Only you see this' },
    { path: 'kind', label: 'Type', type: 'select', options: [{ value: 'button', label: 'Buttons' }, { value: 'select', label: 'Select menu' }, { value: 'reaction', label: 'Reactions' }] },
    { path: 'title', label: 'Title', max: 200 },
    { path: 'behavior', label: 'Behavior', type: 'select', options: [{ value: 'toggle', label: 'Toggle' }, { value: 'unique', label: 'One role only' }, { value: 'add_only', label: 'Add only' }, { value: 'remove_only', label: 'Remove only' }] },
    { path: 'description', label: 'Description', type: 'textarea', wide: true, max: 1500 },
    { path: 'roles', label: 'Roles', type: 'roles', wide: true },
    { path: 'emojis', label: 'Emojis, in the same order', wide: true, help: 'Separate with spaces, and use - to skip one. Reaction panels need one for every role.' },
    COLOR_FIELD,
    { path: 'tempMinutes', label: 'Roles expire after (minutes)', type: 'number', min: 1, help: 'Empty keeps them' },
    { path: 'requiredRoleId', label: 'Only members with this role', type: 'role', placeholder: 'Everyone' },
  ],
});

const TICKET_PANELS = (ctx) => ({
  title: 'Ticket panels', sub: 'Messages where members open a ticket. Create one, then post it.', noun: 'ticket panel', path: 'ticketpanels', empty: 'No panels yet.',
  actions: (item, reload) => postButton(ctx, 'ticketpanels', item, reload),
  columns: [
    { label: 'Name', render: (p) => p.name },
    { label: 'Style', render: (p) => pill(p.style, 'accent') },
    { label: 'Categories', clip: true, render: (p) => p.categories.map((c) => c.label).join(', ') },
    { label: 'Channel', render: (p) => panelLocation(ctx, p) },
  ],
  toForm: (p) => ({ name: p?.name ?? '', title: p?.title ?? 'Need help?', description: p?.description ?? 'Open a ticket and our team will help you privately.', style: p?.style ?? 'buttons', color: p?.color ?? '#7c3aed', labels: p?.categories.map((c) => c.label) ?? [], existing: p?.categories ?? [], questions: p?.categories[0]?.questions ?? [] }),
  toBody: (s) => ({
    name: s.name, title: s.title, description: s.description, style: s.style, color: s.color,
    categories: s.labels.map((label) => ({ ...(s.existing.find((c) => c.label === label) ?? { label }), questions: s.questions })),
  }),
  fields: () => [
    { path: 'name', label: 'Name', max: 40, help: 'Only you see this' },
    { path: 'style', label: 'Style', type: 'select', options: [{ value: 'buttons', label: 'Buttons' }, { value: 'select', label: 'Select menu' }] },
    { path: 'title', label: 'Title', max: 200 },
    COLOR_FIELD,
    { path: 'description', label: 'Description', type: 'textarea', wide: true, max: 1500 },
    { path: 'labels', label: 'Categories', type: 'list', wide: true, placeholder: 'Billing, then press Enter', help: 'One button or menu option each' },
    { path: 'questions', label: 'Custom questions', type: 'list', wide: true, placeholder: 'What is your order number? then press Enter', help: 'Asked when someone opens a ticket from this panel. Up to 5, each up to 45 characters. Empty asks: How can we help?' },
  ],
});

const AUTO_RESPONSES = {
  title: 'Auto responses', sub: 'Reply automatically when a message matches.', noun: 'auto response', path: 'autoresponses', empty: 'None yet.',
  columns: [
    { label: 'Trigger', clip: true, render: (a) => a.trigger }, { label: 'Match', render: (a) => pill(a.matchType, 'accent') },
    { label: 'Response', clip: true, render: (a) => a.response }, { label: 'State', render: (a) => pill(a.enabled ? 'On' : 'Off', a.enabled ? 'good' : '') },
  ],
  toForm: (a) => a ? { trigger: a.trigger, matchType: a.matchType, response: a.response, channels: a.channels, cooldownSec: a.cooldownSec, deleteTrigger: a.deleteTrigger, enabled: a.enabled } : { trigger: '', matchType: 'contains', response: '', channels: [], cooldownSec: 10, deleteTrigger: false, enabled: true },
  toBody: (s) => s,
  fields: () => [
    { path: 'trigger', label: 'Trigger', max: 200 },
    { path: 'matchType', label: 'Match type', type: 'select', options: [['contains', 'Contains'], ['word', 'Whole word'], ['exact', 'Exact message'], ['startsWith', 'Starts with'], ['regex', 'Regex']].map(([value, label]) => ({ value, label })) },
    { path: 'response', label: 'Response', type: 'textarea', wide: true, max: 2000, help: 'Variables: {user} {username} {server} {channel}' },
    { path: 'channels', label: 'Only in channels', type: 'channels', wide: true },
    { path: 'cooldownSec', label: 'Cooldown (seconds)', type: 'number', min: 0, max: 3600 },
    { path: 'deleteTrigger', label: 'Delete the trigger message', type: 'toggle' },
    { path: 'enabled', label: 'Enabled', type: 'toggle' },
  ],
};

const SCHEDULES = (ctx) => ({
  title: 'Scheduled messages', sub: 'Recurring messages and announcements.', noun: 'schedule', path: 'schedules', empty: 'None yet.',
  columns: [
    { label: 'Name', render: (s) => s.name }, { label: 'Channel', render: (s) => channelName(ctx, s.channelId) }, { label: 'Schedule', render: (s) => s.cron ?? 'Once' },
    { label: 'Next run', render: (s) => (s.nextRunAt ? fmtDate(s.nextRunAt) : 'Done') }, { label: 'State', render: (s) => pill(s.enabled ? 'On' : 'Paused', s.enabled ? 'good' : '') },
  ],
  toForm: (s) => s ? { name: s.name, channelId: s.channelId, cron: s.cron ?? '', timezone: s.timezone, content: s.content, templateName: s.templateName ?? null, enabled: s.enabled } : { name: '', channelId: null, cron: '0 9 * * 1', timezone: 'UTC', content: '', templateName: null, enabled: true },
  toBody: (s) => s,
  fields: () => [
    { path: 'name', label: 'Name', max: 40 },
    { path: 'channelId', label: 'Channel', type: 'channel', placeholder: 'Choose a channel' },
    { path: 'cron', label: 'Cron schedule', help: '0 9 * * 1 means Mondays at 09:00. Five minutes minimum.' },
    { path: 'timezone', label: 'Timezone', help: 'For example Europe/Paris' },
    { path: 'content', label: 'Message', type: 'textarea', wide: true, max: 2000 },
    { path: 'templateName', label: 'Or an embed template name', max: 40 },
    { path: 'enabled', label: 'Enabled', type: 'toggle' },
  ],
});

const ACTION_OPTIONS = [['reply', 'Reply'], ['send_channel', 'Send to a channel'], ['dm', 'DM the member'], ['add_role', 'Add a role'], ['remove_role', 'Remove a role'], ['delete_message', 'Delete the message'], ['timeout', 'Timeout'], ['log', 'Write to the log']].map(([value, label]) => ({ value, label }));

const RULES = (ctx) => ({
  title: 'Automation rules', sub: 'When a trigger happens, run an action.', noun: 'rule', path: 'rules', empty: 'None yet.',
  columns: [
    { label: 'Name', render: (r) => r.name }, { label: 'Trigger', clip: true, render: (r) => `${r.trigger.type.replace('_', ' ')}${r.trigger.value ? `: ${r.trigger.type === 'role_added' ? roleName(ctx, r.trigger.value) : r.trigger.value}` : ''}` },
    { label: 'Actions', clip: true, render: (r) => r.actions.map((a) => a.type.replace('_', ' ')).join(', ') }, { label: 'Runs', render: (r) => r.runs }, { label: 'State', render: (r) => pill(r.enabled ? 'On' : 'Off', r.enabled ? 'good' : '') },
  ],
  toForm: (r) => {
    const a = r?.actions?.[0] ?? {};
    const isRole = a.type === 'add_role' || a.type === 'remove_role';
    return { name: r?.name ?? '', triggerType: r?.trigger.type ?? 'keyword', triggerValue: r?.trigger.type === 'role_added' ? '' : r?.trigger.value ?? '', triggerRole: r?.trigger.type === 'role_added' ? r.trigger.value : null, actionType: a.type ?? 'reply', text: isRole ? '' : a.value ?? '', role: isRole ? a.value : null, channelId: a.channelId ?? null, minutes: a.minutes ?? 5, cooldownSec: r?.cooldownSec ?? 5, enabled: r?.enabled ?? true, rest: r?.actions?.slice(1) ?? [] };
  },
  toBody: (s) => ({
    name: s.name, enabled: s.enabled, cooldownSec: s.cooldownSec,
    trigger: { type: s.triggerType, value: s.triggerType === 'role_added' ? s.triggerRole ?? undefined : s.triggerType === 'member_join' ? undefined : s.triggerValue },
    actions: [{ type: s.actionType, value: ['add_role', 'remove_role'].includes(s.actionType) ? s.role ?? undefined : s.text || undefined, channelId: s.actionType === 'send_channel' ? s.channelId ?? undefined : undefined, minutes: s.actionType === 'timeout' ? s.minutes : undefined }, ...s.rest],
  }),
  fields: () => [
    { path: 'name', label: 'Name', max: 40, wide: true },
    { path: 'triggerType', label: 'When', type: 'select', options: [['keyword', 'Message has keyword'], ['regex', 'Message matches regex'], ['member_join', 'Member joins'], ['role_added', 'Member receives a role']].map(([value, label]) => ({ value, label })) },
    { path: 'triggerValue', label: 'Keyword or regex', max: 200 },
    { path: 'triggerRole', label: 'Role (for role received)', type: 'role' },
    { path: 'actionType', label: 'Then', type: 'select', options: ACTION_OPTIONS },
    { path: 'text', label: 'Text', type: 'textarea', wide: true, max: 1900 },
    { path: 'role', label: 'Role to add or remove', type: 'role' },
    { path: 'channelId', label: 'Channel to send to', type: 'channel' },
    { path: 'minutes', label: 'Timeout minutes', type: 'number', min: 1, max: 40320 },
    { path: 'cooldownSec', label: 'Cooldown (seconds)', type: 'number', min: 0, max: 3600 },
    { path: 'enabled', label: 'Enabled', type: 'toggle' },
  ],
});

export async function automationPage(ctx) {
  return h('div', {}, pageHead('Automation', 'Let ZYTHERON handle the repetitive work.'), crudSection(ctx, AUTO_RESPONSES), crudSection(ctx, RULES(ctx)), crudSection(ctx, SCHEDULES(ctx)));
}

export const commandsPage = (ctx) => configForm(ctx, 'automation', (state, dirty) => h('div', {}, pageHead('Custom Commands', 'Your own text commands, also available through /cc run.'),
  section('Prefix', null, fieldGrid([{ path: 'customCommandPrefix', label: 'Text prefix', max: 5 }], state, ctx, dirty)),
  crudSection(ctx, {
    title: 'Commands', noun: 'command', path: 'commands', empty: 'None yet.',
    columns: [
      { label: 'Command', render: (c) => `${state.customCommandPrefix}${c.name}` }, { label: 'Response', clip: true, render: (c) => c.templateName ? `Template: ${c.templateName}` : c.response },
      { label: 'Limited to', clip: true, render: (c) => roleTags(ctx, c.allowedRoles, 'Everyone') }, { label: 'Uses', render: (c) => c.uses },
    ],
    toForm: (c) => c ? { name: c.name, response: c.response, templateName: c.templateName ?? null, allowedRoles: c.allowedRoles } : { name: '', response: '', templateName: null, allowedRoles: [] },
    toBody: (s) => s,
    fields: () => [
      { path: 'name', label: 'Name', max: 32, help: 'Lowercase letters, numbers, dashes and underscores' },
      { path: 'templateName', label: 'Or an embed template name', max: 40 },
      { path: 'response', label: 'Response', type: 'textarea', wide: true, max: 2000, help: 'Variables: {user} {username} {server} {channel}' },
      { path: 'allowedRoles', label: 'Limit to roles', type: 'roles', wide: true },
    ],
  })));

// ---------- Server settings ----------
export const settingsPage = (ctx) => configForm(ctx, 'community', (state, dirty) => h('div', {}, pageHead('Server Settings', 'Community features for your members.'),
  section('Leveling', 'Members earn XP for chatting.', fieldGrid([
    { path: 'levels.enabled', label: 'Enabled', type: 'toggle' },
    { path: 'levels.announce', label: 'Announce level ups', type: 'toggle' },
    { path: 'levels.announceChannelId', label: 'Announcement channel', type: 'channel', placeholder: 'Where it happened' },
    { path: 'levels.xpMin', label: 'Minimum XP per message', type: 'number', min: 1, max: 500 },
    { path: 'levels.xpMax', label: 'Maximum XP per message', type: 'number', min: 1, max: 1000 },
    { path: 'levels.cooldownSec', label: 'Cooldown (seconds)', type: 'number', min: 0, max: 3600 },
    { path: 'levels.multiplier', label: 'Multiplier', type: 'number', min: 0.1, max: 10, step: 0.1 },
    { path: 'levels.announceMessage', label: 'Level-up message', wide: true, max: 500, help: 'Variables: {user} {level} {server}' },
    { path: 'levels.ignoredChannels', label: 'No XP in channels', type: 'channels' },
    { path: 'levels.ignoredRoles', label: 'No XP for roles', type: 'roles' },
  ], state, ctx, dirty)),
  h('div', { class: 'grid two', style: 'margin-top:14px' },
    section('Starboard', 'Highlight popular messages.', fieldGrid([
      { path: 'starboard.enabled', label: 'Enabled', type: 'toggle' },
      { path: 'starboard.allowSelfStar', label: 'Count self stars', type: 'toggle' },
      { path: 'starboard.channelId', label: 'Channel', type: 'channel' },
      { path: 'starboard.threshold', label: 'Reactions needed', type: 'number', min: 1, max: 100 },
      { path: 'starboard.emoji', label: 'Emoji', max: 64 },
    ], state, ctx, dirty)),
    section('Birthdays', 'Celebrate on the day, in UTC.', fieldGrid([
      { path: 'birthdays.enabled', label: 'Enabled', type: 'toggle' },
      { path: 'birthdays.channelId', label: 'Channel', type: 'channel' },
      { path: 'birthdays.roleId', label: 'Role for the day', type: 'role' },
      { path: 'birthdays.message', label: 'Message', type: 'textarea', wide: true, max: 500 },
    ], state, ctx, dirty))),
  h('div', { class: 'grid two', style: 'margin-top:14px' },
    section('Suggestions', null, fieldGrid([
      { path: 'suggestions.enabled', label: 'Enabled', type: 'toggle' },
      { path: 'suggestions.channelId', label: 'Channel', type: 'channel' },
    ], state, ctx, dirty)),
    section('Welcome challenge', 'Post the panel with /challenge setup.', fieldGrid([
      { path: 'challenge.enabled', label: 'Enabled', type: 'toggle' },
      { path: 'challenge.verifiedRoleId', label: 'Verified role', type: 'role' },
      { path: 'challenge.type', label: 'Type', type: 'select', options: [{ value: 'math', label: 'Math question' }, { value: 'button', label: 'Button only' }] },
      { path: 'challenge.timeoutMinutes', label: 'Kick after minutes (0 = never)', type: 'number', min: 0, max: 1440 },
    ], state, ctx, dirty))),
  section('Other features', null, fieldGrid([
    { path: 'invites.enabled', label: 'Invite tracking', type: 'toggle' },
    { path: 'afk.enabled', label: 'AFK system', type: 'toggle' },
  ], state, ctx, dirty))));

export { embedBuilderPage };
