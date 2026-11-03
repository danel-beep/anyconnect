/**
 * Fixed-window, in-memory rate limiter. Good enough for one instance; when the hub runs on several
 * instances this should move to Postgres or Redis behind the same interface.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  /** Returns true when the action is allowed. */
  consume(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return { allowed: entry.count <= limit, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }

  close(): void {
    clearInterval(this.sweeper);
  }
}
