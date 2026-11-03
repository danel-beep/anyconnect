import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction. */
export type DbExecutor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface Database {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDatabase(url: string, options: { poolMax?: number } = {}): Database {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.poolMax ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // Errors on idle clients (e.g. the server restarted) must not crash the process.
  pool.on('error', () => {});
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  return { db, pool, close: () => pool.end() };
}

export { schema };
