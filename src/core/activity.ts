import { and, count, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { toolCalls } from '../db/schema.js';

const DAY = 86_400_000;

export interface ActivitySummary {
  /** Calls per UTC day, oldest first, one entry for each of the last `days` days. */
  daily: { day: string; calls: number; errors: number }[];
  byConnector: { connectorId: string; calls: number }[];
  total: number;
  errors: number;
}

/** Narrows the activity log; every field is optional and they combine with AND. */
export interface ActivityFilter {
  accountId?: string | undefined;
  connectorId?: string | undefined;
  status?: 'ok' | 'error' | undefined;
  /** Calls made with these sign-ins or tokens (one AI app's, see `AiAppService.credentialIds`). */
  principalIds?: readonly string[] | undefined;
}

/**
 * How long each workspace keeps its activity log: the plan's `historyDays` (see
 * `EntitlementService`). The privacy policy promises these numbers.
 */
export interface ActivityRetention {
  /** Days the workspace's log is kept; null keeps it forever. */
  historyDays(workspaceId: string): Promise<number | null>;
  /** No workspace keeps less, so rows younger than this are never looked at. */
  readonly minimumHistoryDays: number;
}

/**
 * What the AI did in a workspace, for the dashboard: counts by day and by service over the
 * audit log (`tool_calls`). Only metadata is stored there, never arguments or results.
 */
export class ActivityService {
  constructor(private readonly db: Db) {}

  /**
   * Deletes log entries older than each workspace's retention. Only workspaces with entries past
   * the shortest retention are looked up. One failing workspace does not stop the others; the
   * failures are thrown together at the end.
   */
  async prune(retention: ActivityRetention, now = new Date()): Promise<{ workspaces: number }> {
    const floor = new Date(now.getTime() - retention.minimumHistoryDays * DAY);
    const candidates = await this.db
      .selectDistinct({ workspaceId: toolCalls.workspaceId })
      .from(toolCalls)
      .where(lt(toolCalls.createdAt, floor));
    const failures: unknown[] = [];
    let pruned = 0;
    for (const { workspaceId } of candidates) {
      try {
        const days = await retention.historyDays(workspaceId);
        if (days === null) continue;
        await this.db
          .delete(toolCalls)
          .where(
            and(
              eq(toolCalls.workspaceId, workspaceId),
              lt(toolCalls.createdAt, new Date(now.getTime() - days * DAY)),
            ),
          );
        pruned++;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, `Activity log pruning failed for ${failures.length} workspace(s)`);
    return { workspaces: pruned };
  }

  async summary(workspaceId: string, days: number, now = new Date()): Promise<ActivitySummary> {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * DAY,
    );
    const where = and(eq(toolCalls.workspaceId, workspaceId), gte(toolCalls.createdAt, start));
    const day = sql<string>`to_char(${toolCalls.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
    const [perDay, perConnector] = await Promise.all([
      this.db
        .select({
          day,
          calls: count(),
          errors: sql<number>`count(*) filter (where ${toolCalls.status} = 'error')`.mapWith(Number),
        })
        .from(toolCalls)
        .where(where)
        .groupBy(day),
      this.db
        .select({ connectorId: toolCalls.connectorId, calls: count() })
        .from(toolCalls)
        .where(where)
        .groupBy(toolCalls.connectorId)
        .orderBy(desc(count()))
        .limit(8),
    ]);
    const byDay = new Map(perDay.map((r) => [r.day, r]));
    const daily: ActivitySummary['daily'] = [];
    for (let i = 0; i < days; i++) {
      const key = new Date(start.getTime() + i * DAY).toISOString().slice(0, 10);
      const row = byDay.get(key);
      daily.push({ day: key, calls: row?.calls ?? 0, errors: row?.errors ?? 0 });
    }
    return {
      daily,
      byConnector: perConnector
        .filter((r): r is { connectorId: string; calls: number } => r.connectorId !== null)
        .map((r) => ({ connectorId: r.connectorId, calls: r.calls })),
      total: daily.reduce((n, d) => n + d.calls, 0),
      errors: daily.reduce((n, d) => n + d.errors, 0),
    };
  }

  /**
   * The newest calls first, no older than `sinceDays` (the plan's history window) when given;
   * `before` continues a page after its last row (keyset paging). `filter` narrows the log to one
   * account, one service or the failed calls.
   */
  async recent(
    workspaceId: string,
    opts: {
      limit: number;
      sinceDays?: number | null;
      before?: { at: Date; id: number } | undefined;
      filter?: ActivityFilter | undefined;
    },
    now = new Date(),
  ) {
    const conditions = [eq(toolCalls.workspaceId, workspaceId)];
    const { accountId, connectorId, status, principalIds } = opts.filter ?? {};
    if (principalIds) {
      // An app that never connected has no calls (an empty IN list is not valid SQL).
      if (principalIds.length === 0) return [];
      conditions.push(inArray(toolCalls.principalId, [...principalIds]));
    }
    if (accountId) conditions.push(eq(toolCalls.accountId, accountId));
    if (connectorId) conditions.push(eq(toolCalls.connectorId, connectorId));
    if (status) conditions.push(eq(toolCalls.status, status));
    if (opts.sinceDays)
      conditions.push(gte(toolCalls.createdAt, new Date(now.getTime() - opts.sinceDays * DAY)));
    if (opts.before) {
      const { at, id } = opts.before;
      conditions.push(
        or(lt(toolCalls.createdAt, at), and(eq(toolCalls.createdAt, at), lt(toolCalls.id, id)))!,
      );
    }
    return this.db
      .select()
      .from(toolCalls)
      .where(and(...conditions))
      .orderBy(desc(toolCalls.createdAt), desc(toolCalls.id))
      .limit(opts.limit);
  }

  /** Calls of one account since a moment, and how many failed (the account page's header). */
  async accountTotals(
    workspaceId: string,
    accountId: string,
    since: Date,
  ): Promise<{ calls: number; errors: number }> {
    const [row] = await this.db
      .select({
        calls: count(),
        errors: sql<number>`count(*) filter (where ${toolCalls.status} = 'error')`.mapWith(Number),
      })
      .from(toolCalls)
      .where(
        and(
          eq(toolCalls.accountId, accountId),
          eq(toolCalls.workspaceId, workspaceId),
          gte(toolCalls.createdAt, since),
        ),
      );
    return { calls: row?.calls ?? 0, errors: row?.errors ?? 0 };
  }
}
