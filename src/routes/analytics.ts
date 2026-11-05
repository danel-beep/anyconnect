import type { MiddlewareHandler } from 'hono';
import { clientIp, readCookie } from '../web/http.js';
import { type AppContext, type AppEnv, SESSION_COOKIE } from './context.js';

/** Paths that are never counted: the admin panel, machine endpoints and the hub's own files. */
const SKIP =
  /^\/(?:admin|api|mcp|hooks|oauth\/(?:token|register|revoke)|assets|\.well-known|healthz|readyz)(?:\/|$)/;

/** Text responses a crawler reads for content (pages, robots.txt, llms.txt, sitemaps, feeds). */
const CRAWLED_TYPES = /^(?:text\/(?:html|plain|markdown)|application\/(?:xml|rss\+xml|atom\+xml))/i;

/** Plain request values for the analytics layer (`src/analytics/`), which knows nothing of Hono. */
export function analyticsRequest(c: AppContext) {
  const s = c.get('services');
  return {
    path: c.req.path,
    query: (name: string) => c.req.query(name),
    header: (name: string) => c.req.header(name),
    ip: clientIp(c, s.config.trustProxy),
    known: Boolean(readCookie(c, SESSION_COOKIE, { secure: s.config.secureCookies })),
  };
}

/**
 * Counts every page the hub served: an HTML 200 answer to a GET that is not a prefetch. Runs after
 * the page is rendered and only hands plain values to an in-memory buffer, so it adds no database
 * work and no waiting to the request. Crawlers are counted per family, for every text they read.
 */
export function pageAnalytics(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const analytics = c.get('services').analytics;
    if (!analytics.enabled || c.req.method !== 'GET' || c.res.status !== 200 || SKIP.test(c.req.path)) return;
    const type = c.res.headers.get('content-type') ?? '';
    if (!CRAWLED_TYPES.test(type)) return;
    try {
      if (!type.startsWith('text/html')) {
        analytics.crawlerHit(c.req.header('user-agent'));
        return;
      }
      // Speculative loads (link prefetch, prerender) are not views until the page is shown.
      const purpose = `${c.req.header('sec-purpose') ?? ''} ${c.req.header('purpose') ?? ''}`;
      if (/prefetch|prerender/i.test(purpose)) return;
      // A live update (`data-poll` in site.js) re-reads a page the user is already on.
      if (c.req.header('x-live-update')) return;
      analytics.pageView(analyticsRequest(c));
    } catch (error) {
      c.get('services').ops.errors.capture(error, { source: 'analytics' });
    }
  };
}
