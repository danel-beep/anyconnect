import { and, eq, gte, sql, sum } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { billingUsage, usageCounters } from '../db/schema.js';

/** One executed call to count. */
export interface UsageEvent {
  workspaceId: string;
  /**
   * The workspace whose plan the call counts against (a person's own; in a team its payer's or
   * the member's, see `QuotaGate.payerOf`). Default: the workspace itself.
   */
  payerId?: string;
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
  /** Calls counted against a payer's plan since a day, wherever they happened. */
  billedTotal(payerId: string, since: string): Promise<number>;
  /** The same, per workspace they happened in (a person's own space and the teams they pay for). */
  billedByWorkspace(payerId: string, since: string): Promise<{ workspaceId: string; calls: number }[]>;
  /** Calls made in a workspace since a day, whoever paid for them. */
  workspaceTotal(workspaceId: string, since: string): Promise<number>;
}

export const utcDay = (at = new Date()) => at.toISOString().slice(0, 10);

/**
 * Two upserts per executed call (the detailed counter and what the payer's plan was charged); cheap
 * at the hub's scale (batching can come behind this interface).
 */
export class PgUsageMeter implements UsageMeter {
  constructor(private readonly db: Db) {}

  async record(event: UsageEvent): Promise<void> {
    const day = utcDay(event.at);
    await Promise.all([this.count(event, day), this.bill(event, day)]);
  }

  private async bill(event: UsageEvent, day: string): Promise<void> {
    await this.db
      .insert(billingUsage)
      .values({ payerId: event.payerId ?? event.workspaceId, day, workspaceId: event.workspaceId, calls: 1 })
      .onConflictDoUpdate({
        target: [billingUsage.payerId, billingUsage.day, billingUsage.workspaceId],
        set: { calls: sql`${billingUsage.calls} + 1`, updatedAt: new Date() },
      });
  }

  private async count(event: UsageEvent, day: string): Promise<void> {
    const errors = event.failed ? 1 : 0;
    await this.db
      .insert(usageCounters)
      .values({
        workspaceId: event.workspaceId,
        day,
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

  async billedTotal(payerId: string, since: string): Promise<number> {
    const [row] = await this.db
      .select({ calls: sum(billingUsage.calls) })
      .from(billingUsage)
      .where(and(eq(billingUsage.payerId, payerId), gte(billingUsage.day, since)));
    return Number(row?.calls ?? 0);
  }

  async billedByWorkspace(payerId: string, since: string): Promise<{ workspaceId: string; calls: number }[]> {
    const rows = await this.db
      .select({ workspaceId: billingUsage.workspaceId, calls: sum(billingUsage.calls) })
      .from(billingUsage)
      .where(and(eq(billingUsage.payerId, payerId), gte(billingUsage.day, since)))
      .groupBy(billingUsage.workspaceId);
    return rows.map((r) => ({ workspaceId: r.workspaceId, calls: Number(r.calls ?? 0) }));
  }

  async workspaceTotal(workspaceId: string, since: string): Promise<number> {
    const [row] = await this.db
      .select({ calls: sum(usageCounters.calls) })
      .from(usageCounters)
      .where(and(eq(usageCounters.workspaceId, workspaceId), gte(usageCounters.day, since)));
    return Number(row?.calls ?? 0);
  }
}
