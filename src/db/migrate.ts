import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';

/** Works from both src/ (tsx) and dist/ (compiled): the folder sits at the repository root. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Applies pending migrations. A Postgres advisory lock makes this safe when several
 * instances start at the same time.
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('anyconnect:migrations'))");
    try {
      await migrate(drizzle({ client, casing: 'snake_case' }), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('anyconnect:migrations'))");
    }
  } finally {
    client.release();
  }
}
