import { api, getPath, guard, h, setPath, toast } from './lib.js';

/**
 * Declarative forms. A field: { path, label, type, help, wide, options, min, max, when }.
 * Types: toggle, text, textarea, number, color, select, channel, role, channels, roles, list.
 */
const channelLabel = (c) => `${c.type === 'voice' ? '🔊 ' : c.type === 'category' ? '▾ ' : '# '}${c.name}`;

/** Discord's "no colour" is black, which shows as the default text colour in Discord too. */
export const roleColor = (hex) => (/^#[0-9a-f]{6}$/i.test(hex ?? '') && hex !== '#000000' ? hex : null);

const colored = (el, color) => {
  el.style.color = color ?? '';
  return el;
};

function channelOptions(ctx, kinds = ['text', 'announcement']) {
  return ctx.resources.channels.filter((c) => kinds.includes(c.type));
}

function singleSelect(id, items, value, onChange, placeholder) {
  const colorOf = (v) => items.find((it) => it.value === v)?.color ?? null;
  const select = h('select', { id, onchange: (e) => { colored(select, colorOf(e.target.value)); onChange(e.target.value || null); } },
    colored(h('option', { value: '' }, placeholder), 'var(--text)'),
    items.map((it) => colored(h('option', { value: it.value, selected: it.value === value }, it.label), it.color ?? 'var(--text)')));
  return colored(select, colorOf(value));
}

const chipFor = (item, chip) => {
  if (item?.color) {
    chip.style.setProperty('--role', item.color);
    chip.classList.add('role-chip');
  }
  return chip;
};

function multiPicker(id, items, values, onChange, placeholder) {
  const wrap = h('div', { class: 'field-multi' });
  const render = () => {
    wrap.replaceChildren(
      h('div', { class: 'chips' }, values.map((v) => chipFor(items.find((i) => i.value === v), h('span', { class: 'chip' }, items.find((i) => i.value === v)?.label ?? v, h('button', { type: 'button', 'aria-label': `Remove ${items.find((i) => i.value === v)?.label ?? v}`, onclick: () => { values = values.filter((x) => x !== v); onChange(values); render(); } }, '×'))))),
      h('select', { id, class: values.length ? 'mt' : '', 'aria-label': placeholder, onchange: (e) => { if (e.target.value) { values = [...values, e.target.value]; onChange(values); render(); } } },
        h('option', { value: '' }, placeholder),
        items.filter((i) => !values.includes(i.value)).map((i) => colored(h('option', { value: i.value }, i.label), i.color ?? 'var(--text)'))),
    );
  };
  render();
  return wrap;
}

/** Tags that sit inside the input box. Enter adds one, each has its own ×, and × on the right clears them all. */
function stringList(id, values, onChange, placeholder, { lowercase = false } = {}) {
  const input = h('input', { id, type: 'text', placeholder });
  const tags = h('div', { class: 'tag-items' });
  const clear = h('button', { class: 'tag-clear', type: 'button', 'aria-label': 'Remove all', title: 'Remove all', onclick: () => { update([]); input.focus(); } }, '×');
  const update = (next) => {
    values = next;
    onChange(values);
    render();
  };
  function render() {
    tags.replaceChildren(...values.map((v) => h('span', { class: 'tag' },
      h('button', { type: 'button', 'aria-label': `Remove ${v}`, onclick: () => { update(values.filter((x) => x !== v)); input.focus(); } }, '×'),
      h('span', {}, v))));
    clear.hidden = !values.length;
    input.placeholder = values.length ? '' : placeholder;
  }
  const add = () => {
    const raw = input.value.trim();
    const v = lowercase ? raw.toLowerCase() : raw;
    input.value = '';
    if (v && !values.includes(v)) update([...values, v]);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); add(); }
    else if (e.key === 'Backspace' && !input.value && values.length) update(values.slice(0, -1));
  });
  input.addEventListener('blur', add);
  render();
  return h('div', { class: 'tag-input', onclick: (e) => { if (e.target === e.currentTarget || e.target === tags) input.focus(); } }, tags, input, clear);
}

let uid = 0;

export function renderField(field, state, ctx, onDirty) {
  const id = `f${++uid}`;
  const value = getPath(state, field.path);
  const set = (v) => { setPath(state, field.path, v); onDirty?.(); };
  const roles = () => ctx.resources.roles.filter((r) => !r.managed).map((r) => ({ value: r.id, label: `@${r.name}`, color: roleColor(r.color) }));

  if (field.type === 'toggle') {
    return h('label', { class: `toggle ${field.wide ? 'field wide' : ''}` },
      h('span', { class: 't' }, field.label, field.help ? h('span', { class: 'help' }, field.help) : null),
      h('input', { type: 'checkbox', checked: Boolean(value), onchange: (e) => set(e.target.checked) }),
      h('span', { class: 'sw' }));
  }

  let control;
  switch (field.type) {
    case 'textarea': control = h('textarea', { id, value: value ?? '', rows: field.rows ?? 3, maxLength: field.max, placeholder: field.placeholder ?? '', oninput: (e) => set(e.target.value) }); break;
    case 'number': control = h('input', { id, type: 'number', value: value ?? '', min: field.min, max: field.max, step: field.step ?? 1, oninput: (e) => set(e.target.value === '' ? null : Number(e.target.value)) }); break;
    case 'color': control = h('div', { class: 'row' }, h('input', { id, type: 'color', value: value ?? '#7c3aed', oninput: (e) => { set(e.target.value); e.target.nextSibling.value = e.target.value; } }), h('input', { type: 'text', value: value ?? '#7c3aed', maxLength: 7, 'aria-label': `${field.label} hex`, oninput: (e) => { set(e.target.value); if (/^#[0-9a-f]{6}$/i.test(e.target.value)) e.target.previousSibling.value = e.target.value; } })); control.lastChild.style.flex = '1'; break;
    case 'select': control = h('select', { id, onchange: (e) => set(e.target.value) }, field.options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label))); break;
    case 'channel': control = singleSelect(id, channelOptions(ctx, field.kinds).map((c) => ({ value: c.id, label: channelLabel(c) })), value, set, field.placeholder ?? 'Not set'); break;
    case 'role': control = singleSelect(id, roles(), value, set, field.placeholder ?? 'Not set'); break;
    case 'channels': control = multiPicker(id, channelOptions(ctx, field.kinds).map((c) => ({ value: c.id, label: channelLabel(c) })), value ?? [], set, 'Add a channel…'); break;
    case 'roles': control = multiPicker(id, roles(), value ?? [], set, 'Add a role…'); break;
    case 'list': control = stringList(id, value ?? [], set, field.placeholder ?? 'Type and press Enter', { lowercase: field.lowercase }); break;
    default: control = h('input', { id, type: 'text', value: value ?? '', maxLength: field.max, placeholder: field.placeholder ?? '', oninput: (e) => set(e.target.value) });
  }
  return h('div', { class: `field ${field.wide ? 'wide' : ''}` }, h('label', { htmlFor: id }, field.label), control, field.help ? h('span', { class: 'help' }, field.help) : null);
}

export const fieldGrid = (fields, state, ctx, onDirty) => h('div', { class: 'fields' }, fields.map((f) => renderField(f, state, ctx, onDirty)));

/** A settings page bound to one config section, with a sticky "unsaved changes" bar. */
export async function configForm(ctx, section, build, { onSaved } = {}) {
  let saved = await api(`/api/guilds/${ctx.guildId}/config/${section}`);
  const state = structuredClone(saved);
  const bar = h('div', { class: 'savebar', role: 'region', 'aria-label': 'Unsaved changes' });
  const dirty = () => bar.classList.toggle('show', JSON.stringify(state) !== JSON.stringify(saved));
  const saveBtn = h('button', { class: 'btn primary' }, 'Save changes');
  saveBtn.addEventListener('click', guard(saveBtn, async () => {
    saved = await api(`/api/guilds/${ctx.guildId}/config/${section}`, { method: 'PUT', body: state });
    Object.assign(state, structuredClone(saved));
    onSaved?.();
    dirty();
    ctx.refreshStatus?.();
    toast('Saved.');
  }));
  const reset = h('button', { class: 'btn', onclick: () => ctx.rerender() }, 'Discard');
  bar.append(h('span', {}, 'You have unsaved changes.'), h('div', { class: 'row' }, reset, saveBtn));
  ctx.cleanups.push(() => bar.remove());
  document.body.append(bar);
  return build(state, dirty);
}

export const section = (title, sub, ...children) => h('section', { class: 'card' }, h('h2', {}, title), sub ? h('p', { class: 'sub' }, sub) : null, children);

export const dataTable = (columns, rows, emptyText = 'Nothing here yet.') => {
  if (!rows.length) return h('p', { class: 'empty' }, emptyText);
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, columns.map((c) => h('th', { scope: 'col' }, c.label)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, columns.map((c) => {
      const cell = h('td', { class: c.clip ? 'clip' : '' }, c.render(r));
      if (c.clip) cell.title = cell.textContent; // works for plain text and for coloured roles
      return cell;
    }))))));
};
