import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from './context.js';

/**
 * Endpoints anyone can post to before signing in (sign-in, OAuth, webhooks): small forms and JSON,
 * so they get a tight limit. Everything else (MCP, the API, dashboard forms with manifests) gets the
 * configured one.
 */
const SMALL_BODY_PREFIXES = [
  '/login',
  '/logout',
  '/oauth/',
  '/security/',
  '/telegram/',
  '/billing/webhook/',
  '/confirm/',
  '/grants/',
];
export const SMALL_BODY_BYTES = 256 * 1024;

/**
 * Rejects request bodies over the limit with 413 before a handler reads them, whether the client
 * sent a Content-Length or streamed the body: without it one request could fill the memory.
 */
export function requestBodyLimit(maxBytes: number): MiddlewareHandler<AppEnv> {
  const tooLarge = (c: Parameters<MiddlewareHandler<AppEnv>>[0]) =>
    c.req.path.startsWith('/api/') || c.req.path.startsWith('/mcp')
      ? c.json({ error: { code: 'payload_too_large', message: 'Request body too large' } }, 413)
      : c.text('Request body too large', 413);
  const small = bodyLimit({ maxSize: Math.min(SMALL_BODY_BYTES, maxBytes), onError: tooLarge });
  const large = bodyLimit({ maxSize: maxBytes, onError: tooLarge });
  return (c, next) =>
    SMALL_BODY_PREFIXES.some((prefix) => c.req.path.startsWith(prefix)) ? small(c, next) : large(c, next);
}
