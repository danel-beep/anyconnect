import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

/**
 * Per-request context that follows the async work of one HTTP request (or one background job):
 * every log line and every captured error carries the same `requestId`, so one request can be
 * traced through the logs, the error tracker and the reference a user reports ("ref …").
 */
export interface OpsContext {
  requestId: string;
  /** Background job name when the work is a job run. */
  job?: string;
}

const storage = new AsyncLocalStorage<OpsContext>();

export function runWithContext<T>(context: OpsContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): OpsContext | undefined {
  return storage.getStore();
}

/** A short random id (16 hex chars), used for request ids and error references. */
export function newRequestId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * The id of an incoming request: the caller's `X-Request-Id` when it looks like an id (a proxy or
 * a client tracing its own calls), otherwise a new one. Anything else is ignored so a client cannot
 * inject text into the logs.
 */
export function requestIdFrom(header: string | undefined): string {
  return header && /^[A-Za-z0-9._:-]{6,100}$/.test(header) ? header : newRequestId();
}
