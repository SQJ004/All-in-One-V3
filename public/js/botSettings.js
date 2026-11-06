import { api, fmtDate, guard, h, icon, toast } from './lib.js';

const PAGE_SIZES = [10, 25, 50];

function nicknameSection(ctx, profile) {
  const url = `/api/guilds/${ctx.guildId}/nickname`;
  const input = h('input', { type: 'text', value: profile.nickname ?? '', maxLength: 32, placeholder: profile.username, 'aria-label': 'Bot nickname' });
  const apply = h('button', { class: 'btn primary', type: 'submit' }, 'Apply');
  const form = h('form', { class: 'input-group' }, input, apply);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    guard(apply, async () => {
      await api(url, { method: 'PUT', body: { nickname: input.value.trim() } });
      toast(input.value.trim() ? 'Nickname changed.' : 'Nickname cleared.');
      ctx.refreshActions?.();
    })();
  });
  return h('section', { class: 'settings-block' }, h('h2', {}, 'Nickname'), h('p', {}, "Set the bot's display name in the server."), form);
}

function prefixSection(ctx, initial) {
  const url = `/api/guilds/${ctx.guildId}/config/commands`;
  let prefixes = initial;
  const list = h('ul', { class: 'prefix-list' });
  const save = async (next) => {
    const saved = await api(url, { method: 'PUT', body: { prefixes: next } });
    prefixes = saved.prefixes;
    render();
    ctx.refreshActions?.();
  };
  function render() {
    list.replaceChildren(...prefixes.map((p) => {
      const remove = h('button', { class: 'prefix-remove', type: 'button', 'aria-label': `Remove prefix ${p}`, title: prefixes.length === 1 ? 'The bot needs at least one prefix' : 'Remove', disabled: prefixes.length === 1 }, '×');
      remove.addEventListener('click', guard(remove, () => save(prefixes.filter((x) => x !== p))));
      return h('li', {}, h('code', {}, p), remove);
    }));
  }
  const input = h('input', { type: 'text', maxLength: 5, placeholder: 'Enter a prefix', 'aria-label': 'New prefix', autocomplete: 'off' });
  const add = h('button', { class: 'btn primary', type: 'submit' }, 'Add');
  const form = h('form', { class: 'input-group' }, input, add);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = input.value.trim().toLowerCase();
    if (!value) return;
    if (prefixes.includes(value)) { toast('That prefix is already set.', 'error'); return; }
    guard(add, async () => {
      await save([...prefixes, value]);
      input.value = '';
      toast('Prefix added.');
    })();
  });
  render();
  return h('section', { class: 'settings-block' },
    h('h2', {}, 'Custom Prefix'),
    h('p', {}, 'Set up to 5 prefixes for typed music and utility commands, like v!play. Slash commands always work.'),
    form, list);
}

/** Who changed what on this dashboard, newest first. */
function recentActions(ctx) {
  const url = `/api/guilds/${ctx.guildId}/actions`;
  let rows = [];
  let page = 0;
  let size = PAGE_SIZES[0];
  let sortKey = 'at';
  let sortDir = -1;
  const filters = { username: '', action: '' };
  const body = h('tbody', {});
  const pager = h('div', { class: 'pager' });
  const headButtons = new Map();

  function render() {
    const shown = rows
      .filter((r) => r.username.toLowerCase().includes(filters.username) && r.action.toLowerCase().includes(filters.action))
      .sort((a, b) => String(a[sortKey]).localeCompare(String(b[sortKey])) * sortDir);
    const pages = Math.max(1, Math.ceil(shown.length / size));
    page = Math.min(page, pages - 1);
    const slice = shown.slice(page * size, page * size + size);
    body.replaceChildren(...(slice.length
      ? slice.map((r) => h('tr', {}, h('td', {}, fmtDate(r.at)), h('td', {}, r.username), h('td', {}, r.action)))
      : [h('tr', {}, h('td', { colSpan: 3, class: 'empty-row' }, rows.length ? 'No actions match your filters.' : 'No dashboard changes yet.'))]));
    const button = (label, target, disabled, active) => h('button', { type: 'button', class: active ? 'active' : '', disabled, 'aria-current': active ? 'page' : undefined, onclick: () => { page = target; render(); } }, label);
    pager.replaceChildren(
      button('‹', page - 1, page === 0, false),
      ...Array.from({ length: pages }, (_, n) => n).filter((n) => n === 0 || n === pages - 1 || Math.abs(n - page) <= 1).map((n) => button(String(n + 1), n, false, n === page)),
      button('›', page + 1, page >= pages - 1, false));
    for (const [key, b] of headButtons) b.textContent = `${b.dataset.label} ${sortKey === key ? (sortDir === 1 ? '▲' : '▼') : ''}`.trim();
  }

  const head = (key, label) => {
    const b = h('button', { type: 'button', 'data-label': label, onclick: () => {
      if (sortKey === key) sortDir = -sortDir; else { sortKey = key; sortDir = 1; }
      render();
    } }, label);
    headButtons.set(key, b);
    return h('th', { scope: 'col' }, b);
  };
  const filter = (key, label) => h('th', {}, h('input', { type: 'search', placeholder: `Filter by ${label}`, 'aria-label': `Filter by ${label}`, oninput: (e) => { filters[key] = e.target.value.trim().toLowerCase(); page = 0; render(); } }));
  const records = h('select', { 'aria-label': 'Records per page', onchange: (e) => { size = Number(e.target.value); page = 0; render(); } }, PAGE_SIZES.map((n) => h('option', { value: n }, n)));

  const load = async () => {
    rows = await api(url);
    render();
  };
  ctx.refreshActions = () => void load().catch(() => undefined);
  void load().catch(() => {
    body.replaceChildren(h('tr', {}, h('td', { colSpan: 3, class: 'empty-row' }, 'Recent actions could not be loaded.')));
  });
  render();
  return h('section', { class: 'card settings-card' },
    h('header', { class: 'settings-card-head' }, icon('logging'), 'Last actions'),
    h('div', { class: 'settings-card-body' },
      h('h2', {}, 'Recent actions'),
      h('p', { class: 'settings-note' }, 'Changes made on this dashboard in the last 90 days.'),
      h('label', { class: 'records' }, 'Records:', records),
      h('div', { class: 'table-wrap actions-table' }, h('table', {},
        h('thead', {}, h('tr', {}, head('at', 'Executed'), head('username', 'Username'), head('action', 'Action')), h('tr', { class: 'filter-row' }, h('th', {}), filter('username', 'Username'), filter('action', 'Action'))),
        body)),
      pager));
}

export async function botSettingsPage(ctx) {
  const [profile, commands] = await Promise.all([api(`/api/guilds/${ctx.guildId}/bot-profile`), api(`/api/guilds/${ctx.guildId}/config/commands`)]);
  return h('div', { class: 'settings-page' },
    h('section', { class: 'card settings-card' },
      h('header', { class: 'settings-card-head' }, icon('settings'), 'Bot Settings'),
      h('div', { class: 'settings-card-body' },
        nicknameSection(ctx, profile),
        prefixSection(ctx, commands.prefixes),
        h('section', { class: 'settings-block' }, h('h2', {}, 'ZYTHERON Premium'), h('p', {}, 'Not available yet. Every feature is free. ', h('a', { href: '#/docs/premium' }, 'Read more'), '.')))),
    recentActions(ctx));
}
