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
  let deadline: (seen: { stopping: boolean }) => void;
  const deadlineReached = new Promise<{ stopping: boolean }>((resolve) => {
    deadline = resolve;
  });
  const fairStarted: string[] = [];
  const fairDone: string[] = [];
  let releaseFair: () => void;
  const fairRelease = new Promise<void>((resolve) => {
    releaseFair = resolve;
  });
  let allFairDone: () => void;
  const fairFinished = new Promise<void>((resolve) => {
    allFairDone = resolve;
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
      .register({
        name: 'test.deadline',
        description: 'Waits until it is told to stop',
        timeoutMs: 1_000,
        retryLimit: 0,
        run: async (_data, ctx) => {
          await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
          deadline({ stopping: ctx.stopping() });
        },
      })
      .register<{ who: string }>({
        name: 'test.fair',
        description: 'Three slots, one per group',
        concurrency: 3,
        groupConcurrency: 1,
        run: async (data) => {
          fairStarted.push(data.who);
          await fairRelease;
          fairDone.push(data.who);
          if (fairDone.length === 3) allFairDone();
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

  it('gives every run a deadline: its signal aborts when the time is up', async () => {
    const started = Date.now();
    await queue.send('test.deadline');
    expect(await within(8_000, deadlineReached)).toEqual({ stopping: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('drops a repeated hand-over of the same work', async () => {
    expect(await queue.send('test.echo', { n: 1 }, { dedupeKey: 'event-1' })).toBeTruthy();
    expect(await queue.send('test.echo', { n: 1 }, { dedupeKey: 'event-1' })).toBeNull();
    expect(await queue.send('test.echo', { n: 2 }, { dedupeKey: 'event-2' })).toBeTruthy();
  });

  it('shares a job’s slots between groups: a busy one does not take them all', async () => {
    await queue.send('test.fair', { who: 'busy-1' }, { group: 'busy' });
    await queue.send('test.fair', { who: 'busy-2' }, { group: 'busy' });
    await queue.send('test.fair', { who: 'other' }, { group: 'other' });
    // Three free slots, yet the second run of the busy group waits for its first.
    for (let i = 0; i < 100 && fairStarted.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 500));
    expect([...fairStarted].sort()).toEqual(['busy-1', 'other']);
    releaseFair();
    await within(15_000, fairFinished);
    expect(fairDone).toHaveLength(3);
  });

  it('tells running jobs to wrap up on shutdown; the next process runs them again', async () => {
    const schema = 'pgboss_shutdown';
    const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    const errors: unknown[] = [];
    const make = (
      run: (ctx: { signal: AbortSignal; stopping(): boolean; attempt: number }) => Promise<void>,
    ) =>
      new JobQueue({
        connectionString: TEST_DATABASE_URL,
        logger: createLogger({ level: 'silent' }),
        schema,
        pollingIntervalSeconds: 1,
        retryDelaySeconds: 1,
        onError: (error) => errors.push(error),
      }).register({ name: 'test.long', description: 'Long work', run: (_data, ctx) => run(ctx) });

    let begun!: () => void;
    const running = new Promise<void>((resolve) => {
      begun = resolve;
    });
    let stoppedAs: boolean | undefined;
    const first = make(async (ctx) => {
      begun();
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
      stoppedAs = ctx.stopping();
      throw new Error('stopped before the work was done');
    });
    await first.start();
    await first.send('test.long');
    await within(5_000, running);
    const stopping = Date.now();
    await first.stop();
    // The job did not hold the shutdown up, and being stopped is not reported as a fault.
    expect(Date.now() - stopping).toBeLessThan(5_000);
    expect(stoppedAs).toBe(true);
    expect(errors).toHaveLength(0);

    let again!: (attempt: number) => void;
    const retried = new Promise<number>((resolve) => {
      again = resolve;
    });
    const second = make(async (ctx) => again(ctx.attempt));
    await second.start();
    try {
      expect(await within(15_000, retried)).toBe(1);
    } finally {
      await second.stop();
    }
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
