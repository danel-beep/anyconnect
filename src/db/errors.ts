import { DrizzleQueryError } from 'drizzle-orm';

/**
 * Recognises failures that mean "the database cannot be reached right now" (it restarts, the
 * network to it failed, the pool has no free connection) as opposed to a bug or bad data. Callers
 * answer those as a temporary outage: HTTP 503 with Retry-After, a "try again in a minute" for the
 * AI, a retry for background work. See docs/OPERATIONS.md ("Сбой базы данных").
 */

/** SQLSTATE classes and codes: connection exceptions, shutdowns, too many connections. */
const UNAVAILABLE_CODES = new Set([
  '57P01', // admin_shutdown (restart, failover)
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (starting up, recovery)
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
]);

/** Socket-level errors (Node's `code`). */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** node-postgres and pg-pool report these as plain errors without a code. */
const MESSAGES = [
  /^Connection terminated/i, // "…unexpectedly", "…due to connection timeout"
  /^timeout exceeded when trying to connect/i, // the pool had no free connection in time
  /^Query read timeout/i, // `query_timeout` passed: the connection is presumed dead
  /is not queryable/i, // a client that already saw a connection error
  /^Client was closed and is not queryable/i,
  /^Cannot use a pool after calling end/i, // shutting down
];

export function isDatabaseUnavailable(error: unknown): boolean {
  return unavailable(error, 0, true);
}

/**
 * Socket error codes count only where they come from the driver: the error itself (a pool that
 * cannot connect) or the cause of a query error. A connector's failed `fetch` carries the same
 * codes one level down, and that is the service being down, not the database.
 */
function unavailable(error: unknown, depth: number, socketCodes: boolean): boolean {
  if (!error || typeof error !== 'object' || depth > 4) return false;
  const { code, message, cause } = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof code === 'string') {
    if (UNAVAILABLE_CODES.has(code) || /^08[0-9A-Z]{3}$/.test(code)) return true;
    if (socketCodes && NETWORK_CODES.has(code)) return true;
  }
  if (typeof message === 'string' && MESSAGES.some((m) => m.test(message))) return true;
  // A connection refused on every address of the host arrives as one AggregateError.
  if (socketCodes && error instanceof AggregateError) {
    if (error.errors.some((inner) => unavailable(inner, depth + 1, true))) return true;
  }
  // Drizzle wraps driver errors ("Failed query: …") with the original as `cause`.
  const fromDriver = error instanceof DrizzleQueryError;
  return unavailable(cause, depth + 1, fromDriver);
}

/** What the hub tells an HTTP client while the database is unavailable (seconds). */
export const DATABASE_RETRY_AFTER_SECONDS = 30;
