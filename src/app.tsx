import { type Context, Hono } from 'hono';
import { compress } from 'hono/compress';
import { BRAND } from './brand.js';
import { VaultLockedError } from './core/vaults.js';
import { DATABASE_RETRY_AFTER_SECONDS, isDatabaseUnavailable } from './db/errors.js';
import { AppError } from './lib/errors.js';
import { requestIdFrom, runWithContext } from './ops/context.js';
import { adminRoutes } from './routes/admin.js';
import { aiAppRoutes } from './routes/ai-apps.js';
import { pageAnalytics } from './routes/analytics.js';
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
import { messengerLoginRoutes } from './routes/messenger-login.js';
import { oauthRoutes } from './routes/oauth.js';
import { savedLocale } from './routes/page-helpers.js';
import { profileRoutes } from './routes/profiles.js';
import { referralCapture } from './routes/referral.js';
import { securityRoutes } from './routes/security.js';
import { seoRoutes } from './routes/seo.js';
import { siteRoutes } from './routes/site.js';
import { teamRoutes } from './routes/team.js';
import { telegramConnectRoutes } from './routes/telegram-connect.js';
import { triggerRoutes } from './routes/triggers.js';
import { webRoutes } from './routes/web.js';
import { webVault } from './routes/web-vault.js';
import type { Services } from './services.js';
import { pageSecurityHeaders } from './web/http.js';
import { DEFAULT_LOCALE, translator } from './web/i18n.js';
import { ErrorPage } from './web/pages.js';
import { LANG_PARAM, parseLocale } from './web/seo/urls.js';

const COMPRESSIBLE =
  /^(?:text\/(?:html|css|plain|javascript)|application\/(?:javascript|xml|rss\+xml))(?:[;\s]|$)/i;

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
  app.use('*', referralCapture());
  app.use('*', requestBodyLimit(services.config.maxRequestBodyBytes));
  // Pages, styles, scripts, feeds and llms.txt go out gzipped (a page shrinks to about a fifth).
  // MCP, API and OAuth responses are JSON or event streams and stay as they are.
  app.use('*', compress({ encoding: 'gzip', contentTypeFilter: COMPRESSIBLE }));
  // Counts served pages into an in-memory buffer after they are rendered (docs/ANALYTICS.md).
  app.use('*', pageAnalytics());
  // Opens (or, the first time, creates) the signed-in user's vault from this browser's device key.
  app.use('*', webVault());

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
  app.route('/', messengerLoginRoutes());
  app.route('/', telegramConnectRoutes());
  app.route('/', appRoutes());
  app.route('/', teamRoutes());
  app.route('/', profileRoutes());
  app.route('/', triggerRoutes());
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

  app.onError((thrown, c) => {
    // A sealed account this request cannot open is the user's situation, not a server fault: any
    // path that misses its own check still answers 423 with the actionable message.
    const error =
      thrown instanceof VaultLockedError ? new AppError(423, 'vault_locked', thrown.message) : thrown;
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
    if (isDatabaseUnavailable(error)) return unavailable(c);
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

/**
 * The database cannot be reached (restart, network): a temporary outage, not a bug. 503 with
 * Retry-After tells browsers, AI apps and OAuth clients to come back rather than give up (a
 * token endpoint answering 500 or 400 can make an AI app drop its sign-in).
 */
function unavailable(c: Context<AppEnv>) {
  const headers = { 'Retry-After': String(DATABASE_RETRY_AFTER_SECONDS), 'Cache-Control': 'no-store' };
  const message = `${BRAND.name} is temporarily unavailable. Try again in a minute.`;
  if (c.req.path.startsWith('/api/'))
    return c.json({ error: { code: 'unavailable', message } }, 503, headers);
  if (!wantsHtml(c.req.header('accept')))
    return c.json({ error: 'temporarily_unavailable', error_description: message }, 503, headers);
  const t = c.get('t');
  return c.html(
    <ErrorPage
      t={t}
      lang={c.get('locale')}
      title={t('error.unavailableTitle')}
      message={t('error.unavailable', { brand: BRAND.name })}
    />,
    503,
    headers,
  );
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
