import { describe, expect, it } from 'vitest';
import { defaultGuildConfig } from '../../src/config/guildConfig.js';
import { capsPercent, isSecurityExempt, ladderAction, MessageGuard, NukeTracker, RaidDetector, scoreAccount, StrikeLedger, violationWeight, wordMatch, type MessageFacts } from '../../src/modules/security/engine.js';
import { analyzeHost, foldHomoglyphs, levenshtein, parseFeed, scanContent, setFeedDomains } from '../../src/modules/security/linkScanner.js';

const cfg = () => defaultGuildConfig().security;
const links = { scam: true, phishing: true, invites: false, allowedDomains: [], blockedDomains: [] };

describe('link scanner', () => {
  it.each(['https://discord.com/channels/1/2', 'https://discord.gg/abc', 'https://cdn.discordapp.com/x.png', 'https://www.youtube.com/watch?v=1', 'https://github.com/x', 'https://steamcommunity.com/id/x', 'https://example.com/discord-guide', 'https://finance.com/a', 'https://discard.app/'])('allows %s', (url) => {
    expect(scanContent(url, links)).toEqual([]);
  });

  it.each([
    ['https://dlscord.com/nitro', 'phishing'], ['https://d1sc0rd.gg/free', 'phishing'], ['https://discord-nitro.gift/claim', 'phishing'], ['https://discordnitro-free.com', 'phishing'],
    ['https://steamcommunlty.com/tradeoffer', 'phishing'], ['https://discord.com.evil.ru/login', 'phishing'], ['https://xn--dscord-3ya.com', 'phishing'], ['https://185.12.33.4/login', 'phishing'],
    ['https://grabify.link/abc', 'scam'], ['https://discord.com@evil-host.ru/login', null],
  ])('flags %s', (url, category) => {
    const r = scanContent(url, links);
    if (category) expect(r[0]?.category).toBe(category);
    else expect(r.every((v) => v.host !== 'discord.com')).toBe(true); // userinfo trick resolves to the real host
  });

  it('uses the real host when userinfo tries to disguise it', () => {
    expect(scanContent('https://discord.com@discord-gift.xyz/x', links)[0]?.host).toBe('discord-gift.xyz');
  });

  it('respects the allow and block lists', () => {
    expect(scanContent('https://dlscord.com', { ...links, allowedDomains: ['dlscord.com'] })).toEqual([]);
    expect(scanContent('https://sub.bad.example/x', { ...links, blockedDomains: ['bad.example'] })[0]?.category).toBe('blocked');
  });

  it('blocks invites only when asked', () => {
    expect(scanContent('join discord.gg/abc', links)).toEqual([]);
    expect(scanContent('join discord.gg/abc', { ...links, invites: true })[0]?.category).toBe('invite');
  });

  it('catches scam scripts that carry a link, but not the phrase alone', () => {
    expect(scanContent('Free nitro here https://some-site.example/x', links)[0]?.category).toBe('scam');
    expect(scanContent('is free nitro a scam?', links)).toEqual([]);
  });

  it('applies toggles per category', () => {
    expect(scanContent('https://dlscord.com', { ...links, phishing: false })).toEqual([]);
    expect(scanContent('https://grabify.link/a', { ...links, scam: false })).toEqual([]);
  });

  it('uses the remote feed', () => {
    expect(analyzeHost('freshly-listed.example')).toBeNull();
    setFeedDomains(parseFeed('# comment\nfreshly-listed.example\n'));
    expect(analyzeHost('a.freshly-listed.example')?.category).toBe('scam');
    setFeedDomains(parseFeed('["other.example"]'));
    expect(analyzeHost('freshly-listed.example')).toBeNull();
    setFeedDomains([]);
  });

  it('computes helpers', () => {
    expect(levenshtein('discord', 'discrd')).toBe(1);
    expect(foldHomoglyphs('d1sc0rd')).toBe(foldHomoglyphs('discord'));
  });
});

describe('anti-nuke counting', () => {
  const limit = { count: 3, windowSec: 30 };
  it('trips exactly once at the limit', () => {
    const t = new NukeTracker();
    const now = 1_000_000;
    expect(t.record('g', 'a', 'channelDelete', limit, now).trip).toBe(false);
    expect(t.record('g', 'a', 'channelDelete', limit, now + 1).trip).toBe(false);
    expect(t.record('g', 'a', 'channelDelete', limit, now + 2).trip).toBe(true);
    const after = t.record('g', 'a', 'channelDelete', limit, now + 3);
    expect(after.trip).toBe(false);
    expect(after.alreadyTripped).toBe(true);
  });
  it('forgets actions outside the window', () => {
    const t = new NukeTracker();
    t.record('g', 'a', 'ban', limit, 0);
    t.record('g', 'a', 'ban', limit, 1000);
    expect(t.record('g', 'a', 'ban', limit, 31_000).trip).toBe(false);
  });
  it('counts per person and per guild', () => {
    const t = new NukeTracker();
    t.record('g', 'a', 'ban', limit, 0);
    t.record('g', 'b', 'ban', limit, 0);
    t.record('h', 'a', 'ban', limit, 0);
    expect(t.record('g', 'a', 'ban', limit, 1).count).toBe(2);
  });
  it('exempts owner, the bot, trusted and whitelisted', () => {
    const s = { ...cfg(), trustedAdmins: ['t'], whitelistUsers: ['w'], whitelistRoles: ['r'] };
    const ctx = { ownerId: 'o', botId: 'b', roleIds: [] as string[] };
    for (const actorId of ['o', 'b', 't', 'w']) expect(isSecurityExempt(s, { ...ctx, actorId })).toBe(true);
    expect(isSecurityExempt(s, { ...ctx, actorId: 'x', roleIds: ['r'] })).toBe(true);
    expect(isSecurityExempt(s, { ...ctx, actorId: 'x', roleIds: ['other'] })).toBe(false);
  });
});

describe('raid detection', () => {
  const raidCfg = { ...cfg().antiRaid, joinThreshold: 3, windowSec: 10, raidModeMinutes: 5 };
  it('opens raid mode at the threshold, then flags later joiners', () => {
    const d = new RaidDetector();
    expect(d.join('g', 'a', raidCfg, 0).raid).toBe(false);
    expect(d.join('g', 'b', raidCfg, 1000).raid).toBe(false);
    const third = d.join('g', 'c', raidCfg, 2000);
    expect(third).toMatchObject({ raid: true, started: true });
    expect(third.recent).toEqual(['a', 'b', 'c']);
    expect(d.join('g', 'd', raidCfg, 3000)).toMatchObject({ raid: true, started: false });
  });
  it('does not fire on slow, steady joins', () => {
    const d = new RaidDetector();
    for (let n = 0; n < 20; n++) expect(d.join('g', `u${n}`, raidCfg, n * 11_000).raid).toBe(false);
  });
  it('ends after raid mode expires or by hand', () => {
    const d = new RaidDetector();
    for (const id of ['a', 'b', 'c']) d.join('g', id, raidCfg, 0);
    expect(d.isActive('g', 1000)).toBe(true);
    expect(d.isActive('g', 6 * 60_000)).toBe(false);
    d.end('g');
    expect(d.isActive('g', 1000)).toBe(false);
  });
});

describe('suspicious accounts', () => {
  it('flags new accounts with no avatar', () => {
    const r = scoreAccount({ ageDays: 0.5, hasAvatar: false, username: 'alex', bot: false }, 3);
    expect(r.score).toBeGreaterThanOrEqual(60);
    expect(r.reasons.length).toBeGreaterThan(1);
  });
  it('does not flag established accounts just for having no avatar', () => {
    expect(scoreAccount({ ageDays: 800, hasAvatar: false, username: 'sam', bot: false }, 3).score).toBeLessThan(60);
  });
  it('raises the score for scam usernames', () => {
    expect(scoreAccount({ ageDays: 800, hasAvatar: true, username: 'Free Nitro Giveaway', bot: false }, 3).score).toBeGreaterThan(0);
  });
});

describe('message guard', () => {
  const facts = (over: Partial<MessageFacts> = {}): MessageFacts => ({ guildId: 'g', authorId: 'a', channelId: 'c', messageId: String(Math.random()), content: 'hello', userMentions: 0, roleMentions: 0, everyoneAttempt: false, canMentionEveryone: false, ...over });
  it('catches message floods but not normal chat', () => {
    const g = new MessageGuard();
    const s = cfg();
    for (let n = 0; n < s.antiSpam.maxMessages - 1; n++) expect(g.evaluate(s, facts({ content: `msg ${n}` }), n * 100).filter((v) => v.type === 'spam')).toEqual([]);
    const v = g.evaluate(s, facts({ content: 'last' }), 700).find((x) => x.type === 'spam');
    expect(v?.deleteIds?.length).toBe(s.antiSpam.maxMessages);
  });
  it('catches duplicates, ignoring case and spacing', () => {
    const g = new MessageGuard();
    const s = cfg();
    const texts = ['BUY NOW', 'buy  now', 'buy now', ' Buy Now '];
    const out = texts.map((content, n) => g.evaluate(s, facts({ content }), n * 3000));
    expect(out[3]!.some((v) => v.type === 'duplicate')).toBe(true);
    expect(out[2]!.some((v) => v.type === 'duplicate')).toBe(false);
  });
  it('does not treat attachment-only messages as duplicates', () => {
    const g = new MessageGuard();
    const s = cfg();
    for (let n = 0; n < 5; n++) expect(g.evaluate(s, facts({ content: '' }), n * 3000).some((v) => v.type === 'duplicate')).toBe(false);
  });
  it('keeps users separate', () => {
    const g = new MessageGuard();
    const s = cfg();
    for (let n = 0; n < 20; n++) expect(g.evaluate(s, facts({ authorId: `u${n}`, content: 'same' }), n)).toEqual([]);
  });
  it('catches mass mentions and @everyone attempts', () => {
    const g = new MessageGuard();
    const s = cfg();
    expect(g.evaluate(s, facts({ userMentions: 5, roleMentions: 1 })).some((v) => v.type === 'mass_mention')).toBe(true);
    expect(g.evaluate(s, facts({ everyoneAttempt: true })).some((v) => v.type === 'everyone')).toBe(true);
    expect(g.evaluate(s, facts({ everyoneAttempt: true, canMentionEveryone: true, messageId: 'x', authorId: 'b' })).some((v) => v.type === 'everyone')).toBe(false);
  });
  it('matches banned words on word boundaries only', () => {
    expect(wordMatch('this is bad', ['bad'])).toBe('bad');
    expect(wordMatch('a badminton game', ['bad'])).toBeNull();
    expect(wordMatch('a.b test', ['a.b'])).toBe('a.b');
  });
  it('measures caps, ignoring short messages', () => {
    expect(capsPercent('LOL')).toBe(0);
    expect(capsPercent('THIS IS A VERY LOUD MESSAGE')).toBe(100);
    expect(capsPercent('this is a calm message here')).toBe(0);
  });
});

describe('strike ladder', () => {
  const ladder = cfg().ladder;
  it('selects the highest rung reached', () => {
    expect(ladderAction(ladder, 1)?.action).toBe('delete');
    expect(ladderAction(ladder, 3)?.action).toBe('timeout');
    expect(ladderAction(ladder, 7)).toMatchObject({ action: 'timeout', durationMinutes: 120 });
    expect(ladderAction(ladder, 50)?.action).toBe('kick');
    expect(ladderAction([], 5)).toBeNull();
  });
  it('decays old strikes', () => {
    const l = new StrikeLedger();
    expect(l.add('g', 'u', 60, 1, 0)).toBe(1);
    expect(l.add('g', 'u', 60, 2, 1000)).toBe(3);
    expect(l.add('g', 'u', 60, 1, 61 * 60_000 + 1001)).toBe(1);
  });
  it('weights scam links above ordinary violations, but not invites', () => {
    expect(violationWeight({ type: 'link', detail: '', link: { url: '', host: '', category: 'phishing', reason: '' } })).toBe(3);
    expect(violationWeight({ type: 'link', detail: '', link: { url: '', host: '', category: 'invite', reason: '' } })).toBe(1);
    expect(violationWeight({ type: 'spam', detail: '' })).toBe(1);
  });
});
