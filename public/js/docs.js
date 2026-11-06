import { api, h } from './lib.js';
import { commandCard, commandsSection, communitySection, footer, header, inviteLink, inviteSection, observeReveals, premiumSection } from './landing.js';

// The documentation. Command lists come from the running bot, so they cannot go out of date.
// The wording describes real features, so update it when features change.

const code = (text) => ({ code: text });

const GROUPS = [
  { title: 'Get started', pages: [
    { id: 'getting-started', title: 'Getting started', intro: 'Add ZYTHERON to your server and get it ready in a few minutes.', special: 'invite', blocks: [
      { h: 'After adding ZYTHERON', steps: ['Move the ZYTHERON role near the top of your role list. It cannot act on anyone above it.', 'Run /setup. It shows missing permissions and which systems are off.', 'Run /security setup to start protection in monitor mode.', 'Run /help to see every system.'] },
    ], commands: ['setup', 'help', 'ping'] },
    { id: 'using-commands', title: 'Slash, v! and aliases', intro: 'There are three ways to run a command.', blocks: [
      { h: 'Slash commands', p: 'Type / in Discord and pick a command from the list. Every command works this way.' },
      { h: 'The v! prefix', p: 'Music commands and /user, /avatar, /server, /roles, /roll and /moveme also work as typed messages. Change the prefix, or add more, under Bot settings in the dashboard.' }, code('v!play lofi'),
      { h: 'Your own aliases', p: 'Open a command under Edit in the dashboard and add an alias with any prefix, such as p, #p or !play. Words after the alias are passed to the command in order, or as name:value.' }, code('#mod warn @someone being rude'),
      { h: 'Good to know', list: ['All permission checks and dashboard rules still apply to typed commands.', 'Replies a slash command would show only to you appear in the channel for 30 seconds when you use an alias.', 'Commands that open a form only work as slash commands.', 'An alias with no prefix runs on any message that starts with that word, so a prefix like # is safer.'] },
    ] },
    { id: 'dashboard', title: 'Web dashboard', intro: 'Sign in with Discord to manage your server from the website.', blocks: [
      { h: 'Who can use it', p: 'You see servers where you have the Manage Server permission. Your Discord permissions are checked on every request, and only the server owner or a trusted admin can change security settings.' },
      { h: 'Turning commands on and off', p: 'All Commands, Utility, Music and Fun list commands with a switch and an Edit button. Edit sets aliases, enabled and disabled roles and channels, and auto-delete options. /security, /help and /setup are always on, and can only have aliases.' },
      { h: 'Bot settings', p: 'Set the bot\'s nickname, choose typed-command prefixes, and see who changed what on the dashboard in the last 90 days.' },
      { h: 'Status ticks', p: 'A green tick in the menu means a module is on, and a grey dot means it is off.' },
    ] },
  ] },
  { title: 'Protection', pages: [
    { id: 'security', title: 'Security', intro: 'Anti-nuke, anti-raid, scam link detection and emergency lockdown.', blocks: [
      { h: 'Monitor and Enforce', p: 'New servers start in monitor mode: threats are logged and nobody is punished. Review what it finds with /security events, whitelist your trusted staff and bots, then switch to Enforce.' },
      { h: 'Who is never punished', p: 'The server owner, trusted admins, and whitelisted users and roles are never punished by anti-nuke.' },
      { h: 'Recovery', p: 'Recovery can rebuild deleted channels and roles and reverse mass bans. It cannot bring back messages or re-add kicked members.' },
      { h: 'Lockdown', p: '/security lockdown on locks channels in an emergency, and /security lockdown off restores them as they were.' },
    ], commands: ['security'] },
    { id: 'automod', title: 'Auto moderation', intro: 'Filter banned words, excessive capitals, invites and chosen domains automatically.', blocks: [
      { h: 'Set it up', steps: ['Check the current rules with /automod status.', 'Add words with /automod word-add.', 'Set rules for capitals, invites and domains.', 'Exempt trusted channels or roles with /automod exempt.'] },
    ], commands: ['automod'] },
    { id: 'moderation', title: 'Moderation', intro: 'Bans, timeouts, warnings, jail and channel controls, with a full case history.', blocks: [
      { h: 'Set it up', steps: ['Choose a log channel with /modconfig modlog.', 'Decide whether members get a DM with /modconfig dm.', 'Prepare the jail role with /modconfig jail-setup.', 'Set automatic actions with /modconfig warn-threshold.'] },
    ], commands: ['moderation', 'modconfig'] },
    { id: 'logging', title: 'Logging', intro: 'An audit trail for messages, members, roles, channels, voice, bans, invites, webhooks and server changes.', blocks: [
      { h: 'Set it up', p: 'This turns logging on and sends every category to one channel:' }, code('/logs setup channel:#logs'),
      { p: 'To send one category somewhere else, use /logs route. If logging seems silent, run /logs status, which warns you when nothing is being posted.' },
      { h: 'Role and channel logs', p: 'These show permission names, with ✅ allowed or added, ⛔ denied or removed, and ➖ back to default. ZYTHERON needs View Audit Log to report who made each change.' },
    ], commands: ['logs'] },
  ] },
  { title: 'Community', pages: [
    { id: 'welcome', title: 'Welcome & goodbye', intro: 'Greet new members with embeds and generated image cards.', blocks: [
      { h: 'Set it up', steps: ['Choose a channel with /welcome setup.', 'Try it with /welcome test.', 'Change the message with /welcome edit, and the image with /welcome card.', 'Turn on goodbye messages with /welcome goodbye, and DMs with /welcome dm.'] },
      { h: 'Variables', p: 'Use these in your messages:' }, code('{user} {username} {server} {membercount} {avatar} {userid} {createdat} {joinposition}'),
    ], commands: ['welcome'] },
    { id: 'music', title: 'Music', intro: 'Play music in voice with a live player, queue and buttons.', blocks: [
      { h: 'Play something', p: 'Join a voice channel, then use a song name or a link:' }, code('/play lofi'),
      { h: 'What can play', list: ['Song names and Audius links. Audius is an open music service that permits streaming, and is mostly independent artists.', 'Direct links to audio files you are allowed to use, such as an .mp3.', 'YouTube and Spotify links, only when the same recording is on Audius. Those services do not allow bots to play their audio, so many famous songs will not play. ZYTHERON says so instead of playing the wrong song.'] },
      { h: 'Good to know', list: ['To change the music, you must be in the same voice channel as the bot.', 'Each server has its own player, queue, loop setting and saved volume.', 'ZYTHERON leaves after a few minutes with nothing playing or nobody listening.', 'It needs the Connect and Speak permissions.'] },
      { h: 'Watching YouTube together', p: '/youtube searches YouTube, and its Watch Together button opens Discord\'s own YouTube activity in your voice channel.' },
    ], commands: ['play', 'pause', 'resume', 'skip', 'stop', 'leave', 'queue', 'nowplaying', 'volume', 'loop', 'shuffle', 'remove', 'clearqueue', 'previous', 'seek', 'lyrics', 'youtube'] },
    { id: 'tickets', title: 'Tickets', intro: 'Members press a button to open a private support channel with your staff.', blocks: [
      { h: 'Set it up', steps: ['Run /ticket setup.', 'Create a panel with /ticket panel-create.', 'Add categories with /ticket panel-category.', 'Post it with /ticket panel-publish.'] },
      { p: 'Staff can claim, close and reopen tickets. Transcripts are saved when a ticket closes, and members can rate their support.' },
    ], commands: ['ticket'] },
    { id: 'roles', title: 'Roles', intro: 'Auto roles, role panels, temporary roles and self roles.', blocks: [
      { h: 'Role panels', steps: ['Create a panel with /rolepanel create, using reactions, buttons or a menu.', 'Add roles with /rolepanel add.', 'Post it with /rolepanel publish.'] },
      { h: 'Others', list: ['/autorole gives roles automatically when someone joins, with separate lists for people and bots.', '/temprole gives a role for a limited time.', '/selfrole lets members pick from roles you allow.'] },
    ], commands: ['rolepanel', 'autorole', 'temprole', 'selfrole'] },
    { id: 'community', title: 'Levels & engagement', intro: 'Levels, giveaways, polls, suggestions and more to keep your server active.', blocks: [
      { list: ['Levels: members earn XP by chatting, with ranks, a leaderboard and role rewards.', 'Giveaways: a button to enter, with winners drawn automatically.', 'Polls, suggestions and a starboard for your best messages.', 'Birthdays, invite tracking, server statistics, profiles and verification challenges.'] },
    ], commands: ['level', 'giveaway', 'poll', 'suggest', 'suggestions', 'starboard', 'birthday', 'invites', 'serverstats', 'profile', 'challenge', 'afk'] },
    { id: 'utility', title: 'Utility', intro: 'Quick information and small helpers.', commands: ['user', 'avatar', 'server', 'roles', 'roll', 'moveme'] },
  ] },
  { title: 'Tools', pages: [
    { id: 'embeds', title: 'Embed builder', intro: 'Publish rich messages with one command, or use the editor for more.', blocks: [
      { h: 'Publish straight away', p: 'Use \\n in the description for a new line. With no content, this opens the builder instead.' }, code('/embed create title:Welcome! description:Hello! channel:#welcome color:#8B5CF6'),
      { h: 'The builder', p: '/embed builder adds fields, multiple embeds, role buttons and menus. Save designs as templates, or import and export them as JSON.' },
    ], commands: ['embed'] },
    { id: 'automation', title: 'Automation', intro: 'Auto responses, custom commands, schedules and trigger rules.', blocks: [
      { list: ['/autoresponse replies automatically to keywords.', '/cc creates your own commands, used with a text prefix that /cc prefix sets. It is ! by default.', '/schedule posts one-off or recurring messages.', '/rule links a trigger to actions.'] },
    ], commands: ['autoresponse', 'cc', 'schedule', 'rule'] },
    { id: 'commands', title: 'All commands', intro: 'Every command the bot can run, with usage and required permissions.', special: 'commands' },
  ] },
  { title: 'More', pages: [
    { id: 'premium', title: 'Premium', intro: 'These features are free for now, because ZYTHERON has no paid plan yet.', blocks: [
      { h: 'In your dashboard', list: ['Anti-Nuke: stops one account from destroying your server.', 'Anti-Raid: responds to waves of new accounts.', 'Anti-Webhook: finds webhook abuse.', 'Server Backup & Restore: saves your roles, channels and settings.', 'Advanced Ticket System: private support channels.', 'Custom Bot Identity: the name, picture and status of the bot.', 'Advanced Audit Logs: a searchable record of what happens.', 'Staff Performance: leaderboard, profiles, goals and staff history.'] },
      { h: 'Planned', p: 'These may become a paid plan later, along with the ideas below.' },
    ], special: 'premium' },
    { id: 'support', title: 'Support', intro: 'Get help from the ZYTHERON team and community.', special: 'support' },
  ] },
];

const PAGES = GROUPS.flatMap((group) => group.pages);

let catalog = null;

function pageCommands(names) {
  const grid = h('div', { class: 'lp-command-grid docs-commands' }, h('p', { class: 'lp-empty' }, 'Loading commands…'));
  const fill = (commands) => grid.replaceChildren(...commands.filter((c) => names.includes(c.name.slice(1).split(' ')[0])).map(commandCard));
  if (catalog) fill(catalog);
  else api('/api/public/commands').then((res) => { catalog = res.commands; fill(catalog); }, () => grid.replaceChildren(h('p', { class: 'lp-empty' }, 'The command list could not be loaded. Please reload the page.')));
  return h('section', {}, h('h2', {}, 'Commands'), grid);
}

function renderBlock(block) {
  if (block.code) return h('pre', { class: 'docs-code' }, h('code', {}, block.code));
  return h('section', {},
    block.h ? h('h2', {}, block.h) : null,
    block.p ? h('p', {}, block.p) : null,
    block.list ? h('ul', {}, block.list.map((item) => h('li', {}, item))) : null,
    block.steps ? h('ol', {}, block.steps.map((item) => h('li', {}, item))) : null);
}

const SPECIAL = {
  commands: () => commandsSection({ heading: false }),
  premium: () => premiumSection({ heading: false }),
  support: (info) => communitySection(info),
  invite: (info) => inviteSection(info),
};

export function docsView({ page, info, user, cleanups }) {
  const current = PAGES.find((p) => p.id === page) ?? PAGES[0];
  const index = PAGES.indexOf(current);
  const previous = PAGES[index - 1];
  const next = PAGES[index + 1];
  const jump = h('select', { class: 'docs-jump', 'aria-label': 'Choose a docs page', onchange: (e) => { location.hash = `#/docs/${e.target.value}`; } },
    GROUPS.map((group) => h('optgroup', { label: group.title }, group.pages.map((p) => h('option', { value: p.id, selected: p === current }, p.title)))));
  const root = h('div', { class: 'lp' },
    header(info, user),
    h('div', { class: 'docs lp-wrap' },
      h('nav', { class: 'docs-side', 'aria-label': 'Documentation' },
        jump,
        h('div', { class: 'docs-menu' }, GROUPS.map((group) => h('div', { class: 'docs-group' },
          h('h2', {}, group.title),
          group.pages.map((p) => h('a', { href: `#/docs/${p.id}`, class: p === current ? 'active' : '', 'aria-current': p === current ? 'page' : undefined }, p.title)))))),
      h('main', { class: 'docs-main' },
        h('p', { class: 'lp-eyebrow' }, 'Docs'),
        h('h1', {}, current.title),
        h('p', { class: 'docs-intro' }, current.intro),
        current.special === 'invite' ? h('div', { class: 'docs-special' }, SPECIAL.invite(info)) : null,
        (current.blocks ?? []).map(renderBlock),
        current.special && current.special !== 'invite' ? h('div', { class: 'docs-special' }, SPECIAL[current.special](info)) : null,
        current.commands ? pageCommands(current.commands) : null,
        h('div', { class: 'docs-pager' },
          previous ? h('a', { href: `#/docs/${previous.id}` }, h('small', {}, 'Previous'), previous.title) : h('span', {}),
          next ? h('a', { class: 'next', href: `#/docs/${next.id}` }, h('small', {}, 'Next'), next.title) : h('span', {})),
        h('div', { class: 'docs-cta' }, h('p', {}, 'Ready to try it?'), inviteLink(info, 'Add to Discord')))),
    footer(info));
  requestAnimationFrame(() => observeReveals(root, cleanups));
  return root;
}
