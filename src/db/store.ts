import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../core/logger.js';

/**
 * A small JSON document store: one file per collection in the data folder, kept in memory
 * and written shortly after each change. Good for a single bot process and local testing.
 * Without openStore() it stays in memory only, which is what the tests use.
 */
export type Filter = Record<string, unknown>;
export type Update = Partial<Record<'$set' | '$setOnInsert' | '$inc' | '$addToSet' | '$push' | '$pull', Record<string, unknown>>>;
type Row = Record<string, any> & { _id: string };
export type Doc<T> = T & { save(): Promise<Doc<T>>; deleteOne(): Promise<void> };

export interface CollectionOptions<T> {
  defaults?: () => Partial<T>;
  /** Field sets that must be unique. `where` limits the rule to matching documents. */
  unique?: Array<{ fields: string[]; where?: Filter }>;
  /** Removes documents once `field` is older than `seconds`. */
  ttl?: Array<{ field: string; seconds: number; where?: Filter }>;
  timestamps?: boolean;
}

export class DuplicateError extends Error {
  readonly code = 'DUPLICATE';
  constructor(collection: string, fields: string[]) {
    super(`Duplicate ${fields.join(' + ')} in ${collection}`);
  }
}

const FLUSH_DELAY_MS = 500;
const newId = (): string => randomBytes(12).toString('hex');
const isOperatorObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !(v instanceof Date) && !Array.isArray(v) && Object.keys(v).some((k) => k.startsWith('$'));
const comparable = (v: unknown): unknown => (v instanceof Date ? v.getTime() : v);
const same = (a: unknown, b: unknown): boolean => comparable(a) === comparable(b) || (a == null && b == null);
const getPath = (o: Row, path: string): unknown => (path.includes('.') ? path.split('.').reduce<any>((c, k) => c?.[k], o) : o[path]);

function setPath(o: Row, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: any = o;
  for (const k of keys.slice(0, -1)) cur = cur[k] ??= {};
  cur[keys.at(-1)!] = value;
}

function matchOperators(value: unknown, ops: Record<string, unknown>): boolean {
  const list = Array.isArray(value) ? value : [value];
  return Object.entries(ops).every(([op, arg]) => {
    const a = comparable(value) as number;
    const b = comparable(arg) as number;
    switch (op) {
      case '$eq': return same(value, arg);
      case '$ne': return !same(value, arg) && !(Array.isArray(value) && value.includes(arg));
      case '$in': return (arg as unknown[]).some((x) => list.some((v) => same(v, x)));
      case '$nin': return !(arg as unknown[]).some((x) => list.some((v) => same(v, x)));
      case '$gt': return value != null && a > b;
      case '$gte': return value != null && a >= b;
      case '$lt': return value != null && a < b;
      case '$lte': return value != null && a <= b;
      case '$exists': return (value !== undefined) === arg;
      case '$regex': return typeof value === 'string' && new RegExp(String(arg), 'i').test(value);
      default: throw new Error(`Unsupported filter operator ${op}`);
    }
  });
}

export function matches(row: Row, filter: Filter): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return (expected as Filter[]).some((f) => matches(row, f));
    const value = getPath(row, key);
    if (isOperatorObject(expected)) return matchOperators(value, expected);
    return Array.isArray(value) ? value.some((v) => same(v, expected)) : same(value, expected);
  });
}

function applyUpdate(row: Row, update: Update, inserting: boolean): void {
  if (inserting) for (const [k, v] of Object.entries(update.$setOnInsert ?? {})) setPath(row, k, structuredClone(v));
  for (const [k, v] of Object.entries(update.$set ?? {})) setPath(row, k, structuredClone(v));
  for (const [k, v] of Object.entries(update.$inc ?? {})) setPath(row, k, Number(getPath(row, k) ?? 0) + (v as number));
  for (const [k, v] of Object.entries(update.$push ?? {})) setPath(row, k, [...((getPath(row, k) as unknown[]) ?? []), structuredClone(v)]);
  for (const [k, v] of Object.entries(update.$addToSet ?? {})) {
    const list = (getPath(row, k) as unknown[]) ?? [];
    setPath(row, k, list.some((x) => same(x, v)) ? list : [...list, v]);
  }
  for (const [k, v] of Object.entries(update.$pull ?? {})) {
    const list = (getPath(row, k) as unknown[]) ?? [];
    setPath(row, k, list.filter((x) => (typeof v === 'object' && v !== null ? !matches(x as Row, v as Filter) : !same(x, v))));
  }
}

function compare(a: Row, b: Row, sort: Record<string, 1 | -1>): number {
  for (const [key, dir] of Object.entries(sort)) {
    const x = comparable(getPath(a, key)) as any;
    const y = comparable(getPath(b, key)) as any;
    if (x === y) continue;
    if (x == null) return -dir;
    if (y == null) return dir;
    return x < y ? -dir : dir;
  }
  return 0;
}

export class FindQuery<T> implements PromiseLike<Doc<T>[]> {
  private sortBy?: Record<string, 1 | -1>;
  private skipN = 0;
  private limitN = Infinity;
  constructor(private readonly run: (sort: Record<string, 1 | -1> | undefined, skip: number, limit: number) => Doc<T>[]) {}
  sort(by: Record<string, 1 | -1>): this { this.sortBy = by; return this; }
  skip(n: number): this { this.skipN = n; return this; }
  limit(n: number): this { this.limitN = n; return this; }
  then<A = Doc<T>[], B = never>(ok?: ((v: Doc<T>[]) => A | PromiseLike<A>) | null, fail?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return new Promise<Doc<T>[]>((resolve) => resolve(this.run(this.sortBy, this.skipN, this.limitN))).then(ok, fail);
  }
}

// ---------- Persistence ----------
let dataDir: string | null = null;
let flushTimer: NodeJS.Timeout | undefined;
const collections = new Map<string, Collection<any>>();

const encode = (rows: Row[]): string =>
  JSON.stringify(rows, function (this: any, key, value) {
    return this[key] instanceof Date ? { $date: (this[key] as Date).toISOString() } : value;
  });
const decode = (text: string): Row[] =>
  JSON.parse(text, (_k, v) => (v && typeof v === 'object' && typeof v.$date === 'string' ? new Date(v.$date) : v));

function scheduleFlush(): void {
  if (!dataDir || flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flushStore();
  }, FLUSH_DELAY_MS);
  flushTimer.unref();
}

export class Collection<T> {
  private rows = new Map<string, Row>();
  dirty = false;

  constructor(readonly name: string, private readonly options: CollectionOptions<T> = {}) {
    if (collections.has(name)) throw new Error(`Collection ${name} is defined twice`);
    collections.set(name, this);
    if (dataDir) this.load();
  }

  // ---------- Reads ----------
  private wrap(row: Row): Doc<T> {
    const doc = structuredClone(row);
    Object.defineProperties(doc, {
      save: { enumerable: false, value: async () => this.replace(doc as unknown as Doc<T>) },
      deleteOne: { enumerable: false, value: async () => { this.remove(doc._id); } },
    });
    return doc as unknown as Doc<T>;
  }

  private first(filter: Filter, sort?: Record<string, 1 | -1>): Row | undefined {
    if (typeof filter._id === 'string' && Object.keys(filter).length === 1) return this.rows.get(filter._id);
    if (!sort) {
      for (const row of this.rows.values()) if (matches(row, filter)) return row;
      return undefined;
    }
    return [...this.rows.values()].filter((r) => matches(r, filter)).sort((a, b) => compare(a, b, sort))[0];
  }

  find(filter: Filter = {}): FindQuery<T> {
    return new FindQuery<T>((sort, skip, limit) => {
      let list = [...this.rows.values()].filter((r) => matches(r, filter));
      if (sort) list = list.sort((a, b) => compare(a, b, sort));
      return list.slice(skip, skip + limit).map((r) => this.wrap(r));
    });
  }

  async findOne(filter: Filter = {}): Promise<Doc<T> | null> {
    const row = this.first(filter);
    return row ? this.wrap(row) : null;
  }

  async findById(id: string): Promise<Doc<T> | null> {
    return this.findOne({ _id: id });
  }

  async exists(filter: Filter): Promise<boolean> {
    return Boolean(this.first(filter));
  }

  async countDocuments(filter: Filter = {}): Promise<number> {
    let n = 0;
    for (const row of this.rows.values()) if (matches(row, filter)) n++;
    return n;
  }

  // ---------- Writes ----------
  private assertUnique(row: Row): void {
    for (const { fields, where } of this.options.unique ?? []) {
      if (where && !matches(row, where)) continue;
      for (const other of this.rows.values()) {
        if (other._id === row._id || (where && !matches(other, where))) continue;
        if (fields.every((f) => same(getPath(row, f), getPath(other, f)))) throw new DuplicateError(this.name, fields);
      }
    }
  }

  private commit(row: Row): void {
    this.assertUnique(row);
    this.rows.set(row._id, row);
    this.touch();
  }

  private touch(): void {
    this.dirty = true;
    scheduleFlush();
  }

  private blank(data: Filter): Row {
    const now = new Date();
    const stamps = this.options.timestamps === false ? {} : { createdAt: now, updatedAt: now };
    return { _id: newId(), ...stamps, ...structuredClone(this.options.defaults?.() ?? {}), ...structuredClone(data) } as Row;
  }

  private stamp(row: Row): void {
    if (this.options.timestamps !== false) row.updatedAt = new Date();
  }

  async create(data: Partial<T> & Record<string, unknown>): Promise<Doc<T>> {
    const row = this.blank(data);
    this.commit(row);
    return this.wrap(row);
  }

  async insertMany(items: Array<Partial<T> & Record<string, unknown>>): Promise<void> {
    for (const item of items) await this.create(item);
  }

  private replace(doc: Doc<T>): Doc<T> {
    const row = structuredClone(doc) as unknown as Row;
    this.stamp(row);
    this.commit(row);
    (doc as unknown as Row).updatedAt = row.updatedAt;
    return doc;
  }

  private remove(id: string): boolean {
    const removed = this.rows.delete(id);
    if (removed) this.touch();
    return removed;
  }

  /** Applies an update as one step. No await happens in here, so concurrent calls cannot interleave. */
  private updateRow(filter: Filter, update: Update, opts: { upsert?: boolean; sort?: Record<string, 1 | -1> }): { row?: Row; matched: boolean } {
    const existing = this.first(filter, opts.sort);
    if (existing) {
      const row = structuredClone(existing);
      applyUpdate(row, update, false);
      this.stamp(row);
      this.commit(row);
      return { row, matched: true };
    }
    if (!opts.upsert) return { matched: false };
    const seed = Object.fromEntries(Object.entries(filter).filter(([k, v]) => !k.startsWith('$') && !isOperatorObject(v)));
    const row = this.blank(seed);
    applyUpdate(row, update, true);
    this.commit(row);
    return { row, matched: false };
  }

  async updateOne(filter: Filter, update: Update, opts: { upsert?: boolean } = {}): Promise<{ modifiedCount: number }> {
    return { modifiedCount: this.updateRow(filter, update, opts).matched ? 1 : 0 };
  }

  async updateMany(filter: Filter, update: Update): Promise<{ modifiedCount: number }> {
    let modifiedCount = 0;
    for (const existing of [...this.rows.values()]) {
      if (!matches(existing, filter)) continue;
      this.updateRow({ _id: existing._id }, update, {});
      modifiedCount++;
    }
    return { modifiedCount };
  }

  /** Returns the document after the update. */
  async findOneAndUpdate(filter: Filter, update: Update, opts: { upsert?: boolean; sort?: Record<string, 1 | -1> } = {}): Promise<Doc<T> | null> {
    const { row } = this.updateRow(filter, update, opts);
    return row ? this.wrap(row) : null;
  }

  async findByIdAndUpdate(id: string, update: Update): Promise<Doc<T> | null> {
    return this.findOneAndUpdate({ _id: id }, update);
  }

  async findOneAndDelete(filter: Filter): Promise<Doc<T> | null> {
    const row = this.first(filter);
    if (!row) return null;
    this.remove(row._id);
    return this.wrap(row);
  }

  async deleteOne(filter: Filter): Promise<{ deletedCount: number }> {
    const row = this.first(filter);
    return { deletedCount: row && this.remove(row._id) ? 1 : 0 };
  }

  async deleteMany(filter: Filter = {}): Promise<{ deletedCount: number }> {
    let deletedCount = 0;
    for (const row of [...this.rows.values()]) if (matches(row, filter) && this.remove(row._id)) deletedCount++;
    return { deletedCount };
  }

  // ---------- Housekeeping ----------
  sweep(now = Date.now()): void {
    for (const { field, seconds, where } of this.options.ttl ?? []) {
      for (const row of [...this.rows.values()]) {
        const at = getPath(row, field);
        if (at instanceof Date && at.getTime() + seconds * 1000 < now && (!where || matches(row, where))) this.remove(row._id);
      }
    }
  }

  private get file(): string {
    return join(dataDir!, `${this.name}.json`);
  }

  load(): void {
    if (!existsSync(this.file)) return;
    try {
      this.rows = new Map(decode(readFileSync(this.file, 'utf8')).map((r) => [r._id, r]));
    } catch (err) {
      // Keep the unreadable file for recovery instead of overwriting it on the next save.
      const aside = `${this.file}.corrupt-${Date.now()}`;
      renameSync(this.file, aside);
      logger.error({ err, file: aside }, 'Data file was unreadable. It was set aside and this collection starts empty');
      this.rows = new Map();
    }
  }

  write(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, encode([...this.rows.values()]));
    // Replacing via rename means a crash mid-write cannot leave a half-written file.
    renameSync(tmp, this.file);
    this.dirty = false;
  }

  clear(): void {
    this.rows.clear();
    this.dirty = false;
  }
}

/** Starts saving to a folder and loads what is already there. */
export function openStore(dir: string): void {
  mkdirSync(dir, { recursive: true });
  dataDir = dir;
  for (const c of collections.values()) {
    c.load();
    c.sweep();
  }
  setInterval(() => { for (const c of collections.values()) c.sweep(); }, 3_600_000).unref();
}

/** Writes pending changes now. A failed write is logged and retried on the next change. */
export function flushStore(): void {
  if (!dataDir) return;
  for (const c of collections.values()) {
    if (!c.dirty) continue;
    try {
      c.write();
    } catch (err) {
      logger.error({ err, collection: c.name }, 'Could not save data');
      scheduleFlush();
    }
  }
}

/** Saves and detaches from the folder, keeping nothing in memory. */
export function closeStore(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = undefined;
  flushStore();
  dataDir = null;
  resetStore();
}

/** Empties every collection in memory. */
export function resetStore(): void {
  for (const c of collections.values()) c.clear();
}
