import { and, eq, gte, sql, sum } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { usageCounters } from '../db/schema.js';

/** One executed call to count. */
export interface UsageEvent {
  workspaceId: string;
  /** See `usageCaller`: the AI account when known, else the AI app connection. */
  caller: string;
  connectorId: string;
  action: string;
  failed: boolean;
  at?: Date;
}

export interface UsageRow {
  day: string;
  caller: string;
  connectorId: string;
  action: string;
  calls: number;
  errors: number;
}

/** Where usage is counted. Postgres by default; plans and limits read it through the same interface. */
export interface UsageMeter {
  record(event: UsageEvent): Promise<void>;
  /** Counters of a workspace since a day (inclusive, `YYYY-MM-DD`). */
  list(workspaceId: string, since: string): Promise<UsageRow[]>;
  /** Total calls of one caller across all workspaces since a day: the anti-abuse view. */
  callerTotal(caller: string, since: string): Promise<number>;
}

export const utcDay = (at = new Date()) => at.toISOString().slice(0, 10);

/** One upsert per executed call; cheap at the hub's scale (batching can come behind this interface). */
export class PgUsageMeter implements UsageMeter {
  constructor(private readonly db: Db) {}

  async record(event: UsageEvent): Promise<void> {
    const errors = event.failed ? 1 : 0;
    await this.db
      .insert(usageCounters)
      .values({
        workspaceId: event.workspaceId,
        day: utcDay(event.at),
        caller: event.caller,
        connectorId: event.connectorId,
        action: event.action,
        calls: 1,
        errors,
      })
      .onConflictDoUpdate({
        target: [
          usageCounters.workspaceId,
          usageCounters.day,
          usageCounters.caller,
          usageCounters.connectorId,
          usageCounters.action,
        ],
        set: {
          calls: sql`${usageCounters.calls} + 1`,
          errors: sql`${usageCounters.errors} + ${errors}`,
          updatedAt: new Date(),
        },
      });
  }

  async list(workspaceId: string, since: string): Promise<UsageRow[]> {
    return this.db
      .select({
        day: usageCounters.day,
        caller: usageCounters.caller,
        connectorId: usageCounters.connectorId,
        action: usageCounters.action,
        calls: usageCounters.calls,
        errors: usageCounters.errors,
      })
      .from(usageCounters)
      .where(and(eq(usageCounters.workspaceId, workspaceId), gte(usageCounters.day, since)))
      .orderBy(usageCounters.day, usageCounters.connectorId, usageCounters.action);
  }

  async callerTotal(caller: string, since: string): Promise<number> {
    const [row] = await this.db
      .select({ calls: sum(usageCounters.calls) })
      .from(usageCounters)
      .where(and(eq(usageCounters.caller, caller), gte(usageCounters.day, since)));
    return Number(row?.calls ?? 0);
  }
}
