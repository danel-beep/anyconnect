import type { MiddlewareHandler } from 'hono';
import { isProbe } from '../ops/request-log.js';
import type { AppEnv } from './context.js';

/**
 * Redirects requests that arrive on a former public host (see LEGACY_PUBLIC_URLS) to the same path
 * on the canonical one. Pages and links get a permanent 301; other methods get 308, which keeps the
 * method and body, so AI apps still configured with the old MCP URL reach the new one (they are asked
 * to sign in again, because tokens are bound to the URL they were issued for).
 */
export function canonicalHost(publicUrl: string, legacyHosts: readonly string[]): MiddlewareHandler<AppEnv> {
  const legacy = new Set(legacyHosts.map((h) => h.toLowerCase()));
  return async (c, next) => {
    // The platform probes health on whatever host it likes: those never redirect.
    if (legacy.size === 0 || isProbe(c.req.path)) return next();
    const host = (c.req.header('host') ?? '').toLowerCase();
    if (!legacy.has(host)) return next();
    const url = new URL(c.req.url);
    const target = `${publicUrl}${url.pathname}${url.search}`;
    const method = c.req.method;
    return c.redirect(target, method === 'GET' || method === 'HEAD' ? 301 : 308);
  };
}
