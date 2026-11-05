import { defineConfig } from 'vitest/config';

/** `npm run test:visual`: page layout checks in a real browser (needs Postgres and Chromium). */
export default defineConfig({
  test: {
    include: ['test/visual/**/*.visual.ts'],
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 120_000,
  },
});
