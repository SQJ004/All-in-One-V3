import { api, ApiError, fmtAgo, h, icon, setCsrf, showError } from './lib.js';
import { botSettingsPage } from './botSettings.js';
import { botCommandsPage, modulePage } from './commandManager.js';
import { docsView } from './docs.js';
import { landingView, legalView } from './landing.js';
import { serverHomePage } from './home.js';
import { appShell } from './shell.js';
import { auditLogsPage, backupPage, botIdentityPage, premiumPage } from './platform.js';
import { staffApp } from './staff.js';
import { antiNukePage, antiRaidPage, antiWebhookPage } from './protection.js';
import { automationPage, commandsPage, embedBuilderPage, loggingPage, moderationPage, overviewPage, rolesPage, securityPage, settingsPage, ticketsPage, welcomePage } from './pages.js';

const app = document.getElementById('app');

const NAV_GROUPS = [
  { items: [['home', 'Server Home', serverHomePage]] },
  { title: 'SETTINGS', items: [['overview', 'Overview', overviewPage], ['bot-settings', 'Bot settings', botSettingsPage], ['settings', 'Server settings', settingsPage], ['bot-commands', 'All commands', botCommandsPage]] },
  { title: 'PREMIUM', premium: true, items: [['premium', 'All premium features', premiumPage], ['anti-nuke', 'Anti-Nuke', antiNukePage], ['anti-raid', 'Anti-Raid', antiRaidPage], ['anti-webhook', 'Anti-Webhook', antiWebhookPage], ['backup', 'Server Backup & Restore', backupPage], ['tickets', 'Advanced Ticket System', ticketsPage], ['bot-identity', 'Custom Bot Identity', botIdentityPage], ['audit-logs', 'Advanced Audit Logs', auditLogsPage], ['staff', 'Staff Performance', null]] },
  { title: 'MODERATION', items: [['security', 'Security', securityPage], ['moderation', 'Moderation', moderationPage], ['logging', 'Logs', loggingPage]] },
  { title: 'ROLES', items: [['roles', 'Auto roles', rolesPage]] },
  { title: 'MESSAGES', items: [['welcome', 'Welcome & goodbye', welcomePage], ['embeds', 'Embed builder', embedBuilderPage]] },
  { title: 'CUSTOM COMMANDS', items: [['commands', 'Custom commands', commandsPage], ['automation', 'Automation', automationPage]] },
  { title: 'UTILITY', items: [['utility', 'Utility', modulePage('Utility')], ['music', 'Music', modulePage('Music')], ['fun', 'Fun', modulePage('Fun')]] },
];
const NAV = NAV_GROUPS.flatMap((group) => group.items);

let me = null;
let guilds = null;
let cleanups = [];
let menuCollapsed = false;
const collapsedGroups = new Set();

let overviewCache = null;
const OVERVIEW_CACHE_MS = 30_000;
/** Used for the sidebar badge and online dot, so it is not fetched again for every page. */
const overviewFor = (guildId) => {
  if (overviewCache?.guildId !== guildId || Date.now() - overviewCache.at > OVERVIEW_CACHE_MS) overviewCache = { guildId, at: Date.now(), data: api(`/api/guilds/${guildId}/overview`) };
  overviewCache.data.catch(() => { overviewCache = null; });
  return overviewCache.data;
};

const runCleanups = () => { cleanups.forEach((fn) => fn()); cleanups = []; };

const avatarUrl = (u) => (u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null);
const initials = (name) => name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

/** Public facts for the homepage. The page still renders if this request fails. */
let publicCache = null;
const publicInfo = async () => (publicCache ??= await api('/api/public').catch(() => ({})));

async function homeView() {
  const info = await publicInfo();
  app.replaceChildren(landingView({ info, user: me, cleanups }));
}

const logout = async () => {
  await api('/auth/logout', { method: 'POST' }).catch(showError);
  me = null; guilds = null;
  location.hash = '#/home';
  route();
};

const guildIcon = (g, className) => (g.icon ? h('img', { class: className, src: g.icon, alt: '' }) : h('span', { class: className }, initials(g.name)));

/** A small menu opened by a picture in the top bar. */
function dropdown(label, face, items) {
  const menu = h('details', { class: 'dash-drop' }, h('summary', { 'aria-label': label }, face, h('i', { 'aria-hidden': 'true' }, '▾')), h('div', { class: 'dash-drop-menu' }, items));
  const closeOutside = (e) => { if (!menu.contains(e.target)) menu.open = false; };
  document.addEventListener('click', closeOutside);
  cleanups.push(() => document.removeEventListener('click', closeOutside));
  return menu;
}

/** The small account picture. Links that used to be in the top bar live here now. */
function userMenu() {
  const url = avatarUrl(me);
  const info = publicCache ?? {};
  return dropdown('Your account', url ? h('img', { class: 'avatar', src: url, alt: '' }) : h('span', { class: 'avatar' }, initials(me.username)), [
    h('p', { class: 'dash-drop-name' }, me.username),
    h('a', { href: '#/' }, 'All servers'),
    h('a', { href: '#/home' }, 'Homepage'),
    h('a', { href: '#/docs' }, 'Docs'),
    h('a', { href: '#/docs/commands' }, 'Command list'),
    h('a', { href: '#/docs/premium' }, 'About Premium'),
    info.inviteUrl ? h('a', { href: info.inviteUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Invite the bot') : null,
    info.supportUrl ? h('a', { href: info.supportUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Discord server') : null,
    h('button', { type: 'button', onclick: logout }, 'Sign out'),
  ]);
}

/** Finds a dashboard page by name. */
function pageSearch(guild) {
  const results = h('div', { class: 'sx-search-results', hidden: true });
  const input = h('input', { type: 'search', placeholder: 'Search...', 'aria-label': 'Search pages' });
  const close = () => { results.hidden = true; input.value = ''; };
  input.addEventListener('input', () => {
    const text = input.value.trim().toLowerCase();
    const found = text ? NAV.filter(([, label]) => label.toLowerCase().includes(text)).slice(0, 8) : [];
    results.replaceChildren(...(found.length ? found.map(([id, label]) => h('a', { href: `#/g/${guild.id}/${id}`, onclick: close }, icon(id), label)) : [h('p', {}, 'No matching page')]));
    results.hidden = !text;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); input.blur(); }
    if (e.key === 'Enter') results.querySelector('a')?.click();
  });
  input.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 150));
  const shortcut = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.focus(); } };
  document.addEventListener('keydown', shortcut);
  cleanups.push(() => document.removeEventListener('keydown', shortcut));
  return h('div', { class: 'sx-top-search' }, icon('search'), input, h('kbd', {}, 'Ctrl+K'), results);
}

let noteCache = null;
const NOTE_CACHE_MS = 30_000;

/** The bell shows real security events. */
function notifications(guild) {
  const count = h('b', { class: 'bell-count', hidden: true });
  const list = h('div', { class: 'bell-list' }, h('p', {}, 'Loading…'));
  const fresh = noteCache?.guildId === guild.id && Date.now() - noteCache.at < NOTE_CACHE_MS;
  (fresh ? Promise.resolve(noteCache.data) : api(`/api/guilds/${guild.id}/notifications`).then((data) => { noteCache = { guildId: guild.id, at: Date.now(), data }; return data; })).then((data) => {
    const urgent = data.events.filter((e) => e.severity === 'critical').length;
    count.textContent = urgent > 9 ? '9+' : String(urgent);
    count.hidden = !urgent;
    list.replaceChildren(
      ...data.events.map((e) => h('a', { href: `#/g/${guild.id}/audit-logs`, class: 'bell-item' }, h('b', {}, e.type.replace(/_/g, ' ')), h('span', {}, e.summary), h('small', {}, fmtAgo(e.at)))),
      !data.events.length ? h('p', {}, 'Nothing new.') : '');
  }).catch(() => list.replaceChildren(h('p', {}, 'Could not load notifications.')));
  return dropdown('Notifications', h('span', { class: 'bell' }, icon('bell'), count), [h('p', { class: 'dash-drop-name' }, 'Notifications'), list]);
}

/** The clean bar on the server picker. */
function topBar() {
  return h('header', { class: 'topbar' },
    h('div', { class: 'topbar-left' }, h('a', { class: 'brand', href: '#/home', title: 'ZYTHERON homepage' }, h('img', { src: '/logo.svg', alt: '' }), 'ZYTHERON')),
    h('div', { class: 'topbar-right' }, userMenu()));
}

async function pickerView() {
  guilds = await api('/api/guilds');
  await publicInfo();
  const circle = (g, present) => {
    const face = h('span', { class: `server-face ${present ? 'on' : 'off'}` }, guildIcon(g, 'server-icon'));
    const name = h('span', { class: 'server-name' }, g.name);
    return present
      ? h('a', { class: 'server-pick', href: `#/g/${g.id}`, title: `Manage ${g.name}` }, face, name)
      : h('a', { class: 'server-pick', href: g.inviteUrl, target: '_blank', rel: 'noopener noreferrer', title: `Add ZYTHERON to ${g.name}` }, face, name);
  };
  const ordered = [...guilds.filter((g) => g.botPresent), ...guilds.filter((g) => !g.botPresent)];
  app.replaceChildren(h('div', { class: 'picker-page' },
    topBar(),
    h('div', { class: 'picker-backdrop', 'aria-hidden': 'true' }),
    h('main', { class: 'server-panel' },
      h('header', { class: 'settings-card-head' }, icon('logging'), 'Server picker'),
      h('div', { class: 'server-panel-body' },
        h('h1', {}, `Hello, ${me.username}! Please select a server to get started`),
        ordered.length
          ? h('div', { class: 'server-grid' }, ordered.map((g) => circle(g, g.botPresent)))
          : h('p', { class: 'server-empty' }, 'You have no servers where you have the Manage Server permission.'),
        h('p', { class: 'server-legend' }, h('span', { class: 'server-dot on' }), 'ZYTHERON is in this server', h('span', { class: 'server-dot off' }), 'Click to add ZYTHERON')))));
}

function sideMenu(guild, activeId) {
  const statusNodes = new Map();
  const link = ([id, label], premium) => {
    const mark = premium ? h('span', { class: 'sx-crown', 'aria-hidden': 'true' }, icon('sx-crown')) : h('span', { class: 'nav-status' });
    if (!premium) statusNodes.set(id, mark);
    const active = id === activeId;
    return h('a', { class: `sx-nav ${premium ? 'premium' : ''} ${active ? 'active' : ''}`, href: `#/g/${guild.id}/${id}`, 'aria-current': active ? 'page' : undefined }, icon(id), h('span', {}, label), mark);
  };
  const group = ({ title, items, premium }) => {
    if (!title) return h('div', { class: 'sx-nav-group' }, items.map((item) => link(item, premium)));
    const open = premium || items.some(([id]) => id === activeId) || !collapsedGroups.has(title);
    const list = h('div', { class: 'sx-nav-items', hidden: !open }, items.map((item) => link(item, premium)));
    const toggle = h('button', { class: `sx-nav-head ${premium ? 'premium' : ''}`, type: 'button', 'aria-expanded': String(open), onclick: () => {
      const next = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(next));
      list.hidden = !next;
      if (next) collapsedGroups.delete(title); else collapsedGroups.add(title);
    } }, h('span', {}, title), h('i', { 'aria-hidden': 'true' }, '›'));
    return h('section', { class: 'sx-nav-group' }, toggle, list);
  };
  return { panel: NAV_GROUPS.map(group), statusNodes };
}

/** Ticks in the menu come from the server's real settings. A failed check just shows nothing. */
const statusCache = new Map();

async function refreshStatus(guildId, statusNodes, force = false) {
  const paint = (id, on) => {
    const node = statusNodes.get(id);
    if (!node) return;
    node.className = `nav-status ${on ? 'on' : 'off'}`;
    node.title = on ? 'On' : 'Off';
    node.setAttribute('aria-label', node.title);
  };
  const known = statusCache.get(guildId);
  if (known && !force) { for (const [id, on] of known) paint(id, on); return; }
  const seen = new Map();
  statusCache.set(guildId, seen);
  const config = (section) => api(`/api/guilds/${guildId}/config/${section}`).catch(() => null);
  const show = (id, on) => { seen.set(id, on); paint(id, on); };
  await Promise.all(['security', 'welcome', 'logging', 'tickets'].map(async (section) => {
    const value = await config(section);
    if (value) show(section, Boolean(value.enabled));
  }));
  const security = await config('security');
  if (security) {
    show('anti-nuke', security.enabled && security.antiNuke.enabled);
    show('anti-raid', security.enabled && security.antiRaid.enabled);
    show('anti-webhook', security.enabled && security.antiWebhook.enabled);
  }
  const backup = await config('backup');
  if (backup) show('backup', backup.autoEnabled);
  const [commands, list] = await Promise.all([config('commands'), api(`/api/guilds/${guildId}/command-list`).catch(() => null)]);
  if (!commands || !list) return;
  for (const [id, category] of [['utility', 'Utility'], ['music', 'Music'], ['fun', 'Fun']]) {
    show(id, list.some((c) => c.category === category && !commands.disabled.includes(c.name)));
  }
}

async function guildView(guildId, pageId, sub) {
  if (!guilds) guilds = await api('/api/guilds');
  const guild = guilds.find((g) => g.id === guildId);
  if (!guild?.botPresent) { location.hash = '#/'; return; }
  const entry = NAV.find(([id]) => id === pageId) ?? NAV[0];

  const info = await publicInfo();
  const overview = overviewFor(guildId);
  const shellParts = { guild, guilds, me, info, overview, dropdown, logout, collapsed: menuCollapsed, onCollapse: (value) => { menuCollapsed = value; } };
  if (entry[0] === 'staff') {
    // Staff Performance fills the same frame, with its own menu.
    const resources = await api(`/api/guilds/${guildId}/resources`);
    app.replaceChildren(staffApp({ ...shellParts, guildId, resources, cleanups, path: sub ?? [], bell: notifications(guild), account: userMenu(), rerender: () => route() }));
    return;
  }
  const { panel, statusNodes } = sideMenu(guild, entry[0]);
  const { root, main } = appShell({
    ...shellParts, nav: panel, search: pageSearch(guild), bell: notifications(guild), account: userMenu(),
    crumbs: [h('a', { href: `#/g/${guildId}/home` }, 'Dashboard'), h('a', { href: `#/g/${guildId}/home` }, guild.name), h('b', {}, entry[1])],
  });
  app.replaceChildren(root);

  const status = (force) => refreshStatus(guildId, statusNodes, force);
  void status();
  const resources = await api(`/api/guilds/${guildId}/resources`);
  const ctx = { guildId, guild, overview, resources, cleanups, rerender: () => route(), refreshStatus: () => status(true) };
  try {
    main.replaceChildren(await entry[2](ctx));
  } catch (err) {
    showError(err);
    main.replaceChildren(h('div', { class: 'sx-note danger' }, err.message));
  }
}

async function loadUser() {
  if (me) return;
  const { signedIn } = await api('/api/public/session');
  if (!signedIn) return;
  me = await api('/api/me');
  setCsrf(me.csrf);
}

async function route() {
  runCleanups();
  window.scrollTo(0, 0);
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  try {
    if (parts[0] === 'docs') {
      await loadUser();
      app.replaceChildren(docsView({ page: parts[1], info: await publicInfo(), user: me, cleanups }));
      return;
    }
    if (parts[0] === 'terms' || parts[0] === 'privacy') {
      await loadUser();
      app.replaceChildren(legalView({ page: parts[0], info: await publicInfo(), user: me }));
      return;
    }
    await loadUser();
    // Opening the bare address always shows the homepage. Signed-in people reach the dashboard at #/.
    if (!location.hash || parts[0] === 'home' || !me) await homeView();
    else if (parts[0] === 'g' && parts[1]) await guildView(parts[1], parts[2], parts.slice(3));
    else await pickerView();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { me = null; return homeView(); }
    if (err instanceof ApiError && err.status === 403) { location.hash = '#/'; return showError(err); }
    showError(err);
  }
}

window.addEventListener('hashchange', route);
route();
