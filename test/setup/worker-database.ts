import { openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDatabaseIfMissing,
  DEFAULT_TEST_DATABASE_URL,
  databaseName,
  NoServerError,
  siblingDatabaseUrl,
} from './databases.js';

/**
 * Test files run in parallel: every Vitest worker gets its own database next to the one in
 * `TEST_DATABASE_URL` (`manyplug_test` → `manyplug_test_w1`, `manyplug_test_w2`…), so a file's
 * `resetDatabase()` never pulls the schema out from under a file running in another worker.
 * The base database itself is never used and need not exist.
 *
 * Runs before each test file (Vitest `setupFiles`), before `test/helpers.ts` reads the variable.
 * A failure here never stops unit tests that do not touch Postgres: without a server it stays
 * silent (tests that need one fail with "connection refused"), and when the server refuses
 * (no CREATEDB, wrong password) it says why before those tests fail.
 */

const worker = process.env.VITEST_POOL_ID;
const current = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;

// Each file normally runs in a fresh process; with --no-isolate a worker runs several files in one
// process and this file runs again for each, with the variable already pointing at its database.
if (worker && !databaseName(current).endsWith(`_w${worker}`)) {
  const url = siblingDatabaseUrl(current, `w${worker}`);
  process.env.TEST_DATABASE_URL = url;
  try {
    await createDatabaseIfMissing(url, [current]);
  } catch (error) {
    if (!(error instanceof NoServerError) && firstTimeThisRun(`db-${databaseName(url)}`)) {
      console.warn(
        `[test setup] Could not create the test database "${databaseName(url)}": ${(error as Error).message}. ` +
          'Check TEST_DATABASE_URL, create the database yourself or let the test role create databases (CREATEDB). ' +
          'Tests that use Postgres will fail.',
      );
    }
  }
}

/**
 * Every test file runs this setup in a new process; a warning repeated for each of them would bury
 * the test results. Workers are children of the Vitest process, so its pid names the run.
 */
function firstTimeThisRun(key: string): boolean {
  try {
    openSync(join(tmpdir(), `manyplug-test-setup-${process.ppid}-${key}`), 'wx');
    return true;
  } catch {
    return false;
  }
}
