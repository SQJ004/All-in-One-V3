import { h, icon } from './lib.js';

const initials = (name) => (name || '?').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase() || '?';
const guildFace = (g, cls) => (g.icon ? h('img', { class: cls, src: g.icon, alt: '' }) : h('span', { class: cls }, initials(g.name)));

/**
 * The frame around every dashboard page: floating sidebar with the server selector and
 * the signed-in account, a floating top bar, and the page area. Pages only fill `main`.
 */
export function appShell({ guild, guilds, me, nav, crumbs, search, bell, account, info, overview, dropdown, logout, serverLink = (g) => `#/g/${g.id}`, collapsed = false, onCollapse }) {
  const roleBadge = h('span', { class: 'sx-admin', hidden: true });
  const online = h('span', { class: 'sx-online' }, h('i'), 'Checking');
  const main = h('main', { class: 'sx-main main' }, h('div', { class: 'sx-loading' }, Array.from({ length: 6 }, () => h('i'))));
  const side = h('aside', { class: 'sx-side' });
  const small = () => window.matchMedia('(max-width: 1000px)').matches;
  const scrim = h('button', { class: 'sx-scrim', type: 'button', 'aria-label': 'Close menu', tabIndex: -1, onclick: () => setOpen(false) });
  const setOpen = (open) => { side.classList.toggle('open', open); scrim.classList.toggle('open', open); };
  const root = h('div', { class: `sx ${collapsed ? 'collapsed' : ''}` });

  side.append(
    h('a', { class: 'sx-brand', href: '#/home', title: 'ZYTHERON homepage' }, h('img', { src: '/logo.svg', alt: '' }), 'ZYTHERON'),
    dropdown('Switch server', h('span', { class: 'sx-server' }, guildFace(guild, 'sx-avatar small'), h('span', { class: 'sx-server-text' }, h('b', {}, guild.name), online)), [
      h('p', { class: 'dash-drop-name' }, 'Switch server'),
      guilds.filter((g) => g.botPresent).map((g) => h('a', { href: serverLink(g), class: g.id === guild.id ? 'active' : '' }, guildFace(g, 'avatar small'), h('span', {}, g.name))),
      h('a', { href: '#/' }, 'All servers'),
    ]),
    h('nav', { class: 'sx-navs', 'aria-label': `${guild.name} navigation`, onclick: (e) => { if (e.target.closest('a')) setOpen(false); } }, nav),
    h('div', { class: 'sx-me' },
      me.avatar ? h('img', { class: 'sx-avatar', src: `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64`, alt: '' }) : h('span', { class: 'sx-avatar' }, initials(me.username)),
      h('div', { class: 'sx-me-text' }, h('b', {}, me.username), roleBadge),
      h('button', { class: 'sx-signout', type: 'button', onclick: logout, 'aria-label': 'Sign out', title: 'Sign out' }, icon('sx-signout'))));

  const menuBtn = h('button', { class: 'sx-menu-btn', type: 'button', 'aria-label': 'Toggle menu', title: 'Toggle menu', onclick: () => {
    if (small()) return setOpen(!side.classList.contains('open'));
    root.classList.toggle('collapsed');
    onCollapse?.(root.classList.contains('collapsed'));
  } }, icon('sx-menu'));

  const top = h('header', { class: 'sx-top' }, menuBtn,
    h('nav', { class: 'sx-crumbs', 'aria-label': 'Breadcrumb' }, crumbs.flatMap((c, n) => (n ? [h('i', { 'aria-hidden': 'true' }, '›'), c] : [c]))),
    h('div', { class: 'sx-top-right' }, search, bell, account));

  root.append(side, scrim, h('div', { class: 'sx-body' }, top, info?.demo ? h('div', { class: 'sx-note demo' }, 'Demo mode: this is sample data with a pretend Discord. Nothing here touches a real server.') : null, main));

  overview?.then((o) => {
    roleBadge.textContent = o.access.isOwner ? 'Owner' : o.access.isTrusted ? 'Admin' : 'Manager';
    roleBadge.hidden = false;
    online.replaceChildren(h('i', { class: o.guild.online ? 'on' : '' }), o.guild.online ? 'Online' : 'Offline');
  }).catch(() => online.replaceChildren(h('i'), 'Unknown'));

  return { root, main };
}
