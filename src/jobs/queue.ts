import { PgBoss } from 'pg-boss';
import type { Logger } from '../logger.js';

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
  run(data: TData, ctx: JobContext): Promise<void>;
}

export interface JobQueueOptions {
  connectionString: string;
  logger: Logger;
  /** Postgres schema of pg-boss's own tables. */
  schema?: string;
  pollingIntervalSeconds?: number;
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
            const logger = this.options.logger.child({ job: definition.name, jobId: job.id });
            const started = Date.now();
            try {
              await definition.run(job.data, { logger });
              logger.debug({ ms: Date.now() - started }, 'job done');
            } catch (err) {
              logger.warn({ err }, 'job failed');
              throw err; // pg-boss records the failure and retries per queue policy
            }
          }
        },
      );
    }
    this.options.logger.info({ jobs: this.names }, 'background jobs started');
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
