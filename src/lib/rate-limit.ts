import { createHash } from 'node:crypto';
import net from 'node:net';

/** Keys longer than this are hashed, so client-supplied parts (an email address) cannot grow memory. */
const MAX_KEY_LENGTH = 128;
/** Counters kept at most; past it the oldest go first (they are the closest to expiring anyway). */
const MAX_ENTRIES = 100_000;

/**
 * Fixed-window, in-memory rate limiter. Good enough for one instance; when the hub runs on several
 * instances this should move to Postgres or Redis behind the same interface.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly maxEntries = MAX_ENTRIES) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  /** Returns true when the action is allowed. */
  consume(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const id = boundedKey(key);
    let entry = this.hits.get(id);
    if (!entry || entry.resetAt <= now) {
      if (!entry) this.makeRoom(now);
      entry = { count: 0, resetAt: now + windowMs };
      this.hits.set(id, entry);
    }
    entry.count += 1;
    return { allowed: entry.count <= limit, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  }

  reset(key: string): void {
    this.hits.delete(boundedKey(key));
  }

  /** Number of live counters (for tests and metrics). */
  get size(): number {
    return this.hits.size;
  }

  private makeRoom(now: number): void {
    if (this.hits.size < this.maxEntries) return;
    this.sweep(now);
    for (const key of this.hits.keys()) {
      if (this.hits.size < this.maxEntries) break;
      this.hits.delete(key);
    }
  }

  private sweep(now = Date.now()): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }

  close(): void {
    clearInterval(this.sweeper);
  }
}

function boundedKey(key: string): string {
  return key.length <= MAX_KEY_LENGTH ? key : `#${createHash('sha256').update(key).digest('base64url')}`;
}

/**
 * The part of a client address that per-IP limits count: the address itself for IPv4, its /64 for
 * IPv6 (one subscriber usually gets a whole /64, so counting single addresses would not limit).
 */
export function rateLimitIp(address: string): string {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0]!;
  const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1]!;
  if (net.isIP(bare) !== 6) return bare;
  const halves = bare.toLowerCase().split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const groups = [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  return `${groups
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}
