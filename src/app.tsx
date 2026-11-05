import { Hono } from 'hono';
import { AppError } from './lib/errors.js';
import { adminRoutes } from './routes/admin.js';
import { apiRoutes } from './routes/api.js';
import { appRoutes } from './routes/app.js';
import { billingRoutes } from './routes/billing.js';
import { canonicalHost } from './routes/canonical-host.js';
import { confirmRoutes } from './routes/confirm.js';
import { connectRoutes } from './routes/connect.js';
import type { AppEnv } from './routes/context.js';
import { hookRoutes } from './routes/hooks.js';
import { loginRoutes } from './routes/login.js';
import { mcpRoutes } from './routes/mcp.js';
import { oauthRoutes } from './routes/oauth.js';
import { savedLocale } from './routes/page-helpers.js';
import { securityRoutes } from './routes/security.js';
import { siteRoutes } from './routes/site.js';
import { teamRoutes } from './routes/team.js';
import { webRoutes } from './routes/web.js';
import type { Services } from './services.js';
import { pageSecurityHeaders } from './web/http.js';
import { DEFAULT_LOCALE, translator } from './web/i18n.js';
import { ErrorPage } from './web/pages.js';

export function createApp(services: Services) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const started = performance.now();
    c.set('services', services);
    const locale = savedLocale(c) ?? DEFAULT_LOCALE;
    c.set('locale', locale);
    c.set('t', translator(locale));
    await next();
    const path = c.req.path;
    const level = path === '/healthz' || path === '/readyz' ? 'debug' : 'info';
    services.logger[level](
      { method: c.req.method, path, status: c.res.status, ms: Math.round(performance.now() - started) },
      'request',
    );
  });
  app.use('*', pageSecurityHeaders({ hsts: services.config.secureCookies }));
  app.use('*', canonicalHost(services.config.publicUrl, services.config.legacyHosts));

  app.get('/healthz', (c) => c.json({ status: 'ok', version: services.version }));
  app.get('/readyz', async (c) => {
    try {
      await services.database.pool.query('select 1');
      return c.json({ status: 'ok' });
    } catch {
      return c.json({ status: 'unavailable' }, 503);
    }
  });

  app.route('/', siteRoutes());
  app.route('/', oauthRoutes());
  app.route('/', loginRoutes());
  app.route('/', securityRoutes());
  app.route('/', mcpRoutes());
  app.route('/', hookRoutes());
  app.route('/api/v1', apiRoutes());
  app.route('/', confirmRoutes());
  app.route('/', connectRoutes());
  app.route('/', appRoutes());
  app.route('/', teamRoutes());
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
    services.logger.error({ err: error, path: c.req.path }, 'unhandled error');
    if (c.req.path.startsWith('/api/'))
      return c.json({ error: { code: 'internal', message: 'Internal error' } }, 500);
    if (!wantsHtml(c.req.header('accept'))) return c.text('Internal error', 500);
    return c.html(
      <ErrorPage t={c.get('t')} lang={c.get('locale')} message={c.get('t')('error.internal')} />,
      500,
    );
  });

  return app;
}

/** Browsers ask for HTML; API clients and tools usually do not. */
const wantsHtml = (accept: string | undefined) => (accept ?? '').includes('text/html');
