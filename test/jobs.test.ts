import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobQueue } from '../src/jobs/queue.js';
import { createLogger } from '../src/logger.js';
import { resetDatabase, TEST_DATABASE_URL } from './helpers.js';

/** Resolves with `promise`, or fails if it takes longer than `ms`. */
const within = <T>(ms: number, promise: Promise<T>) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`not within ${ms} ms`)), ms)),
  ]);

describe('background job queue (pg-boss)', () => {
  // Idle workers barely poll: a job that runs at once proves that NOTIFY woke its worker.
  const queue = new JobQueue({
    connectionString: TEST_DATABASE_URL,
    logger: createLogger({ level: 'silent' }),
    pollingIntervalSeconds: 60,
    retryDelaySeconds: 1,
  });
  const received: unknown[] = [];
  let flakyRuns = 0;
  let retried: () => void;
  const retriedOnce = new Promise<void>((resolve) => {
    retried = resolve;
  });
  let slowRunning = 0;
  let allSlowRunning: () => void;
  const slowTogether = new Promise<void>((resolve) => {
    allSlowRunning = resolve;
  });
  let done: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  beforeAll(async () => {
    await resetDatabase();
    queue
      .register<{ n: number }>({
        name: 'test.echo',
        description: 'Records its input',
        run: async (data) => {
          received.push(data);
          done();
        },
      })
      .register({
        name: 'test.flaky',
        description: 'Fails once, then works',
        run: async () => {
          flakyRuns++;
          if (flakyRuns === 1) throw new Error('temporary failure');
          retried();
        },
      })
      .register<{ n: number }>({
        name: 'test.slow',
        description: 'Waits until three runs are in flight',
        concurrency: 3,
        run: async () => {
          slowRunning++;
          if (slowRunning === 3) allSlowRunning();
          await slowTogether;
        },
      })
      .register({ name: 'test.cron', description: 'Recurring', cron: '0 3 * * *', run: async () => {} });
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  it('runs an enqueued job at once: NOTIFY wakes the idle worker, no polling needed', async () => {
    await queue.send('test.echo', { n: 42 });
    await within(5000, finished);
    expect(received).toEqual([{ n: 42 }]);
    await expect(queue.send('test.unknown')).rejects.toThrow(/Unknown job/);
    expect(() => queue.register({ name: 'late', description: 'x', run: async () => {} })).toThrow(
      /before starting/,
    );
  });

  it('retries a failed job when its retry delay ends, not after the polling backstop (no NOTIFY)', async () => {
    await queue.send('test.flaky');
    await within(10_000, retriedOnce);
    expect(flakyRuns).toBe(2);
  });

  it('works on several runs of a job at a time when the job asks for it', async () => {
    // Each run waits for the other two: with one worker the first would never finish.
    for (const n of [1, 2, 3]) await queue.send('test.slow', { n });
    await within(10_000, slowTogether);
    expect(slowRunning).toBe(3);
  });

  it('turns NOTIFY on for queues an older release created without it', async () => {
    const schema = 'pgboss_upgrade';
    const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    const old = new PgBoss({ connectionString: TEST_DATABASE_URL, schema });
    await old.start();
    await old.createQueue('test.old');
    expect((await old.getQueue('test.old'))?.notify).toBe(false);
    await old.stop({ graceful: false });

    const upgraded = new JobQueue({
      connectionString: TEST_DATABASE_URL,
      logger: createLogger({ level: 'silent' }),
      schema,
      pollingIntervalSeconds: 60,
    });
    let ran!: () => void;
    const run = new Promise<void>((resolve) => {
      ran = resolve;
    });
    upgraded.register({ name: 'test.old', description: 'Made by an older release', run: async () => ran() });
    await upgraded.start();
    try {
      await upgraded.send('test.old');
      await within(5000, run);
    } finally {
      await upgraded.stop();
    }
  });

  it('every built-in job has a unique name and a valid cron', async () => {
    const { builtinJobs } = await import('../src/jobs/builtin.js');
    const jobs = builtinJobs({
      health: {} as never,
      alerts: {} as never,
      customServices: {} as never,
      billingNotices: {} as never,
      status: {} as never,
      activity: {} as never,
      retention: {} as never,
    });
    expect(new Set(jobs.map((j) => j.name)).size).toBe(jobs.length);
    for (const job of jobs) expect(job.cron).toMatch(/^(\S+\s){4}\S+$/);
  });
});
