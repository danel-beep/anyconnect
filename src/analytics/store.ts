import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  analyticsEvents,
  analyticsPages,
  analyticsSalts,
  analyticsVisits,
  userAttribution,
} from '../db/schema.js';

export type VisitRow = typeof analyticsVisits.$inferInsert;
export type AttributionRow = typeof userAttribution.$inferInsert;
export type StoredVisit = typeof analyticsVisits.$inferSelect;

export interface CounterRow {
  day: string;
  path: string;
  views: number;
}

export interface EventRow {
  day: string;
  name: string;
  key: string;
  count: number;
}

const DAY = 86_400_000;
const BATCH = 500;
export const utcDay = (at: Date | number = new Date()) => new Date(at).toISOString().slice(0, 10);

/**
 * The salt of each UTC day, shared by every instance through the database and cached here.
 * `create: false` only reads (sign-up attribution must not invent a salt for a day without visits).
 */
export class DailySalts {
  private readonly cache = new Map<string, string>();

  constructor(private readonly db: Db) {}

  async forDay(day: string, create = true): Promise<string | undefined> {
    const cached = this.cache.get(day);
    if (cached) return cached;
    if (create) {
      await this.db
        .insert(analyticsSalts)
        .values({ day, salt: randomBytes(32).toString('base64url') })
        .onConflictDoNothing();
    }
    const [row] = await this.db.select().from(analyticsSalts).where(eq(analyticsSalts.day, day)).limit(1);
    if (!row) return undefined;
    // Two days are all anyone needs; older entries are dropped with the rows in the database.
    if (this.cache.size > 4) this.cache.clear();
    this.cache.set(day, row.salt);
    return row.salt;
  }

  /** Forgets salts older than yesterday: visits of those days can never be linked to anyone again. */
  async prune(now = new Date()): Promise<void> {
    await this.db.delete(analyticsSalts).where(lt(analyticsSalts.day, utcDay(now.getTime() - DAY)));
    this.cache.clear();
  }
}

/** The daily visitor id: SHA-256 of the day's salt, the address (IPv6 by /64) and the browser. */
export function visitorId(salt: string, address: string, userAgent: string): string {
  return createHash('sha256')
    .update(salt)
    .update('\u0000')
    .update(address)
    .update('\u0000')
    .update(userAgent)
    .digest('base64url')
    .slice(0, 22);
}

/** Visit columns that move together: the traffic source of a visit. */
const TOUCH_COLUMNS = ['source', 'medium', 'campaign', 'term', 'content', 'referrer_host'] as const;

/** Writes of the collector and the sign-up attribution, as batched upserts. */
export class AnalyticsStore {
  constructor(private readonly db: Db) {}

  async writeVisits(rows: VisitRow[]): Promise<void> {
    const v = analyticsVisits;
    // A visit that started as direct takes the source of a later page view that has one (the ad
    // click after a first direct look); a visit with a source keeps its first one.
    const upgrade = (column: (typeof TOUCH_COLUMNS)[number]) =>
      sql.raw(
        `case when "analytics_visits"."source" = 'direct' and excluded."source" <> 'direct' then excluded."${column}" else "analytics_visits"."${column}" end`,
      );
    for (let i = 0; i < rows.length; i += BATCH) {
      await this.db
        .insert(v)
        .values(rows.slice(i, i + BATCH))
        .onConflictDoUpdate({
          target: [v.day, v.visitor],
          set: {
            pageviews: sql`${v.pageviews} + excluded.pageviews`,
            firstAt: sql`least(${v.firstAt}, excluded.first_at)`,
            lastAt: sql`greatest(${v.lastAt}, excluded.last_at)`,
            known: sql`${v.known} or excluded.known`,
            source: upgrade('source'),
            medium: upgrade('medium'),
            campaign: upgrade('campaign'),
            term: upgrade('term'),
            content: upgrade('content'),
            referrerHost: upgrade('referrer_host'),
          },
        });
    }
  }

  async writePages(rows: CounterRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += BATCH) {
      await this.db
        .insert(analyticsPages)
        .values(rows.slice(i, i + BATCH))
        .onConflictDoUpdate({
          target: [analyticsPages.day, analyticsPages.path],
          set: { views: sql`${analyticsPages.views} + excluded.views` },
        });
    }
  }

  async writeEvents(rows: EventRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += BATCH) {
      await this.db
        .insert(analyticsEvents)
        .values(rows.slice(i, i + BATCH))
        .onConflictDoUpdate({
          target: [analyticsEvents.day, analyticsEvents.name, analyticsEvents.key],
          set: { count: sql`${analyticsEvents.count} + excluded.count` },
        });
    }
  }

  /** The visits of these (day, visitor) pairs, the ones with a traffic source first, newest first. */
  async findVisits(keys: { day: string; visitor: string }[]): Promise<StoredVisit[]> {
    if (!keys.length) return [];
    return this.db
      .select()
      .from(analyticsVisits)
      .where(
        or(...keys.map((k) => and(eq(analyticsVisits.day, k.day), eq(analyticsVisits.visitor, k.visitor)))),
      )
      .orderBy(sql`(${analyticsVisits.source} = 'direct')`, sql`${analyticsVisits.day} desc`);
  }

  /** Writes a user's attribution once; a second sign-up of the same user changes nothing. */
  async attribute(row: AttributionRow): Promise<void> {
    await this.db.insert(userAttribution).values(row).onConflictDoNothing();
  }

  /** Drops visits, page and event counters older than `retentionDays`. */
  async prune(retentionDays: number, now = new Date()): Promise<void> {
    const before = utcDay(now.getTime() - retentionDays * DAY);
    await this.db.delete(analyticsVisits).where(lt(analyticsVisits.day, before));
    await this.db.delete(analyticsPages).where(lt(analyticsPages.day, before));
    await this.db.delete(analyticsEvents).where(lt(analyticsEvents.day, before));
  }

  /** Test and CLI helper: every event counter of some names (all days). */
  async eventTotals(names: string[]): Promise<{ name: string; key: string; count: number }[]> {
    if (!names.length) return [];
    return this.db
      .select({
        name: analyticsEvents.name,
        key: analyticsEvents.key,
        count: sql<number>`sum(${analyticsEvents.count})::int`,
      })
      .from(analyticsEvents)
      .where(inArray(analyticsEvents.name, names))
      .groupBy(analyticsEvents.name, analyticsEvents.key);
  }
}
