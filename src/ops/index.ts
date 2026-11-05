import type { AppConfig } from '../config.js';
import type { Database } from '../db/client.js';
import type { JobQueue } from '../jobs/queue.js';
import { JobRunStore } from '../jobs/runs.js';
import type { Logger } from '../logger.js';
import {
  connectionsCheck,
  databaseCheck,
  eventLoopCheck,
  jobsCheck,
  migrationsCheck,
  publicProbeCheck,
} from './builtin-checks.js';
import { HealthRegistry } from './checks.js';
import { PgErrorStore } from './error-store.js';
import { ErrorReporter } from './errors.js';
import { SentrySink } from './sentry.js';
import { StatusService } from './status.js';

/** Operations: error tracking, health checks, job run history. Wired once in `createServices`. */
export interface Ops {
  /** `0.1.0+abc1234`: the version and, on Render, the commit of the running build. */
  release: string;
  errors: ErrorReporter;
  /** The built-in error tracker (admin panel → Errors). */
  errorStore: PgErrorStore;
  health: HealthRegistry;
  jobRuns: JobRunStore;
  /** The public status page (samples every minute, uptime history, incidents). */
  status: StatusService;
  close(): Promise<void>;
}

export function createOps(deps: {
  config: AppConfig;
  version: string;
  logger: Logger;
  database: Database;
  /** Tests: talk to a fake Sentry. */
  sentryFetch?: typeof fetch;
  /** Tests: probe the public address with another fetch. */
  probeFetch?: typeof fetch;
}): Ops {
  const { config, logger, database } = deps;
  const release = config.ops.commit ? `${deps.version}+${config.ops.commit}` : deps.version;
  const errors = new ErrorReporter({ logger, release, environment: config.ops.environment });
  const errorStore = new PgErrorStore(database.db);
  errors.addSink(errorStore);
  if (config.ops.sentryDsn) {
    errors.addSink(
      new SentrySink(config.ops.sentryDsn, {
        ...(deps.sentryFetch ? { fetch: deps.sentryFetch } : {}),
        ...(config.ops.instance ? { serverName: config.ops.instance } : {}),
      }),
    );
  }
  const jobRuns = new JobRunStore(database.db);
  const loop = eventLoopCheck();
  const health = new HealthRegistry()
    .register(databaseCheck(database.pool))
    .register(migrationsCheck(database.pool))
    .register(loop)
    // Through the public address: what users and AI apps actually reach.
    .register(
      publicProbeCheck({
        name: 'public_web',
        components: ['web'],
        url: `${config.publicUrl}/healthz`,
        expect: [200],
        ...(deps.probeFetch ? { fetch: deps.probeFetch } : {}),
      }),
    )
    .register(
      publicProbeCheck({
        name: 'public_mcp',
        components: ['mcp'],
        url: config.mcpUrl,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
        },
        // Without a token: 401 (sign in first) or, with MCP_ANONYMOUS, an answer.
        expect: [200, 401],
        ...(deps.probeFetch ? { fetch: deps.probeFetch } : {}),
      }),
    );
  const status = new StatusService({ db: database.db, health });
  return {
    release,
    errors,
    errorStore,
    health,
    jobRuns,
    status,
    async close() {
      loop.stop();
      await errors.flush();
    },
  };
}

/** Reports built-in services that keep failing on their side (status page: connected services). */
export function watchConnections(
  ops: Ops,
  db: Database['db'],
  names: () => ReadonlyMap<string, string>,
): void {
  ops.health.register(connectionsCheck({ db, services: names }));
}

/** Registers the job check once the queue knows its jobs. */
export function watchJobs(ops: Ops, jobs: JobQueue): void {
  ops.health.register(jobsCheck({ definitions: () => jobs.definitionsList, runs: () => ops.jobRuns.list() }));
}
