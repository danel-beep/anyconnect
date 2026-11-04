import { PgBoss } from 'pg-boss';
import type { Logger } from '../logger.js';
import { newRequestId, runWithContext } from '../ops/context.js';
import type { JobMonitor } from './runs.js';

/**
 * Background jobs on Postgres (pg-boss): no extra infrastructure, jobs survive restarts, and with
 * several instances each job runs once. Used for account health checks today; schedules, triggers
 * and long-running work of later stages are added as more `JobDefinition`s.
 */

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
  pollingIntervalSeconds?: number;
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
    const boss = new PgBoss({
      connectionString: this.options.connectionString,
      schema: this.options.schema ?? 'pgboss',
      application_name: 'manyplug-jobs',
    });
    boss.on('error', (err) => this.options.logger.warn({ err }, 'job queue error'));
    await boss.start();
    this.boss = boss;
    for (const definition of this.definitions.values()) {
      // Singleton: at most one active job per queue, so a slow run never overlaps the next tick.
      await boss.createQueue(definition.name, { policy: definition.cron ? 'singleton' : 'standard' });
      if (definition.cron) await boss.schedule(definition.name, definition.cron, {}, { tz: 'UTC' });
      await boss.work<object>(
        definition.name,
        { pollingIntervalSeconds: this.options.pollingIntervalSeconds ?? 5 },
        async (jobs) => {
          for (const job of jobs) {
            await runWithContext({ requestId: `job-${newRequestId()}`, job: definition.name }, () =>
              this.runOne(definition, job.id, job.data),
            );
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
