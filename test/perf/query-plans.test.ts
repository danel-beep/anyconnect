import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers.js';
import type { LoggedQuery } from './query-log.js';
import { recordQueries } from './query-log.js';
import { SCALE_TEST, seedScale } from './scale-data.js';
import { startWorkload, type Workload } from './workload.js';

/**
 * Query plans at scale: the hub runs on a database filled with synthetic users (`scale-data.ts`),
 * every statement that its pages, MCP requests and background jobs send is explained with the
 * parameters it was sent with, and none may read a whole large table. Plans, not timings: a plan does
 * not depend on how fast the CI machine is, and a missing index shows at a few thousand rows already.
 *
 * "Large" is a table that grows with use (activity log, messages, events), not with the number of
 * users; the work lists of the background jobs read every account on purpose.
 */
const LARGE_ROWS = 5000;
/** Jobs that need what a test does not have (a backup bucket). */
const SKIP_JOBS = new Set(['backup.database']);

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  Filter?: string;
  Plans?: PlanNode[];
}

describe('queries use indexes on a busy hub', () => {
  let work: Workload;
  let large: Map<string, number>;
  /** Indexes that hold only some rows (`where status = 'running'`): walking one is the point. */
  let partial: Set<string>;

  beforeAll(async () => {
    await resetDatabase();
    work = await startWorkload();
    await seedScale(work.hub.services.database.pool, SCALE_TEST);
    const { rows } = await work.hub.services.database.pool.query<{ name: string; rows: number }>(
      `select relname as name, reltuples::int as rows from pg_class
       where relkind = 'r' and relnamespace = 'public'::regnamespace and reltuples >= $1`,
      [LARGE_ROWS],
    );
    large = new Map(rows.map((r) => [r.name, r.rows]));
    const indexes = await work.hub.services.database.pool.query<{ name: string }>(
      `select indexrelid::regclass::text as name from pg_index where indpred is not null`,
    );
    partial = new Set(indexes.rows.map((r) => r.name));
  }, 120_000);

  afterAll(async () => {
    await work?.close();
  });

  /**
   * The large tables a statement may read from start to end: a sequential scan, or an index walked
   * from one end with every row filtered (`order by id desc limit 50` for a workspace with no
   * rows walks the whole log backwards).
   */
  const fullScans = async (query: LoggedQuery): Promise<string[]> => {
    const { rows } = await work.hub.services.database.pool.query(`explain (format json) ${query.sql}`, [
      ...query.params,
    ]);
    const found: string[] = [];
    const walk = (node: PlanNode) => {
      const table = node['Relation Name'];
      if (table && large.has(table)) {
        const type = node['Node Type'];
        if (type === 'Seq Scan') found.push(`${table} (${large.get(table)} rows)`);
        else if (
          /^Index (Only )?Scan$/.test(type) &&
          !node['Index Cond'] &&
          node.Filter &&
          !partial.has(node['Index Name']!)
        )
          found.push(`${table} (${large.get(table)} rows) walked along ${node['Index Name']}`);
      }
      for (const child of node.Plans ?? []) walk(child);
    };
    walk(rows[0]['QUERY PLAN'][0].Plan);
    return found;
  };

  it('in every page, MCP request and background job', async () => {
    expect([...large.keys()]).toEqual(
      expect.arrayContaining(['tool_calls', 'messenger_messages', 'trigger_events']),
    );
    const sources = new Map([...(await work.pages()), ...(await work.apiRequests())]);
    for (const name of work.hub.services.jobs.names) {
      if (SKIP_JOBS.has(name)) continue;
      // A job may fail on the synthetic rows (placeholders where ciphertext would be): its plans count.
      const { queries } = await recordQueries(work.hub.services.database, () =>
        work.hub.services.jobs.runNow(name).catch(() => undefined),
      );
      sources.set(`job ${name}`, queries);
    }
    expect(sources.size).toBeGreaterThan(20);

    const explained = new Map<string, string[]>();
    const problems: string[] = [];
    for (const [source, queries] of sources) {
      for (const query of queries) {
        if (!/^\s*(select|insert|update|delete|with)\b/i.test(query.sql)) continue;
        let scans = explained.get(query.sql);
        if (!scans) {
          scans = await fullScans(query);
          explained.set(query.sql, scans);
          if (scans.length)
            problems.push(
              `${source}: ${scans.join(', ')}\n    ${query.sql.replace(/\s+/g, ' ').slice(0, 300)}`,
            );
        }
      }
    }
    expect(explained.size).toBeGreaterThan(50);
    expect(problems, `statements that read a whole large table:\n${problems.join('\n')}`).toEqual([]);
  }, 180_000);

  it('removing a row of a large table finds its children by an index', async () => {
    // A cascading foreign key without an index on the child column reads the whole child table for
    // every parent row removed (removing an account, a chat, a trigger).
    const { rows } = await work.hub.services.database.pool.query<{ child: string; column: string }>(`
      select c.conrelid::regclass::text as child, a.attname as column
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace
        and not exists (
          select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1]
        )`);
    const missing = rows.filter((r) => large.has(r.child)).map((r) => `${r.child}.${r.column}`);
    expect(missing).toEqual([]);
  });
});
