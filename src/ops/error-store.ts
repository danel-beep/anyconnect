import { and, count, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { errorGroups } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import type { ErrorEvent, ErrorSink } from './errors.js';

export type ErrorGroup = typeof errorGroups.$inferSelect;

/**
 * The built-in error tracker: errors grouped by fingerprint in Postgres, shown in the admin panel.
 * Writes are coalesced in memory (one upsert per group every few seconds), so an error storm costs
 * a handful of queries, not one per failure.
 */
export class PgErrorStore implements ErrorSink {
  readonly name = 'postgres';
  private readonly pending = new Map<string, { event: ErrorEvent; count: number }>();
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;

  constructor(
    private readonly db: Db,
    private readonly options: { flushIntervalMs?: number } = {},
  ) {}

  capture(event: ErrorEvent): void {
    const entry = this.pending.get(event.fingerprint);
    if (entry) {
      entry.event = event;
      entry.count += 1;
    } else {
      this.pending.set(event.fingerprint, { event, count: 1 });
    }
    // A cap keeps memory bounded if the database is down for a long time.
    if (this.pending.size > 500) this.pending.delete(this.pending.keys().next().value!);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => {});
    }, this.options.flushIntervalMs ?? 2000);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.flushing) await this.flushing;
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    this.flushing = (async () => {
      for (const { event, count: n } of batch) await this.upsert(event, n);
    })().finally(() => {
      this.flushing = undefined;
    });
    await this.flushing;
  }

  private async upsert(event: ErrorEvent, n: number): Promise<void> {
    const latest = {
      message: event.message,
      stack: event.stack ?? null,
      context: event.context as Record<string, unknown>,
      lastRef: event.ref,
      lastRequestId: event.requestId ?? null,
      release: event.release,
      lastSeenAt: event.at,
    };
    await this.db
      .insert(errorGroups)
      .values({
        id: newId('err'),
        fingerprint: event.fingerprint,
        source: event.source,
        type: event.type,
        count: n,
        firstSeenAt: event.at,
        ...latest,
      })
      .onConflictDoUpdate({
        target: errorGroups.fingerprint,
        // A new occurrence of a resolved error reopens it (a regression).
        set: { ...latest, count: sql`${errorGroups.count} + ${n}`, resolvedAt: null },
      });
  }

  async list(options: { status?: 'open' | 'resolved'; limit?: number } = {}): Promise<ErrorGroup[]> {
    const where =
      options.status === 'resolved'
        ? isNotNull(errorGroups.resolvedAt)
        : options.status === 'open'
          ? isNull(errorGroups.resolvedAt)
          : undefined;
    return this.db
      .select()
      .from(errorGroups)
      .where(where)
      .orderBy(desc(errorGroups.lastSeenAt))
      .limit(Math.min(Math.max(options.limit ?? 50, 1), 200));
  }

  async get(id: string): Promise<ErrorGroup | undefined> {
    const [row] = await this.db.select().from(errorGroups).where(eq(errorGroups.id, id)).limit(1);
    return row;
  }

  /** Open groups, and how many of them were seen since `since`. */
  async summary(since: Date): Promise<{ open: number; recent: number }> {
    const [row] = await this.db
      .select({
        open: count(),
        recent: sql<number>`count(*) filter (where ${errorGroups.lastSeenAt} >= ${since})`.mapWith(Number),
      })
      .from(errorGroups)
      .where(isNull(errorGroups.resolvedAt));
    return { open: row?.open ?? 0, recent: row?.recent ?? 0 };
  }

  async setResolved(id: string, resolved: boolean): Promise<boolean> {
    const rows = await this.db
      .update(errorGroups)
      .set({ resolvedAt: resolved ? new Date() : null })
      .where(eq(errorGroups.id, id))
      .returning({ id: errorGroups.id });
    return rows.length > 0;
  }

  /** Forgets groups not seen for `days` (maintenance). */
  async prune(days: number): Promise<void> {
    await this.db
      .delete(errorGroups)
      .where(and(lt(errorGroups.lastSeenAt, new Date(Date.now() - days * 86_400_000))));
  }
}
