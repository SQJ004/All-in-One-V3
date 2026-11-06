import { api, confirmDialog, guard, h, icon, showError, toast } from './lib.js';
import { configForm, fieldGrid, section } from './forms.js';

const head = (title, sub) => h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, title), h('p', {}, sub)));
const freeNote = () => h('p', { class: 'notice premium-note' }, 'Included free for now. ZYTHERON has no paid plan yet.');

/** A page made of a list that people add to and remove from. */
function listPage(ctx, sectionName, { title, sub, cardTitle, help, addLabel, empty, blank, fields }) {
  let render = () => {};
  return configForm(ctx, sectionName, (state, dirty) => {
    const list = h('div', { class: 'premium-list' });
    render = () => {
      list.replaceChildren(...(state.items.length ? state.items.map((item, n) => h('div', { class: 'card premium-item' },
        fieldGrid(fields, item, ctx, dirty),
        h('button', { class: 'btn small danger-text', type: 'button', onclick: () => { state.items.splice(n, 1); render(); dirty(); } }, 'Remove'))) : [h('p', { class: 'empty' }, empty)]));
    };
    render();
    return h('div', {}, head(title, sub), freeNote(),
      section(cardTitle, help,
        list,
        h('button', { class: 'btn', type: 'button', onclick: () => { state.items.push(blank()); render(); dirty(); } }, addLabel)));
  }, { onSaved: () => render() });
}

export const stickyPage = (ctx) => listPage(ctx, 'sticky', {
  title: 'Sticky Messages', sub: 'Keep a message at the bottom of a channel.', cardTitle: 'Your sticky messages',
  help: 'After people chat, ZYTHERON waits 5 seconds, then moves the message back to the bottom. It first appears after the next message in that channel. Mentions in it never ping anyone.',
  addLabel: 'Add sticky message', empty: 'No sticky messages yet.', blank: () => ({ channelId: null, content: '' }),
  fields: [
    { path: 'channelId', label: 'Channel', type: 'channel' },
    { path: 'content', label: 'Message', type: 'textarea', wide: true, max: 2000 },
  ],
});

export const autoPurgePage = (ctx) => listPage(ctx, 'autoPurge', {
  title: 'Auto Purge', sub: 'Delete old messages in chosen channels automatically.', cardTitle: 'Channels to clean',
  help: 'Deleted messages cannot be recovered. It runs every 5 minutes and always leaves pinned messages. Only the server owner or a trusted admin can change this. Discord does not let bots bulk delete messages older than 14 days, so those stay.',
  addLabel: 'Add channel', empty: 'No channels are being cleaned.', blank: () => ({ channelId: null, afterMinutes: 1440 }),
  fields: [
    { path: 'channelId', label: 'Channel', type: 'channel' },
    { path: 'afterMinutes', label: 'Delete messages older than (minutes)', type: 'number', min: 5, max: 20160, help: '1440 is one day. The longest is 20160, which is 14 days.' },
  ],
});

export const voiceLinkPage = (ctx) => listPage(ctx, 'voiceLink', {
  title: 'Voice Link', sub: 'Give a role while someone is in a voice channel.', cardTitle: 'Your links',
  help: "The role is added when someone joins the channel, and removed when they leave. Roles with moderator or admin permissions cannot be used, and ZYTHERON's role must be above the role it gives.",
  addLabel: 'Add link', empty: 'No voice links yet.', blank: () => ({ channelId: null, roleId: null }),
  fields: [
    { path: 'channelId', label: 'Voice channel', type: 'channel', kinds: ['voice'] },
    { path: 'roleId', label: 'Role to give', type: 'role' },
  ],
});

export const levelsPage = (ctx) => {
  let render = () => {};
  return configForm(ctx, 'community', (state, dirty) => {
    const rewards = h('div', { class: 'premium-list' });
    render = () => {
      rewards.replaceChildren(...(state.levels.rewards.length ? state.levels.rewards.map((reward, n) => h('div', { class: 'card premium-item' },
        fieldGrid([{ path: 'level', label: 'Level', type: 'number', min: 1, max: 1000 }, { path: 'roleId', label: 'Role to give', type: 'role' }], reward, ctx, dirty),
        h('button', { class: 'btn small danger-text', type: 'button', onclick: () => { state.levels.rewards.splice(n, 1); render(); dirty(); } }, 'Remove'))) : [h('p', { class: 'empty' }, 'No role rewards yet.')]));
    };
    render();
    return h('div', {}, head('Levels', 'Members earn XP for chatting.'), freeNote(),
      section('Leveling', 'Members can see their progress with /level rank and /level leaderboard.', fieldGrid([
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
      section('Role rewards', 'Give a role when a member reaches a level.', rewards,
        h('button', { class: 'btn', type: 'button', onclick: () => { state.levels.rewards.push({ level: 5, roleId: null }); render(); dirty(); } }, 'Add reward')));
  }, { onSaved: () => render() });
};

const MAX_IMAGE_BYTES = 180 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif'];

const readImage = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('That image could not be read.'));
  reader.readAsDataURL(file);
});

/** A picture you click to replace. It uploads as soon as you choose a file, and shows the bot's normal picture when nothing custom is set. */
function imageSpot(ctx, kind, label, defaultUrl, onChange) {
  const url = `/api/guilds/${ctx.guildId}/bot-images`;
  const picture = h('span', { class: 'profile-picture' });
  const input = h('input', { class: 'profile-file', type: 'file', accept: IMAGE_TYPES.join(','), tabIndex: -1, 'aria-hidden': 'true' });
  const button = h('button', { class: 'profile-pick', type: 'button', 'aria-label': `Change ${label.toLowerCase()}`, title: `Change ${label.toLowerCase()}`, onclick: () => input.click() },
    picture,
    h('span', { class: 'profile-overlay' }, icon('camera'), kind === 'banner' ? h('span', {}, 'Change banner') : null));
  const root = h('div', { class: `profile-spot ${kind}` }, button, input);
  const spot = {
    root,
    custom: null,
    show(custom) {
      spot.custom = custom;
      const src = custom ?? defaultUrl;
      picture.replaceChildren(...(src ? [h('img', { src, alt: '' })] : []));
      onChange();
    },
  };
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) return toast('Choose a PNG, JPG or GIF image.', 'err');
    if (file.size > MAX_IMAGE_BYTES) return toast('That image is too large. The limit is 180 KB.', 'err');
    root.classList.add('busy');
    button.disabled = true;
    try {
      const data = await readImage(file);
      await api(url, { method: 'PUT', body: { [kind]: data } });
      spot.show(data);
      toast(`${label} updated. Discord can take a moment to show it.`);
    } catch (err) {
      showError(err);
    } finally {
      root.classList.remove('busy');
      button.disabled = false;
    }
  });
  return spot;
}

export async function personalizePage(ctx) {
  const base = `/api/guilds/${ctx.guildId}`;
  const profile = await api(`${base}/bot-profile`);
  let savedNickname = profile.nickname;
  const reset = h('button', { class: 'btn', type: 'button' }, 'Reset to default');
  const updateReset = () => { reset.hidden = !(savedNickname || banner.custom || avatar.custom); };
  const banner = imageSpot(ctx, 'banner', 'Banner', profile.defaultBannerUrl, updateReset);
  const avatar = imageSpot(ctx, 'avatar', 'Avatar', profile.defaultAvatarUrl, updateReset);

  const shownName = h('strong', {});
  const nickname = h('input', { type: 'text', maxLength: 32, placeholder: profile.username, 'aria-label': 'Bot nickname', oninput: () => { shownName.textContent = nickname.value.trim() || profile.username; } });
  const showNickname = (value) => {
    savedNickname = value;
    nickname.value = value ?? '';
    shownName.textContent = value || profile.username;
    updateReset();
  };
  const apply = h('button', { class: 'btn primary', type: 'submit' }, 'Apply');
  const form = h('form', { class: 'input-group' }, nickname, apply);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    guard(apply, async () => {
      const value = nickname.value.trim() || null;
      await api(`${base}/nickname`, { method: 'PUT', body: { nickname: value ?? '' } });
      showNickname(value);
      toast(value ? 'Nickname changed.' : 'Nickname cleared.');
    })();
  });

  const showProfile = (current) => {
    banner.show(current.bannerUrl);
    avatar.show(current.avatarUrl);
    showNickname(current.nickname);
  };
  reset.addEventListener('click', guard(reset, async () => {
    const yes = await confirmDialog('Reset to default?', `This removes the custom avatar, banner and nickname in this server. ZYTHERON goes back to its normal look.`, 'Reset');
    if (!yes) return;
    try {
      const images = { ...(avatar.custom ? { avatar: null } : {}), ...(banner.custom ? { banner: null } : {}) };
      if (Object.keys(images).length) await api(`${base}/bot-images`, { method: 'PUT', body: images });
      if (savedNickname) await api(`${base}/nickname`, { method: 'PUT', body: { nickname: '' } });
      toast('Back to the default look. Discord can take a moment to show it.');
    } finally {
      // Shows what Discord really has now, even if only part of the reset worked.
      showProfile(await api(`${base}/bot-profile`));
    }
  }));
  showProfile(profile);

  return h('div', {}, head('Personalize', 'Change how ZYTHERON looks in this server only.'), freeNote(),
    h('section', { class: 'card profile-card' },
      banner.root,
      avatar.root,
      h('div', { class: 'profile-body' },
        h('p', { class: 'profile-name' }, shownName, h('span', { class: 'profile-tag' }, 'BOT')),
        h('p', { class: 'profile-help' }, 'Click the banner or avatar to change it. PNG, JPG or GIF, up to 180 KB.'),
        h('div', { class: 'profile-field' }, h('h2', {}, 'Nickname'), h('p', {}, "The bot's display name in this server."), form),
        h('div', { class: 'profile-reset' }, reset))));
}
