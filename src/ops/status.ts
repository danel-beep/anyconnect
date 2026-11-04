import { and, desc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { statusComponents, statusDays, statusIncidents } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { type HealthRegistry, type HealthStatus, type StatusComponent, worst } from './checks.js';

/**
 * The public status page's data. Every minute (`status.sample` job) the health checks run and
 * each public component gets the worst status of the checks that feed it. Per component the hub
 * keeps its current state, minutes per status per UTC day (the 90-day bars) and incidents
 * (periods not `ok`). Minutes without a sample — the hub or its jobs were not running — count as
 * `missing`: a status page that only records what it saw while alive would always look perfect.
 *
 * The page itself is served by the hub, so it cannot show an outage while the hub is down; an
 * external monitor on /readyz covers that (see docs/OPERATIONS.md).
 */

export const PUBLIC_COMPONENTS: readonly { id: StatusComponent; publicDetail?: boolean }[] = [
  { id: 'web' },
  { id: 'mcp' },
  { id: 'connections', publicDetail: true },
  { id: 'jobs' },
  { id: 'database' },
];

export type DayStatus = HealthStatus | 'missing' | 'none';

export interface StatusDay {
  day: string;
  status: DayStatus;
  /** Share of sampled minutes the component worked (degraded counts as working); null = no data. */
  uptime: number | null;
}

export interface ComponentStatus {
  id: StatusComponent;
  status: HealthStatus;
  since: Date;
  /** Shown publicly only for components where it is safe (`connections`: service names). */
  note: string | undefined;
  days: StatusDay[];
  uptime: number | null;
}

export interface StatusIncident {
  /** `all`: the hub was not running (no samples). */
  component: StatusComponent | 'all';
  status: 'degraded' | 'down' | 'missing';
  startedAt: Date;
  endedAt: Date | null;
}

export interface StatusPageData {
  overall: HealthStatus;
  /** Last sample; null before the first one. */
  updatedAt: Date | null;
  /** The sampler stopped (no sample for a while): the data shown may be out of date. */
  stale: boolean;
  components: ComponentStatus[];
  incidents: StatusIncident[];
}

const MINUTE = 60_000;
const DAY = 86_400_000;
const RANK: Record<string, number> = { degraded: 1, missing: 2, down: 3 };

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class StatusService {
  constructor(
    private readonly deps: {
      db: Db;
      health: HealthRegistry;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** One sample: run the checks and record each component's status for this minute. */
  async sample(): Promise<Record<string, HealthStatus>> {
    const report = await this.deps.health.run({ timeoutMs: 10_000 });
    const minute = Math.floor(this.now() / MINUTE) * MINUTE;
    const result: Record<string, HealthStatus> = {};
    for (const { id } of PUBLIC_COMPONENTS) {
      const checks = report.checks.filter((c) => c.components?.includes(id));
      if (checks.length === 0) continue;
      const status = worst(checks.map((c) => c.status));
      const detail =
        checks
          .filter((c) => c.status !== 'ok')
          .map((c) => (id === 'connections' ? (c.detail ?? '') : `${c.name}: ${c.detail ?? c.status}`))
          .filter(Boolean)
          .join('; ')
          .slice(0, 500) || null;
      await this.record(id, status, detail, minute);
      result[id] = status;
    }
    return result;
  }

  private async record(
    component: StatusComponent,
    status: HealthStatus,
    detail: string | null,
    minute: number,
  ) {
    const db = this.deps.db;
    const [prev] = await db.select().from(statusComponents).where(eq(statusComponents.component, component));
    const last = prev ? Math.floor(prev.lastSampleAt.getTime() / MINUTE) * MINUTE : undefined;
    if (last !== undefined && last >= minute) return; // already sampled this minute

    // Minutes nobody sampled since the previous run (up to 90 days back).
    if (last !== undefined && minute - last > 2 * MINUTE) {
      const from = Math.max(last + MINUTE, minute - 90 * DAY);
      await this.addMissing(component, from, minute);
      // One incident for the whole hub, not one per component.
      const [known] = await db
        .select({ id: statusIncidents.id })
        .from(statusIncidents)
        .where(and(eq(statusIncidents.status, 'missing'), eq(statusIncidents.startedAt, new Date(from))))
        .limit(1);
      if (!known) {
        await db.insert(statusIncidents).values({
          id: newId('inc'),
          component: 'all',
          status: 'missing',
          startedAt: new Date(from),
          endedAt: new Date(minute),
        });
      }
    }

    const column =
      status === 'ok' ? 'okMinutes' : status === 'degraded' ? 'degradedMinutes' : ('downMinutes' as const);
    await db
      .insert(statusDays)
      .values({ component, day: dayOf(minute), [column]: 1 })
      .onConflictDoUpdate({
        target: [statusDays.component, statusDays.day],
        set: { [column]: sql`${statusDays[column]} + 1` },
      });

    const [open] = await db
      .select()
      .from(statusIncidents)
      .where(
        and(
          eq(statusIncidents.component, component),
          isNull(statusIncidents.endedAt),
          or(eq(statusIncidents.status, 'degraded'), eq(statusIncidents.status, 'down')),
        ),
      )
      .limit(1);
    if (status === 'ok') {
      if (open)
        await db
          .update(statusIncidents)
          .set({ endedAt: new Date(minute) })
          .where(eq(statusIncidents.id, open.id));
    } else if (!open) {
      await db.insert(statusIncidents).values({
        id: newId('inc'),
        component,
        status,
        detail,
        startedAt: new Date(minute),
      });
    } else {
      await db
        .update(statusIncidents)
        .set({ status: (RANK[status] ?? 0) > (RANK[open.status] ?? 0) ? status : open.status, detail })
        .where(eq(statusIncidents.id, open.id));
    }

    const since = prev && prev.status === status ? prev.since : new Date(minute);
    const values = { status, detail, since, lastSampleAt: new Date(minute) };
    await db
      .insert(statusComponents)
      .values({ component, ...values })
      .onConflictDoUpdate({ target: statusComponents.component, set: values });
  }

  /** Adds `missing` minutes for [from, to), split by UTC day. */
  private async addMissing(component: StatusComponent, from: number, to: number) {
    let start = from;
    while (start < to) {
      const dayEnd = Math.floor(start / DAY) * DAY + DAY;
      const end = Math.min(dayEnd, to);
      const minutes = Math.round((end - start) / MINUTE);
      if (minutes > 0) {
        await this.deps.db
          .insert(statusDays)
          .values({ component, day: dayOf(start), missingMinutes: minutes })
          .onConflictDoUpdate({
            target: [statusDays.component, statusDays.day],
            set: { missingMinutes: sql`${statusDays.missingMinutes} + ${minutes}` },
          });
      }
      start = end;
    }
  }

  /** Everything the status page shows: current state, `days` daily bars, recent incidents. */
  async page(options: { days?: number; incidentDays?: number } = {}): Promise<StatusPageData> {
    const days = options.days ?? 90;
    const now = this.now();
    const firstDay = dayOf(now - (days - 1) * DAY);
    const [current, history, incidents] = await Promise.all([
      this.deps.db.select().from(statusComponents),
      this.deps.db.select().from(statusDays).where(gte(statusDays.day, firstDay)),
      this.deps.db
        .select()
        .from(statusIncidents)
        .where(gte(statusIncidents.startedAt, new Date(now - (options.incidentDays ?? 14) * DAY)))
        .orderBy(desc(statusIncidents.startedAt))
        .limit(50),
    ]);
    const byComponent = new Map(current.map((c) => [c.component, c]));
    const components: ComponentStatus[] = [];
    for (const { id, publicDetail } of PUBLIC_COMPONENTS) {
      const state = byComponent.get(id);
      if (!state) continue;
      const rows = new Map(history.filter((h) => h.component === id).map((h) => [h.day, h]));
      const bars: StatusDay[] = [];
      let up = 0;
      let total = 0;
      for (let i = days - 1; i >= 0; i--) {
        const day = dayOf(now - i * DAY);
        const row = rows.get(day);
        const sampled = row ? row.okMinutes + row.degradedMinutes + row.downMinutes + row.missingMinutes : 0;
        if (!row || sampled === 0) {
          bars.push({ day, status: 'none', uptime: null });
          continue;
        }
        const working = row.okMinutes + row.degradedMinutes;
        up += working;
        total += sampled;
        bars.push({ day, status: dayStatus(row), uptime: working / sampled });
      }
      components.push({
        id,
        status: state.status,
        since: state.since,
        note: publicDetail && state.status !== 'ok' ? (state.detail ?? undefined) : undefined,
        days: bars,
        uptime: total ? up / total : null,
      });
    }
    const updatedAt = current.length
      ? new Date(Math.max(...current.map((c) => c.lastSampleAt.getTime())))
      : null;
    return {
      overall: worst(components.map((c) => c.status)),
      updatedAt,
      stale: updatedAt !== null && now - updatedAt.getTime() > 5 * MINUTE,
      components,
      incidents: incidents.map((i) => ({
        component: i.component as StatusComponent | 'all',
        status: i.status,
        startedAt: i.startedAt,
        endedAt: i.endedAt,
      })),
    };
  }

  /** Forgets history older than `days` (maintenance). */
  async prune(days = 400): Promise<void> {
    const cutoff = this.now() - days * DAY;
    await this.deps.db.delete(statusDays).where(lt(statusDays.day, dayOf(cutoff)));
    await this.deps.db.delete(statusIncidents).where(lt(statusIncidents.startedAt, new Date(cutoff)));
  }
}

/**
 * A day's color: short blips do not paint the whole day. Down (or unsampled) for 15 minutes or
 * more is `down`, any trouble for 5 minutes or more is `degraded`.
 */
function dayStatus(row: { degradedMinutes: number; downMinutes: number; missingMinutes: number }): DayStatus {
  if (row.downMinutes >= 15) return 'down';
  if (row.missingMinutes >= 15) return 'missing';
  if (row.degradedMinutes + row.downMinutes + row.missingMinutes >= 5) return 'degraded';
  return 'ok';
}
