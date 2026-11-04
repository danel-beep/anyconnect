/**
 * Circuit breaker per key (one connected account). After `threshold` consecutive transient
 * failures the circuit opens: calls fail at once for `openMs` instead of each waiting for the
 * service's timeouts. Then one trial call goes through (half-open): success closes the circuit,
 * failure opens it again for twice as long (up to `maxOpenMs`).
 *
 * In memory, like `RateLimiter`: each instance learns on its own, which is enough to stop an AI
 * from spending minutes on a service that is down. Moves to shared storage behind the same
 * interface if the hub runs many instances.
 */
export interface CircuitOptions {
  threshold?: number;
  openMs?: number;
  maxOpenMs?: number;
  now?: () => number;
}

export type CircuitDecision =
  | { allowed: true; trial: boolean }
  | { allowed: false; retryAfterSeconds: number; failures: number };

interface Entry {
  failures: number;
  openUntil: number;
  /** How long the circuit opens next time (doubles on every failed trial). */
  openMs: number;
  trialRunning: boolean;
}

export class CircuitBreaker {
  private readonly entries = new Map<string, Entry>();
  private readonly threshold: number;
  private readonly openMs: number;
  private readonly maxOpenMs: number;
  private readonly now: () => number;

  constructor(options: CircuitOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.openMs = options.openMs ?? 30_000;
    this.maxOpenMs = options.maxOpenMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /** May a call go out now? */
  check(key: string): CircuitDecision {
    const entry = this.entries.get(key);
    if (!entry || entry.failures < this.threshold) return { allowed: true, trial: false };
    const now = this.now();
    if (now < entry.openUntil || entry.trialRunning) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.openUntil - now) / 1000)),
        failures: entry.failures,
      };
    }
    entry.trialRunning = true;
    return { allowed: true, trial: true };
  }

  success(key: string): void {
    this.entries.delete(key);
  }

  failure(key: string): void {
    const now = this.now();
    const entry = this.entries.get(key) ?? {
      failures: 0,
      openUntil: 0,
      openMs: this.openMs,
      trialRunning: false,
    };
    entry.failures += 1;
    if (entry.trialRunning) {
      // The trial failed: open again, for longer.
      entry.trialRunning = false;
      entry.openMs = Math.min(entry.openMs * 2, this.maxOpenMs);
      entry.openUntil = now + entry.openMs;
    } else if (entry.failures === this.threshold) {
      entry.openUntil = now + entry.openMs;
    }
    this.entries.set(key, entry);
  }

  /** A call that ended neither way (cancelled, refused before reaching the service). */
  release(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.trialRunning = false;
  }
}
