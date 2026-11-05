import pg from 'pg';

/**
 * Test files run in parallel: every Vitest worker gets its own database next to the one in
 * `TEST_DATABASE_URL` (`manyplug_test` → `manyplug_test_w1`, `manyplug_test_w2`…), so a file's
 * `resetDatabase()` never pulls the schema out from under a file running in another worker.
 *
 * Runs before each test file (Vitest `setupFiles`), before `test/helpers.ts` reads the variable.
 * Creating the database is best effort: unit tests that never touch Postgres still run without it.
 */

const DEFAULT_URL = 'postgres://postgres@localhost:5432/manyplug_test';

// A worker runs many files one after another and keeps its environment: remember the base address.
process.env.TEST_DATABASE_BASE_URL ??= process.env.TEST_DATABASE_URL ?? DEFAULT_URL;
const base = process.env.TEST_DATABASE_BASE_URL;
const worker = process.env.VITEST_POOL_ID;

if (worker) {
  const url = new URL(base);
  url.pathname = `${url.pathname}_w${worker}`;
  process.env.TEST_DATABASE_URL = url.toString();
  await createDatabaseIfMissing(url);
}

async function createDatabaseIfMissing(url: URL): Promise<void> {
  const name = decodeURIComponent(url.pathname.slice(1));
  // The maintenance database exists on every server; the test database itself may not exist yet.
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString(), connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
  } catch {
    return; // No Postgres here: only tests that need it will fail, with their own clear error.
  }
  try {
    const exists = await client.query('select 1 from pg_database where datname = $1', [name]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
  } catch (error) {
    // Another process created it first (42P04): fine.
    if ((error as { code?: string }).code !== '42P04') throw error;
  } finally {
    await client.end();
  }
}
