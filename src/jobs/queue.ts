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
/** How long a run may take unless its job says otherwise. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** What pg-boss waits past a job's own deadline before it takes the job back. */
const EXPIRE_MARGIN_SECONDS = 30;

export interface JobContext {
  logger: Logger;
  /**
   * Aborted when the run must end: its time is up (`timeoutMs`) or the process is shutting down.
   * Long jobs pass it to what they wait for and stop between items, so no run outlives its
   * deadline and a deploy does not wait for (or cut through) a pass over every account.
   */
  signal: AbortSignal;
  /** True once the process is shutting down (as opposed to the run's time being up). */
  stopping(): boolean;
  /** 0 for the first try of this job, 1 for its first retry… */
  attempt: number;
}

/** How a job is enqueued (see {@link JobQueue.send}). */
export interface SendOptions {
  /**
   * Whose work this is (a workspace id). With the job's `groupConcurrency`, one group takes only
   * that many of the job's slots, so a busy workspace cannot hold up everyone else's runs.
   */
  group?: string;
  /**
   * At most one job with this key is accepted per `dedupeSeconds` window (default one hour): a
   * second `send` in the window is dropped. For "make sure this is queued" calls that may repeat.
   */
  dedupeKey?: string;
  dedupeSeconds?: number;
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
  /**
   * How many runs of this job one process works on at a time (default 1). For jobs that mostly wait
   * for another service (an AI answering a trigger), so one slow run does not hold up the queue.
   */
  concurrency?: number;
  /** Of `concurrency`, how many runs one group (see {@link SendOptions.group}) may take at a time. */
  groupConcurrency?: number;
  /**
   * How long one run may take (default 10 minutes). When it is up, `ctx.signal` aborts; shortly
   * after, the queue gives the job up as failed. Every job has a deadline: a run that hangs on a
   * service would otherwise block its queue (recurring jobs never overlap) until a restart.
   */
  timeoutMs?: number;
  /** How many times a failed run is tried again (default 2). */
  retryLimit?: number;
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
  /** Aborted by `stop()`: tells running jobs to wrap up. */
  private shutdown = new AbortController();

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
    this.shutdown = new AbortController();
    for (const definition of this.definitions.values()) {
      const limits = {
        notify: true,
        retryDelay,
        // pg-boss aborts the run's signal and fails the job at this point; the job's own deadline
        // comes first, so a run normally ends by itself and reports what it got done.
        expireInSeconds: Math.ceil(timeoutOf(definition) / 1000) + EXPIRE_MARGIN_SECONDS,
        ...(definition.retryLimit !== undefined ? { retryLimit: definition.retryLimit } : {}),
      };
      // Singleton: at most one active job per queue, so a slow run never overlaps the next tick.
      await boss.createQueue(definition.name, {
        policy: definition.cron ? 'singleton' : 'standard',
        ...limits,
      });
      // createQueue leaves an existing queue as it is: update queues made by older releases.
      await boss.updateQueue(definition.name, limits);
      if (definition.cron) await boss.schedule(definition.name, definition.cron, {}, { tz: 'UTC' });
      let workerId: string | undefined;
      workerId = await boss.work<object>(
        definition.name,
        {
          pollingIntervalSeconds,
          notifyPollingIntervalSeconds: Math.max(this.options.backstopSeconds ?? 300, pollingIntervalSeconds),
          ...(definition.concurrency && definition.concurrency > 1
            ? { localConcurrency: definition.concurrency }
            : {}),
          ...(definition.groupConcurrency ? { localGroupConcurrency: definition.groupConcurrency } : {}),
        },
        async (jobs) => {
          try {
            for (const job of jobs) {
              await runWithContext({ requestId: `job-${newRequestId()}`, job: definition.name }, () =>
                this.runOne(definition, job.id, job.data, { signal: job.signal, attempt: job.retryCount }),
              );
            }
          } catch (err) {
            // A failed job goes back to the queue for a retry without a NOTIFY: look again when the
            // retry is due instead of after the backstop.
            // pg-boss sets the retry time by the database clock after this handler returns: wake
            // twice, so saving the failure or a small clock difference cannot push it to the backstop.
            for (const extraMs of [2_000, 10_000]) {
              setTimeout(() => workerId && boss.notifyWorker(workerId), retryDelay * 1000 + extraMs).unref();
            }
            throw err;
          }
        },
      );
      // Jobs the previous process gave back when it shut down become due again after the retry
      // delay, without a NOTIFY: look once then instead of at the backstop.
      setTimeout(
        () => workerId && this.boss === boss && boss.notifyWorker(workerId),
        retryDelay * 1000 + 2_000,
      ).unref();
    }
    this.options.logger.info({ jobs: this.names }, 'background jobs started');
  }

  private async runOne(
    definition: JobDefinition<any>,
    jobId: string,
    data: object,
    run: { signal?: AbortSignal; attempt?: number } = {},
  ): Promise<void> {
    const logger = this.options.logger.child({ job: definition.name, jobId });
    const monitor = this.options.monitor;
    const started = Date.now();
    const shutdown = this.shutdown.signal;
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeoutOf(definition)),
      shutdown,
      ...(run.signal ? [run.signal] : []),
    ]);
    const ctx: JobContext = { logger, signal, stopping: () => shutdown.aborted, attempt: run.attempt ?? 0 };
    // Monitoring is best effort: a failed status write must not fail the job itself.
    await monitor?.started(definition.name).catch((err) => logger.warn({ err }, 'job monitor failed'));
    try {
      await definition.run(data, ctx);
      const ms = Date.now() - started;
      logger.debug({ ms }, 'job done');
      await monitor
        ?.succeeded(definition.name, ms)
        .catch((err) => logger.warn({ err }, 'job monitor failed'));
    } catch (err) {
      const ms = Date.now() - started;
      // A run cut short by a shutdown is not a fault: the queue hands it to the next process.
      if (shutdown.aborted) logger.info({ ms }, 'job interrupted by shutdown, it will be retried');
      else if (this.options.onError) this.options.onError(err, definition.name);
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
  async send(name: string, data: object = {}, options: SendOptions = {}): Promise<string | null> {
    if (!this.boss) throw new Error('The job queue is not running');
    if (!this.definitions.has(name)) throw new Error(`Unknown job "${name}"`);
    return this.boss.send(name, data, {
      ...(options.group ? { group: { id: options.group } } : {}),
      ...(options.dedupeKey
        ? { singletonKey: options.dedupeKey, singletonSeconds: options.dedupeSeconds ?? 3600 }
        : {}),
    });
  }

  /** Tells running jobs to wrap up (`ctx.signal`), waits for them a little, then stops the queue. */
  async stop(): Promise<void> {
    const boss = this.boss;
    this.boss = undefined;
    this.shutdown.abort();
    await boss?.stop({ graceful: true, timeout: 8000 });
  }
}

function timeoutOf(definition: JobDefinition<any>): number {
  return Math.max(1_000, definition.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}
