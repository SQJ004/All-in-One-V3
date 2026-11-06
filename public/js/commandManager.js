import { api, guard, h, icon, toast } from './lib.js';
import { fieldGrid } from './forms.js';

const CATEGORY_ORDER = ['Utility', 'Moderation', 'Music', 'Fun', 'Admin'];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function switchControl(label, checked, onChange, disabled = false) {
  const input = h('input', { type: 'checkbox', checked, disabled, 'aria-label': label, onchange: () => onChange(input) });
  return h('label', { class: `cmd-switch ${disabled ? 'locked' : ''}` }, input, h('span', { class: 'sw' }));
}

/** One category on its own page, with a big switch for the whole page. */
export const modulePage = (category) => (ctx) => botCommandsPage(ctx, category);

/** Every bot command with its own switch and limits, for this server only. */
export async function botCommandsPage(ctx, onlyCategory) {
  const url = `/api/guilds/${ctx.guildId}/config/commands`;
  const [config, commands] = await Promise.all([api(url), api(`/api/guilds/${ctx.guildId}/command-list`)]);
  const disabled = new Set(config.disabled);
  const rules = config.rules;
  const refreshers = [];
  const refreshAll = () => refreshers.forEach((fn) => fn());

  /** Saves right away, and puts things back if the save fails. */
  const saveDisabled = async (change) => {
    const before = [...disabled];
    change();
    refreshAll();
    try {
      await api(url, { method: 'PUT', body: { disabled: [...disabled] } });
      ctx.refreshStatus?.();
      return true;
    } catch (err) {
      disabled.clear();
      before.forEach((name) => disabled.add(name));
      refreshAll();
      toast(err.message, 'error');
      return false;
    }
  };

  const limitsText = (name) => {
    const rule = rules[name];
    if (!rule) return null;
    const parts = [];
    if (rule.allowedRoleIds?.length) parts.push(`Limited to ${plural(rule.allowedRoleIds.length, 'role')}`);
    if (rule.disabledRoleIds?.length) parts.push(`Blocked for ${plural(rule.disabledRoleIds.length, 'role')}`);
    if (rule.allowedChannelIds?.length) parts.push(`Only in ${plural(rule.allowedChannelIds.length, 'channel')}`);
    if (rule.disabledChannelIds?.length) parts.push(`Blocked in ${plural(rule.disabledChannelIds.length, 'channel')}`);
    if (rule.aliases?.length) parts.push(rule.aliases.length === 1 ? '1 alias' : `${rule.aliases.length} aliases`);
    if (rule.deleteInvocation || rule.deleteWithMessage || rule.deleteReplyAfter5s) parts.push('Auto-delete on');
    return parts.length ? parts.join(' · ') : null;
  };

  /** The settings that open under a command when Edit is pressed. */
  const editPanel = (command, onSaved, close) => {
    const saved = rules[command.name] ?? {};
    const locked = command.alwaysOn;
    const state = {
      aliases: [...(saved.aliases ?? [])], allowedRoleIds: [...(saved.allowedRoleIds ?? [])], disabledRoleIds: [...(saved.disabledRoleIds ?? [])],
      allowedChannelIds: [...(saved.allowedChannelIds ?? [])], disabledChannelIds: [...(saved.disabledChannelIds ?? [])],
      deleteWithMessage: Boolean(saved.deleteWithMessage), deleteInvocation: Boolean(saved.deleteInvocation), deleteReplyAfter5s: Boolean(saved.deleteReplyAfter5s),
    };
    const saveButton = h('button', { class: 'btn primary', type: 'button' }, icon('check'), 'Save Changes');
    saveButton.addEventListener('click', guard(saveButton, async () => {
      const aliases = state.aliases.map((a) => a.toLowerCase());
      const body = locked ? { aliases } : { ...state, aliases };
      const result = await api(url, { method: 'PUT', body: { rules: { [command.name]: body } } });
      Object.assign(rules, result.rules);
      onSaved();
      close();
      toast(`Saved /${command.name}.`);
    }));
    return h('div', { class: 'cmd-edit' },
      fieldGrid([
        { path: 'aliases', label: 'Aliases', type: 'list', lowercase: true, placeholder: 'Type an alias and press Enter', wide: locked, help: 'Use any prefix you like, such as p, #p or !play. Typing it in chat runs this command.' },
        ...(locked ? [] : [
          { path: 'allowedRoleIds', label: 'Enabled roles', type: 'roles', help: 'If you pick any, only these roles can use it.' },
          { path: 'disabledRoleIds', label: 'Disabled roles', type: 'roles', help: 'These roles can never use it.' },
          { path: 'allowedChannelIds', label: 'Enabled channels', type: 'channels', kinds: ['text', 'announcement', 'voice'], help: 'If you pick any, it only works in these channels.' },
          { path: 'disabledChannelIds', label: 'Disabled channels', type: 'channels', kinds: ['text', 'announcement', 'voice'], help: 'It never works in these channels.' },
          { path: 'deleteWithMessage', label: 'Auto-delete with message deletion', type: 'toggle', help: "Deleting the typed message also deletes the bot's reply." },
          { path: 'deleteInvocation', label: 'Auto-delete command invocation message', type: 'toggle', help: 'Deletes the typed message that ran the command. The bot needs Manage Messages.' },
          { path: 'deleteReplyAfter5s', label: "Auto-delete bot's reply message after 5 seconds", type: 'toggle' },
        ]),
      ], state, ctx),
      h('p', { class: 'cmd-modal-help' }, locked ? 'This command is always on, so only aliases can be changed. Its permission checks still apply.' : 'The server owner and Administrators are never limited by roles or channels.'),
      h('p', { class: 'cmd-modal-help' }, 'Replies that a slash command would show only to you appear in the channel for 30 seconds when you use an alias.'),
      h('div', { class: 'cmd-edit-actions' }, saveButton, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel')));
  };

  let closeOpenPanel = null;

  const row = (command) => {
    const limits = h('span', { class: 'pill cmd-limits' });
    const updateLimits = () => {
      const text = limitsText(command.name);
      limits.textContent = text ?? '';
      limits.hidden = !text;
    };
    updateLimits();
    const toggle = switchControl(`/${command.name}`, !disabled.has(command.name), (input) => saveDisabled(() => {
      if (input.checked) disabled.delete(command.name); else disabled.add(command.name);
    }).then((ok) => { if (ok) toast(`/${command.name} is ${input.checked ? 'on' : 'off'}.`); }), command.alwaysOn);
    const panelSlot = h('div', {});
    const closePanel = () => {
      panelSlot.replaceChildren();
      editButton.classList.remove('primary');
      editButton.setAttribute('aria-expanded', 'false');
      if (closeOpenPanel === closePanel) closeOpenPanel = null;
    };
    const editButton = h('button', { class: 'btn small', type: 'button', 'aria-label': `Edit /${command.name}`, 'aria-expanded': 'false', onclick: () => {
      if (closeOpenPanel === closePanel) return closePanel();
      closeOpenPanel?.(); // one open at a time keeps the list easy to read
      panelSlot.replaceChildren(editPanel(command, updateLimits, closePanel));
      editButton.classList.add('primary');
      editButton.setAttribute('aria-expanded', 'true');
      closeOpenPanel = closePanel;
    } }, 'Edit');
    const node = h('article', { class: 'cmd-row', 'data-search': `${command.name} ${command.description}`.toLowerCase() },
      h('div', { class: 'cmd-row-main' },
        h('div', { class: 'cmd-text' },
          h('h3', {}, `/${command.name}`, command.subcommands ? h('span', { class: 'cmd-subs' }, plural(command.subcommands, 'subcommand')) : null),
          h('p', {}, command.description),
          limits),
        h('div', { class: 'cmd-actions' }, command.alwaysOn ? h('span', { class: 'pill' }, 'Always on') : null, editButton, toggle)),
      panelSlot);
    refreshers.push(() => { toggle.querySelector('input').checked = !disabled.has(command.name); node.classList.toggle('off', disabled.has(command.name)); });
    return node;
  };

  const group = (category) => {
    const items = commands.filter((c) => c.category === category);
    const switchable = items.filter((c) => !c.alwaysOn);
    const single = category === onlyCategory;
    const master = switchControl(`All ${category} commands`, true, (input) => saveDisabled(() => {
      for (const c of switchable) { if (input.checked) disabled.delete(c.name); else disabled.add(c.name); }
    }).then((ok) => { if (ok) toast(`${category} commands are ${input.checked ? 'on' : 'off'}.`); }));
    refreshers.push(() => { master.querySelector('input').checked = switchable.some((c) => !disabled.has(c.name)); });
    if (single) master.classList.add('big');
    return h('section', { class: 'cmd-group', 'data-category': category },
      single
        ? h('header', { class: 'cmd-group-head module' }, h('h1', {}, category), master)
        : h('header', { class: 'cmd-group-head' }, h('h2', {}, category), h('span', { class: 'cmd-count' }, plural(items.length, 'command')), master),
      items.map(row));
  };

  const note = () => h('p', { class: 'cmd-note' }, 'A command you turn off stays in Discord\'s command list, because that list is shared by every server. Using it just replies that it is off.');
  if (onlyCategory) {
    const page = group(onlyCategory);
    refreshAll();
    return h('div', {}, page, note());
  }
  const groups = CATEGORY_ORDER.filter((c) => commands.some((x) => x.category === c)).map(group);
  refreshAll();

  const empty = h('p', { class: 'cmd-empty', hidden: true }, 'No commands match your search.');
  const search = h('input', { type: 'search', placeholder: 'Search commands', 'aria-label': 'Search commands', autocomplete: 'off', oninput: () => {
    const q = search.value.trim().toLowerCase();
    let any = false;
    for (const g of groups) {
      let shown = 0;
      for (const r of g.querySelectorAll('.cmd-row')) {
        r.hidden = !r.dataset.search.includes(q);
        if (!r.hidden) shown += 1;
      }
      g.hidden = !shown;
      any ||= shown > 0;
    }
    empty.hidden = any;
  } });

  return h('div', {},
    h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Commands'), h('p', {}, 'Choose which commands work on this server, and who can use them. Changes apply right away.'))),
    h('label', { class: 'cmd-search' }, icon('search'), search),
    groups,
    empty,
    note());
}
