import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { jobRuns } from '../db/schema.js';
import { scrubSecrets } from '../ops/scrub.js';

export type JobRun = typeof jobRuns.$inferSelect;

/** Notified by the job queue around every run (see `JobQueueOptions.monitor`). */
export interface JobMonitor {
  started(name: string): Promise<void>;
  succeeded(name: string, ms: number): Promise<void>;
  failed(name: string, error: unknown, ms: number): Promise<void>;
}

/**
 * The latest run of each job in Postgres, shared by every instance and the worker: the admin
 * panel, the health checks and the status page see a job that stopped running or keeps failing.
 */
export class JobRunStore implements JobMonitor {
  constructor(private readonly db: Db) {}

  async started(name: string): Promise<void> {
    const now = new Date();
    await this.db
      .insert(jobRuns)
      .values({ name, lastStartedAt: now })
      .onConflictDoUpdate({ target: jobRuns.name, set: { lastStartedAt: now } });
  }

  async succeeded(name: string, ms: number): Promise<void> {
    const now = new Date();
    await this.db
      .insert(jobRuns)
      .values({ name, lastSucceededAt: now, lastDurationMs: ms, runs: 1 })
      .onConflictDoUpdate({
        target: jobRuns.name,
        set: {
          lastSucceededAt: now,
          lastDurationMs: ms,
          consecutiveFailures: 0,
          runs: sql`${jobRuns.runs} + 1`,
        },
      });
  }

  async failed(name: string, error: unknown, ms: number): Promise<void> {
    const now = new Date();
    const message = scrubSecrets((error as Error)?.message ?? String(error), 500);
    await this.db
      .insert(jobRuns)
      .values({
        name,
        lastFailedAt: now,
        lastError: message,
        lastDurationMs: ms,
        consecutiveFailures: 1,
        runs: 1,
        failures: 1,
      })
      .onConflictDoUpdate({
        target: jobRuns.name,
        set: {
          lastFailedAt: now,
          lastError: message,
          lastDurationMs: ms,
          consecutiveFailures: sql`${jobRuns.consecutiveFailures} + 1`,
          runs: sql`${jobRuns.runs} + 1`,
          failures: sql`${jobRuns.failures} + 1`,
        },
      });
  }

  list(): Promise<JobRun[]> {
    return this.db.select().from(jobRuns).orderBy(jobRuns.name);
  }
}
