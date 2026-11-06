import { api, confirmDialog, guard, h, modal, toast } from './lib.js';
import { fieldGrid, section } from './forms.js';

const newEmbed = () => ({ title: 'New embed', description: 'Write something here.', color: '#7c3aed', timestamp: false, fields: [] });
const EMPTY_TO_UNDEFINED = ['title', 'url', 'description', 'authorName', 'authorIcon', 'footerText', 'footerIcon', 'thumbnail', 'image'];

/** Blank strings mean "not set" to the API, which validates URLs. */
export function cleanSpec(spec) {
  return {
    content: spec.content?.trim() ? spec.content : undefined,
    embeds: spec.embeds.map((e) => {
      const out = { ...e };
      for (const k of EMPTY_TO_UNDEFINED) if (!out[k]?.trim?.()) delete out[k];
      return out;
    }),
    buttons: spec.buttons.map((b) => (b.emoji ? b : { ...b, emoji: undefined })),
    roleMenu: spec.roleMenu ?? undefined,
  };
}

/** Renders a safe subset of Discord markdown using DOM nodes, never innerHTML. */
function markdown(text) {
  const frag = document.createDocumentFragment();
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    frag.append(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) frag.append(h('b', {}, t.slice(2, -2)));
    else if (t.startsWith('`')) frag.append(h('code', {}, t.slice(1, -1)));
    else if (t.startsWith('*')) frag.append(h('i', {}, t.slice(1, -1)));
    else { const parts = t.match(/^\[(.+)\]\((.+)\)$/); frag.append(h('a', { href: parts[2], target: '_blank', rel: 'noreferrer noopener' }, parts[1])); }
    last = m.index + t.length;
  }
  frag.append(text.slice(last));
  return frag;
}

const isImage = (u) => /^https:\/\//.test(u ?? '');

function previewEmbed(e) {
  return h('div', { class: 'dc-embed', style: `border-color:${e.color}` },
    e.authorName ? h('div', { class: 'dc-author' }, isImage(e.authorIcon) ? h('img', { src: e.authorIcon, alt: '' }) : null, e.authorName) : null,
    e.title ? h('div', { class: 'dc-title' }, e.url ? h('a', { href: e.url, target: '_blank', rel: 'noreferrer noopener' }, e.title) : e.title) : null,
    e.description ? h('div', { class: 'dc-desc' }, markdown(e.description)) : null,
    e.fields.length ? h('div', { class: 'dc-fields' }, e.fields.map((f) => h('div', { class: `dc-field ${f.inline ? 'inline' : ''}` }, h('b', {}, f.name), markdown(f.value)))) : null,
    isImage(e.thumbnail) ? h('img', { class: 'thumb', src: e.thumbnail, alt: '' }) : null,
    isImage(e.image) ? h('img', { class: 'image', src: e.image, alt: '' }) : null,
    e.footerText || e.timestamp ? h('div', { class: 'dc-footer' }, isImage(e.footerIcon) ? h('img', { src: e.footerIcon, alt: '' }) : null, [e.footerText, e.timestamp ? 'Today at 12:00' : null].filter(Boolean).join(' • ')) : null);
}

export async function embedBuilderPage(ctx) {
  const base = `/api/guilds/${ctx.guildId}`;
  const spec = { content: '', embeds: [newEmbed()], buttons: [], roleMenu: null };
  let active = 0;
  let templates = await api(`${base}/embeds`);
  let channelId = '';

  const preview = h('div', { class: 'dc' });
  const editor = h('div');
  const list = h('div');

  const renderPreview = () => {
    preview.replaceChildren(h('div', { class: 'dc-msg' },
      h('img', { class: 'dc-avatar', src: '/logo.svg', alt: '' }),
      h('div', { style: 'min-width:0' },
        h('div', { class: 'dc-head' }, h('span', { class: 'dc-name' }, 'ZYTHERON'), h('span', { class: 'dc-badge' }, 'BOT'), h('span', { class: 'dc-time' }, 'Today at 12:00')),
        spec.content ? h('div', { class: 'dc-text' }, markdown(spec.content)) : null,
        spec.embeds.map(previewEmbed),
        spec.buttons.length ? h('div', { class: 'dc-buttons' }, spec.buttons.map((b) => h('span', { class: `dc-btn ${b.kind === 'role' ? b.style : ''}` }, b.label, b.kind === 'link' ? ' ↗' : ''))) : null)));
  };

  const renderEditor = () => {
    const e = spec.embeds[active];
    editor.replaceChildren(
      section('Message', null, fieldGrid([{ path: 'content', label: 'Text above the embeds', type: 'textarea', wide: true, max: 2000, rows: 2 }], spec, ctx, renderPreview)),
      h('section', { class: 'card' },
        h('div', { class: 'row', style: 'margin-bottom:12px' },
          h('h2', { style: 'font-size:15px;font-weight:600' }, 'Embeds'),
          h('div', { class: 'spacer' }),
          spec.embeds.map((_, n) => h('button', { class: `btn small ${n === active ? 'primary' : ''}`, 'aria-pressed': n === active ? 'true' : 'false', onclick: () => { active = n; renderEditor(); } }, n + 1)),
          h('button', { class: 'btn small', disabled: spec.embeds.length >= 10, onclick: () => { spec.embeds.push(newEmbed()); active = spec.embeds.length - 1; refresh(); } }, 'Add'),
          h('button', { class: 'btn small', disabled: spec.embeds.length >= 10 || !e, onclick: () => { spec.embeds.splice(active + 1, 0, structuredClone(e)); active += 1; refresh(); } }, 'Duplicate'),
          h('button', { class: 'btn small danger', disabled: !e, onclick: () => { spec.embeds.splice(active, 1); active = Math.max(0, active - 1); refresh(); } }, 'Remove')),
        e ? [
          fieldGrid([
            { path: 'title', label: 'Title', max: 256 },
            { path: 'url', label: 'Title link', placeholder: 'https://' },
            { path: 'description', label: 'Description', type: 'textarea', wide: true, max: 4096, rows: 5, help: 'Supports **bold**, *italic*, `code` and [links](https://example.com)' },
            { path: 'color', label: 'Color', type: 'color' },
            { path: 'timestamp', label: 'Show timestamp', type: 'toggle' },
            { path: 'authorName', label: 'Author', max: 256 },
            { path: 'authorIcon', label: 'Author icon URL', placeholder: 'https://' },
            { path: 'footerText', label: 'Footer', max: 2048 },
            { path: 'footerIcon', label: 'Footer icon URL', placeholder: 'https://' },
            { path: 'thumbnail', label: 'Thumbnail URL', placeholder: 'https://' },
            { path: 'image', label: 'Main image URL', placeholder: 'https://' },
          ], e, ctx, renderPreview),
          h('div', { class: 'row', style: 'margin:16px 0 8px' }, h('b', {}, `Fields (${e.fields.length}/25)`), h('div', { class: 'spacer' }), h('button', { class: 'btn small', disabled: e.fields.length >= 25, onclick: () => { e.fields.push({ name: 'Field name', value: 'Field value', inline: false }); refresh(); } }, 'Add field')),
          e.fields.map((f, n) => h('div', { class: 'sub-item' }, fieldGrid([
            { path: 'name', label: 'Name', max: 256 }, { path: 'inline', label: 'Inline', type: 'toggle' },
            { path: 'value', label: 'Value', type: 'textarea', wide: true, max: 1024, rows: 2 },
          ], f, ctx, renderPreview), h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn small danger', onclick: () => { e.fields.splice(n, 1); refresh(); } }, 'Remove field')))),
        ] : h('p', { class: 'empty' }, 'No embeds. This message will be text only.')),
      section('Buttons', 'Link buttons open a URL. Role buttons toggle a role for whoever presses them.', h('div', { class: 'row', style: 'margin-bottom:10px' },
        h('button', { class: 'btn small', disabled: spec.buttons.length >= 20, onclick: () => { spec.buttons.push({ kind: 'link', label: 'Open link', url: 'https://example.com' }); refresh(); } }, 'Add link button'),
        h('button', { class: 'btn small', disabled: spec.buttons.length >= 20 || !ctx.resources.roles.length, onclick: () => { spec.buttons.push({ kind: 'role', label: 'Get role', roleId: ctx.resources.roles.find((r) => !r.managed && !r.dangerous)?.id ?? ctx.resources.roles[0].id, style: 'primary' }); refresh(); } }, 'Add role button')),
      spec.buttons.map((b, n) => h('div', { class: 'sub-item' }, fieldGrid(b.kind === 'link'
        ? [{ path: 'label', label: 'Label', max: 80 }, { path: 'url', label: 'URL' }, { path: 'emoji', label: 'Emoji', help: 'Unicode, or <:name:id>' }]
        : [{ path: 'label', label: 'Label', max: 80 }, { path: 'roleId', label: 'Role', type: 'role' }, { path: 'style', label: 'Style', type: 'select', options: ['primary', 'secondary', 'success', 'danger'].map((value) => ({ value, label: value })) }, { path: 'emoji', label: 'Emoji' }], b, ctx, renderPreview),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn small danger', onclick: () => { spec.buttons.splice(n, 1); refresh(); } }, 'Remove button'))))),
    );
  };

  const refresh = () => { renderEditor(); renderPreview(); };

  const load = (data) => {
    spec.content = data.content ?? '';
    spec.embeds = (data.embeds ?? []).map((e) => ({ ...newEmbed(), title: '', description: '', ...e, fields: e.fields ?? [] }));
    spec.buttons = data.buttons ?? [];
    spec.roleMenu = data.roleMenu ?? null;
    active = 0;
    refresh();
  };

  const renderList = () => list.replaceChildren(templates.length ? h('div', {}, templates.map((t) => h('div', { class: 'row sub-item' },
    h('b', { style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis' }, t.name),
    h('button', { class: 'btn small', onclick: () => { load(structuredClone(t.spec)); toast(`Loaded ${t.name}.`); } }, 'Load'),
    h('button', { class: 'btn small', onclick: guard(null, async () => { await saveAs(`${t.name}-copy`, t.spec); }) }, 'Duplicate'),
    h('button', { class: 'btn small danger', onclick: async () => {
      if (!(await confirmDialog(`Delete ${t.name}?`, 'This cannot be undone.', 'Delete'))) return;
      await guard(null, () => api(`${base}/embeds/${encodeURIComponent(t.name)}`, { method: 'DELETE' }))();
      templates = await api(`${base}/embeds`); renderList();
    } }, 'Delete')))) : h('p', { class: 'empty' }, 'No templates yet.'));

  const saveAs = async (name, s) => {
    await api(`${base}/embeds`, { method: 'PUT', body: { name, spec: s } });
    templates = await api(`${base}/embeds`);
    renderList();
    toast(`Saved ${name}.`);
  };

  const saveBtn = h('button', { class: 'btn' }, 'Save template');
  saveBtn.addEventListener('click', async () => {
    const state = { name: '' };
    await modal('Save template', () => ({ node: fieldGrid([{ path: 'name', label: 'Name', max: 40, help: 'Lowercase letters, numbers, dashes and underscores' }], state, ctx), submit: async () => { await saveAs(state.name, cleanSpec(spec)); return true; } }));
  });

  const exportBtn = h('button', { class: 'btn', onclick: () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(cleanSpec(spec), null, 2)], { type: 'application/json' }));
    const a = h('a', { href: url, download: 'embed.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } }, 'Export JSON');

  const importBtn = h('button', { class: 'btn', onclick: async () => {
    const state = { json: '' };
    await modal('Import JSON', () => ({
      node: fieldGrid([{ path: 'json', label: 'ZYTHERON message JSON', type: 'textarea', wide: true, rows: 10 }], state, ctx),
      submit: () => {
        let data;
        try { data = JSON.parse(state.json); } catch { throw new Error('That is not valid JSON.'); }
        if (!data || !Array.isArray(data.embeds)) throw new Error('Expected an object with an "embeds" list.');
        load(data);
        return true;
      },
    }), { submitLabel: 'Import' });
  } }, 'Import JSON');

  const sendBtn = h('button', { class: 'btn primary' }, 'Send message');
  sendBtn.addEventListener('click', guard(sendBtn, async () => {
    if (!channelId) throw new Error('Choose a channel first.');
    await api(`${base}/embeds/send`, { method: 'POST', body: { channelId, spec: cleanSpec(spec) } });
    toast('Message sent.');
  }));

  const channelPick = h('select', { 'aria-label': 'Channel to send to', style: 'width:auto;max-width:220px', onchange: (e) => { channelId = e.target.value; } },
    h('option', { value: '' }, 'Choose a channel'),
    ctx.resources.channels.filter((c) => c.type === 'text' || c.type === 'announcement').map((c) => h('option', { value: c.id }, `# ${c.name}`)));

  refresh();
  renderList();

  return h('div', {},
    h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Embed Builder'), h('p', {}, 'Design rich messages with a live preview.')), h('div', { class: 'row' }, channelPick, sendBtn)),
    h('div', { class: 'builder' },
      h('div', {}, editor),
      h('div', { class: 'preview-col' },
        section('Live preview', null, preview),
        h('section', { class: 'card' }, h('div', { class: 'row', style: 'margin-bottom:12px' }, h('h2', { style: 'font-size:15px;font-weight:600' }, 'Templates'), h('div', { class: 'spacer' }), saveBtn, importBtn, exportBtn), list))));
}
