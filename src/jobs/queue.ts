import { PgBoss } from 'pg-boss';
import type { Logger } from '../logger.js';
import { newRequestId, runWithContext } from '../ops/context.js';
import type { JobMonitor } from './runs.js';

/**
 * Background jobs on Postgres (pg-boss): no extra infrastructure, jobs survive restarts, and with
 * several instances each job runs once. Used for account health checks today; schedules, triggers
 * and long-running work of later stages are added as more `JobDefinition`s.
 *
 * Idle cost matters more than latency here: most of the time no job is due, and every poll is a
 * query on the shared database. So a new job wakes its workers through Postgres LISTEN/NOTIFY
 * (pg-boss `useListenNotify` + queues with `notify`), and polling is only a slow backstop. Where
 * NOTIFY is unavailable (a pooler in transaction mode), workers fall back to the normal poll.
 */

const HOUSEKEEPING_SECONDS = 300;

export interface JobContext {
  logger: Logger;
}

export interface JobDefinition<TData extends object = Record<string, unknown>> {
  /** Queue name, e.g. `accounts.refresh_tokens`. */
  name: string;
  description: string;
  /** Cron expression (UTC) for recurring jobs. Recurring jobs never overlap. */
  cron?: string;
  /**
   * How often a recurring job should succeed at least. Longer silence shows as a late job in the
   * health checks and on the status page (default: none, the job is not watched).
   */
  expectEveryMs?: number;
  run(data: TData, ctx: JobContext): Promise<void>;
}

export interface JobQueueOptions {
  connectionString: string;
  logger: Logger;
  /** Postgres schema of pg-boss's own tables. */
  schema?: string;
  /** How often an idle worker checks its queue when NOTIFY is unavailable (default 5 s). */
  pollingIntervalSeconds?: number;
  /** Backstop poll while NOTIFY wakes the workers (default 300 s); only covers a lost notification. */
  backstopSeconds?: number;
  /** Pause before a failed job is tried again (default 30 s; pg-boss retries twice). */
  retryDelaySeconds?: number;
  /**
   * How often due occurrences of recurring jobs are handed to their queues (default 30 s, pg-boss's
   * own default is 5 s). Adds at most this much delay to a cron job, which runs on minutes anyway.
   */
  cronWorkerIntervalSeconds?: number;
  /** Records every run (last success, failures) for health checks and the admin panel. */
  monitor?: JobMonitor;
  /** Reports a failed run to the error tracker. */
  onError?: (error: unknown, job: string) => void;
}

export class JobQueue {
  private readonly definitions = new Map<string, JobDefinition<any>>();
  private boss: PgBoss | undefined;

  constructor(private readonly options: JobQueueOptions) {}

  register<T extends object>(definition: JobDefinition<T>): this {
    if (this.boss) throw new Error('Register jobs before starting the queue');
    if (this.definitions.has(definition.name))
      throw new Error(`Job "${definition.name}" is already registered`);
    this.definitions.set(definition.name, definition);
    return this;
  }

  get names(): string[] {
    return [...this.definitions.keys()];
  }

  /** The registered jobs (name, schedule, expected frequency). */
  get definitionsList(): readonly JobDefinition<any>[] {
    return [...this.definitions.values()];
  }

  get running(): boolean {
    return this.boss !== undefined;
  }

  async start(): Promise<void> {
    const pollingIntervalSeconds = this.options.pollingIntervalSeconds ?? 5;
    const retryDelay = this.options.retryDelaySeconds ?? 30;
    const boss = new PgBoss({
      connectionString: this.options.connectionString,
      schema: this.options.schema ?? 'pgboss',
      application_name: 'manyplug-jobs',
      useListenNotify: true,
      // Checks that the LISTEN connection still hears its channels (default every 10 s, then the
      // most frequent idle query of the process).
      notifyHeartbeatIntervalMs: 60_000,
      cronWorkerIntervalSeconds: this.options.cronWorkerIntervalSeconds ?? 30,
      // pg-boss's own housekeeping, every 5–60 s by default: job dependencies ("flows", unused
      // here), queue statistics, expiry and retention, its schema upgrades. Every 5 minutes is
      // plenty for jobs that run on minute schedules, and each run is a query on the database.
      flowIntervalSeconds: HOUSEKEEPING_SECONDS,
      monitorIntervalSeconds: HOUSEKEEPING_SECONDS,
      superviseIntervalSeconds: HOUSEKEEPING_SECONDS,
      bamIntervalSeconds: HOUSEKEEPING_SECONDS,
    });
    boss.on('error', (err) => this.options.logger.warn({ err }, 'job queue error'));
    // E.g. LISTEN is not possible: jobs still run, only through polling.
    boss.on('warning', (warning) => this.options.logger.warn({ warning }, 'job queue warning'));
    await boss.start();
    this.boss = boss;
    for (const definition of this.definitions.values()) {
      // Singleton: at most one active job per queue, so a slow run never overlaps the next tick.
      await boss.createQueue(definition.name, {
        policy: definition.cron ? 'singleton' : 'standard',
        notify: true,
        retryDelay,
      });
      // createQueue leaves an existing queue as it is: update queues made by older releases.
      await boss.updateQueue(definition.name, { notify: true, retryDelay });
      if (definition.cron) await boss.schedule(definition.name, definition.cron, {}, { tz: 'UTC' });
      let workerId: string | undefined;
      workerId = await boss.work<object>(
        definition.name,
        {
          pollingIntervalSeconds,
          notifyPollingIntervalSeconds: Math.max(this.options.backstopSeconds ?? 300, pollingIntervalSeconds),
        },
        async (jobs) => {
          try {
            for (const job of jobs) {
              await runWithContext({ requestId: `job-${newRequestId()}`, job: definition.name }, () =>
                this.runOne(definition, job.id, job.data),
              );
            }
          } catch (err) {
            // A failed job goes back to the queue for a retry without a NOTIFY: look again when the
            // retry is due instead of after the backstop.
            const timer = setTimeout(() => workerId && boss.notifyWorker(workerId), retryDelay * 1000 + 500);
            timer.unref();
            throw err;
          }
        },
      );
    }
    this.options.logger.info({ jobs: this.names }, 'background jobs started');
  }

  private async runOne(definition: JobDefinition<any>, jobId: string, data: object): Promise<void> {
    const logger = this.options.logger.child({ job: definition.name, jobId });
    const monitor = this.options.monitor;
    const started = Date.now();
    // Monitoring is best effort: a failed status write must not fail the job itself.
    await monitor?.started(definition.name).catch((err) => logger.warn({ err }, 'job monitor failed'));
    try {
      await definition.run(data, { logger });
      const ms = Date.now() - started;
      logger.debug({ ms }, 'job done');
      await monitor
        ?.succeeded(definition.name, ms)
        .catch((err) => logger.warn({ err }, 'job monitor failed'));
    } catch (err) {
      const ms = Date.now() - started;
      if (this.options.onError) this.options.onError(err, definition.name);
      else logger.warn({ err }, 'job failed');
      await monitor
        ?.failed(definition.name, err, ms)
        .catch((e) => logger.warn({ err: e }, 'job monitor failed'));
      throw err; // pg-boss records the failure and retries per queue policy
    }
  }

  /** Runs a registered job right here, outside the queue (CLI, tests). Monitored like a queued run. */
  async runNow(name: string, data: object = {}): Promise<void> {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`Unknown job "${name}"`);
    await runWithContext({ requestId: `job-${newRequestId()}`, job: name }, () =>
      this.runOne(definition, 'manual', data),
    );
  }

  /** Enqueues a job now (e.g. "check this account" after the user changed it). */
  async send(name: string, data: object = {}): Promise<string | null> {
    if (!this.boss) throw new Error('The job queue is not running');
    if (!this.definitions.has(name)) throw new Error(`Unknown job "${name}"`);
    return this.boss.send(name, data);
  }

  async stop(): Promise<void> {
    const boss = this.boss;
    this.boss = undefined;
    await boss?.stop({ graceful: true, timeout: 8000 });
  }
}
