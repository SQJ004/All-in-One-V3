import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Collection, closeStore, DuplicateError, flushStore, matches, openStore, resetStore } from '../../src/db/store.js';

interface Item { _id: string; guildId: string; name: string; n: number; list: string[]; when?: Date | null; createdAt: Date; updatedAt: Date; status?: string; key?: string | null }
const Items = new Collection<Item>('testItems', { defaults: () => ({ n: 0, list: [] }), unique: [{ fields: ['guildId', 'name'] }, { fields: ['key'], where: { status: 'pending', key: { $ne: null } } }], ttl: [{ field: 'when', seconds: 60, where: { status: 'done' } }] });

beforeEach(() => resetStore());

describe('queries', () => {
  const row = { _id: '1', a: 1, s: 'Hello', nil: null, list: ['x', 'y'], d: new Date(1000), nested: { v: 2 } } as any;
  it.each([
    [{ a: 1 }, true], [{ a: 2 }, false], [{ nil: null }, true], [{ missing: null }, true], [{ a: null }, false],
    [{ list: 'x' }, true], [{ list: 'z' }, false], [{ 'nested.v': 2 }, true],
    [{ a: { $ne: 2 } }, true], [{ a: { $ne: 1 } }, false], [{ nil: { $ne: null } }, false], [{ a: { $in: [1, 2] } }, true], [{ a: { $in: [3] } }, false], [{ missing: { $in: [null] } }, true],
    [{ a: { $gt: 0 } }, true], [{ a: { $gte: 1 } }, true], [{ a: { $lt: 1 } }, false], [{ a: { $lte: 1 } }, true], [{ missing: { $lte: 5 } }, false],
    [{ d: { $lte: new Date(1000) } }, true], [{ d: { $gt: new Date(1000) } }, false], [{ d: new Date(1000) }, true],
    [{ s: { $regex: 'hel' } }, true], [{ s: { $regex: 'nope' } }, false], [{ a: { $exists: true } }, true], [{ missing: { $exists: true } }, false],
    [{ $or: [{ a: 9 }, { a: 1 }] }, true], [{ $or: [{ a: 9 }] }, false], [{ a: 1, s: 'nope' }, false],
  ])('%j -> %s', (filter, want) => expect(matches(row, filter as never)).toBe(want));
  it('fails loudly on an unknown operator', () => expect(() => matches(row, { a: { $where: '1' } })).toThrow(/Unsupported/));

  it('sorts, skips and limits', async () => {
    await Items.insertMany([{ guildId: 'g', name: 'a', n: 2 }, { guildId: 'g', name: 'b', n: 3 }, { guildId: 'g', name: 'c', n: 1 }]);
    expect((await Items.find({ guildId: 'g' }).sort({ n: -1 })).map((i) => i.n)).toEqual([3, 2, 1]);
    expect((await Items.find().sort({ n: 1 }).skip(1).limit(1)).map((i) => i.n)).toEqual([2]);
    expect(await Items.countDocuments({ n: { $gte: 2 } })).toBe(2);
    expect(await Items.exists({ name: 'b' })).toBe(true);
    expect(await Items.exists({ name: 'z' })).toBe(false);
  });
});

describe('writes', () => {
  it('applies defaults, ids and timestamps', async () => {
    const d = await Items.create({ guildId: 'g', name: 'a' });
    expect(d).toMatchObject({ n: 0, list: [] });
    expect(typeof d._id).toBe('string');
    expect(d.createdAt).toBeInstanceOf(Date);
  });
  it('applies every update operator', async () => {
    await Items.create({ guildId: 'g', name: 'a', list: ['x'] });
    const d = await Items.findOneAndUpdate({ name: 'a' }, { $set: { 'deep.path': 1, status: 's' }, $inc: { n: 2 }, $push: { list: 'y' } });
    expect(d).toMatchObject({ deep: { path: 1 }, status: 's', n: 2, list: ['x', 'y'] });
    await Items.updateOne({ name: 'a' }, { $addToSet: { list: 'y' } });
    await Items.updateOne({ name: 'a' }, { $addToSet: { list: 'z' } });
    expect((await Items.findOne({ name: 'a' }))?.list).toEqual(['x', 'y', 'z']);
    await Items.updateOne({ name: 'a' }, { $pull: { list: 'x' } });
    expect((await Items.findOne({ name: 'a' }))?.list).toEqual(['y', 'z']);
  });
  it('pulls objects by partial match', async () => {
    await Items.create({ guildId: 'g', name: 'a', list: [{ u: 1, o: 1 }, { u: 1, o: 2 }, { u: 2, o: 1 }] as never });
    await Items.updateOne({ name: 'a' }, { $pull: { list: { u: 1, o: 2 } } });
    expect((await Items.findOne({ name: 'a' }))?.list.length).toBe(2);
    await Items.updateOne({ name: 'a' }, { $pull: { list: { u: 1 } } });
    expect((await Items.findOne({ name: 'a' }))?.list).toEqual([{ u: 2, o: 1 }]);
  });
  it('upserts from the filter, using $setOnInsert only on insert', async () => {
    const opts = { upsert: true };
    expect((await Items.updateOne({ guildId: 'g', name: 'new' }, { $setOnInsert: { n: 5 } }, opts)).modifiedCount).toBe(0);
    expect((await Items.findOne({ name: 'new' }))?.n).toBe(5);
    expect((await Items.updateOne({ guildId: 'g', name: 'new' }, { $setOnInsert: { n: 9 }, $inc: { n: 1 } }, opts)).modifiedCount).toBe(1);
    expect((await Items.findOne({ name: 'new' }))?.n).toBe(6);
  });
  it('does not match or create without upsert', async () => {
    expect(await Items.updateOne({ name: 'x' }, { $set: { n: 1 } })).toEqual({ modifiedCount: 0 });
    expect(await Items.findOneAndUpdate({ name: 'x' }, { $set: { n: 1 } })).toBeNull();
    expect(await Items.countDocuments()).toBe(0);
  });
  it('enforces unique rules, across create, update and save', async () => {
    await Items.create({ guildId: 'g', name: 'a' });
    const b = await Items.create({ guildId: 'g', name: 'b' });
    await expect(Items.create({ guildId: 'g', name: 'a' })).rejects.toBeInstanceOf(DuplicateError);
    await expect(Items.create({ guildId: 'h', name: 'a' })).resolves.toBeTruthy();
    await expect(Items.updateOne({ name: 'b' }, { $set: { name: 'a' } })).rejects.toMatchObject({ code: 'DUPLICATE' });
    b.name = 'a';
    await expect(b.save()).rejects.toMatchObject({ code: 'DUPLICATE' });
    expect((await Items.findById(b._id))?.name).toBe('b'); // a failed write changes nothing
  });
  it('applies conditional unique rules', async () => {
    await Items.create({ guildId: 'g', name: 'a', status: 'pending', key: 'k' });
    await expect(Items.create({ guildId: 'g', name: 'b', status: 'pending', key: 'k' })).rejects.toBeInstanceOf(DuplicateError);
    await expect(Items.create({ guildId: 'g', name: 'c', status: 'done', key: 'k' })).resolves.toBeTruthy();
    await expect(Items.create({ guildId: 'g', name: 'd', status: 'pending', key: null })).resolves.toBeTruthy();
    await expect(Items.create({ guildId: 'g', name: 'e', status: 'pending', key: null })).resolves.toBeTruthy();
  });
  it('isolates returned documents until they are saved', async () => {
    const d = await Items.create({ guildId: 'g', name: 'a' });
    d.list.push('changed');
    expect((await Items.findById(d._id))?.list).toEqual([]);
    await d.save();
    expect((await Items.findById(d._id))?.list).toEqual(['changed']);
    await d.deleteOne();
    expect(await Items.findById(d._id)).toBeNull();
  });
  it('has no lost updates under concurrency', async () => {
    await Items.create({ guildId: 'g', name: 'a' });
    await Promise.all(Array.from({ length: 200 }, () => Items.updateOne({ name: 'a' }, { $inc: { n: 1 } })));
    expect((await Items.findOne({ name: 'a' }))?.n).toBe(200);
  });
  it('removes expired documents only when they match', async () => {
    await Items.create({ guildId: 'g', name: 'old', status: 'done', when: new Date(0) });
    await Items.create({ guildId: 'g', name: 'active', status: 'pending', when: new Date(0) });
    await Items.create({ guildId: 'g', name: 'fresh', status: 'done', when: new Date() });
    Items.sweep();
    expect((await Items.find().sort({ name: 1 })).map((i) => i.name)).toEqual(['active', 'fresh']);
  });
  it('deletes', async () => {
    await Items.insertMany([{ guildId: 'g', name: 'a' }, { guildId: 'g', name: 'b' }, { guildId: 'h', name: 'c' }]);
    expect((await Items.findOneAndDelete({ name: 'c' }))?.name).toBe('c');
    expect(await Items.deleteOne({ name: 'zzz' })).toEqual({ deletedCount: 0 });
    expect(await Items.deleteMany({ guildId: 'g' })).toEqual({ deletedCount: 2 });
  });
});

describe('saving to disk', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vortex-store-')); });
  afterEach(() => { closeStore(); rmSync(dir, { recursive: true, force: true }); });

  it('round-trips data, keeping dates as dates', async () => {
    openStore(dir);
    const when = new Date('2026-03-04T05:06:07.000Z');
    const d = await Items.create({ guildId: 'g', name: 'a', when, status: 'pending', list: ['x'] });
    closeStore();
    expect(await Items.countDocuments()).toBe(0);
    openStore(dir);
    const back = await Items.findById(d._id);
    expect(back).toMatchObject({ name: 'a', list: ['x'] });
    expect(back?.when).toBeInstanceOf(Date);
    expect(back?.when?.getTime()).toBe(when.getTime());
    expect(back?.createdAt).toBeInstanceOf(Date);
  });
  it('writes shortly after a change, without an explicit save', async () => {
    openStore(dir);
    await Items.create({ guildId: 'g', name: 'a' });
    await new Promise((r) => setTimeout(r, 800));
    expect(JSON.parse(readFileSync(join(dir, 'testItems.json'), 'utf8'))[0].name).toBe('a');
  });
  it('leaves no temporary files', async () => {
    openStore(dir);
    await Items.create({ guildId: 'g', name: 'a' });
    flushStore();
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
  it('sets a corrupt file aside rather than destroying it', async () => {
    writeFileSync(join(dir, 'testItems.json'), '{not json');
    openStore(dir);
    expect(await Items.countDocuments()).toBe(0);
    const aside = readdirSync(dir).find((f) => f.includes('.corrupt-'));
    expect(aside).toBeTruthy();
    expect(readFileSync(join(dir, aside!), 'utf8')).toBe('{not json');
    await Items.create({ guildId: 'g', name: 'a' });
    flushStore();
    expect(existsSync(join(dir, 'testItems.json'))).toBe(true);
  });
  it('sweeps expired documents on open', async () => {
    openStore(dir);
    await Items.create({ guildId: 'g', name: 'old', status: 'done', when: new Date(0) });
    closeStore();
    openStore(dir);
    expect(await Items.countDocuments()).toBe(0);
  });
});
