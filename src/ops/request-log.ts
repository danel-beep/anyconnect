/**
 * How an HTTP request is described in the logs and in error reports. Pure, so the rules are easy
 * to test and to extend.
 *
 * The access-log line of a request ({@link requestLogLine}):
 * - Health probes (`/healthz`, `/readyz`) go to `debug`: the platform calls them all the time.
 * - A request slower than {@link SLOW_REQUEST_MS} goes to `warn` with `slow: true`, so slow pages
 *   and API calls can be found in the logs (Render Logs: search for `"slow":true`). Event streams
 *   (MCP over SSE) are timed until the response starts, so a long tool call does not count.
 * - Everything else is `info`.
 */

/** A request that took longer than this is slow (ms). */
export const SLOW_REQUEST_MS = 2000;

const PROBES = new Set(['/healthz', '/readyz']);

export function isProbe(path: string): boolean {
  return PROBES.has(path);
}

export interface RequestLogInput {
  method: string;
  path: string;
  status: number;
  ms: number;
}

export function requestLogLine(request: RequestLogInput): {
  level: 'debug' | 'info' | 'warn';
  fields: RequestLogInput & { slow?: true };
} {
  if (isProbe(request.path)) return { level: 'debug', fields: request };
  if (request.ms >= SLOW_REQUEST_MS) return { level: 'warn', fields: { ...request, slow: true } };
  return { level: 'info', fields: request };
}

/**
 * The path for error grouping: ids in it (`/admin/users/usr_01…`, `/connect/x/acc_…`) become `:id`,
 * so one bug on many pages is one group.
 */
export function routePath(path: string): string {
  return path
    .split('/')
    .map((part) =>
      /^[a-z]{2,5}_[0-9a-z]{10,}$/.test(part) || /^[0-9a-f-]{16,}$/i.test(part) || /^\d+$/.test(part)
        ? ':id'
        : part,
    )
    .join('/')
    .slice(0, 200);
}
