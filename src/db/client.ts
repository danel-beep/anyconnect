import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction. */
export type DbExecutor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** Sees every statement the app sends through drizzle, before it runs (tests, diagnostics). */
export type QueryListener = (query: string, params: readonly unknown[]) => void;

export interface Database {
  db: Db;
  pool: pg.Pool;
  /**
   * Starts telling `listener` about each statement; the returned function stops it. Used by the
   * query-budget and query-plan tests (`test/perf/`); with no listener it costs one length check.
   * Statements sent on the raw `pool` (migrations, the change listener, the job queue) are not seen.
   */
  onQuery(listener: QueryListener): () => void;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  poolMax?: number;
  /**
   * A query that gets no answer for this long fails and its connection is dropped (0: never).
   * After a network split a connection can stay open without ever answering; without this limit
   * every request that picked such a connection would hang until the process restarts.
   */
  queryTimeoutMs?: number;
}

/** Default for `queryTimeoutMs`: far above any query the hub makes, well below "hangs forever". */
export const DEFAULT_QUERY_TIMEOUT_MS = 60_000;

export function createDatabase(url: string, options: DatabaseOptions = {}): Database {
  const queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const pool = new pg.Pool({
    connectionString: url,
    max: options.poolMax ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // TCP keepalive notices a peer that vanished while the connection sat idle in the pool.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    ...(queryTimeoutMs > 0 ? { query_timeout: queryTimeoutMs } : {}),
  });
  // Errors on idle clients (e.g. the server restarted) must not crash the process.
  pool.on('error', () => {});
  const listeners = new Set<QueryListener>();
  const logger = {
    logQuery(query: string, params: unknown[]) {
      if (listeners.size) for (const listener of listeners) listener(query, params);
    },
  };
  const db = drizzle({ client: pool, schema, casing: 'snake_case', logger });
  return {
    db,
    pool,
    onQuery(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => pool.end(),
  };
}

export { schema };
