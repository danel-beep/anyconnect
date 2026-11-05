import { defineConfig } from 'vitest/config';

/** `npm run test:visual`: page layout checks in a real browser (needs Postgres and Chromium). */
export default defineConfig({
  test: {
    include: ['test/visual/**/*.visual.ts'],
    // Its own database next to TEST_DATABASE_URL, created if missing, like the other tests.
    setupFiles: ['test/setup/worker-database.ts'],
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 120_000,
  },
});
