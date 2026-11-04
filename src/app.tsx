import { Hono } from 'hono';
import { AppError } from './lib/errors.js';
import { apiRoutes } from './routes/api.js';
import { confirmRoutes } from './routes/confirm.js';
import type { AppEnv } from './routes/context.js';
import { mcpRoutes } from './routes/mcp.js';
import { oauthRoutes } from './routes/oauth.js';
import { webRoutes } from './routes/web.js';
import type { Services } from './services.js';
import { pageSecurityHeaders } from './web/http.js';
import { pickLocale, translator } from './web/i18n.js';
import { ErrorPage } from './web/pages.js';

export function createApp(services: Services) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const started = performance.now();
    const locale = pickLocale(c.req.header('accept-language'));
    c.set('services', services);
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

  app.get('/healthz', (c) => c.json({ status: 'ok', version: services.version }));
  app.get('/readyz', async (c) => {
    try {
      await services.database.pool.query('select 1');
      return c.json({ status: 'ok' });
    } catch {
      return c.json({ status: 'unavailable' }, 503);
    }
  });

  app.route('/', oauthRoutes());
  app.route('/', mcpRoutes());
  app.route('/api/v1', apiRoutes());
  app.route('/', confirmRoutes());
  app.route('/', webRoutes());

  app.notFound((c) =>
    c.req.path.startsWith('/api/')
      ? c.json({ error: { code: 'not_found', message: 'Not found' } }, 404)
      : c.text('Not found', 404),
  );

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
    return c.text('Internal error', 500);
  });

  return app;
}
