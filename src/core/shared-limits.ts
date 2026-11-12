import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { rateCounters, workLeases } from '../db/schema.js';

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counters in Postgres: the same answer on every instance, and a restart (every
 * deploy) does not hand out a fresh set of attempts. One statement per attempt; counters whose
 * window is over are deleted by the maintenance pass.
 *
 * Use it where an attempt is a guess at a secret or creates something (sign-in, codes, sign-in
 * links, sign-ups) and for limits counted over an hour or more. Per-minute throttles on hot paths
 * (every tool call, anonymous MCP requests) stay with the in-memory `RateLimiter`: a query per call
 * would cost more than a limit that is looser by the number of instances.
 */
export class SharedRateLimiter {
  constructor(private readonly db: Db) {}

  async consume(key: string, limit: number, windowMs: number): Promise<RateDecision> {
    const result = await this.db.execute(sql`
      insert into rate_counters (key_hash, count, reset_at)
      values (${hashKey(key)}, 1, now() + ${windowMs} * interval '1 millisecond')
      on conflict (key_hash) do update set
        count = case when rate_counters.reset_at <= now() then 1 else rate_counters.count + 1 end,
        reset_at = case when rate_counters.reset_at <= now() then excluded.reset_at else rate_counters.reset_at end
      returning count, ceil(extract(epoch from (reset_at - now())))::int as retry_after`);
    const row = result.rows[0] as { count: number; retry_after: number } | undefined;
    if (!row) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: row.count <= limit, retryAfterSeconds: Math.max(1, row.retry_after) };
  }

  /** Forgets a counter (a successful sign-in clears the failed attempts before it). */
  async reset(key: string): Promise<void> {
    await this.db.delete(rateCounters).where(eq(rateCounters.keyHash, hashKey(key)));
  }
}

/** Keys name addresses and emails: only their hash is stored. */
const hashKey = (key: string): string => createHash('sha256').update(key).digest('base64url');

/**
 * "Only one instance does this at a time", for background loops that live in a process (jobs of the
 * queue already run once). `hold` takes the lease when it is free or expired and renews it when
 * this instance has it; an instance that stops (a deploy) releases what it held, and one that
 * crashes loses it when the lease runs out. With one instance it always succeeds, at one statement
 * per pass.
 */
export class WorkLeases {
  /** This process, for as long as it lives. */
  readonly holder = randomUUID();

  constructor(private readonly db: Db) {}

  /** Whether this instance may do the work now; keeps the lease for `ttlMs` from this moment. */
  async hold(name: string, ttlMs: number): Promise<boolean> {
    const result = await this.db.execute(sql`
      insert into work_leases (name, holder, expires_at)
      values (${name}, ${this.holder}, now() + ${ttlMs} * interval '1 millisecond')
      on conflict (name) do update set holder = excluded.holder, expires_at = excluded.expires_at
        where work_leases.holder = excluded.holder or work_leases.expires_at <= now()
      returning holder`);
    return result.rows.length === 1;
  }

  /** Gives up everything this instance holds, so another can take over at once. */
  async release(): Promise<void> {
    await this.db.delete(workLeases).where(eq(workLeases.holder, this.holder));
  }
}
