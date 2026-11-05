import { DEFAULT_TEST_DATABASE_URL, databaseName, siblingDatabaseUrl } from './databases.js';

/**
 * Test files run in parallel: every Vitest worker gets its own database next to the one in
 * `TEST_DATABASE_URL` (`manyplug_test` → `manyplug_test_w1`, `manyplug_test_w2`…), so a file's
 * `resetDatabase()` never pulls the schema out from under a file running in another worker.
 * The base database itself is never used and need not exist; `global.ts` creates the worker
 * databases once per run.
 *
 * Runs before each test file (Vitest `setupFiles`), before `test/helpers.ts` reads the variable.
 */

const worker = process.env.VITEST_POOL_ID;
const current = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;

// Each file normally runs in a fresh process; with --no-isolate a worker runs several files in one
// process and this file runs again for each, with the variable already pointing at its database.
if (worker && !databaseName(current).endsWith(`_w${worker}`)) {
  process.env.TEST_DATABASE_URL = siblingDatabaseUrl(current, `w${worker}`);
}
