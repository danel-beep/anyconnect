import type { TestProject } from 'vitest/node';
import {
  createDatabaseIfMissing,
  DEFAULT_TEST_DATABASE_URL,
  databaseName,
  NoServerError,
  siblingDatabaseUrl,
} from './databases.js';

/**
 * Runs once per test run, in the Vitest process, before any worker starts (`globalSetup`): creates
 * the database of every worker next to `TEST_DATABASE_URL` (`manyplug_test_w1` … `_wN`, one per
 * possible worker). `worker-database.ts` then only points each worker at its own.
 *
 * Never fails the run: unit tests that do not touch Postgres still pass. Without a server it stays
 * silent (tests that need one fail with "connection refused"); when the server refuses (no
 * CREATEDB, wrong password) it says why, once.
 */
export default async function setup(project: TestProject): Promise<void> {
  const base = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const workers = Math.max(1, project.config.maxWorkers);
  for (let worker = 1; worker <= workers; worker++) {
    const url = siblingDatabaseUrl(base, `w${worker}`);
    try {
      await createDatabaseIfMissing(url, [base]);
    } catch (error) {
      if (!(error instanceof NoServerError)) {
        console.warn(
          `[test setup] Could not create the test database "${databaseName(url)}": ${(error as Error).message}. ` +
            'Check TEST_DATABASE_URL, create the databases yourself or let the test role create databases (CREATEDB). ' +
            'Tests that use Postgres will fail.',
        );
      }
      return;
    }
  }
}
