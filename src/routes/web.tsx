import { Hono } from 'hono';
import type { AppEnv } from './context.js';
import { bodyParams } from './context.js';
import { connectionBack, csrfFailedPage, csrfOk, requireApp, setFlash } from './page-helpers.js';

/** Revoking an AI app's access (static files are served by `assetRoutes`). */
export function webRoutes() {
  const app = new Hono<AppEnv>();

  app.post('/grants/:id/revoke', async (c) => {
    const s = c.get('services');
    const form = await bodyParams(c);
    if (!csrfOk(c, form)) return csrfFailedPage(c);
    // Revoking from a profile's or an AI app's page goes back there.
    const back = connectionBack(form);
    const auth = await requireApp(c, back);
    if ('redirect' in auth) return c.redirect(auth.redirect, 303);
    await s.oauth.revokeGrant(auth.workspace.id, c.req.param('id'));
    setFlash(c, 'ok', 'app.flash.appRevoked');
    return c.redirect(back, 303);
  });

  return app;
}
