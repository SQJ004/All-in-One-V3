import type { Client } from 'discord.js';
import { Job, type IJob } from '../db/models.js';
import { logger } from './logger.js';

type Handler = (client: Client<true>, guildId: string, payload: Record<string, any>) => Promise<void>;

const MAX_ATTEMPTS = 5;
const LOCK_MS = 60_000;

/** Durable jobs (tempban expiry, giveaway end...) that survive restarts. */
export async function scheduleJob(type: string, guildId: string, runAt: Date, payload: Record<string, unknown> = {}, dedupeKey?: string): Promise<void> {
  if (dedupeKey) {
    await Job.findOneAndUpdate({ dedupeKey, status: 'pending' }, { $set: { type, guildId, runAt, payload, attempts: 0 } }, { upsert: true });
  } else {
    await Job.create({ type, guildId, runAt, payload });
  }
}

export const cancelJobs = (dedupeKey: string) => Job.deleteMany({ dedupeKey, status: 'pending' });

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(
    private readonly client: Client<true>,
    private readonly handlers: Record<string, Handler>,
    private readonly pollMs = 5000,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Claims due jobs one by one with an atomic update, so a crashed run retries after its lock expires. */
  async tick(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let processed = 0;
    try {
      for (let i = 0; i < 50; i++) {
        const job = await Job.findOneAndUpdate(
          { runAt: { $lte: now }, $or: [{ status: 'pending' }, { status: 'running', lockedUntil: { $lte: now } }] },
          { $set: { status: 'running', lockedUntil: new Date(now.getTime() + LOCK_MS) }, $inc: { attempts: 1 } },
          { sort: { runAt: 1 } },
        );
        if (!job) break;
        await this.run(job as IJob);
        processed++;
      }
    } catch (err) {
      logger.error({ err }, 'Scheduler tick failed');
    } finally {
      this.running = false;
    }
    return processed;
  }

  private async run(job: IJob): Promise<void> {
    const handler = this.handlers[job.type];
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(this.client, job.guildId, job.payload);
      await Job.updateOne({ _id: job._id }, { $set: { status: 'done', lockedUntil: null } });
    } catch (err) {
      const failed = job.attempts >= MAX_ATTEMPTS;
      logger.warn({ err, type: job.type, attempts: job.attempts, failed }, 'Job failed');
      await Job.updateOne(
        { _id: job._id },
        { $set: { status: failed ? 'failed' : 'pending', lockedUntil: null, lastError: String(err), runAt: new Date(Date.now() + 30_000 * 2 ** job.attempts), dedupeKey: failed ? null : (job.dedupeKey ?? null) } },
      );
    }
  }
}
