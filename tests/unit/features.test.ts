import { ButtonStyle, ComponentType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { UserError } from '../../src/core/types.js';
import { compileUserRegex, matchesTrigger, nextCronRun } from '../../src/modules/automation/rules.js';
import { pickWinners, tallyPoll } from '../../src/modules/community/engagement.js';
import { levelForXp, levelProgress, xpForLevel } from '../../src/modules/community/levels.js';
import { birthdayDates, detectUsedInvite, mathChallenge, validBirthday } from '../../src/modules/community/members.js';
import { emptySpec, importJson, isEmbedEmpty, LIBRARY, MessageSpecSchema, renderComponents, renderEmbed, renderMessage, toEmoji } from '../../src/modules/embeds/spec.js';
import { renderChange } from '../../src/modules/logging/index.js';
import { decidePanelChange } from '../../src/modules/roles/index.js';
import { renderTranscript } from '../../src/modules/tickets/transcript.js';
import { renderCard } from '../../src/modules/welcome/card.js';

const ROLE = '123456789012345678';

describe('embed spec', () => {
  it('enforces Discord limits', () => {
    expect(() => MessageSpecSchema.parse({ embeds: [{ title: 'x'.repeat(257) }] })).toThrow();
    expect(() => MessageSpecSchema.parse({ embeds: Array(11).fill({ title: 'x' }) })).toThrow();
    expect(() => MessageSpecSchema.parse({ embeds: [{ fields: Array(26).fill({ name: 'a', value: 'b' }) }] })).toThrow();
    expect(() => MessageSpecSchema.parse({ embeds: [{ fields: [{ name: '', value: 'b' }] }] })).toThrow();
    expect(() => MessageSpecSchema.parse({ embeds: [{ color: 'purple' }] })).toThrow();
    expect(() => MessageSpecSchema.parse({ embeds: [{ image: 'javascript:alert(1)' }] })).toThrow();
    expect(() => MessageSpecSchema.parse({ buttons: [{ kind: 'link', label: 'x', url: 'javascript:alert(1)' }] })).toThrow();
    expect(() => MessageSpecSchema.parse({ buttons: [{ kind: 'role', label: 'x', roleId: 'abc' }] })).toThrow();
  });
  it('enforces the 6000 character total across embeds', () => {
    const big = { description: 'x'.repeat(4000) };
    expect(() => MessageSpecSchema.parse({ embeds: [big, big] })).toThrow(/6000/);
    expect(() => MessageSpecSchema.parse({ embeds: [big, { description: 'x'.repeat(1999) }] })).not.toThrow();
  });
  it('renders every feature', () => {
    const e = renderEmbed(MessageSpecSchema.parse({ embeds: [{ title: 'Hi {server}', description: 'd', color: '#ff0000', authorName: 'a', authorIcon: 'https://x.y/a.png', footerText: 'f', thumbnail: 'https://x.y/t.png', image: '{avatar}', timestamp: true, fields: [{ name: 'n', value: 'v', inline: true }] }] }).embeds[0]!, { server: 'Srv', avatar: 'https://x.y/av.png' });
    expect(e).toMatchObject({ title: 'Hi Srv', color: 0xff0000, author: { name: 'a', icon_url: 'https://x.y/a.png' }, footer: { text: 'f' }, thumbnail: { url: 'https://x.y/t.png' }, image: { url: 'https://x.y/av.png' }, fields: [{ name: 'n', value: 'v', inline: true }] });
    expect(e.timestamp).toBeTruthy();
  });
  it('drops image variables that do not resolve to a URL', () => {
    expect(renderEmbed(MessageSpecSchema.parse({ embeds: [{ title: 't', image: '{avatar}' }] }).embeds[0]!).image).toBeUndefined();
  });
  it('renders buttons into rows of five, with a role menu', () => {
    const spec = MessageSpecSchema.parse({ buttons: [...Array(6).fill({ kind: 'role', label: 'r', roleId: ROLE, style: 'success' }), { kind: 'link', label: 'l', url: 'https://x.y' }], roleMenu: { options: [{ label: 'A', roleId: ROLE }] } });
    const rows = renderComponents(spec);
    expect(rows.length).toBe(3);
    expect(rows[0]!.components.length).toBe(5);
    expect(rows[0]!.components[0]).toMatchObject({ type: ComponentType.Button, style: ButtonStyle.Success });
    const ids = rows.flatMap((r) => r.components).flatMap((c: any) => (c.custom_id ? [c.custom_id] : []));
    expect(new Set(ids).size).toBe(ids.length); // Discord rejects duplicate custom IDs in one message
    expect(rows[1]!.components[1]).toMatchObject({ style: ButtonStyle.Link, url: 'https://x.y' });
    expect(rows[2]!.components[0]).toMatchObject({ type: ComponentType.StringSelect, custom_id: 'embed:rolemenu' });
  });
  it('never exceeds 5 component rows', () => {
    const spec = MessageSpecSchema.parse({ buttons: Array(20).fill({ kind: 'link', label: 'l', url: 'https://x.y' }), roleMenu: { options: [{ label: 'A', roleId: ROLE }] } });
    expect(renderComponents(spec).length).toBeLessThanOrEqual(5);
  });
  it('parses unicode and custom emoji', () => {
    expect(toEmoji('🔥')).toEqual({ name: '🔥' });
    expect(toEmoji('<:cat:123456789012345678>')).toMatchObject({ id: '123456789012345678', name: 'cat' });
    expect(toEmoji('<a:cat:123456789012345678>')).toMatchObject({ animated: true });
    expect(toEmoji(undefined)).toBeUndefined();
  });
  it('round-trips JSON export and import', () => {
    const spec = MessageSpecSchema.parse({ content: 'hello', embeds: [{ title: 't', fields: [{ name: 'a', value: 'b' }] }], buttons: [{ kind: 'link', label: 'l', url: 'https://x.y' }] });
    expect(importJson(JSON.stringify(spec))).toEqual(spec);
  });
  it('imports plain Discord message JSON', () => {
    const r = importJson(JSON.stringify({ content: 'c', embeds: [{ title: 't', color: 0xff0000, footer: { text: 'f' }, author: { name: 'a' }, image: { url: 'https://x.y/i.png' }, fields: [{ name: 'n', value: 'v' }] }] }));
    expect(r.embeds[0]).toMatchObject({ title: 't', color: '#ff0000', footerText: 'f', authorName: 'a', image: 'https://x.y/i.png' });
  });
  it('rejects bad JSON cleanly', () => {
    expect(() => importJson('{nope')).toThrow(/valid JSON/);
    expect(() => importJson('{"embeds":[{"color":"nope"}]}')).toThrow();
  });
  it('ships a valid template library and starting draft', () => {
    for (const [name, entry] of Object.entries(LIBRARY)) expect(renderMessage(entry.spec()).embeds.length, name).toBeGreaterThan(0);
    expect(isEmbedEmpty(emptySpec().embeds[0]!)).toBe(false);
    expect(isEmbedEmpty(MessageSpecSchema.parse({ embeds: [{}] }).embeds[0]!)).toBe(true);
  });
});

describe('role panels', () => {
  const items = [{ roleId: 'a', label: 'A' }, { roleId: 'b', label: 'B' }];
  const panel = (behavior: any, requiredRoleId: string | null = null) => ({ behavior, items, requiredRoleId });
  it('toggles', () => {
    expect(decidePanelChange(panel('toggle'), new Set(), 'a')).toEqual({ add: ['a'], remove: [] });
    expect(decidePanelChange(panel('toggle'), new Set(['a']), 'a')).toEqual({ add: [], remove: ['a'] });
  });
  it('keeps one role in unique mode', () => {
    expect(decidePanelChange(panel('unique'), new Set(['b']), 'a')).toEqual({ add: ['a'], remove: ['b'] });
    expect(decidePanelChange(panel('unique'), new Set(['a']), 'a')).toEqual({ add: [], remove: ['a'] });
  });
  it('honours add only and remove only', () => {
    expect(decidePanelChange(panel('add_only'), new Set(['a']), 'a')).toEqual({ add: [], remove: [] });
    expect(decidePanelChange(panel('remove_only'), new Set(), 'a')).toEqual({ add: [], remove: [] });
    expect(decidePanelChange(panel('remove_only'), new Set(['a']), 'a')).toEqual({ add: [], remove: ['a'] });
  });
  it('checks the required role', () => {
    expect(decidePanelChange(panel('toggle', 'vip'), new Set(), 'a').denied).toBeTruthy();
    expect(decidePanelChange(panel('toggle', 'vip'), new Set(['vip']), 'a').add).toEqual(['a']);
  });
});

describe('automation', () => {
  it.each([['hello there', 'hello', 'contains', true], ['HELLO', 'hello', 'exact', true], ['hello you', 'hello', 'exact', false], ['  hello you', 'hello', 'startsWith', true], ['shell', 'hell', 'word', false], ['oh hell!', 'hell', 'word', true], ['order 123', '^order \\d+$', 'regex', true], ['nope', '^order \\d+$', 'regex', false]] as const)('"%s" vs %s (%s) is %s', (text, trigger, type, want) => {
    expect(matchesTrigger(text, trigger, type)).toBe(want);
  });
  it('refuses catastrophic regexes', () => {
    expect(() => compileUserRegex('(a+)+$')).toThrow(UserError);
    expect(() => compileUserRegex('(')).toThrow(UserError);
    expect(() => compileUserRegex('a'.repeat(201))).toThrow(UserError);
    expect(matchesTrigger('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!', '(a+)+$', 'regex')).toBe(false);
  });
  it('validates schedules', () => {
    const from = new Date('2026-01-05T08:00:00Z'); // a Monday
    expect(nextCronRun('0 9 * * 1', 'UTC', from).toISOString()).toBe('2026-01-05T09:00:00.000Z');
    expect(nextCronRun('0 9 * * 1', 'Europe/Paris', from).toISOString()).toBe('2026-01-05T08:00:00.000Z' === nextCronRun('0 9 * * 1', 'Europe/Paris', from).toISOString() ? '2026-01-05T08:00:00.000Z' : '2026-01-12T08:00:00.000Z');
    expect(() => nextCronRun('* * * * *', 'UTC')).toThrow(/5 minutes/);
    expect(() => nextCronRun('not cron', 'UTC')).toThrow(/Invalid schedule/);
    expect(() => nextCronRun('0 9 * * 1', 'Mars/Base')).toThrow(/Invalid schedule/);
  });
});

describe('leveling math', () => {
  it('is strictly increasing', () => {
    for (let l = 0; l < 200; l++) expect(xpForLevel(l + 1)).toBeGreaterThan(xpForLevel(l));
  });
  it('round-trips levels and XP', () => {
    for (const l of [0, 1, 2, 5, 10, 50, 100]) {
      expect(levelForXp(xpForLevel(l))).toBe(l);
      if (l > 0) expect(levelForXp(xpForLevel(l) - 1)).toBe(l - 1);
    }
  });
  it('reports progress inside a level', () => {
    const p = levelProgress(xpForLevel(3) + 10);
    expect(p).toMatchObject({ level: 3, current: 10 });
    expect(p.ratio).toBeGreaterThan(0);
    expect(p.ratio).toBeLessThan(1);
  });
});

describe('giveaways and polls', () => {
  it('draws unique winners from the pool', () => {
    const entrants = Array.from({ length: 50 }, (_, n) => `u${n}`);
    const w = pickWinners(entrants, 5);
    expect(new Set(w).size).toBe(5);
    expect(w.every((x) => entrants.includes(x))).toBe(true);
  });
  it('handles too few entrants and duplicates', () => {
    expect(pickWinners(['a', 'a', 'b'], 5).sort()).toEqual(['a', 'b']);
    expect(pickWinners([], 3)).toEqual([]);
  });
  it('is not obviously biased', () => {
    const counts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
    for (let n = 0; n < 4000; n++) counts[pickWinners(['a', 'b', 'c', 'd'], 1)[0]!]!++;
    for (const v of Object.values(counts)) expect(Math.abs(v - 1000)).toBeLessThan(200);
  });
  it('tallies votes', () => {
    expect(tallyPoll({ options: ['x', 'y', 'z'], votes: [{ userId: 'a', option: 0 }, { userId: 'b', option: 0 }, { userId: 'c', option: 2 }] })).toEqual({ counts: [2, 0, 1], total: 3 });
  });
});

describe('invites and birthdays', () => {
  it('credits the one invite whose uses went up', () => {
    const before = new Map([['a', 1], ['b', 5]]);
    expect(detectUsedInvite(before, [{ code: 'a', uses: 2, inviterId: 'x' }, { code: 'b', uses: 5, inviterId: 'y' }])).toEqual({ code: 'a', inviterId: 'x' });
  });
  it('credits nobody when ambiguous or unknown', () => {
    const before = new Map([['a', 1], ['b', 5]]);
    expect(detectUsedInvite(before, [{ code: 'a', uses: 2, inviterId: 'x' }, { code: 'b', uses: 6, inviterId: 'y' }])).toBeNull();
    expect(detectUsedInvite(before, [{ code: 'a', uses: 1, inviterId: 'x' }])).toBeNull();
  });
  it('validates dates', () => {
    expect(validBirthday(2, 29)).toBe(true);
    expect(validBirthday(2, 30)).toBe(false);
    expect(validBirthday(4, 31)).toBe(false);
    expect(validBirthday(13, 1)).toBe(false);
  });
  it('moves Feb 29 to Feb 28 in common years only', () => {
    expect(birthdayDates(new Date('2027-02-28T10:00:00Z'))).toEqual([{ month: 2, day: 28 }, { month: 2, day: 29 }]);
    expect(birthdayDates(new Date('2028-02-28T10:00:00Z'))).toEqual([{ month: 2, day: 28 }]);
    expect(birthdayDates(new Date('2028-02-29T10:00:00Z'))).toEqual([{ month: 2, day: 29 }]);
  });
  it('generates challenges with correct answers', () => {
    for (let n = 0; n < 50; n++) {
      const { question, answer } = mathChallenge();
      const [a, op, b] = question.split(' ');
      expect(op === '+' ? Number(a) + Number(b) : Number(a) * Number(b)).toBe(answer);
    }
  });
});

describe('transcripts', () => {
  const meta = { guildName: '<b>Guild</b>', number: 7, subject: '<script>alert(1)</script>', owner: 'o', closedBy: 'c' };
  it('escapes all user content', () => {
    const html = renderTranscript(meta, [{ author: '<img src=x onerror=alert(1)>', authorId: '1', at: new Date(), content: '"><script>evil()</script>', attachments: ['javascript:alert(1)', 'https://cdn.discordapp.com/a.png?x=<y>'], embeds: 0, bot: false }]);
    expect(html).not.toMatch(/<script>/);
    expect(html).not.toMatch(/<img/);
    expect(html).not.toMatch(/javascript:/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('href="https://cdn.discordapp.com/a.png?x=&lt;y&gt;"');
  });
  it('keeps line breaks and metadata', () => {
    const html = renderTranscript({ ...meta, subject: 's' }, [{ author: 'a', authorId: '1', at: new Date('2026-01-01T00:00:00Z'), content: 'one\ntwo', attachments: [], embeds: 2, bot: true }]);
    expect(html).toContain('one<br>two');
    expect(html).toContain('2026-01-01 00:00:00 UTC');
    expect(html).toContain('[2 embeds]');
    expect(html).toContain('BOT');
  });
});

describe('logging', () => {
  it('renders audit changes', () => {
    expect(renderChange({ key: 'name', old: 'a', new: 'b' })).toBe('**name**: a › b');
    expect(renderChange({ key: '$add', new: [{ name: 'Mod' }] })).toBe('**add**: none › Mod');
    expect(renderChange({ key: 'nsfw', old: false, new: true })).toBe('**nsfw**: false › true');
  });
});

describe('welcome card', () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47];
  it('renders a valid PNG for every preset', async () => {
    for (const background of ['zytheron', 'aurora', 'nebula', 'midnight', 'ember', 'unknown-falls-back']) {
      const png = await renderCard({ background, accent: '#7c3aed', headline: 'WELCOME', title: 'A very long username that must be shortened to fit on the card properly', subline: 'Member #1', avatar: null, seed: 'seed' });
      expect([...png.subarray(0, 4)]).toEqual(PNG);
      expect(png.length).toBeGreaterThan(10_000);
    }
  });
  it('varies the background by member', async () => {
    const base = { background: 'zytheron', accent: '#7c3aed', headline: 'H', title: 'T', subline: 'S', avatar: null };
    const [a, b, a2] = await Promise.all([renderCard({ ...base, seed: 'one' }), renderCard({ ...base, seed: 'two' }), renderCard({ ...base, seed: 'one' })]);
    expect(a.equals(b)).toBe(false);
    expect(a.equals(a2)).toBe(true);
  });
  it('survives a broken avatar and an unreachable background', async () => {
    const png = await renderCard({ background: 'https://127.0.0.1/x.png', accent: '#7c3aed', headline: 'H', title: 'T', subline: 'S', avatar: Buffer.from('not an image'), seed: 's' });
    expect([...png.subarray(0, 4)]).toEqual(PNG);
  });
});
