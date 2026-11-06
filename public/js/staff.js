import { api, confirmDialog, fmtAgo, fmtDate, guard, h, icon, modal, showError, svg, toast } from './lib.js';
import { dataTable, fieldGrid, roleColor } from './forms.js';
import { miniBars } from './protection.js';
import { appShell } from './shell.js';

const TIERS = { admin: 'Administrator', moderator: 'Moderator', helper: 'Helper', support: 'Support', unlisted: 'No staff role' };
const TIER_KEYS = ['admin', 'moderator', 'helper', 'support'];
const TIER_CONFIG = { admin: 'adminRoles', moderator: 'moderatorRoles', helper: 'helperRoles', support: 'supportRoles' };
const TIER_ICON = { admin: 'sx-crown', moderator: 'moderation', helper: 'sx-heart', support: 'tickets' };
const TIER_COLOR = { admin: '#ef4444', moderator: '#3b82f6', helper: '#10b981', support: '#a78bfa' };
const RECORD_TYPES = { warning: 'Staff warning', note: 'Staff note', review: 'Performance review', admin_action: 'Administrative action', promotion: 'Promotion', role_change: 'Role change' };
const DAY = 86_400_000;

const NAV = [
  { title: 'Staff', items: [['overview', 'Overview', 'overview'], ['roles', 'Staff Roles', 'sx-shield'], ['permissions', 'Role Permissions', 'sx-lock'], ['members', 'Individual Staff', 'sx-users']] },
  { title: 'Analytics', items: [['analytics', 'Role Analytics', 'sx-chart'], ['tickets', 'Ticket Performance', 'tickets'], ['moderation', 'Moderation Performance', 'moderation'], ['activity', 'Activity Tracking', 'sx-pulse']] },
  { title: 'Management', items: [['goals', 'Goals', 'sx-target'], ['compare', 'Comparison', 'sx-scale'], ['history', 'Role History', 'sx-clock'], ['reports', 'Reports', 'sx-file'], ['settings', 'Settings', 'settings']] },
];
const VIEW_LABEL = Object.fromEntries(NAV.flatMap((g) => g.items.map(([id, label]) => [id, label])));

const fmtMinutes = (m) => (m === null || m === undefined ? 'No data' : m < 60 ? `${Math.round(m)} min` : m < 2880 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} days`);
const fmtScore = (s) => (s === null || s === undefined ? 'No data' : `${s}`);
const fmtPercent = (v) => (v === null || v === undefined ? 'No data' : `${Math.round(v)}%`);
const initials = (name) => (name || '?').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase() || '?';
const avatar = (r, cls = 'sx-avatar') => (r.avatar ? h('img', { class: cls, src: r.avatar, alt: '' }) : h('span', { class: cls }, initials(r.name)));
const badge = (text, kind = '') => h('span', { class: `sx-badge ${kind}` }, text);
const statusBadge = (r) => badge(r.status === 'active' ? 'Active' : 'Inactive', r.status === 'active' ? 'good' : '');
const empty = (text) => h('p', { class: 'sx-empty' }, text);
const average = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const sum = (rows, key) => rows.reduce((total, r) => total + (r[key] ?? 0), 0);
const shortDate = (d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const panel = (title, sub, ...children) => h('section', { class: 'sx-panel' }, h('header', { class: 'sx-panel-head' }, h('h2', {}, title), sub ? h('p', {}, sub) : null), children);
const stat = (iconName, color, label, value, hint) => {
  const chip = h('span', { class: 'sx-stat-icon' }, icon(iconName));
  chip.style.setProperty('--tone', color);
  return h('div', { class: 'sx-stat' }, chip, h('div', { class: 'sx-stat-value' }, value), h('div', { class: 'sx-stat-label' }, label), hint ? h('div', { class: 'sx-stat-hint' }, hint) : null);
};
const head = (title, sub, ...actions) => h('header', { class: 'sx-head' }, h('div', {}, h('h1', {}, title), h('p', {}, sub)), actions.length ? h('div', { class: 'sx-head-actions' }, actions) : null);

/** Shows a loading state, then the view. A failed request says so instead of leaving a blank page. */
function loading(build) {
  const holder = h('div', {}, h('div', { class: 'sx-loading' }, Array.from({ length: 6 }, () => h('i'))));
  build().then((node) => holder.replaceChildren(node)).catch((err) => { showError(err); holder.replaceChildren(h('div', { class: 'sx-note danger' }, err.message)); });
  return holder;
}

// ---------- Charts. Every value is a real count from the bot's records. ----------
let chartId = 0;
function lineChart(points, label, { max: fixedMax } = {}) {
  if (points.length < 2 || !points.some((p) => p.value !== null && p.value > 0)) return empty('Not enough activity to draw this yet.');
  const W = 640; const H = 190; const pad = { l: 34, r: 8, t: 10, b: 24 };
  const max = fixedMax ?? Math.max(1, ...points.map((p) => p.value ?? 0));
  const x = (n) => pad.l + (n / (points.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const known = points.map((p, n) => ({ ...p, n })).filter((p) => p.value !== null);
  const line = known.map((p, i) => `${i ? 'L' : 'M'}${x(p.n).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const id = `sx-fill-${++chartId}`;
  const area = known.length > 1 ? `${line} L${x(known.at(-1).n).toFixed(1)},${H - pad.b} L${x(known[0].n).toFixed(1)},${H - pad.b} Z` : '';
  const every = Math.max(1, Math.ceil(points.length / 6));
  return h('div', { class: 'sx-chart' }, svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label },
    svg('defs', {}, svg('linearGradient', { id, x1: 0, x2: 0, y1: 0, y2: 1 }, svg('stop', { offset: '0%', 'stop-color': '#8b5cf6', 'stop-opacity': '.28' }), svg('stop', { offset: '100%', 'stop-color': '#8b5cf6', 'stop-opacity': '0' }))),
    [0, 0.5, 1].map((f) => svg('g', {}, svg('line', { class: 'sx-grid', x1: pad.l, x2: W - pad.r, y1: y(max * f), y2: y(max * f) }), svg('text', { class: 'sx-axis', x: pad.l - 8, y: y(max * f) + 4, 'text-anchor': 'end' }, Math.round(max * f)))),
    area ? svg('path', { d: area, fill: `url(#${id})` }) : null,
    svg('path', { class: 'sx-line', d: line }),
    known.map((p) => svg('circle', { class: 'sx-dot', cx: x(p.n), cy: y(p.value), r: 3 }, svg('title', {}, `${p.label}: ${p.value}`))),
    points.map((p, n) => (n % every === 0 ? svg('text', { class: 'sx-axis', x: x(n), y: H - 6, 'text-anchor': 'middle' }, p.short ?? p.label) : null))));
}

function donut(segments, centre) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  if (!total) return empty('Nothing in this period.');
  let at = 0;
  const stops = segments.map((s) => { const from = at; at += (s.value / total) * 100; return `${s.color} ${from}% ${at}%`; }).join(', ');
  const ring = h('div', { class: 'sx-donut' }, h('div', {}, h('b', {}, centre.value), h('span', {}, centre.label)));
  ring.style.background = `conic-gradient(${stops})`;
  return h('div', { class: 'sx-donut-wrap' }, ring, h('ul', { class: 'sx-legend' }, segments.map((s) => {
    const dot = h('i');
    dot.style.background = s.color;
    return h('li', {}, dot, h('span', {}, s.label), h('b', {}, s.value));
  })));
}

function hBars(rows, value, display = (v) => v) {
  if (!rows.length) return empty('Nothing in this period.');
  const max = Math.max(1, ...rows.map((r) => value(r) ?? 0));
  return h('div', { class: 'sx-bars' }, rows.map((r) => {
    const fill = h('span');
    fill.style.width = `${Math.round(((value(r) ?? 0) / max) * 100)}%`;
    return h('div', { class: 'sx-bar-row' }, h('span', { class: 'sx-bar-name', title: r.name }, r.name), h('span', { class: 'sx-bar-track' }, fill), h('b', {}, display(value(r))));
  }));
}

function heatmap(days) {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = today - (52 * 7 + new Date(today).getUTCDay()) * DAY;
  const max = Math.max(1, ...Object.values(days));
  const cells = [];
  for (let t = start; t <= today; t += DAY) {
    const key = new Date(t).toISOString().slice(0, 10);
    const n = days[key] ?? 0;
    const cell = h('i', { title: `${key}: ${n} ${n === 1 ? 'action' : 'actions'}` });
    cell.dataset.level = n === 0 ? '0' : String(Math.min(4, Math.ceil((n / max) * 4)));
    cells.push(cell);
  }
  return h('div', { class: 'sx-heat-wrap' }, h('div', { class: 'sx-heat', role: 'img', 'aria-label': `Activity over the last year, on ${Object.keys(days).length} active days` }, cells));
}

const dayPoints = (days, count = 30) => Array.from({ length: count }, (_, n) => {
  const t = Date.now() - (count - 1 - n) * DAY;
  const key = new Date(t).toISOString().slice(0, 10);
  return { label: key, short: shortDate(t), value: days[key] ?? 0 };
});

const activityPanels = (map) => [
  panel('Activity heatmap', `${map.activeDays} active days in the last year.`, map.activeDays ? heatmap(map.days) : empty('No activity recorded yet. This fills up as staff use the bot.')),
  h('div', { class: 'sx-grid-2' },
    panel('Most active hours', 'UTC.', miniBars(map.hours.map((value, hour) => ({ label: `${hour}:00`, value })), 'Actions per hour of the day')),
    panel('Activity distribution', 'By day of the week.', miniBars(map.weekdays.map((value, n) => ({ label: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][n], value })), 'Actions per day of the week'))),
  h('p', { class: 'sx-foot' }, 'Counted only from moderation cases and ticket work. ZYTHERON does not read private messages or guess who is online.'),
];

// ---------- Filters ----------
function rangeFilter(state, onChange) {
  const custom = h('div', { class: 'sx-custom', hidden: state.preset !== 'custom' },
    h('input', { type: 'date', 'aria-label': 'From', value: state.from, onchange: (e) => { state.from = e.target.value; if (state.from && state.to) onChange(); } }),
    h('input', { type: 'date', 'aria-label': 'To', value: state.to, onchange: (e) => { state.to = e.target.value; if (state.from && state.to) onChange(); } }));
  const select = h('select', { 'aria-label': 'Date range', onchange: (e) => { state.preset = e.target.value; custom.hidden = state.preset !== 'custom'; if (state.preset !== 'custom') onChange(); } },
    [['today', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['custom', 'Custom range']].map(([value, label]) => h('option', { value, selected: value === state.preset }, label)));
  return h('div', { class: 'sx-range' }, select, custom);
}
const rangeParams = (state, extra = {}) => {
  const p = new URLSearchParams(extra);
  if (state.preset === 'today') p.set('from', new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString());
  else if (state.preset === 'custom' && state.from && state.to) { p.set('from', `${state.from}T00:00:00.000Z`); p.set('to', `${state.to}T23:59:59.999Z`); }
  else p.set('days', state.preset === 'custom' ? '30' : state.preset);
  return p;
};
const personSelect = (people, state, onChange) => h('select', { 'aria-label': 'Staff member', onchange: (e) => { state.person = e.target.value; onChange(); } },
  h('option', { value: '' }, 'All staff'), people.map((p) => h('option', { value: p.userId, selected: p.userId === state.person }, p.name)));

const memberLink = (ctx, r) => h('a', { class: 'sx-person', href: `${ctx.base}/members/${r.userId}` }, avatar(r), h('span', {}, h('b', {}, r.name), h('small', {}, r.userId)));

// ---------- Overview ----------
function overviewView(ctx, state) {
  const body = () => loading(async () => {
    const q = rangeParams(state);
    const [staff, tickets, moderation, heat] = await Promise.all([ctx.get(`staff?${q}`), ctx.get(`staff/tickets?${q}`), ctx.get(`staff/moderation?${q}`), ctx.get('staff/heatmap')]);
    const t = staff.totals;
    const share = (n) => (t.staff ? `${Math.round((n / t.staff) * 100)}% of staff` : '');
    const busiest = [...staff.staff].sort((a, b) => b.actions - a.actions).filter((r) => r.actions).slice(0, 5);
    const trendIds = busiest.slice(0, 6).map((r) => r.userId);
    const compare = trendIds.length ? await ctx.get(`staff/compare?${rangeParams(state, { ids: trendIds.join(',') })}`) : { staff: [] };
    const weekly = (compare.staff[0]?.trend ?? []).map((w, n) => {
      const scores = compare.staff.map((s) => s.trend[n].score).filter((v) => v !== null);
      return { label: `Week ending ${shortDate(w.weekEnding)}`, short: shortDate(w.weekEnding), value: scores.length ? Math.round(average(scores)) : null };
    });
    const recent = [
      ...moderation.recent.map((c) => ({ at: c.at, icon: 'moderation', tone: '#f87171', text: `${c.staff} · ${c.type}`, sub: `${c.target}: ${c.reason}` })),
      ...tickets.list.map((x) => ({ at: x.openedAt, icon: 'tickets', tone: '#a78bfa', text: `Ticket #${x.number} · ${x.status}`, sub: x.subject })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 7);
    return h('div', { class: 'sx-stack' },
      h('div', { class: 'sx-stats' },
        stat('sx-users', '#a78bfa', 'Total staff members', t.staff),
        stat('sx-pulse', '#34d399', 'Active staff', t.active, share(t.active)),
        stat('sx-clock', '#fbbf24', 'Inactive staff', t.inactive, share(t.inactive)),
        stat('tickets', '#60a5fa', 'Tickets handled', sum(staff.staff, 'handled'), `${t.resolved} resolved`),
        stat('moderation', '#f87171', 'Moderation actions', t.moderation),
        stat('sx-chart', '#8b5cf6', 'Average performance', fmtScore(t.overall), t.overall === null ? '' : 'out of 100')),
      h('div', { class: 'sx-grid-2' },
        panel('Staff activity', 'Team actions per day, last 30 days.', lineChart(dayPoints(heat.days), 'Team actions per day')),
        panel('Weekly performance', 'Average score of your most active staff.', lineChart(weekly, 'Average score per week', { max: 100 }))),
      h('div', { class: 'sx-grid-3' },
        panel('Ticket statistics', null, donut([{ label: 'Resolved', value: tickets.resolved, color: '#8b5cf6' }, { label: 'Claimed', value: tickets.claimed, color: '#60a5fa' }, { label: 'Unanswered', value: tickets.unanswered, color: '#fbbf24' }], { value: tickets.opened, label: 'opened' }),
          h('p', { class: 'sx-foot' }, `Average first response: ${fmtMinutes(tickets.avgFirstResponseMin)}`)),
        panel('Moderation statistics', null, donut([{ label: 'Warnings', value: moderation.warnings, color: '#fbbf24' }, { label: 'Timeouts', value: moderation.timeouts, color: '#a78bfa' }, { label: 'Kicks', value: moderation.kicks, color: '#60a5fa' }, { label: 'Bans', value: moderation.bans, color: '#f87171' }], { value: moderation.total, label: 'actions' })),
        panel('Most active staff', null, busiest.length ? h('ol', { class: 'sx-list' }, busiest.map((r) => h('li', {}, h('a', { class: 'sx-list-item', href: `${ctx.base}/members/${r.userId}` }, avatar(r), h('span', { class: 'sx-list-text' }, h('b', {}, r.name), h('small', {}, `${r.actions} actions`)), h('span', { class: 'sx-score' }, fmtScore(r.score)))))) : empty('No activity in this period.'))),
      panel('Recent staff activities', null, recent.length ? h('ul', { class: 'sx-feed' }, recent.map((e) => {
        const chip = h('span', { class: 'sx-stat-icon small' }, icon(e.icon));
        chip.style.setProperty('--tone', e.tone);
        return h('li', {}, chip, h('div', {}, h('b', {}, e.text), h('small', { title: e.sub }, e.sub)), h('time', {}, fmtAgo(e.at)));
      })) : empty('No activity in this period.')));
  });
  return viewWithRange(ctx, state, 'Staff Performance', 'How your team is doing, from real cases and tickets.', body);
}

function viewWithRange(ctx, state, title, sub, body, ...extra) {
  const slot = h('div');
  const draw = () => slot.replaceChildren(body());
  const root = h('div', {}, head(title, sub, ...extra, rangeFilter(state, draw)), slot);
  draw();
  return root;
}

// ---------- Staff roles ----------
const linkedRoles = (ctx, cfg, tier) => cfg[TIER_CONFIG[tier]].map((id) => ctx.resources.roles.find((r) => r.id === id)).filter(Boolean);
const tierColor = (ctx, cfg, tier) => roleColor(linkedRoles(ctx, cfg, tier)[0]?.color) ?? TIER_COLOR[tier];

async function linkRole(ctx, cfg, tier) {
  const form = { tier: tier ?? 'moderator', roleId: ctx.resources.roles.find((r) => !r.managed)?.id ?? '' };
  const saved = await modal(tier ? `Link a role to ${TIERS[tier]}` : 'Add staff role', () => ({
    node: h('div', {}, h('p', { class: 'sx-foot' }, 'Everyone with this Discord role is tracked as staff in this group.'), fieldGrid([
      ...(tier ? [] : [{ path: 'tier', label: 'Staff group', type: 'select', options: TIER_KEYS.map((k) => ({ value: k, label: TIERS[k] })) }]),
      { path: 'roleId', label: 'Discord role', type: 'role' },
    ], form, ctx)),
    submit: async () => {
      if (!form.roleId) throw new Error('Choose a Discord role.');
      const key = TIER_CONFIG[form.tier];
      if (cfg[key].includes(form.roleId)) throw new Error('That role is already in this group.');
      return api(`/api/guilds/${ctx.guildId}/config/staff`, { method: 'PUT', body: { [key]: [...cfg[key], form.roleId] } });
    },
  }), { submitLabel: 'Add role' });
  if (saved) { toast('Staff role added.'); ctx.rerender(); }
}

async function unlinkRole(ctx, cfg, tier, role) {
  if (!(await confirmDialog(`Stop tracking ${role.name}?`, 'Past records stay. People with only this role will no longer be listed as staff unless they have recorded work.', 'Stop tracking'))) return;
  await guard(null, async () => {
    const key = TIER_CONFIG[tier];
    await api(`/api/guilds/${ctx.guildId}/config/staff`, { method: 'PUT', body: { [key]: cfg[key].filter((id) => id !== role.id) } });
    toast('Role removed from staff tracking.');
    ctx.rerender();
  })();
}

function rolesView(ctx, state) {
  return loading(async () => {
    const [cfg, staff] = await Promise.all([ctx.get('config/staff'), ctx.get(`staff?${rangeParams(state)}`)]);
    const filter = { text: '', show: 'all' };
    const grid = h('div', { class: 'sx-role-grid' });
    const cards = TIER_KEYS.map((tier) => {
      const members = staff.staff.filter((r) => r.tier === tier);
      const roles = linkedRoles(ctx, cfg, tier);
      const scored = members.filter((m) => m.score !== null).map((m) => m.score);
      return { tier, members, roles, tracking: roles.length > 0 || members.length > 0, actions: sum(members, 'actions'), score: scored.length ? Math.round(average(scored)) : null };
    });
    const card = (c) => {
      const color = tierColor(ctx, cfg, c.tier);
      const chip = h('span', { class: 'sx-stat-icon' }, icon(TIER_ICON[c.tier]));
      chip.style.setProperty('--tone', color);
      const menu = h('details', { class: 'sx-menu' }, h('summary', { 'aria-label': `More for ${TIERS[c.tier]}` }, icon('sx-dots')), h('div', {},
        h('a', { href: `${ctx.base}/roles/${c.tier}` }, 'View analytics'),
        h('button', { type: 'button', disabled: !ctx.trusted, onclick: () => { menu.open = false; linkRole(ctx, cfg, c.tier); } }, 'Link a Discord role'),
        c.roles.map((r) => h('button', { type: 'button', class: 'danger', disabled: !ctx.trusted, onclick: () => { menu.open = false; unlinkRole(ctx, cfg, c.tier, r); } }, `Stop tracking ${r.name}`))));
      const card = h('article', { class: 'sx-role' },
        h('div', { class: 'sx-role-top' }, chip, menu),
        h('h2', {}, TIERS[c.tier]),
        h('p', { class: 'sx-role-count' }, c.members.length ? `${c.members.length} ${c.members.length === 1 ? 'member' : 'members'}` : '0 Members – Waiting for Staff Assignment'),
        h('div', { class: 'sx-chips' }, c.roles.length ? c.roles.map((r) => { const dot = h('i'); dot.style.background = roleColor(r.color) ?? '#888888'; return h('span', { class: 'sx-chip' }, dot, r.name); }) : h('span', { class: 'sx-chip muted' }, 'No Discord role linked')),
        h('dl', { class: 'sx-role-stats' },
          h('div', {}, h('dt', {}, 'Tracking'), h('dd', {}, badge(c.tracking ? 'On' : 'Off', c.tracking ? 'good' : ''))),
          h('div', {}, h('dt', {}, 'Activities'), h('dd', {}, c.actions)),
          h('div', {}, h('dt', {}, 'Performance'), h('dd', {}, fmtScore(c.score)))),
        h('a', { class: 'sx-btn', href: `${ctx.base}/roles/${c.tier}` }, 'Configure'));
      card.style.setProperty('--role', color);
      return card;
    };
    const draw = () => {
      const text = filter.text.toLowerCase();
      const shown = cards.filter((c) => (filter.show === 'all' || (filter.show === 'active' ? c.members.length > 0 : c.members.length === 0)) && (!text || TIERS[c.tier].toLowerCase().includes(text) || c.roles.some((r) => r.name.toLowerCase().includes(text))));
      grid.replaceChildren(...(shown.length ? shown.map(card) : [empty('No staff roles match.')]));
    };
    draw();
    const unlisted = staff.staff.filter((r) => r.tier === 'unlisted').length;
    return h('div', {},
      head('Staff Roles', 'Your four staff groups, and the Discord roles in each.', h('button', { class: 'sx-btn primary', type: 'button', disabled: !ctx.trusted, onclick: () => linkRole(ctx, cfg) }, icon('sx-plus'), 'Add Staff Role')),
      ctx.trusted ? null : h('div', { class: 'sx-note' }, 'Only the server owner or a trusted admin can change staff roles.'),
      h('div', { class: 'sx-toolbar' },
        h('div', { class: 'sx-search' }, icon('search'), h('input', { type: 'search', placeholder: 'Search roles', 'aria-label': 'Search roles', oninput: (e) => { filter.text = e.target.value.trim(); draw(); } })),
        h('select', { 'aria-label': 'Filter roles', onchange: (e) => { filter.show = e.target.value; draw(); } }, [['all', 'All roles'], ['active', 'With members'], ['empty', 'Empty']].map(([value, label]) => h('option', { value }, label)))),
      grid,
      unlisted ? h('p', { class: 'sx-foot' }, `${unlisted} ${unlisted === 1 ? 'person has' : 'people have'} recorded staff work but no staff role yet.`) : null);
  });
}

function roleDetailView(ctx, state, tier) {
  if (!TIER_KEYS.includes(tier)) return h('div', { class: 'sx-note danger' }, 'That staff group does not exist.');
  const body = () => loading(async () => {
    const q = rangeParams(state);
    const [cfg, staff] = await Promise.all([ctx.get('config/staff'), ctx.get(`staff?${q}`)]);
    const members = staff.staff.filter((r) => r.tier === tier);
    const top = [...members].sort((a, b) => b.actions - a.actions).slice(0, 6);
    const [maps, compare] = top.length ? await Promise.all([Promise.all(top.map((m) => ctx.get(`staff/heatmap?staff=${m.userId}`))), ctx.get(`staff/compare?${rangeParams(state, { ids: top.map((m) => m.userId).join(',') })}`)]) : [[], { staff: [] }];
    const days = {};
    for (const map of maps) for (const [day, n] of Object.entries(map.days)) days[day] = (days[day] ?? 0) + n;
    const weekly = (compare.staff[0]?.trend ?? []).map((w, n) => {
      const scores = compare.staff.map((s) => s.trend[n].score).filter((v) => v !== null);
      return { label: `Week ending ${shortDate(w.weekEnding)}`, short: shortDate(w.weekEnding), value: scores.length ? Math.round(average(scores)) : null };
    });
    const byType = {};
    for (const m of members) for (const [type, n] of Object.entries(m.byType)) byType[type] = (byType[type] ?? 0) + n;
    const scored = members.filter((m) => m.score !== null).map((m) => m.score);
    const color = tierColor(ctx, cfg, tier);
    const dot = h('i', { class: 'sx-role-dot' });
    dot.style.background = color;
    return h('div', { class: 'sx-stack' },
      h('a', { class: 'sx-back', href: `${ctx.base}/roles` }, '‹ Staff Roles'),
      h('header', { class: 'sx-head' }, h('div', {}, h('h1', { class: 'sx-role-title' }, dot, TIERS[tier]), h('p', {}, `${members.length} ${members.length === 1 ? 'member' : 'members'} · Tracking ${linkedRoles(ctx, cfg, tier).length || members.length ? 'on' : 'off'}`)),
        h('div', { class: 'sx-head-actions' }, h('button', { class: 'sx-btn', type: 'button', disabled: !ctx.trusted, onclick: () => linkRole(ctx, cfg, tier) }, 'Edit Role'))),
      h('div', { class: 'sx-stats' },
        stat('sx-users', '#a78bfa', 'Total members', members.length),
        stat('sx-pulse', '#34d399', 'Active members', members.filter((m) => m.status === 'active').length),
        stat('tickets', '#60a5fa', 'Total tickets', sum(members, 'handled')),
        stat('sx-check', '#34d399', 'Tickets resolved', sum(members, 'resolved')),
        stat('moderation', '#f87171', 'Moderation actions', sum(members, 'cases')),
        stat('sx-chart', '#8b5cf6', 'Average performance', scored.length ? Math.round(average(scored)) : 'No data')),
      members.length ? h('div', { class: 'sx-stack' },
        h('div', { class: 'sx-grid-2' },
          panel('Role activity', members.length > 6 ? 'Actions per day, for the 6 most active members.' : 'Actions per day, last 30 days.', lineChart(dayPoints(days), 'Role actions per day')),
          panel('Performance trend', 'Average score per week.', lineChart(weekly, 'Average score per week', { max: 100 }))),
        panel('Activity heatmap', null, Object.keys(days).length ? heatmap(days) : empty('No activity recorded yet.')),
        h('div', { class: 'sx-grid-2' },
          panel('Ticket performance', 'Tickets resolved per member.', hBars(top, (m) => m.resolved)),
          panel('Moderation statistics', null, Object.keys(byType).length ? hBars(Object.entries(byType).map(([name, n]) => ({ name, n })), (r) => r.n) : empty('No moderation in this period.'))),
        panel('Staff members', null, memberTable(ctx, members))) : h('div', { class: 'sx-empty-card' }, icon('sx-users'), h('h2', {}, '0 Members – Waiting for Staff Assignment'), h('p', {}, 'Link a Discord role to this group, and everyone with it appears here.')));
  });
  const slot = h('div');
  const draw = () => slot.replaceChildren(body());
  draw();
  return h('div', {}, h('div', { class: 'sx-range-right' }, rangeFilter(state, draw)), slot);
}

const memberTable = (ctx, rows) => dataTable([
  { label: 'Staff member', render: (r) => memberLink(ctx, r) },
  { label: 'Last active', render: (r) => (r.lastActive ? fmtAgo(r.lastActive) : 'Never recorded') },
  { label: 'Voice time', render: () => h('span', { class: 'sx-muted', title: 'The bot does not record voice time.' }, 'Not tracked') },
  { label: 'Tickets', render: (r) => r.handled },
  { label: 'Moderation', render: (r) => r.cases },
  { label: 'Score', render: (r) => h('span', { class: 'sx-score' }, fmtScore(r.score)) },
  { label: 'Status', render: statusBadge },
], rows, 'No staff here yet.');

// ---------- Permissions ----------
const PERMISSIONS = [
  ['View Staff Performance', true, true, true], ['View Staff Members', true, true, true], ['View Analytics', true, true, true], ['View Ticket Statistics', true, true, true], ['View Moderation Statistics', true, true, true], ['View Activity History', true, true, true], ['Generate Reports', true, true, true],
  ['Manage Staff Roles', true, true, false], ['Manage Staff Goals', true, true, false], ['View and edit Role History', true, true, false], ['Manage Permissions', false, false, false],
];

function permissionsView() {
  const cell = (on, label) => h('td', {}, h('label', { class: 'sx-switch', title: 'Set by ZYTHERON. Cannot be changed yet.' }, h('input', { type: 'checkbox', checked: on, disabled: true, 'aria-label': label }), h('span')));
  return h('div', {},
    head('Role Permissions', 'Who can do what in Staff Performance today.'),
    h('div', { class: 'sx-note' }, 'These switches show the rules that really apply, and are locked. Changing them per role needs new server code, so they cannot be edited yet.'),
    h('section', { class: 'sx-panel' }, h('div', { class: 'table-wrap' }, h('table', { class: 'sx-perms' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Permission'), ['Server owner', 'Trusted admin', 'Manage Server'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, PERMISSIONS.map(([name, owner, trusted, manager]) => h('tr', {}, h('th', { scope: 'row' }, name), cell(owner, `${name}: server owner`), cell(trusted, `${name}: trusted admin`), cell(manager, `${name}: Manage Server`))))))));
}

// ---------- Individual staff ----------
function membersView(ctx, state) {
  let tierFilter = 'all';
  let text = '';
  const body = () => loading(async () => {
    const data = await ctx.get(`staff?${rangeParams(state)}`);
    const list = h('div');
    const draw = () => {
      const rows = data.staff.filter((r) => (tierFilter === 'all' || r.tier === tierFilter) && (!text || `${r.name} ${r.userId}`.toLowerCase().includes(text)));
      list.replaceChildren(dataTable([
        { label: 'Rank', render: (r) => { const n = data.staff.indexOf(r) + 1; return r.score === null ? '–' : n <= 3 ? h('span', { class: `sx-rank r${n}` }, ['1st', '2nd', '3rd'][n - 1]) : `${n}th`; } },
        { label: 'Staff member', render: (r) => memberLink(ctx, r) },
        { label: 'Role', render: (r) => TIERS[r.tier] },
        { label: 'Score', render: (r) => h('span', { class: 'sx-score' }, fmtScore(r.score)) },
        { label: 'Handled', render: (r) => r.handled },
        { label: 'Resolved', render: (r) => r.resolved },
        { label: 'Moderation', render: (r) => r.cases },
        { label: 'Status', render: statusBadge },
        { label: 'Last active', render: (r) => (r.lastActive ? fmtAgo(r.lastActive) : 'Never recorded') },
      ], rows, 'No staff match. Link Discord roles under Staff Roles.'));
    };
    draw();
    return h('div', {},
      h('div', { class: 'sx-toolbar' },
        h('div', { class: 'sx-search' }, icon('search'), h('input', { type: 'search', placeholder: 'Search by name or ID', 'aria-label': 'Search staff', value: text, oninput: (e) => { text = e.target.value.trim().toLowerCase(); draw(); } })),
        h('select', { 'aria-label': 'Filter by group', onchange: (e) => { tierFilter = e.target.value; draw(); } }, [['all', 'All Staff'], ['admin', 'Administrators'], ['moderator', 'Moderators'], ['helper', 'Helpers'], ['support', 'Support Team']].map(([value, label]) => h('option', { value, selected: value === tierFilter }, label)))),
      panel('Staff leaderboard', 'Ranked by quality, so more punishments never move anyone up.', list));
  });
  return viewWithRange(ctx, state, 'Individual Staff', 'Click anyone to open their profile.', body);
}

function profileView(ctx, state, userId) {
  const body = () => loading(async () => {
    const q = rangeParams(state);
    const [d, records] = await Promise.all([ctx.get(`staff/${userId}?${q}`), ctx.trusted ? ctx.get(`staff/records?staff=${userId}`).catch(() => null) : null]);
    const r = d.row;
    const timeline = [
      ...d.moderation.map((c) => ({ at: c.at, icon: 'moderation', tone: '#f87171', text: `${c.type} · case #${c.caseId}`, sub: `${c.target}: ${c.reason}` })),
      ...d.tickets.map((t) => ({ at: t.openedAt, icon: 'tickets', tone: '#a78bfa', text: `Ticket #${t.number} · ${t.status}`, sub: t.subject })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 10);
    return h('div', { class: 'sx-stack' },
      h('section', { class: 'sx-hero' }, avatar(r, 'sx-avatar big'), h('div', { class: 'sx-hero-text' },
        h('h1', {}, r.name), h('p', { class: 'sx-id' }, r.userId),
        h('div', { class: 'sx-chips' }, h('span', { class: 'sx-chip' }, TIERS[r.tier]), r.roleName && r.roleName !== TIERS[r.tier] ? h('span', { class: 'sx-chip' }, r.roleName) : null, statusBadge(r)),
        h('p', { class: 'sx-hero-meta' }, `Joined ${r.joinedAt ? fmtDate(r.joinedAt) : 'unknown'} · Last activity ${r.lastActive ? fmtAgo(r.lastActive) : 'never recorded'}`)),
      h('div', { class: 'sx-hero-score' }, h('b', {}, fmtScore(r.score)), h('span', {}, r.score === null ? 'Not enough data' : 'Performance score'))),
      h('p', { class: 'sx-foot' }, 'Active means recorded work recently. It does not mean this person is online right now.'),
      h('div', { class: 'sx-stats four' },
        stat('tickets', '#60a5fa', 'Tickets handled', r.handled), stat('sx-check', '#34d399', 'Tickets resolved', r.resolved), stat('sx-alert', '#fbbf24', 'Warnings', r.byType.warn ?? 0), stat('moderation', '#f87171', 'Bans', (r.byType.ban ?? 0) + (r.byType.tempban ?? 0)),
        stat('moderation', '#fb923c', 'Kicks', r.byType.kick ?? 0), stat('sx-clock', '#a78bfa', 'Timeouts', r.byType.timeout ?? 0), stat('music', '#888888', 'Voice time', h('span', { class: 'sx-muted-value' }, 'Not tracked')), stat('sx-pulse', '#8b5cf6', 'Total activities', r.actions)),
      h('div', { class: 'sx-grid-2' },
        panel('Performance history', 'Score per week, last 8 weeks.', lineChart(d.trend.map((w) => ({ label: `Week ending ${shortDate(w.weekEnding)}`, short: shortDate(w.weekEnding), value: w.score })), 'Score per week', { max: 100 })),
        panel('Weekly activity', 'Actions per week, last 8 weeks.', lineChart(d.trend.map((w) => ({ label: `Week ending ${shortDate(w.weekEnding)}`, short: shortDate(w.weekEnding), value: w.actions })), 'Actions per week'))),
      ...activityPanels(d.map),
      h('div', { class: 'sx-grid-2' },
        panel('Activity timeline', null, timeline.length ? h('ul', { class: 'sx-feed' }, timeline.map((e) => {
          const chip = h('span', { class: 'sx-stat-icon small' }, icon(e.icon));
          chip.style.setProperty('--tone', e.tone);
          return h('li', {}, chip, h('div', {}, h('b', {}, e.text), h('small', { title: e.sub }, e.sub)), h('time', {}, fmtAgo(e.at)));
        })) : empty('No activity in this period.')),
        panel('Goals in this period', null, goalBars(d.goals))),
      panel('Ticket history', null, dataTable(ticketColumns, d.tickets, 'No tickets in this period.')),
      panel('Moderation history', null, dataTable(moderationColumns, d.moderation, 'No moderation in this period.')),
      records ? panel('Role history', 'Visible only to the server owner and trusted admins.', dataTable(recordColumns, records.records, 'No records yet.')) : null);
  });
  const slot = h('div');
  const draw = () => slot.replaceChildren(body());
  draw();
  return h('div', {}, h('div', { class: 'sx-head-row' }, h('a', { class: 'sx-back', href: `${ctx.base}/members` }, '‹ Individual Staff'), rangeFilter(state, draw)), slot);
}

const recordColumns = [
  { label: 'Date', render: (r) => fmtDate(r.date) },
  { label: 'Type', render: (r) => badge(RECORD_TYPES[r.type] ?? r.type, r.type === 'warning' ? 'warn' : r.type === 'promotion' ? 'good' : '') },
  { label: 'Reason', clip: true, render: (r) => r.reason },
  { label: 'Administrator', render: (r) => r.adminName },
];

// ---------- Role analytics ----------
function analyticsView(ctx, state) {
  const body = () => loading(async () => {
    const data = await ctx.get(`staff?${rangeParams(state)}`);
    const groups = TIER_KEYS.map((tier) => {
      const members = data.staff.filter((r) => r.tier === tier);
      const scores = members.filter((m) => m.score !== null).map((m) => m.score);
      const days = sum(members, 'activeDays');
      return { tier, name: TIERS[tier], count: members.length, handled: sum(members, 'handled'), resolved: sum(members, 'resolved'), cases: sum(members, 'cases'), actions: sum(members, 'actions'), perDay: days ? sum(members, 'actions') / days : null, score: scores.length ? Math.round(average(scores)) : null };
    });
    return h('div', { class: 'sx-stack' },
      h('div', { class: 'sx-grid-2' },
        panel('Average score by group', null, hBars(groups, (g) => g.score, (v) => v ?? 'No data')),
        panel('Activities by group', null, hBars(groups, (g) => g.actions))),
      panel('Compare groups', 'Groups do different work, so compare each one against its own targets rather than raw counts.', dataTable([
        { label: 'Group', render: (g) => h('a', { class: 'sx-table-link', href: `${ctx.base}/roles/${g.tier}` }, g.name) },
        { label: 'Members', render: (g) => g.count }, { label: 'Tickets handled', render: (g) => g.handled }, { label: 'Resolved', render: (g) => g.resolved }, { label: 'Moderation', render: (g) => g.cases },
        { label: 'Actions per active day', render: (g) => (g.perDay === null ? 'No data' : g.perDay.toFixed(1)) }, { label: 'Score', render: (g) => h('span', { class: 'sx-score' }, fmtScore(g.score)) },
      ], groups)));
  });
  return viewWithRange(ctx, state, 'Role Analytics', 'How each staff group is doing.', body);
}

// ---------- Tickets ----------
const ticketColumns = [
  { label: '#', render: (t) => t.number },
  { label: 'Member', render: (t) => t.owner },
  { label: 'Subject', clip: true, render: (t) => t.subject },
  { label: 'Status', render: (t) => badge(t.status, t.status === 'open' ? 'good' : '') },
  { label: 'First response', render: (t) => fmtMinutes(t.firstResponseMin) },
  { label: 'Resolved in', render: (t) => fmtMinutes(t.resolutionMin) },
  { label: 'Rating', render: (t) => (t.rating ? '★'.repeat(t.rating) : '') },
];

function ticketsView(ctx, state) {
  const body = () => {
    const slot = loading(async () => {
      const d = await ctx.get(`staff/tickets?${rangeParams(state, state.person ? { staff: state.person } : {})}`);
      const series = (key) => d.daily.map((r) => ({ label: r.date, short: shortDate(r.date), value: r[key] }));
      return h('div', { class: 'sx-stack' },
        h('div', { class: 'sx-toolbar' }, personSelect(d.people, state, () => slot.replaceWith(body()))),
        h('div', { class: 'sx-stats four' },
          stat('tickets', '#60a5fa', 'Opened', d.opened), stat('sx-users', '#a78bfa', 'Claimed', d.claimed), stat('sx-arrow', '#8b5cf6', 'Assigned', d.assigned), stat('sx-check', '#34d399', 'Resolved', d.resolved, 'Each ticket counts once'),
          stat('sx-lock', '#888888', 'Closed', d.closed), stat('sx-alert', '#fbbf24', 'Unanswered', d.unanswered, 'Open with no staff reply'), stat('sx-clock', '#60a5fa', 'Avg first response', fmtMinutes(d.avgFirstResponseMin)), stat('sx-clock', '#34d399', 'Avg resolution', fmtMinutes(d.avgResolutionMin))),
        h('div', { class: 'sx-grid-2' },
          panel('Ticket resolution', 'Tickets resolved per day.', lineChart(series('resolved'), 'Tickets resolved per day')),
          panel('Ticket activity', 'Tickets opened per day.', lineChart(series('opened'), 'Tickets opened per day'))),
        panel('Staff ticket comparison', 'Tickets resolved per person.', hBars(d.comparison, (r) => r.resolved)),
        panel('Individual tickets', 'First response times are recorded for tickets opened from now on.', dataTable(ticketColumns, d.list, 'No tickets in this period.')));
    });
    return slot;
  };
  return viewWithRange(ctx, state, 'Ticket Performance', 'How quickly and how well tickets get handled.', body);
}

// ---------- Moderation ----------
const moderationColumns = [
  { label: 'Case', render: (c) => `#${c.caseId}` },
  { label: 'Staff member', render: (c) => c.staff },
  { label: 'Action', render: (c) => badge(c.type) },
  { label: 'Target', render: (c) => c.target },
  { label: 'Reason', clip: true, render: (c) => c.reason },
  { label: 'When', render: (c) => fmtDate(c.at) },
  { label: 'Status', render: (c) => badge(c.status, c.status === 'Active' ? 'accent' : '') },
];

function moderationView(ctx, state) {
  const body = () => {
    const slot = loading(async () => {
      const d = await ctx.get(`staff/moderation?${rangeParams(state, state.person ? { staff: state.person } : {})}`);
      return h('div', { class: 'sx-stack' },
        h('div', { class: 'sx-toolbar' }, personSelect(d.people, state, () => slot.replaceWith(body()))),
        h('div', { class: 'sx-stats five' },
          stat('sx-alert', '#fbbf24', 'Warnings given', d.warnings), stat('moderation', '#f87171', 'Members banned', d.bans), stat('moderation', '#fb923c', 'Members kicked', d.kicks), stat('sx-clock', '#a78bfa', 'Timeouts applied', d.timeouts), stat('auto-purge', '#60a5fa', 'Messages deleted', d.messagesDeleted, 'Through /moderation purge')),
        h('div', { class: 'sx-grid-2' },
          panel('Moderation activity', 'More is not better, so this never raises a score.', lineChart(d.daily.map((r) => ({ label: r.date, short: shortDate(r.date), value: r.actions })), 'Moderation actions per day')),
          panel('Staff moderation comparison', 'Quality is the share of punishments with a written reason that nobody else undid within a week.', d.comparison.length ? dataTable([
            { label: 'Staff member', render: (r) => r.name }, { label: 'Actions', render: (r) => r.cases }, { label: 'Quality', render: (r) => fmtPercent(r.quality) },
          ], d.comparison) : empty('No moderation in this period.'))),
        panel('Recent moderation history', null, dataTable(moderationColumns, d.recent, 'No moderation in this period.')));
    });
    return slot;
  };
  return viewWithRange(ctx, state, 'Moderation Performance', 'Quality of moderation, not just the amount.', body);
}

// ---------- Activity ----------
function activityView(ctx, state) {
  const slot = h('div');
  const draw = () => slot.replaceChildren(loading(async () => {
    const [map, staff] = await Promise.all([ctx.get(`staff/heatmap${state.person ? `?staff=${state.person}` : ''}`), ctx.get('staff?days=30')]);
    const seen = [...staff.staff].sort((a, b) => new Date(b.lastActive ?? 0) - new Date(a.lastActive ?? 0));
    return h('div', { class: 'sx-stack' },
      h('div', { class: 'sx-toolbar' }, personSelect(staff.staff, state, draw)),
      h('div', { class: 'sx-stats four' },
        stat('sx-pulse', '#8b5cf6', 'Active days', map.activeDays, 'Last year'),
        stat('sx-chart', '#a78bfa', 'Total actions', Object.values(map.days).reduce((a, b) => a + b, 0), 'Last year'),
        stat('sx-clock', '#60a5fa', 'Busiest hour', Object.keys(map.days).length ? `${map.hours.indexOf(Math.max(...map.hours))}:00` : 'No data', 'UTC'),
        stat('overview', '#34d399', 'Busiest day', Object.keys(map.days).length ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][map.weekdays.indexOf(Math.max(...map.weekdays))] : 'No data')),
      panel('Daily activity', 'Last 30 days.', lineChart(dayPoints(map.days), 'Actions per day')),
      ...activityPanels(map),
      panel('Last seen working', 'From recorded work only.', dataTable([
        { label: 'Staff member', render: (r) => memberLink(ctx, r) },
        { label: 'Last active', render: (r) => (r.lastActive ? fmtAgo(r.lastActive) : 'Never recorded') },
        { label: 'Active days (30)', render: (r) => r.activeDays },
        { label: 'Status', render: statusBadge },
      ], seen, 'No staff yet.')));
  }));
  draw();
  return h('div', {}, head('Activity Tracking', 'When your team works, from events the bot recorded.'), slot);
}

// ---------- Goals ----------
const goalBars = (goals) => h('div', { class: 'sx-goals' }, goals.map((g) => {
  const fill = h('span', { class: g.done ? 'done' : '' });
  fill.style.width = `${g.percent}%`;
  const value = g.value === null ? 'No data' : g.unit === 'minutes' ? fmtMinutes(g.value) : `${Math.round(g.value)}${g.unit === '%' ? '%' : ''}`;
  const target = g.unit === 'minutes' ? `under ${g.target} min` : `${g.target}${g.unit === '%' ? '%' : ` ${g.unit}`}`;
  return h('div', { class: 'sx-goal' }, h('div', {}, h('span', {}, g.label), h('small', {}, `${value} of ${target}`)), h('span', { class: 'sx-bar-track' }, fill), badge(g.done ? 'Done' : 'Pending', g.done ? 'good' : ''));
}));

function goalsView(ctx) {
  return loading(async () => {
    const [{ staff }, cfg] = await Promise.all([ctx.get('staff/goals'), ctx.get('config/staff')]);
    const count = (key, done) => staff.reduce((total, s) => total + s[key].filter((g) => g.done === done).length, 0);
    const save = h('button', { class: 'sx-btn primary', type: 'button', disabled: !ctx.trusted }, 'Save targets');
    save.addEventListener('click', guard(save, async () => { await api(`/api/guilds/${ctx.guildId}/config/staff`, { method: 'PUT', body: { goals: cfg.goals } }); toast('Targets saved.'); ctx.rerender(); }));
    return h('div', { class: 'sx-stack' },
      head('Goals', 'Targets for each staff group, and progress against them.'),
      h('div', { class: 'sx-stats four' }, stat('sx-check', '#34d399', 'Weekly completed', count('weekly', true)), stat('sx-clock', '#fbbf24', 'Weekly pending', count('weekly', false)), stat('sx-check', '#34d399', 'Monthly completed', count('monthly', true)), stat('sx-clock', '#fbbf24', 'Monthly pending', count('monthly', false))),
      panel('Goal progress', null, staff.length ? staff.map((s) => h('details', { class: 'sx-goal-person' }, h('summary', {}, h('b', {}, s.name), h('span', {}, `${TIERS[s.tier]} · ${s.weekly.filter((g) => g.done).length} of ${s.weekly.length} this week`)),
        h('div', { class: 'sx-grid-2' }, h('div', {}, h('h3', {}, 'Last 7 days'), goalBars(s.weekly)), h('div', {}, h('h3', {}, 'Last 30 days'), goalBars(s.monthly))))) : empty('No staff yet.')),
      panel('Targets for each group', 'People with no staff role use the Support targets.', Object.keys(cfg.goals).map((tier) => h('div', { class: 'sx-target' }, h('h3', {}, TIERS[tier]), fieldGrid([
        { path: `goals.${tier}.responseMinutes`, label: 'Response time target (minutes)', type: 'number', min: 1, max: 10080 },
        { path: `goals.${tier}.resolvedPerWeek`, label: 'Tickets resolved per week', type: 'number', min: 0, max: 1000 },
        { path: `goals.${tier}.qualityPercent`, label: 'Support quality target (%)', type: 'number', min: 0, max: 100 },
        { path: `goals.${tier}.moderationPercent`, label: 'Moderation review target (%)', type: 'number', min: 0, max: 100 },
        { path: `goals.${tier}.activeDaysPerWeek`, label: 'Active days per week', type: 'number', min: 0, max: 7 },
      ], cfg, ctx))), h('div', { class: 'sx-actions-row' }, save)));
  });
}

// ---------- Comparison ----------
function compareView(ctx, state) {
  const chosen = new Set();
  const body = () => loading(async () => {
    const { staff } = await ctx.get(`staff?${rangeParams(state)}`);
    const results = h('div', { class: 'sx-stack' });
    const load = guard(null, async () => {
      if (chosen.size < 2) return results.replaceChildren(empty('Choose at least 2 people to compare, up to 6.'));
      const data = await ctx.get(`staff/compare?${rangeParams(state, { ids: [...chosen].join(',') })}`);
      const people = data.staff;
      const row = (label, fn) => h('tr', {}, h('th', { scope: 'row' }, label), people.map((s) => h('td', {}, fn(s))));
      results.replaceChildren(
        new Set(people.map((s) => s.tier)).size > 1 ? h('div', { class: 'sx-note' }, 'These people are in different groups, so their workloads differ. Scores use each group\'s own targets, and raw counts are not directly comparable.') : '',
        panel('Comparison', null, h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, ''), people.map((s) => h('th', { scope: 'col' }, s.name)))),
          h('tbody', {}, row('Group', (s) => TIERS[s.tier]), row('Score', (s) => fmtScore(s.score)), row('Tickets handled', (s) => s.handled), row('Tickets resolved', (s) => s.resolved), row('Average response', (s) => fmtMinutes(s.avgResponseMin)), row('Moderation cases', (s) => s.cases), row('Moderation quality', (s) => fmtPercent(s.parts.moderation)), row('Active days', (s) => s.activeDays), row('Actions per active day', (s) => (s.actionsPerActiveDay === null ? 'No data' : s.actionsPerActiveDay.toFixed(1))), row('Quality rating', (s) => (s.averageRating === null ? 'No ratings' : `${s.averageRating.toFixed(1)} / 5 (${s.ratingCount})`)))))),
        panel('Score', null, hBars(people, (s) => s.score, (v) => v ?? 'No data')),
        panel('Performance trends', 'Score for each of the last 8 weeks.', h('div', { class: 'sx-grid-2' }, people.map((s) => h('div', {}, h('h3', { class: 'sx-sub' }, s.name), lineChart(s.trend.map((w) => ({ label: `Week ending ${shortDate(w.weekEnding)}`, short: shortDate(w.weekEnding), value: w.score })), `${s.name}: score per week`, { max: 100 }))))));
    });
    load();
    return h('div', { class: 'sx-stack' }, panel('Choose staff', null, staff.length ? h('div', { class: 'sx-picker' }, staff.map((s) => h('label', {}, h('input', { type: 'checkbox', checked: chosen.has(s.userId), onchange: (e) => {
      if (e.target.checked && chosen.size >= 6) { e.target.checked = false; return toast('You can compare up to 6 people.', 'err'); }
      if (e.target.checked) chosen.add(s.userId); else chosen.delete(s.userId);
      load();
    } }), avatar(s), h('span', {}, s.name)))) : empty('No staff yet.')), results);
  });
  return viewWithRange(ctx, state, 'Comparison', 'See people side by side, fairly.', body);
}

// ---------- History ----------
function historyView(ctx) {
  const holder = h('div');
  const edit = async (record, people) => {
    const form = record ? { userId: record.userId, type: record.type, reason: record.reason } : { userId: people[0]?.userId ?? '', type: 'note', reason: '' };
    const saved = await modal(record ? 'Edit record' : 'Add record', () => ({
      node: fieldGrid([
        ...(record ? [] : [{ path: 'userId', label: 'Staff member', type: 'select', options: people.map((p) => ({ value: p.userId, label: p.name })) }]),
        { path: 'type', label: 'Record type', type: 'select', options: Object.entries(RECORD_TYPES).map(([value, label]) => ({ value, label })) },
        { path: 'reason', label: 'Reason', type: 'textarea', wide: true, max: 1000 },
      ], form, ctx),
      submit: () => api(`/api/guilds/${ctx.guildId}/staff/records${record ? `/${record._id}` : ''}`, { method: record ? 'PUT' : 'POST', body: form }),
    }));
    if (saved) { toast('Record saved.'); draw(); }
  };
  const draw = () => holder.replaceChildren(loading(async () => {
    if (!ctx.trusted) return h('div', { class: 'sx-note' }, 'Only the server owner or a trusted admin can see staff records.');
    const [data, { staff }] = await Promise.all([ctx.get('staff/records'), ctx.get('staff?days=90')]);
    return h('div', { class: 'sx-stack' },
      panel('Staff history', 'Discord staff role changes are added automatically.', dataTable([
        { label: 'Staff member', render: (r) => r.userName }, ...recordColumns,
        { label: '', render: (r) => h('div', { class: 'row actions' },
          h('button', { class: 'sx-btn small', type: 'button', onclick: () => edit(r, staff) }, 'Edit'),
          h('button', { class: 'sx-btn small danger', type: 'button', onclick: async () => {
            if (!(await confirmDialog('Remove this record?', 'The change is kept in the audit trail.', 'Remove'))) return;
            await guard(null, async () => { await api(`/api/guilds/${ctx.guildId}/staff/records/${r._id}`, { method: 'DELETE' }); toast('Record removed.'); draw(); })();
          } }, 'Remove')) },
      ], data.records, 'No records yet.')),
      panel('Audit trail', 'Every change to a staff record. This cannot be edited.', dataTable([
        { label: 'When', render: (l) => fmtDate(l.createdAt) }, { label: 'Change', render: (l) => badge(l.action) }, { label: 'By', render: (l) => l.by },
        { label: 'Reason before', clip: true, render: (l) => l.before?.reason ?? '' }, { label: 'Reason after', clip: true, render: (l) => l.after?.reason ?? '' },
      ], data.log, 'No changes yet.')));
  }));
  draw();
  const add = h('button', { class: 'sx-btn primary', type: 'button', disabled: !ctx.trusted }, icon('sx-plus'), 'Add record');
  add.addEventListener('click', guard(add, async () => {
    const { staff } = await ctx.get('staff?days=90');
    if (!staff.length) return toast('There are no staff members yet.', 'err');
    await edit(null, staff);
  }));
  return h('div', {}, head('Role History', 'Warnings, reviews, promotions and role changes.', add), holder);
}

// ---------- Reports ----------
const csvCell = (v) => { const t = v === null || v === undefined ? '' : String(v); const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t; return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
function download(name, rows) {
  const url = URL.createObjectURL(new Blob([rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reportsView(ctx, state) {
  const report = (iconName, title, text, make) => {
    const button = h('button', { class: 'sx-btn primary', type: 'button' }, 'Download CSV');
    button.addEventListener('click', guard(button, async () => { const [name, rows] = await make(); download(name, rows); toast(`${title} downloaded, ${rows.length - 1} ${rows.length === 2 ? 'row' : 'rows'}.`); }));
    const chip = h('span', { class: 'sx-stat-icon' }, icon(iconName));
    chip.style.setProperty('--tone', '#a78bfa');
    return h('article', { class: 'sx-report' }, chip, h('h2', {}, title), h('p', {}, text), button);
  };
  const slot = h('div', { class: 'sx-report-grid' },
    report('sx-users', 'Staff summary', 'Everyone\'s score, tickets, moderation and last activity.', async () => {
      const { staff } = await ctx.get(`staff?${rangeParams(state)}`);
      return ['zytheron-staff-summary.csv', [['Name', 'Discord ID', 'Group', 'Score', 'Tickets handled', 'Tickets resolved', 'Moderation actions', 'Average response (min)', 'Average rating', 'Active days', 'Status', 'Last active'], ...staff.map((r) => [r.name, r.userId, TIERS[r.tier], r.score, r.handled, r.resolved, r.cases, r.avgResponseMin === null ? '' : Math.round(r.avgResponseMin), r.averageRating === null ? '' : r.averageRating.toFixed(1), r.activeDays, r.status, r.lastActive])]];
    }),
    report('tickets', 'Ticket report', 'Each ticket with its response and resolution times.', async () => {
      const d = await ctx.get(`staff/tickets?${rangeParams(state)}`);
      return ['zytheron-ticket-report.csv', [['Ticket', 'Member', 'Subject', 'Status', 'First response (min)', 'Resolved in (min)', 'Rating', 'Opened'], ...d.list.map((t) => [t.number, t.owner, t.subject, t.status, t.firstResponseMin === null ? '' : Math.round(t.firstResponseMin), t.resolutionMin === null ? '' : Math.round(t.resolutionMin), t.rating, t.openedAt])]];
    }),
    report('moderation', 'Moderation report', 'Each case with its staff member, target and reason.', async () => {
      const d = await ctx.get(`staff/moderation?${rangeParams(state)}`);
      return ['zytheron-moderation-report.csv', [['Case', 'Staff member', 'Action', 'Target', 'Reason', 'When', 'Status'], ...d.recent.map((c) => [c.caseId, c.staff, c.type, c.target, c.reason, c.at, c.status])]];
    }));
  return h('div', {}, head('Reports', 'Download your staff data as a spreadsheet. Up to the newest 100 tickets or cases per report.', rangeFilter(state, () => undefined)), slot);
}

// ---------- Settings ----------
function settingsView(ctx) {
  return loading(async () => {
    const cfg = await ctx.get('config/staff');
    const save = h('button', { class: 'sx-btn primary', type: 'button', disabled: !ctx.trusted }, 'Save settings');
    save.addEventListener('click', guard(save, async () => { await api(`/api/guilds/${ctx.guildId}/config/staff`, { method: 'PUT', body: { activeWithinDays: cfg.activeWithinDays, weights: cfg.weights } }); toast('Settings saved.'); }));
    return h('div', { class: 'sx-stack' },
      head('Settings', 'How activity and scores are worked out.'),
      ctx.trusted ? null : h('div', { class: 'sx-note' }, 'Only the server owner or a trusted admin can change these settings.'),
      panel('Activity', null, fieldGrid([{ path: 'activeWithinDays', label: 'Counts as active after recorded work within (days)', type: 'number', min: 1, max: 90 }], cfg, ctx)),
      panel('Performance score', 'Each part is worth this share. Parts with no data are skipped and their share is spread over the rest. Someone with only activity gets no score. The number of punishments never raises a score.', fieldGrid([
        { path: 'weights.quality', label: 'Ticket resolution quality (%)', type: 'number', min: 0, max: 100, help: 'Member star ratings, or the share of handled tickets resolved when there are none' },
        { path: 'weights.response', label: 'Response time (%)', type: 'number', min: 0, max: 100, help: 'Against the group\'s response target' },
        { path: 'weights.moderation', label: 'Moderation quality (%)', type: 'number', min: 0, max: 100, help: 'Punishments with a written reason that nobody else undid within a week' },
        { path: 'weights.activity', label: 'Consistency (%)', type: 'number', min: 0, max: 100, help: 'Active days against the group\'s target' },
      ], cfg, ctx), h('div', { class: 'sx-actions-row' }, save)));
  });
}

// ---------- The section's own frame ----------
const state = { preset: '30', from: '', to: '', person: '' };

function renderView(ctx, view, id) {
  switch (view) {
    case 'roles': return id ? roleDetailView(ctx, state, id) : rolesView(ctx, state);
    case 'permissions': return permissionsView();
    case 'members': return id ? profileView(ctx, state, id) : membersView(ctx, state);
    case 'analytics': return analyticsView(ctx, state);
    case 'tickets': return ticketsView(ctx, state);
    case 'moderation': return moderationView(ctx, state);
    case 'activity': return activityView(ctx, state);
    case 'goals': return goalsView(ctx);
    case 'compare': return compareView(ctx, state);
    case 'history': return historyView(ctx);
    case 'reports': return reportsView(ctx, state);
    case 'settings': return settingsView(ctx);
    default: return overviewView(ctx, state);
  }
}

/** Finds a staff page or person. People load the first time the search is used. */
function staffSearch(ctx) {
  const results = h('div', { class: 'sx-search-results', hidden: true });
  const input = h('input', { type: 'search', placeholder: 'Search...', 'aria-label': 'Search staff pages and people' });
  let people = null;
  const close = () => { results.hidden = true; input.value = ''; };
  input.addEventListener('focus', () => { people ??= ctx.get('staff?days=90').then((d) => d.staff).catch(() => []); });
  input.addEventListener('input', async () => {
    const text = input.value.trim().toLowerCase();
    if (!text) { results.hidden = true; return; }
    const list = await (people ?? []);
    const pages = NAV.flatMap((g) => g.items).filter(([, label]) => label.toLowerCase().includes(text)).map(([id, label, ic]) => h('a', { href: `${ctx.base}/${id}`, onclick: close }, icon(ic), label));
    const found = list.filter((p) => `${p.name} ${p.userId}`.toLowerCase().includes(text)).slice(0, 6).map((p) => h('a', { href: `${ctx.base}/members/${p.userId}`, onclick: close }, avatar(p, 'sx-avatar tiny'), p.name));
    results.replaceChildren(...(pages.length || found.length ? [...pages, ...found] : [h('p', {}, 'Nothing found')]));
    results.hidden = false;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); input.blur(); }
    if (e.key === 'Enter') results.querySelector('a')?.click();
  });
  input.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 150));
  const shortcut = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.focus(); } };
  document.addEventListener('keydown', shortcut);
  ctx.cleanups.push(() => document.removeEventListener('keydown', shortcut));
  return h('div', { class: 'sx-top-search' }, icon('search'), input, h('kbd', {}, 'Ctrl+K'), results);
}

/** Staff Performance sits in the shared frame, with its own menu. Everything shown comes from the existing APIs. */
export function staffApp(opts) {
  const { guild, guildId, resources, cleanups, path, overview, rerender } = opts;
  // Older links went straight to a person.
  const first = /^\d{17,20}$/.test(path[0] ?? '') ? 'members' : path[0] || 'overview';
  const id = /^\d{17,20}$/.test(path[0] ?? '') ? path[0] : path[1];
  const base = `#/g/${guildId}/staff`;
  const ctx = { guildId, guild, resources, cleanups, base, trusted: false, rerender, get: (p) => api(`/api/guilds/${guildId}/${p}`) };
  const link = ([view, label, ic]) => {
    const active = view === first;
    return h('a', { class: `sx-nav ${active ? 'active' : ''}`, href: `${base}/${view}`, 'aria-current': active ? 'page' : undefined }, icon(ic), h('span', {}, label));
  };
  const home = `#/g/${guildId}/home`;
  const { root, main } = appShell({
    ...opts,
    serverLink: (g) => `#/g/${g.id}/staff`,
    search: staffSearch(ctx),
    nav: [
      h('div', { class: 'sx-nav-group' }, h('a', { class: 'sx-nav', href: home }, icon('sx-home'), h('span', {}, 'Dashboard'))),
      NAV.map((group) => h('div', { class: 'sx-nav-group' }, h('p', {}, group.title), group.items.map(link))),
    ],
    crumbs: [h('a', { href: home }, 'Dashboard'), h('a', { href: `${base}/overview` }, guild.name), h('b', {}, id && first === 'members' ? 'Staff profile' : id && first === 'roles' ? TIERS[id] ?? 'Role' : VIEW_LABEL[first] ?? 'Overview')],
  });
  overview.then((o) => {
    ctx.trusted = o.access.isTrusted;
    main.replaceChildren(renderView(ctx, first, id));
  }).catch((err) => { showError(err); main.replaceChildren(h('div', { class: 'sx-note danger' }, err.message)); });
  return root;
}
