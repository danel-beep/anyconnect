import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx', 'eval/**/*.test.ts'],
    // Files run in parallel; each worker has its own Postgres database (see the setup file).
    setupFiles: ['test/setup/worker-database.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
