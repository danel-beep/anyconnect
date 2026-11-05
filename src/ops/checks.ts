import { scrubSecrets } from './scrub.js';

/**
 * Health checks of the hub itself (not of connected accounts, see `core/health.ts`). Each part of
 * the system registers a named check; `/readyz`, the admin System page and the public status page
 * all read the same report. A new component (a cache, a second queue, an external dependency) is
 * one more `HealthCheck`.
 */

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface CheckResult {
  status: HealthStatus;
  /** Short, secret-free explanation ("12 ms", "3 jobs late"). */
  detail?: string;
}

export interface HealthCheck {
  /** Stable id, e.g. `database`. */
  name: string;
  /** A failing critical check makes the instance not ready (`/readyz` → 503). */
  critical: boolean;
  /**
   * Public components this check affects on the status page (the database affects the website
   * and the AI connections too); absent = internal only.
   */
  components?: readonly StatusComponent[];
  run(signal: AbortSignal): Promise<CheckResult>;
}

/** What visitors see on the status page; several checks can feed one component. */
export type StatusComponent = 'web' | 'mcp' | 'database' | 'jobs' | 'connections';

export interface CheckReport extends CheckResult {
  name: string;
  critical: boolean;
  components?: readonly StatusComponent[] | undefined;
  ms: number;
}

export interface HealthReport {
  status: HealthStatus;
  checks: CheckReport[];
  at: Date;
}

const RANK: Record<HealthStatus, number> = { ok: 0, degraded: 1, down: 2 };

export function worst(statuses: Iterable<HealthStatus>): HealthStatus {
  let result: HealthStatus = 'ok';
  for (const s of statuses) if (RANK[s] > RANK[result]) result = s;
  return result;
}

export class HealthRegistry {
  private readonly checks = new Map<string, HealthCheck>();
  /** Latest report per kind (all checks / critical only). */
  private readonly cached = new Map<boolean, { report: HealthReport; at: number }>();

  register(check: HealthCheck): this {
    if (this.checks.has(check.name)) throw new Error(`Health check "${check.name}" is already registered`);
    this.checks.set(check.name, check);
    return this;
  }

  get names(): string[] {
    return [...this.checks.keys()];
  }

  /**
   * Runs the checks in parallel, each with its own timeout (a hung check reports `down`, it does
   * not hang the probe). Results are cached for `cacheMs` so frequent probes stay cheap.
   */
  async run(
    options: { criticalOnly?: boolean; timeoutMs?: number; cacheMs?: number } = {},
  ): Promise<HealthReport> {
    const criticalOnly = options.criticalOnly ?? false;
    const cacheMs = options.cacheMs ?? 0;
    const hit = this.cached.get(criticalOnly);
    if (cacheMs > 0 && hit && Date.now() - hit.at < cacheMs) return hit.report;
    const selected = [...this.checks.values()].filter((c) => !criticalOnly || c.critical);
    const timeoutMs = options.timeoutMs ?? 3000;
    const checks = await Promise.all(selected.map((check) => runOne(check, timeoutMs)));
    const report: HealthReport = {
      // Only critical checks can take the whole instance down; others degrade it.
      status: worst(checks.map((c) => (c.critical || c.status === 'ok' ? c.status : 'degraded'))),
      checks,
      at: new Date(),
    };
    this.cached.set(criticalOnly, { report, at: Date.now() });
    return report;
  }
}

async function runOne(check: HealthCheck, timeoutMs: number): Promise<CheckReport> {
  const started = performance.now();
  const signal = AbortSignal.timeout(timeoutMs);
  const base = { name: check.name, critical: check.critical, components: check.components };
  try {
    const result = await Promise.race([
      check.run(signal),
      new Promise<CheckResult>((resolve) =>
        signal.addEventListener(
          'abort',
          () => resolve({ status: 'down', detail: `no answer in ${timeoutMs} ms` }),
          {
            once: true,
          },
        ),
      ),
    ]);
    return { ...base, ...result, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      ...base,
      status: 'down',
      detail: scrubSecrets((error as Error)?.message ?? 'failed', 200),
      ms: Math.round(performance.now() - started),
    };
  }
}
