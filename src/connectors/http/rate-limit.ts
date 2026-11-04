import { ConnectorError } from '../sdk.js';

export interface RateLimit {
  /** Requests allowed per window. */
  requests: number;
  perSeconds: number;
}

/**
 * Token bucket per key (normally one per account), so a connector stays under a service's limits
 * instead of hitting 429s. Short waits are absorbed; a long wait becomes a `rate_limited` error with
 * a retry hint for the AI. In-memory: each hub instance keeps its own buckets.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(private readonly options: { maxWaitMs?: number; maxKeys?: number } = {}) {}

  async acquire(key: string, limit: RateLimit, signal?: AbortSignal): Promise<void> {
    const capacity = Math.max(1, limit.requests);
    const refillPerMs = capacity / (limit.perSeconds * 1000);
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= (this.options.maxKeys ?? 10_000)) this.buckets.clear();
      bucket = { tokens: capacity, updatedAt: now };
      this.buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
    bucket.updatedAt = now;
    bucket.tokens -= 1;
    if (bucket.tokens >= 0) return;
    const waitMs = Math.ceil(-bucket.tokens / refillPerMs);
    if (waitMs > (this.options.maxWaitMs ?? 10_000)) {
      bucket.tokens += 1; // the request is not made, give the token back
      throw new ConnectorError('rate_limited', 'Too many requests to this service right now', {
        retryAfterSeconds: Math.ceil(waitMs / 1000),
      });
    }
    await sleep(waitMs, signal);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
