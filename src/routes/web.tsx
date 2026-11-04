import { Hono } from 'hono';
import { APP_CSS } from '../web/styles.js';
import { WEBAUTHN_JS } from '../web/webauthn-client.js';
import type { AppEnv } from './context.js';
import { bodyParams } from './context.js';
import { connectionBack, csrfFailedPage, csrfOk, requireApp, setFlash } from './page-helpers.js';

/** Shared web assets (styles, passkey script) and revoking an AI app's access. */
export function webRoutes() {
  const app = new Hono<AppEnv>();

  app.get('/assets/app.css', (c) =>
    c.body(APP_CSS, 200, {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    }),
  );

  app.get('/assets/webauthn.js', (c) =>
    c.body(WEBAUTHN_JS, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    }),
  );

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
