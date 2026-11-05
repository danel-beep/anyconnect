import { Hono } from 'hono';
import { AppError } from './lib/errors.js';
import { requestIdFrom, runWithContext } from './ops/context.js';
import { adminRoutes } from './routes/admin.js';
import { aiAppRoutes } from './routes/ai-apps.js';
import { apiRoutes } from './routes/api.js';
import { appRoutes } from './routes/app.js';
import { billingRoutes } from './routes/billing.js';
import { requestBodyLimit } from './routes/body-limit.js';
import { canonicalHost } from './routes/canonical-host.js';
import { confirmRoutes } from './routes/confirm.js';
import { connectRoutes } from './routes/connect.js';
import type { AppEnv } from './routes/context.js';
import { directoryRoutes } from './routes/directories.js';
import { hookRoutes } from './routes/hooks.js';
import { loginRoutes } from './routes/login.js';
import { mcpRoutes } from './routes/mcp.js';
import { oauthRoutes } from './routes/oauth.js';
import { savedLocale } from './routes/page-helpers.js';
import { profileRoutes } from './routes/profiles.js';
import { securityRoutes } from './routes/security.js';
import { seoRoutes } from './routes/seo.js';
import { siteRoutes } from './routes/site.js';
import { webRoutes } from './routes/web.js';
import type { Services } from './services.js';
import { pageSecurityHeaders } from './web/http.js';
import { DEFAULT_LOCALE, translator } from './web/i18n.js';
import { ErrorPage } from './web/pages.js';
import { LANG_PARAM, parseLocale } from './web/seo/urls.js';

export function createApp(services: Services) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const started = performance.now();
    // One id per request, in every log line and error report of it, and in the response header so
    // a user or a client can quote it.
    const requestId = requestIdFrom(c.req.header('x-request-id'));
    c.set('services', services);
    c.set('requestId', requestId);
    // ?lang= opens a page in that language for this request (search engines, shared links); the
    // RU/EN switch stores a choice in a cookie.
    const locale = parseLocale(c.req.query(LANG_PARAM)) ?? savedLocale(c) ?? DEFAULT_LOCALE;
    c.set('locale', locale);
    c.set('t', translator(locale));
    await runWithContext({ requestId }, async () => {
      await next();
      c.header('X-Request-Id', requestId);
      const path = c.req.path;
      const level = PROBES.has(path) ? 'debug' : 'info';
      services.logger[level](
        { method: c.req.method, path, status: c.res.status, ms: Math.round(performance.now() - started) },
        'request',
      );
    });
  });
  app.use('*', pageSecurityHeaders({ hsts: services.config.secureCookies }));
  app.use('*', canonicalHost(services.config.publicUrl, services.config.legacyHosts));
  app.use('*', requestBodyLimit(services.config.maxRequestBodyBytes));

  // Liveness: the process answers. Cheap on purpose (the platform restarts the instance when it
  // fails, which does not help when the database is down).
  app.get('/healthz', (c) => c.json({ status: 'ok', version: services.ops.release }));
  // Readiness: this instance can serve traffic (database reachable, schema current).
  app.get('/readyz', async (c) => {
    const report = await services.ops.health.run({ criticalOnly: true, cacheMs: 2000 });
    return c.json(
      {
        status: report.status === 'down' ? 'unavailable' : report.status,
        checks: Object.fromEntries(report.checks.map((x) => [x.name, x.status])),
      },
      report.status === 'down' ? 503 : 200,
    );
  });

  app.route('/', siteRoutes());
  app.route('/', seoRoutes());
  app.route('/', oauthRoutes());
  app.route('/', directoryRoutes());
  app.route('/', loginRoutes());
  app.route('/', securityRoutes());
  app.route('/', mcpRoutes());
  app.route('/', hookRoutes());
  app.route('/api/v1', apiRoutes());
  app.route('/', confirmRoutes());
  app.route('/', connectRoutes());
  app.route('/', appRoutes());
  app.route('/', profileRoutes());
  app.route('/', aiAppRoutes());
  app.route('/', adminRoutes());
  app.route('/', billingRoutes());
  app.route('/', webRoutes());

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/'))
      return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    if (!wantsHtml(c.req.header('accept'))) return c.text('Not found', 404);
    const t = c.get('t');
    return c.html(
      <ErrorPage
        t={t}
        lang={c.get('locale')}
        title={t('error.notFound')}
        message={t('error.notFoundText')}
      />,
      404,
    );
  });

  app.onError((error, c) => {
    if (error instanceof AppError) {
      if (c.req.path.startsWith('/api/')) {
        return c.json(
          {
            error: {
              code: error.code,
              message: error.message,
              ...(error.details ? { details: error.details } : {}),
            },
          },
          error.status as 400,
        );
      }
      return c.html(
        <ErrorPage t={c.get('t')} lang={c.get('locale')} message={error.message} />,
        error.status as 400,
      );
    }
    const ref = services.ops.errors.capture(error, {
      source: 'http',
      context: { method: c.req.method, path: routePath(c.req.path) },
    });
    if (c.req.path.startsWith('/api/'))
      return c.json({ error: { code: 'internal', message: `Internal error (ref ${ref})`, ref } }, 500);
    if (!wantsHtml(c.req.header('accept'))) return c.text(`Internal error (ref ${ref})`, 500);
    const t = c.get('t');
    return c.html(
      <ErrorPage
        t={t}
        lang={c.get('locale')}
        message={t('error.internal')}
        detail={t('error.reference', { ref })}
      />,
      500,
    );
  });

  return app;
}

const PROBES = new Set(['/healthz', '/readyz']);

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

/** Browsers ask for HTML; API clients and tools usually do not. */
const wantsHtml = (accept: string | undefined) => (accept ?? '').includes('text/html');
