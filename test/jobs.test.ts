import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobQueue } from '../src/jobs/queue.js';
import { createLogger } from '../src/logger.js';
import { resetDatabase, TEST_DATABASE_URL } from './helpers.js';

describe('background job queue (pg-boss)', () => {
  const queue = new JobQueue({
    connectionString: TEST_DATABASE_URL,
    logger: createLogger({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
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

  it('runs enqueued jobs and registers schedules', async () => {
    await queue.send('test.echo', { n: 42 });
    await finished;
    expect(received).toEqual([{ n: 42 }]);
    await expect(queue.send('test.unknown')).rejects.toThrow(/Unknown job/);
    expect(() => queue.register({ name: 'late', description: 'x', run: async () => {} })).toThrow(
      /before starting/,
    );
  });

  it('every built-in job has a unique name and a valid cron', async () => {
    const { builtinJobs } = await import('../src/jobs/builtin.js');
    const jobs = builtinJobs({ health: {} as never });
    expect(new Set(jobs.map((j) => j.name)).size).toBe(jobs.length);
    for (const job of jobs) expect(job.cron).toMatch(/^(\S+\s){4}\S+$/);
  });
});
