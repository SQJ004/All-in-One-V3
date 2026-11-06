/** In-memory sliding window. Keys are evicted lazily, and a sweep caps memory on busy guilds. */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly maxKeys = 50_000) {}

  /** Records one hit and returns how many hits are inside the window, including this one. */
  hit(key: string, windowMs: number, now = Date.now()): number {
    const cutoff = now - windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) this.evictOldest();
    return list.length;
  }

  count(key: string, windowMs: number, now = Date.now()): number {
    const cutoff = now - windowMs;
    return (this.hits.get(key) ?? []).filter((t) => t > cutoff).length;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private evictOldest(): void {
    const excess = this.hits.size - this.maxKeys;
    let i = 0;
    for (const key of this.hits.keys()) {
      if (i++ > excess) break;
      this.hits.delete(key);
    }
  }
}

/** Per-key cooldown. allow() returns 0 if allowed, otherwise the milliseconds left. */
export class Cooldown {
  private readonly until = new Map<string, number>();

  allow(key: string, ms: number, now = Date.now()): number {
    const left = (this.until.get(key) ?? 0) - now;
    if (left > 0) return left;
    this.until.set(key, now + ms);
    if (this.until.size > 50_000) {
      for (const [k, v] of this.until) if (v < now) this.until.delete(k);
    }
    return 0;
  }
}
