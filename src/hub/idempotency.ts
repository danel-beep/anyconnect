import type { ExecResult } from './result.js';

export type Claim =
  | { state: 'new' }
  /** An identical call is running right now; resolves with its result. */
  | { state: 'pending'; result: Promise<ExecResult> }
  | { state: 'done'; result: ExecResult; completedAt: number; expiresAt: number };

/**
 * Remembers recent non-idempotent writes by a hash of (workspace, account, action, input), so an
 * accidental repeat (an AI retry after a timeout, a duplicated batch entry) does not send the same
 * email twice. Only successful calls are remembered; a failed call can be retried right away.
 */
export interface IdempotencyStore {
  claim(key: string): Promise<Claim>;
  complete(key: string, result: ExecResult, ttlMs: number): Promise<void>;
  release(key: string, result: ExecResult): Promise<void>;
}

interface Entry {
  state: 'pending' | 'done';
  result?: ExecResult;
  completedAt?: number;
  expiresAt: number;
  waiters: Array<(result: ExecResult) => void>;
}

/**
 * In-process store: correct for one instance (today's deployment). With several instances it moves
 * to Postgres behind the same interface, like `RateLimiter`.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly options: { maxEntries?: number; pendingTimeoutMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async claim(key: string): Promise<Claim> {
    const now = this.now();
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > now) {
      if (entry.state === 'done') {
        return {
          state: 'done',
          result: entry.result!,
          completedAt: entry.completedAt!,
          expiresAt: entry.expiresAt,
        };
      }
      return { state: 'pending', result: new Promise((resolve) => entry.waiters.push(resolve)) };
    }
    this.sweep(now);
    this.entries.set(key, {
      state: 'pending',
      expiresAt: now + (this.options.pendingTimeoutMs ?? 15 * 60_000),
      waiters: [],
    });
    return { state: 'new' };
  }

  async complete(key: string, result: ExecResult, ttlMs: number): Promise<void> {
    const entry = this.entries.get(key);
    const now = this.now();
    this.entries.set(key, { state: 'done', result, completedAt: now, expiresAt: now + ttlMs, waiters: [] });
    for (const resolve of entry?.waiters ?? []) resolve(result);
  }

  async release(key: string, result: ExecResult): Promise<void> {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    for (const resolve of entry?.waiters ?? []) resolve(result);
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
    const max = this.options.maxEntries ?? 10_000;
    while (this.entries.size >= max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
