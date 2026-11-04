import type { RateLimitSpec } from '../../connectors/sdk.js';
import type { RateLimiter } from '../../lib/rate-limit.js';
import { type CallContext, type Middleware, unitKey, unitLabel } from '../executor.js';
import { type ExecResult, errorResult } from '../result.js';

const TRANSIENT = new Set(['rate_limited', 'upstream']);

export interface LimitsOptions {
  rateLimiter: RateLimiter;
  /** Longest the hub waits by itself (for a free slot or before a retry) instead of failing. */
  maxWaitMs?: number;
  /** Retries of transient failures; only for idempotent actions, so nothing is done twice. */
  maxRetries?: number;
  /** Base delay of the exponential backoff. */
  backoffMs?: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Keeps calls within the service limits a connector declares (per account, connector-wide and per
 * action), waits briefly for a free slot instead of failing, and retries transient upstream
 * failures of idempotent actions with backoff — so the AI does not spend turns on retries.
 */
export function limitsStage(options: LimitsOptions): Middleware {
  const maxWaitMs = options.maxWaitMs ?? 5_000;
  const maxRetries = options.maxRetries ?? 2;
  const backoffMs = options.backoffMs ?? 500;

  const acquire = async (call: CallContext, key: string, spec: RateLimitSpec): Promise<ExecResult | null> => {
    const windowMs = spec.perSeconds * 1000;
    let slot = options.rateLimiter.consume(key, spec.requests, windowMs);
    if (slot.allowed) return null;
    const waitMs = slot.retryAfterSeconds * 1000;
    if (waitMs <= maxWaitMs && Date.now() + waitMs < call.deadline) {
      await sleep(waitMs, call.signal);
      slot = options.rateLimiter.consume(key, spec.requests, windowMs);
      if (slot.allowed) return null;
    }
    call.audit.outcome = 'rate_limited';
    return errorResult(
      `Too many calls to ${call.connector.name} for ${unitLabel(call)} (limit ${spec.requests} per ${spec.perSeconds} s). Retry after ${slot.retryAfterSeconds} s.`,
      'rate_limited',
      slot.retryAfterSeconds,
    );
  };

  return async (call, next) => {
    if (call.connector.rateLimit) {
      const denied = await acquire(call, `svc:${unitKey(call)}`, call.connector.rateLimit);
      if (denied) return denied;
    }
    if (call.action.rateLimit) {
      const denied = await acquire(call, `act:${unitKey(call)}:${call.action.name}`, call.action.rateLimit);
      if (denied) return denied;
    }

    let result = await next();
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const kind = result.error?.kind;
      if (!result.isError || !kind || !TRANSIENT.has(kind) || !call.meta.idempotent) break;
      const delay = result.error?.retryAfterSeconds
        ? result.error.retryAfterSeconds * 1000
        : backoffMs * 2 ** (attempt - 1);
      if (delay > maxWaitMs || Date.now() + delay + 1_000 >= call.deadline || call.signal.aborted) break;
      await sleep(delay, call.signal);
      if (call.signal.aborted) break;
      call.audit.retries = attempt;
      result = await next();
    }
    return result;
  };
}
