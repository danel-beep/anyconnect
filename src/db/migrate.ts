import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { BRAND } from '../brand.js';

/** Works from both src/ (tsx) and dist/ (compiled): the folder sits at the repository root. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Applies pending migrations. A Postgres advisory lock makes this safe when several
 * instances start at the same time.
 *
 * Given a database URL, it runs on a connection of its own without the pool's query timeout
 * (`DATABASE_QUERY_TIMEOUT_SECONDS`): waiting for another instance's migrations, or one long
 * migration, may take longer than any normal query.
 */
export async function runMigrations(target: pg.Pool | string): Promise<void> {
  if (typeof target === 'string') {
    const client = new pg.Client({ connectionString: target, application_name: `${BRAND.slug}-migrations` });
    await client.connect();
    try {
      await migrateWith(client);
    } finally {
      await client.end().catch(() => {});
    }
    return;
  }
  const client = await target.connect();
  try {
    await migrateWith(client);
  } finally {
    client.release();
  }
}

async function migrateWith(client: pg.Client | pg.PoolClient): Promise<void> {
  // The lock name keeps the former product name so old and new instances share it during a deploy.
  await client.query("SELECT pg_advisory_lock(hashtext('anyconnect:migrations'))");
  try {
    await migrate(drizzle({ client, casing: 'snake_case' }), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('anyconnect:migrations'))");
  }
}
