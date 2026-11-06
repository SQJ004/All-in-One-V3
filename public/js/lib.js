// Small DOM and API helpers. All user-controlled text goes through textContent,
// never innerHTML, so server names and templates cannot inject markup.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el && key !== 'list' && key !== 'form') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, v);
  for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c instanceof Node ? c : String(c));
  return el;
}

const ICON_PATHS = {
  home: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  'sx-menu': 'M4 7h16M4 12h16M4 17h16',
  'sx-home': 'M3 11l9-8 9 8M5 9.500V21h14V9.500M10 21v-6h4v6',
  'sx-users': 'M9 4a3.500 3.500 0 110 7 3.500 3.500 0 010-7zM3 20a6 6 0 0112 0zM16 5a3 3 0 010 6M18 14a5 5 0 013 6h-3',
  'sx-shield': 'M12 2l8 3v6c0 5-3.400 9.300-8 11-4.600-1.700-8-6-8-11V5z',
  'sx-lock': 'M6 11h12v10H6zM8.500 11V7.500a3.500 3.500 0 017 0V11',
  'sx-chart': 'M4 4v16h16M8 16v-5M12 16V8M16 16v-3',
  'sx-pulse': 'M3 12h4l3-7 4 14 3-7h4',
  'sx-target': 'M12 3a9 9 0 110 18 9 9 0 010-18zM12 8a4 4 0 110 8 4 4 0 010-8zM12 11.500v1',
  'sx-scale': 'M12 4v16M7 20h10M5 8h14M5 8l-3 7h6zM19 8l-3 7h6z',
  'sx-clock': 'M12 3a9 9 0 110 18 9 9 0 010-18zM12 7v5l3.500 2',
  'sx-file': 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
  'sx-check': 'M12 3a9 9 0 110 18 9 9 0 010-18zM8 12l3 3 5-6',
  'sx-alert': 'M12 3l10 18H2zM12 10v5M12 18v.500',
  'sx-arrow': 'M4 12h15M13 6l6 6-6 6',
  'sx-plus': 'M12 5v14M5 12h14',
  'sx-dots': 'M5 12h.500M12 12h.500M19 12h.500',
  'sx-signout': 'M15 4h5v16h-5M10 8l-4 4 4 4M6 12h10',
  'sx-crown': 'M3 7l5 4.500L12 4l4 7.500L21 7l-2 12H5z',
  'sx-heart': 'M12 20s-8-5-8-11a4.500 4.500 0 018-2.800A4.500 4.500 0 0120 9c0 6-8 11-8 11z',
  premium: 'M3 7l5 4.500L12 4l4 7.500L21 7l-2 12H5z',
  bell: 'M6 16V10a6 6 0 0112 0v6l2 2H4zM10 21h4',
  'anti-nuke': 'M12 2l8 3v6c0 5-3.400 9.300-8 11-4.600-1.700-8-6-8-11V5zM12 7l-2.500 5H13l-1.500 4',
  'anti-raid': 'M12 2l8 3v6c0 5-3.400 9.300-8 11-4.600-1.700-8-6-8-11V5zM9 12l2 2 4-4',
  'anti-webhook': 'M9 8a3 3 0 116 0 3 3 0 01-2 2.800L15 15M7 20a3 3 0 11.500-6L10 10M17 20a3 3 0 10-2.500-5H8',
  backup: 'M12 3a9 9 0 11-8.500 6M3 4v5h5M12 8v4l3 2',
  'bot-identity': 'M12 3a4 4 0 110 8 4 4 0 010-8zM4 21a8 8 0 0116 0z',
  'audit-logs': 'M4 5h16M4 10h16M4 15h10M4 20h7M18 15l3 3-3 3',
  'ai-moderation': 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2zM19 15l1 2.500L22.500 19 20 20l-1 2.500L18 20l-2.500-1 2.500-1.500z',
  staff: 'M9 4a3.500 3.500 0 110 7 3.500 3.500 0 010-7zM3 20a6 6 0 0112 0zM16 5a3 3 0 010 6M18 14a5 5 0 013 6h-3',
  'bot-commands': 'M8 4H6a2 2 0 00-2 2v12a2 2 0 002 2h2M16 4h2a2 2 0 012 2v12a2 2 0 01-2 2h-2M10 9l-2 3 2 3M14 9l2 3-2 3',
  utility: 'M14.7 6.3a4 4 0 00-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 005.4-5.4l-2.7 2.7-2.3-.5-.5-2.3z',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zM21 16a3 3 0 11-6 0 3 3 0 016 0z',
  fun: 'M12 3a9 9 0 110 18 9 9 0 010-18zM8 14s1.5 2.5 4 2.5 4-2.5 4-2.5M9 9.5v.5M15 9.5v.5',
  'bot-settings': 'M12 8.5a3.5 3.5 0 110 7 3.5 3.5 0 010-7zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2',
  personalize: 'M15 4l1 2.500L18.500 7.500 16 8.500 15 11l-1-2.500L11.500 7.500 14 6.500zM5 19L14 10l2 2-9 9zM6 5l.6 1.400L8 7l-1.400.6L6 9l-.6-1.400L4 7l1.400-.6z',
  levels: 'M5 20v-6h3v6zM10.500 20V9h3v11zM16 20V4h3v16z',
  'voice-link': 'M10 14a4 4 0 010-6l3-3a4 4 0 016 6l-1.500 1.500M14 10a4 4 0 010 6l-3 3a4 4 0 01-6-6l1.500-1.500',
  sticky: 'M5 3h14v12l-6 6H5zM13 21v-6h6M9 8h6M9 12h3',
  'auto-purge': 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6',
  camera: 'M9 4l-1.500 2.500H4a2 2 0 00-2 2V18a2 2 0 002 2h16a2 2 0 002-2V8.500a2 2 0 00-2-2h-3.500L15 4zM12 9.500a3.500 3.500 0 110 7 3.500 3.500 0 010-7z',
  level: 'M4 20V14M10 20V9M16 20V4M2 20h20',
  coin: 'M12 3a9 9 0 110 18 9 9 0 010-18zM15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 2 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6v12',
  smile: 'M12 3a9 9 0 110 18 9 9 0 010-18zM8 14s1.5 2.5 4 2.5 4-2.5 4-2.5M9 9.5v.5M15 9.5v.5',
  gift: 'M3 9h18v4H3zM5 13v8h14v-8M12 9v12M12 9S10.5 3 7.5 4 8 9 12 9zM12 9s1.5-6 4.5-5-.5 5-4.5 5z',
  search: 'M11 4a7 7 0 110 14 7 7 0 010-14zM21 21l-5-5',
  overview: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  welcome: 'M3 8l9 6 9-6M3 6h18v13H3z',
  embeds: 'M4 4h16v16H4zM8 9h8M8 13h8M8 17h5',
  security: 'M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5z',
  moderation: 'M14 4l6 6-3 3-6-6zM11 7L4 14l6 6 7-7M3 21h9',
  logging: 'M5 3h14v18H5zM9 8h6M9 12h6M9 16h4',
  roles: 'M12 3a4 4 0 110 8 4 4 0 010-8zM4 21c0-4 3.6-7 8-7s8 3 8 7',
  tickets: 'M3 8a2 2 0 002-2h14a2 2 0 002 2v2a2 2 0 000 4v2a2 2 0 00-2 2H5a2 2 0 00-2-2v-2a2 2 0 000-4z',
  automation: 'M13 2L4 14h7l-1 8 9-12h-7z',
  commands: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h4',
  settings: 'M12 8.5a3.5 3.5 0 110 7 3.5 3.5 0 010-7zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2',
};

export const icon = (name) => svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'aria-hidden': 'true' }, svg('path', { d: ICON_PATHS[name] ?? '' }));

let csrf = '';
export const setCsrf = (token) => { csrf = token; };

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `Request failed (${status})`);
    this.status = status;
    this.issues = body?.issues;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export function toast(message, kind = 'ok', issues) {
  const el = h('div', { class: `toast ${kind}` }, message, issues?.length ? h('ul', {}, issues.map((i) => h('li', {}, `${i.path}: ${i.message}`))) : null);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
}

export const showError = (err) => toast(err.message, 'err', err.issues);

/** Runs an action with button-busy state and error toasts. */
export const guard = (button, fn) => async (...args) => {
  if (button) button.disabled = true;
  try {
    return await fn(...args);
  } catch (err) {
    showError(err);
  } finally {
    if (button) button.disabled = false;
  }
};

export const getPath = (obj, path) => path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[keys.at(-1)] = value;
}

export const fmtDate = (d) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function fmtAgo(d) {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const fmtUptime = (ms) => {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const hours = Math.floor(m / 60);
  return hours < 48 ? `${hours}h ${m % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

export function modal(title, build, { submitLabel = 'Save', cancellable = true } = {}) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { 'aria-label': title });
    const close = (value) => { dialog.close(); dialog.remove(); resolve(value); };
    const save = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);
    const content = build();
    const form = h('form', { method: 'dialog', onsubmit: async (e) => {
      e.preventDefault();
      await guard(save, async () => { close(await content.submit()); })();
    } }, h('h2', {}, title), content.node, h('div', { class: 'actions' }, cancellable ? h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'Cancel') : null, save));
    dialog.append(form);
    dialog.addEventListener('cancel', () => resolve(null));
    document.body.append(dialog);
    dialog.showModal();
  });
}

export function confirmDialog(title, message, label = 'Confirm') {
  return modal(title, () => ({ node: h('p', {}, message), submit: () => true }), { submitLabel: label });
}
