import { defineConfig } from 'vitest/config';
import { DEFAULT_TEST_DATABASE_URL, databaseName, siblingDatabaseUrl } from './test/setup/databases.js';

// Its own databases next to TEST_DATABASE_URL (`manyplug_test_visual_w1`), so it can run alongside
// `npm test`, whose files reset theirs. Set here, in the main process, so the global setup that
// creates the database and the worker that uses it both see it.
const base = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
if (!databaseName(base).endsWith('_visual')) {
  process.env.TEST_DATABASE_URL = siblingDatabaseUrl(base, 'visual');
}

/** `npm run test:visual`: page layout checks in a real browser (needs Postgres and Chromium). */
export default defineConfig({
  test: {
    include: ['test/visual/**/*.visual.ts'],
    globalSetup: ['test/setup/global.ts'],
    setupFiles: ['test/setup/worker-database.ts'],
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 120_000,
  },
});
