import { availableParallelism } from 'node:os';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx', 'eval/**/*.test.ts'],
    // Files run in parallel; each worker has its own Postgres database (see the setup file).
    setupFiles: ['test/setup/worker-database.ts'],
    // A worker holds 3–5 connections at its peak: more than 8 workers would run into Postgres's
    // default limit of 100 connections on a many-core machine, without making the run faster.
    maxWorkers: Math.max(1, Math.min(8, availableParallelism() - 1)),
    // `vitest --changed` (npm run check:fast) follows imports; migrations are read from disk at
    // run time, so a change to them reruns everything.
    forceRerunTriggers: [...configDefaults.forceRerunTriggers, '**/drizzle/**', '**/test/setup/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
