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
  });
  const received: unknown[] = [];
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
    });
    expect(new Set(jobs.map((j) => j.name)).size).toBe(jobs.length);
    for (const job of jobs) expect(job.cron).toMatch(/^(\S+\s){4}\S+$/);
  });
});
