import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type pg from 'pg';
import { MIGRATIONS_FOLDER } from '../db/migrate.js';
import type { JobDefinition } from '../jobs/queue.js';
import type { JobRun } from '../jobs/runs.js';
import type { HealthCheck } from './checks.js';

/** Postgres answers, and how fast. */
export function databaseCheck(pool: pg.Pool, slowMs = 1000): HealthCheck {
  return {
    name: 'database',
    critical: true,
    component: 'database',
    async run() {
      const started = performance.now();
      await pool.query('select 1');
      const ms = Math.round(performance.now() - started);
      return ms > slowMs
        ? { status: 'degraded', detail: `slow: ${ms} ms` }
        : { status: 'ok', detail: `${ms} ms` };
    },
  };
}

/** Migrations this build ships with (from drizzle/meta/_journal.json). */
export function expectedMigrations(folder = MIGRATIONS_FOLDER): { count: number; lastWhen: number } {
  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: { when: number }[];
  };
  return { count: journal.entries.length, lastWhen: Math.max(0, ...journal.entries.map((e) => e.when)) };
}

export interface MigrationState {
  /** Migrations this build ships with. */
  expected: number;
  /** Migrations recorded in the database. */
  applied: number;
  /** `pending`: the database is behind this build; `ahead`: a newer build migrated it (a rollback). */
  state: 'current' | 'pending' | 'ahead';
}

export async function migrationState(pool: pg.Pool, folder = MIGRATIONS_FOLDER): Promise<MigrationState> {
  const expected = expectedMigrations(folder);
  const exists = await pool.query("select to_regclass('drizzle.__drizzle_migrations') as t");
  let applied = 0;
  let lastApplied = 0;
  if (exists.rows[0]?.t) {
    const result = await pool.query<{ n: string; last: string | null }>(
      'select count(*) as n, max(created_at) as last from drizzle.__drizzle_migrations',
    );
    applied = Number(result.rows[0]?.n ?? 0);
    lastApplied = Number(result.rows[0]?.last ?? 0);
  }
  const state =
    lastApplied > expected.lastWhen || applied > expected.count
      ? 'ahead'
      : applied < expected.count
        ? 'pending'
        : 'current';
  return { expected: expected.count, applied, state };
}

/** The database schema matches this build. */
export function migrationsCheck(pool: pg.Pool, folder = MIGRATIONS_FOLDER): HealthCheck {
  return {
    name: 'migrations',
    critical: true,
    component: 'database',
    async run() {
      const m = await migrationState(pool, folder);
      if (m.state === 'pending')
        return { status: 'down', detail: `${m.expected - m.applied} migrations not applied` };
      if (m.state === 'ahead')
        return { status: 'degraded', detail: 'the database was migrated by a newer version' };
      return { status: 'ok', detail: `${m.applied} applied` };
    },
  };
}

/**
 * Recurring jobs ran recently enough and are not failing over and over. A job that has not run
 * since the hub started is given its full period before it counts as late.
 */
export function jobsCheck(deps: {
  definitions: () => readonly JobDefinition<any>[];
  runs: () => Promise<JobRun[]>;
  startedAt?: number;
  now?: () => number;
}): HealthCheck {
  const startedAt = deps.startedAt ?? Date.now();
  return {
    name: 'jobs',
    critical: false,
    component: 'jobs',
    async run() {
      const now = deps.now?.() ?? Date.now();
      const runs = new Map((await deps.runs()).map((r) => [r.name, r]));
      const late: string[] = [];
      const failing: string[] = [];
      for (const job of deps.definitions()) {
        if (!job.expectEveryMs) continue;
        const run = runs.get(job.name);
        const lastOk = run?.lastSucceededAt?.getTime() ?? 0;
        if (now - Math.max(lastOk, startedAt) > job.expectEveryMs) late.push(job.name);
        if ((run?.consecutiveFailures ?? 0) >= 3) failing.push(job.name);
      }
      if (late.length || failing.length) {
        const parts = [
          ...(late.length ? [`late: ${late.join(', ')}`] : []),
          ...(failing.length ? [`failing: ${failing.join(', ')}`] : []),
        ];
        return { status: 'degraded', detail: parts.join('; ') };
      }
      return { status: 'ok' };
    },
  };
}

/**
 * The Node.js event loop is not blocked: long pauses make every request slow, whatever the
 * database says. Measured continuously; p99 of the last interval.
 */
export function eventLoopCheck(degradedMs = 500): HealthCheck & { stop(): void } {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  return {
    name: 'event_loop',
    critical: false,
    component: 'web',
    async run() {
      const p99 = Math.round(histogram.percentile(99) / 1e6);
      histogram.reset();
      return p99 > degradedMs
        ? { status: 'degraded', detail: `p99 delay ${p99} ms` }
        : { status: 'ok', detail: `p99 ${p99} ms` };
    },
    stop: () => histogram.disable(),
  };
}
