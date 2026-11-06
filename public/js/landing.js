import { api, h, icon, modal, svg } from './lib.js';
import { PREMIUM } from './site-config.js';

// The public homepage, and the parts it shares with the docs in docs.js. Stats and commands
// come from the running bot. The wording describes real features, so update it when they change.

const BLURB = 'Your all-in-one Discord bot for a smarter, safer and more entertaining community.';
const STATS_REFRESH_MS = 30_000;
const COMMANDS_SHOWN = 12;

const FEATURES = [
  { icon: 'lock', color: '#8b5cf6', doc: 'security', title: 'Security', body: 'Anti-nuke, anti-raid, scam link detection and emergency lockdown. It starts in monitor mode, so nobody is punished until you are ready.' },
  { icon: 'shield', color: '#ff6464', doc: 'moderation', title: 'Moderation', body: 'Bans, tempbans, timeouts, warnings, jail, purge and channel locks, with case history and staff notes.' },
  { icon: 'robot', color: '#00c4a7', doc: 'automod', title: 'Auto Moderation', body: 'Filter banned words, excessive capitals, invites and chosen domains automatically.' },
  { icon: 'clipboard', color: '#4f8cff', doc: 'logging', title: 'Logging', body: 'Messages, members, roles, channels, voice, bans and invites, with permission names and who made each change.' },
  { icon: 'note', color: '#ec4dd8', doc: 'music', title: 'Music', body: 'Search songs or play audio links in voice, with a live player, queue, loop, shuffle, seek and lyrics.' },
  { icon: 'door', color: '#ff7eb6', doc: 'welcome', title: 'Welcome & Goodbye', body: 'Greet members with embeds and generated image cards, plus goodbye messages and DMs.' },
  { icon: 'ticket', color: '#ffb000', doc: 'tickets', title: 'Tickets', body: 'Private support channels with panels, categories, claiming, transcripts and ratings.' },
  { icon: 'key', color: '#a78bfa', doc: 'roles', title: 'Roles', body: 'Auto roles, reaction, button and menu panels, temporary roles and self roles.' },
  { icon: 'star', color: '#00bfff', doc: 'community', title: 'Levels & Engagement', body: 'XP and role rewards, giveaways, polls, suggestions, starboard and birthdays.' },
  { icon: 'message', color: '#22c55e', doc: 'embeds', title: 'Embed Builder', body: 'Publish with one command, or use the editor for fields, buttons, menus and saved templates.' },
  { icon: 'terminal', color: '#ffd000', doc: 'automation', title: 'Automation', body: 'Auto responses, custom commands, scheduled messages, and rules that link a trigger to an action.' },
  { icon: 'grid', color: '#6c7bff', doc: 'dashboard', title: 'Web Dashboard', body: 'Sign in with Discord to change settings, switch commands on or off, and add aliases with any prefix.' },
];

const COMMAND_FILTERS = ['All Commands', 'Moderation', 'Utility', 'Fun', 'Economy', 'Music', 'Admin'];
const PLANNED_FILTERS = new Set(['Economy']);

const STEPS = [
  ['Click Add to Discord', 'Discord opens its own authorization page for ZYTHERON.'],
  ['Select your Discord server', 'Choose a server where you have the Manage Server permission.'],
  ['Authorize the required permissions', 'Approve them, then run /setup in your server to check everything is ready.'],
];

const LEGAL = {
  terms: {
    title: 'Terms of Service',
    sections: [
      ['Using ZYTHERON', "By adding ZYTHERON to a server, you agree to these terms and to Discord's own Terms of Service and Community Guidelines."],
      ['Your responsibility', 'You are responsible for how ZYTHERON is configured on your server and for the moderation actions taken there. Do not use ZYTHERON to break the law or to harm other people.'],
      ['Availability', 'We work to keep ZYTHERON running, but it is provided as is, and features can change or be interrupted.'],
      ['Ending access', 'You can remove ZYTHERON from your server at any time. We can restrict access if these terms are broken.'],
    ],
  },
  privacy: {
    title: 'Privacy Policy',
    sections: [
      ['What we store', 'IDs for your server, channels and users, your settings, and the features you use, such as moderation cases, tickets, levels, birthdays and profiles. The dashboard keeps a list of who changed what for 90 days.'],
      ['Message content', 'ZYTHERON reads messages to run automod, levels and auto responses. It does not keep ordinary messages. Messages flagged by security are saved as a short excerpt in the security log for up to 90 days, and logging and ticket transcripts post to channels on your own server.'],
      ['What we do not do', 'We do not sell your data, and we do not record voice channels.'],
      ['How long we keep it', 'Server data is kept while ZYTHERON is in your server, and can be deleted on request after it leaves.'],
      ['Your choices', 'You can remove ZYTHERON at any time, and you can ask us for a copy or deletion of your data through our Discord server.'],
    ],
  },
};

const DISCORD_PATH = 'M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z';
const discordIcon = () => svg('svg', { viewBox: '0 0 24 24', fill: 'currentColor', class: 'lp-discord', 'aria-hidden': 'true' }, svg('path', { d: DISCORD_PATH }));

const prefersReduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const scrollBehavior = () => (prefersReduced() ? 'auto' : 'smooth');
const external = { target: '_blank', rel: 'noopener noreferrer' };

/** Set when a section link is used on another page, then scrolled to once the homepage opens. */
let pendingSection = null;

/** Section links scroll in place, because the hash in the address bar is used for page routing. */
function sectionLink(id, label, className = '', onclick) {
  return h('a', { class: className, href: '#/home', onclick: (e) => {
    onclick?.();
    const target = document.getElementById(id);
    if (!target) { pendingSection = id; return; }
    e.preventDefault();
    target.scrollIntoView({ behavior: scrollBehavior() });
  } }, label);
}

/** Runs once the command list has its final height, so the page does not shift after scrolling. */
function scrollToPending() {
  if (pendingSection) document.getElementById(pendingSection)?.scrollIntoView();
  pendingSection = null;
}

function notice(title, text) {
  return modal(title, () => ({ node: h('p', {}, text), submit: () => true }), { submitLabel: 'Got it', cancellable: false });
}

export function inviteLink(info, label, className = '') {
  if (info.inviteUrl) return h('a', { class: `lp-btn lp-primary ${className}`, href: info.inviteUrl, ...external }, label);
  return h('button', { class: `lp-btn lp-primary ${className}`, type: 'button', onclick: () => notice('Invite link unavailable', 'The invite link could not be loaded. Reload the page and try again.') }, label);
}

/** Opens the real server invite, or says plainly that none has been set. It never makes one up. */
export function discordLink(info, label, className = '') {
  if (info.supportUrl) return h('a', { class: className, href: info.supportUrl, ...external }, label);
  return h('button', { class: className, type: 'button', onclick: () => notice('Discord server not linked yet', 'ZYTHERON does not have a Discord server link yet. Site owner: put your server invite in SUPPORT_URL in the .env file, then restart.') }, label);
}

const reveal = (node) => { node.classList.add('lp-reveal'); return node; };
const plannedBadge = () => h('span', { class: 'lp-planned' }, 'Planned');
const sectionHead = (eyebrow, title, body) => reveal(h('div', { class: 'lp-head' }, h('p', { class: 'lp-eyebrow' }, eyebrow), h('h2', {}, title), body ? h('p', { class: 'lp-head-body' }, body) : null));

// ---------- Navigation ----------
export function header(info, user) {
  const links = (close) => [
    sectionLink('home', 'Home', '', close),
    sectionLink('features', 'Features', '', close),
    h('a', { href: '#/docs', onclick: close }, 'Docs'),
    h('a', { href: '#/docs/commands', onclick: close }, 'Commands'),
    h('a', { href: '#/docs/premium', onclick: close }, 'Premium'),
    h('a', { href: '#/docs/support', onclick: close }, 'Support'),
    discordLink(info, 'Discord Server', 'lp-nav-button'),
  ];
  const account = () => (user
    ? h('a', { class: 'lp-btn lp-ghost', href: '#/' }, 'Dashboard')
    : h('a', { class: 'lp-btn lp-ghost', href: '/auth/login' }, discordIcon(), 'Login with Discord'));
  const root = h('header', { class: 'lp-header' });
  const setOpen = (open) => {
    root.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    toggle.textContent = open ? '✕' : '☰';
  };
  const toggle = h('button', { class: 'lp-menu', type: 'button', 'aria-label': 'Open menu', 'aria-expanded': 'false', onclick: () => setOpen(!root.classList.contains('open')) }, '☰');
  const close = () => setOpen(false);
  root.append(
    h('div', { class: 'lp-bar' },
      sectionBrand(close),
      h('nav', { 'aria-label': 'Main' }, links()),
      h('div', { class: 'lp-bar-actions' }, account(), inviteLink(info, 'Invite Bot'), toggle)),
    h('nav', { class: 'lp-drawer', 'aria-label': 'Mobile' }, links(close), account(), inviteLink(info, 'Invite Bot')));
  return root;
}

function sectionBrand(onclick) {
  const brand = sectionLink('home', ['ZYTHERON'], 'brand lp-brand', onclick);
  brand.prepend(h('img', { src: '/logo.svg', alt: '' }));
  return brand;
}

// ---------- Hero ----------
const BARS = 132;
const ARMS = 3;
const PARTICLES = 150;

/** Decorative levels: slow swells, a pulse, and fast shimmer. Not tied to any real data. */
function levelAt(i, t) {
  const a = (i / BARS) * Math.PI * 2;
  const pulse = Math.max(0, Math.sin(t * 4.2)) ** 6;
  return 0.14 + (0.5 + 0.5 * Math.sin(a * 3 + t * 1.3)) * 0.36 + (0.5 + 0.5 * Math.sin(a * 11 - t * 3.1)) * 0.24 + (0.5 + 0.5 * Math.sin(a * 29 + t * 6.7)) * 0.12 + pulse * 0.3;
}

function drawVortex(ctx, size, t) {
  const c = size / 2;
  const inner = size * 0.205;
  ctx.clearRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (let arm = 0; arm < ARMS; arm++) {
    for (let k = 0; k < PARTICLES; k++) {
      const fall = 1 - ((k / PARTICLES + t * 0.035) % 1);
      const radius = inner * 0.95 + fall * fall * size * 0.3;
      const angle = (arm / ARMS) * Math.PI * 2 + fall * 4.6 + t * 0.14;
      ctx.fillStyle = `hsla(${270 + fall * 15}, 100%, 92%, ${Math.sin(fall * Math.PI) * 0.6})`;
      ctx.beginPath();
      ctx.arc(c + Math.cos(angle) * radius, c + Math.sin(angle) * radius * 0.94, size * 0.0036 * (0.5 + fall), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.lineWidth = Math.max(1.5, size * 0.0062);
  for (let i = 0; i < BARS; i++) {
    const a = (i / BARS) * Math.PI * 2 - Math.PI / 2 + t * 0.05;
    const to = inner + 2 + levelAt(i, t) * size * 0.2;
    ctx.strokeStyle = `hsla(${272 + 14 * (0.5 + 0.5 * Math.cos(a * 2))}, 100%, 92%, .95)`;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * inner, c + Math.sin(a) * inner);
    ctx.lineTo(c + Math.cos(a) * to, c + Math.sin(a) * to);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function vortexVisual(cleanups) {
  const canvas = h('canvas', {});
  const ctx = canvas.getContext('2d');
  let size = 0;
  let frame = 0;
  let visible = true;
  let clock = 8;
  let last = performance.now();
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    size = canvas.parentElement.getBoundingClientRect().width;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawVortex(ctx, size, clock);
  };
  const loop = (now) => {
    clock += Math.min(0.05, (now - last) / 1000);
    last = now;
    drawVortex(ctx, size, clock);
    frame = requestAnimationFrame(loop);
  };
  const start = () => {
    cancelAnimationFrame(frame);
    last = performance.now();
    if (!prefersReduced() && visible && !document.hidden) frame = requestAnimationFrame(loop);
  };
  const box = h('div', { class: 'lp-vortex', 'aria-hidden': 'true' },
    canvas,
    h('div', { class: 'lp-vortex-core' }, h('img', { src: '/logo.svg', alt: '' })),
    ['/embed create', '/security lockdown on', '/ticket panel-publish'].map((name, n) => h('code', { class: `lp-chip lp-chip-${n}` }, name)));
  const resizer = new ResizeObserver(resize);
  const watcher = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; start(); });
  requestAnimationFrame(() => { if (!canvas.isConnected) return; resizer.observe(box); watcher.observe(canvas); resize(); start(); });
  document.addEventListener('visibilitychange', start);
  cleanups.push(() => {
    cancelAnimationFrame(frame);
    resizer.disconnect();
    watcher.disconnect();
    document.removeEventListener('visibilitychange', start);
  });
  return box;
}

function hero(info, cleanups) {
  return h('section', { class: 'lp-hero', id: 'home' },
    h('div', { class: 'lp-hero-grid', 'aria-hidden': 'true' }),
    h('div', { class: 'lp-wrap lp-hero-inner' },
      h('div', { class: 'lp-hero-copy' },
        h('h1', {}, 'MEET ZYTHERON'),
        h('p', { class: 'lp-lead' }, 'Your Discord server deserves something more powerful. Meet Zytheron, your all-in-one Discord bot designed to make your community smarter, safer, and more entertaining.'),
        h('div', { class: 'lp-cta' },
          inviteLink(info, ['Add to Discord'], 'lp-lg'),
          h('a', { class: 'lp-btn lp-ghost lp-lg', href: '#/docs' }, 'Read the Docs'))),
      h('div', { class: 'lp-hero-visual' }, vortexVisual(cleanups))),
    svg('svg', { class: 'lp-wave', viewBox: '0 0 1440 120', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, svg('path', { d: 'M0 120V62c170-50 330-62 520-26s330 66 520 34 280-58 400-42v92z' })));
}

// ---------- Live statistics ----------
function countUp(node, target) {
  if (prefersReduced()) { node.textContent = target.toLocaleString('en'); return; }
  const begun = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - begun) / 1200);
    node.textContent = Math.round(target * (1 - (1 - p) ** 3)).toLocaleString('en');
    if (p < 1 && node.isConnected) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function statsSection(info, cleanups) {
  const card = (iconName, label) => {
    const value = h('dd', { class: 'lp-stat-value' }, '–');
    const note = h('p', { class: 'lp-stat-note' });
    const node = h('div', { class: 'lp-stat' }, h('span', { class: 'lp-icon' }, icon(iconName)), h('dt', {}, label), value, note);
    return { node: reveal(node), value, note };
  };
  const servers = card('overview', 'Total Servers');
  const users = card('roles', 'Total Users');
  const commands = card('commands', 'Total Commands');
  const status = card('automation', 'Bot Status');
  let animated = false;

  const show = (stats) => {
    const numbers = stats ? [[servers, stats.servers], [users, stats.users], [commands, stats.commands]] : [];
    if (!stats) for (const c of [servers, users, commands]) { c.value.textContent = 'Unavailable'; c.value.classList.add('small'); }
    for (const [c, n] of numbers) {
      c.value.classList.remove('small');
      if (animated) c.value.textContent = n.toLocaleString('en'); else countUp(c.value, n);
    }
    animated = Boolean(stats);
    servers.note.textContent = stats ? 'Servers ZYTHERON is in right now' : 'Live data could not be loaded';
    users.note.textContent = stats ? 'Members across those servers' : '';
    commands.note.textContent = stats ? `${stats.subcommands.toLocaleString('en')} including subcommands` : '';
    const state = !stats ? 'unknown' : stats.online ? 'online' : 'offline';
    status.value.replaceChildren(h('i', { class: `lp-dot ${state}` }), { online: 'Online', offline: 'Offline', unknown: 'Unknown' }[state]);
    status.value.classList.add('small');
    status.note.textContent = stats ? 'Checked every 30 seconds' : '';
  };

  show(info.stats ?? null);
  const timer = setInterval(() => { api('/api/public').then((fresh) => show(fresh.stats), () => show(null)); }, STATS_REFRESH_MS);
  cleanups.push(() => clearInterval(timer));
  return h('section', { class: 'lp-wrap lp-stats-wrap', 'aria-label': 'Live bot statistics' },
    h('dl', { class: 'lp-stats' }, servers.node, users.node, commands.node, status.node));
}

// ---------- Features ----------
/** Solid white icons for the coloured tiles on the feature cards. */
const FEATURE_ICONS = {
  lock: 'M7 10V7a5 5 0 0110 0v3h1a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8a2 2 0 012-2h1zm2 0h6V7a3 3 0 00-6 0v3zm3 4a2 2 0 00-1 3.7V20h2v-2.3a2 2 0 00-1-3.7z',
  shield: 'M12 2l8 3v6c0 5.2-3.4 9.7-8 11-4.600-1.300-8-5.800-8-11V5l8-3zm0 3.200v13.700c3-1.200 5-4.400 5-7.900V7.100l-5-1.900z',
  robot: 'M11 2h2v3h4a3 3 0 013 3v9a3 3 0 01-3 3H7a3 3 0 01-3-3V8a3 3 0 013-3h4V2zM8.500 10a1.500 1.500 0 100 3 1.500 1.500 0 000-3zm7 0a1.500 1.500 0 100 3 1.500 1.500 0 000-3zM8 15.500V17h8v-1.500H8zM1 10h2v6H1v-6zm20 0h2v6h-2v-6z',
  clipboard: 'M9 2h6a1 1 0 011 1v1h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2V3a1 1 0 011-1zm1 2v2h4V4h-4zM8 10v2h2v-2H8zm4 0v2h4v-2h-4zm-4 4v2h2v-2H8zm4 0v2h4v-2h-4z',
  note: 'M21 3v13.500a3.500 3.500 0 11-2-3.160V7.600l-9 1.800v9.100a3.500 3.500 0 11-2-3.160V5l13-2z',
  door: 'M5 3h9a2 2 0 012 2v14h2V7h2a1 1 0 011 1v11h2v2H1v-2h4V3zm7 8a1.200 1.200 0 100 2.400 1.200 1.200 0 000-2.400z',
  ticket: 'M3 6h18a1 1 0 011 1v3.500a2.500 2.500 0 000 5V19a1 1 0 01-1 1H3a1 1 0 01-1-1v-3.500a2.500 2.500 0 000-5V7a1 1 0 011-1zm11 3v2h2V9h-2zm0 4v2h2v-2h-2z',
  key: 'M15 2a7 7 0 11-3.100 13.300L10 17.200V20H7.200v2.800H2v-5.200l7.700-7.700A7 7 0 0115 2zm2 3.500a1.500 1.500 0 100 3 1.500 1.500 0 000-3z',
  star: 'M12 2l3 6.600 7.200.8-5.300 4.900 1.400 7.100-6.300-3.500-6.300 3.500 1.400-7.100-5.300-4.900 7.200-.8L12 2z',
  message: 'M4 3h16a2 2 0 012 2v11a2 2 0 01-2 2h-8l-5 4v-4H4a2 2 0 01-2-2V5a2 2 0 012-2zm3 4v2h10V7H7zm0 4v2h7v-2H7z',
  terminal: 'M4 3h16a2 2 0 012 2v14a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2zm2.500 4L5 8.500 8.500 12 5 15.500 6.500 17l5-5-5-5zM12 15v2h7v-2h-7z',
  grid: 'M3 3h8v10H3V3zm10 0h8v6h-8V3zM3 15h8v6H3v-6zm10-4h8v10h-8V11z',
};
const featureIcon = (name) => svg('svg', { viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' }, svg('path', { d: FEATURE_ICONS[name], 'fill-rule': 'evenodd' }));

function featuresSection() {
  const glow = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--x', `${e.clientX - box.left}px`);
    e.currentTarget.style.setProperty('--y', `${e.clientY - box.top}px`);
  };
  return h('section', { class: 'lp-section lp-wrap', id: 'features' },
    sectionHead('Features', 'Why ZYTHERON?', 'One bot for protecting your server, helping your staff and keeping your community active.'),
    h('div', { class: 'lp-features' }, FEATURES.map((f) => reveal(h('article', { class: `lp-feature ${f.planned ? 'is-planned' : ''}`, onmousemove: glow },
      h('span', { class: 'lp-icon solid', style: `--c:${f.color}` }, featureIcon(f.icon)),
      h('h3', {}, f.title),
      h('p', {}, f.body),
      h('a', { class: 'lp-more', href: `#/docs/${f.doc}`, 'aria-label': `Learn more about ${f.title}` }, 'Learn more →'))))));
}

// ---------- Commands ----------
export function commandCard(c) {
  return h('article', { class: 'lp-command' },
    h('code', { class: 'lp-command-name' }, c.name),
    h('p', {}, c.description),
    h('p', { class: 'lp-usage' }, h('span', {}, 'Usage'), h('code', {}, c.usage), c.prefixUsage ? h('code', {}, c.prefixUsage) : null),
    h('p', { class: 'lp-perms' }, c.requirement ? h('span', {}, c.requirement) : null, c.permissions.map((p) => h('span', {}, p)), !c.requirement && !c.permissions.length ? h('span', { class: 'open' }, 'No permission needed') : null));
}

export function commandsSection({ heading = true } = {}) {
  const state = { query: '', filter: COMMAND_FILTERS[0], expanded: false, list: null };
  const grid = h('div', { class: 'lp-command-grid' });
  const count = h('p', { class: 'lp-count', role: 'status' });
  const more = h('button', { class: 'lp-btn lp-ghost lp-lg', type: 'button', onclick: () => {
    state.expanded = !state.expanded;
    render();
    if (!state.expanded) document.getElementById('commands')?.scrollIntoView({ behavior: scrollBehavior() });
  } });
  const filterButtons = new Map();

  const load = () => {
    grid.replaceChildren(h('p', { class: 'lp-empty' }, 'Loading commands…'));
    api('/api/public/commands').then((res) => { state.list = res.commands; render(); scrollToPending(); }, () => {
      scrollToPending();
      count.textContent = '';
      more.hidden = true;
      grid.replaceChildren(h('div', { class: 'lp-empty' }, h('p', {}, 'The command list could not be loaded.'), h('button', { class: 'lp-btn lp-ghost', type: 'button', onclick: load }, 'Try again')));
    });
  };

  function render() {
    if (!state.list) return;
    const q = state.query.trim().toLowerCase();
    const inFilter = (c, filter) => filter === COMMAND_FILTERS[0] || c.category === filter;
    const matches = (c) => !q || `${c.name} ${c.description} ${c.usage}`.toLowerCase().includes(q);
    for (const [filter, button] of filterButtons) {
      button.setAttribute('aria-pressed', String(filter === state.filter));
      button.querySelector('small').textContent = PLANNED_FILTERS.has(filter) ? 'Planned' : state.list.filter((c) => inFilter(c, filter) && matches(c)).length;
    }
    const found = state.list.filter((c) => inFilter(c, state.filter) && matches(c));
    const shown = state.expanded ? found : found.slice(0, COMMANDS_SHOWN);
    grid.replaceChildren(...shown.map(commandCard));
    count.textContent = found.length ? `Showing ${shown.length} of ${found.length} commands` : '';
    if (!found.length) {
      grid.replaceChildren(h('p', { class: 'lp-empty' }, PLANNED_FILTERS.has(state.filter) ? `${state.filter} is planned. ZYTHERON has no ${state.filter.toLowerCase()} commands yet, so none are listed.` : `No commands match "${state.query.trim()}".`));
    }
    more.hidden = found.length <= COMMANDS_SHOWN;
    more.textContent = state.expanded ? 'SHOW FEWER' : 'VIEW ALL COMMANDS';
  }

  const search = h('input', { type: 'search', placeholder: 'Search commands', 'aria-label': 'Search commands', autocomplete: 'off', oninput: (e) => { state.query = e.target.value; state.expanded = false; render(); } });
  const filters = h('div', { class: 'lp-filters', role: 'group', 'aria-label': 'Command categories' }, COMMAND_FILTERS.map((filter) => {
    const button = h('button', { type: 'button', onclick: () => { state.filter = filter; state.expanded = false; render(); } }, filter, ' ', h('small', {}));
    filterButtons.set(filter, button);
    return button;
  }));
  load();
  return h('section', { class: 'lp-section lp-commands-section', id: 'commands' },
    h('div', { class: 'lp-wrap' },
      heading ? sectionHead('Commands', 'EXPLORE OUR COMMANDS', 'This list comes straight from the bot, so it always shows what ZYTHERON can really run.') : null,
      reveal(h('div', { class: 'lp-command-tools' }, h('label', { class: 'lp-search' }, icon('search'), search), filters)),
      count, grid,
      h('div', { class: 'lp-center' }, more)));
}

// ---------- Community, invite and premium ----------
export function communitySection(info) {
  const line = (width) => h('i', { style: `width:${width}%` });
  return h('section', { class: 'lp-section lp-wrap', id: 'community' },
    reveal(h('div', { class: 'lp-community' },
      h('div', { class: 'lp-community-copy' },
        h('p', { class: 'lp-eyebrow' }, 'Community'),
        h('h2', {}, 'JOIN THE ZYTHERON COMMUNITY'),
        h('p', { class: 'lp-head-body' }, 'Connect with our community, get support, discover updates, and stay connected with everything happening around Zytheron.'),
        discordLink(info, ['JOIN OUR DISCORD'], 'lp-btn lp-discord-btn lp-lg')),
      h('div', { class: 'lp-discord-art', 'aria-hidden': 'true' },
        h('div', { class: 'lp-art-rail' }, h('span', { class: 'on' }, h('img', { src: '/logo.svg', alt: '' })), h('span', {}), h('span', {}), h('span', {})),
        h('div', { class: 'lp-art-channels' }, h('b', {}), [62, 80, 54, 72].map(line)),
        h('div', { class: 'lp-art-chat' }, [[70, 44], [88, 60], [52, 76]].map(([a, b]) => h('div', { class: 'lp-art-msg' }, h('span', {}), h('div', {}, line(a), line(b)))))))));
}

export function inviteSection(info) {
  return h('section', { class: 'lp-section lp-wrap', id: 'invite' },
    sectionHead('Get started', 'HOW TO INVITE ZYTHERON'),
    h('ol', { class: 'lp-steps' }, STEPS.map(([title, body], n) => reveal(h('li', {}, h('span', { class: 'lp-step-number' }, n + 1), h('h3', {}, title), h('p', {}, body))))),
    h('div', { class: 'lp-center' }, inviteLink(info, 'Invite Bot', 'lp-lg')));
}

export function premiumSection({ heading = true } = {}) {
  const explore = PREMIUM.url
    ? h('a', { class: 'lp-btn lp-primary lp-lg', href: PREMIUM.url, ...external }, 'EXPLORE PREMIUM')
    : h('button', { class: 'lp-btn lp-primary lp-lg', type: 'button', onclick: () => notice('Premium is not available yet', 'There is nothing to buy yet. Every feature ZYTHERON has today is free, and the benefits on this page are only plans.') }, 'EXPLORE PREMIUM');
  return h('section', { class: 'lp-section', id: 'premium' },
    h('div', { class: 'lp-wrap' },
      reveal(h('div', { class: 'lp-premium' },
        h('div', { class: 'lp-head' },
          h('p', { class: 'lp-eyebrow' }, 'Premium'),
          h('h2', {}, 'MORE POWER, WHEN YOU WANT IT'),
          h('p', { class: 'lp-head-body' }, PREMIUM.available ? 'Optional extras for servers that want more.' : 'Premium is planned and is not on sale yet. Every feature ZYTHERON has today is free.')),
        h('div', { class: 'lp-premium-grid' }, PREMIUM.plannedBenefits.map((b) => h('article', {},
          h('div', { class: 'lp-feature-top' }, h('span', { class: 'lp-icon' }, icon(b.icon)), PREMIUM.available ? null : plannedBadge()),
          h('h3', {}, b.title), h('p', {}, b.body)))),
        h('div', { class: 'lp-center' }, explore)))));
}

export function footer(info) {
  return h('footer', { class: 'lp-footer' },
    h('div', { class: 'lp-wrap lp-footer-grid' },
      h('div', {}, sectionBrand(), h('p', {}, BLURB)),
      h('nav', { 'aria-label': 'Site' }, h('h2', {}, 'Explore'),
        sectionLink('home', 'Home'), h('a', { href: '#/docs' }, 'Docs'), h('a', { href: '#/docs/commands' }, 'Commands'), h('a', { href: '#/docs/support' }, 'Support'), discordLink(info, 'Discord Server', 'lp-nav-button')),
      h('nav', { 'aria-label': 'Legal' }, h('h2', {}, 'Legal'), h('a', { href: '#/terms' }, 'Terms of Service'), h('a', { href: '#/privacy' }, 'Privacy Policy'))),
    h('p', { class: 'lp-wrap lp-copyright' }, `© ${new Date().getFullYear()} ZYTHERON. All rights reserved. Not affiliated with Discord Inc.`));
}

export function observeReveals(root, cleanups) {
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      observer.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -6% 0px' });
  root.querySelectorAll('.lp-reveal').forEach((node) => observer.observe(node));
  cleanups.push(() => observer.disconnect());
}

function ctaSection(info) {
  return h('section', { class: 'lp-wrap lp-section lp-cta-section' }, reveal(h('div', { class: 'lp-cta-banner' },
    h('h2', {}, 'Ready to upgrade your server?'),
    h('p', {}, 'Add ZYTHERON in a minute, and start with protection in monitor mode.'),
    h('div', { class: 'lp-cta lp-cta-center' }, inviteLink(info, [discordIcon(), 'Add to Discord'], 'lp-lg'), h('a', { class: 'lp-btn lp-ghost lp-lg', href: '#/docs' }, icon('embeds'), 'Read the docs')))));
}

export function landingView({ info, user, cleanups }) {
  const root = h('div', { class: 'lp' },
    header(info, user),
    h('main', {},
      hero(info, cleanups),
      statsSection(info, cleanups),
      featuresSection(),
      ctaSection(info)),
    footer(info));
  requestAnimationFrame(() => observeReveals(root, cleanups));
  setTimeout(scrollToPending, 0);
  return root;
}

export function legalView({ page, info, user }) {
  const { title, sections } = LEGAL[page];
  return h('div', { class: 'lp' },
    header(info, user),
    h('main', { class: 'lp-legal' },
      h('a', { class: 'lp-back', href: '#/home' }, '← Back to home'),
      h('h1', {}, title),
      h('p', { class: 'lp-draft' }, 'Draft for review. This is sample wording, not legal advice.'),
      sections.map(([heading, body]) => h('section', {}, h('h2', {}, heading), h('p', {}, body)))),
    footer(info));
}
