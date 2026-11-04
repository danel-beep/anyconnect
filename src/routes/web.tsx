import { Hono } from 'hono';
import { getDefaultWorkspace } from '../core/identity.js';
import { csrfToken, verifyCsrf } from '../web/http.js';
import { ErrorPage, HomePage } from '../web/pages.js';
import { APP_CSS } from '../web/styles.js';
import { WEBAUTHN_JS } from '../web/webauthn-client.js';
import { type AppEnv, bodyParams, currentSession, secondFactorRedirect } from './context.js';

/** The hub's home page (a minimal dashboard until the full web panel exists). */
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

  app.get('/', async (c) => {
    const s = c.get('services');
    const session = await currentSession(c);
    if (!session) return c.redirect('/login', 302);
    const gate = await secondFactorRedirect(c, session, '/');
    if (gate) return c.redirect(gate, 302);
    const user = session.user;
    const workspace = await getDefaultWorkspace(s.db, user.id);
    if (!workspace)
      return c.html(<ErrorPage t={c.get('t')} lang={c.get('locale')} message="No workspace" />, 500);
    const [accounts, grants, calls] = await Promise.all([
      s.accounts.list(workspace.id),
      s.oauth.listGrants(workspace.id),
      s.hub.recentToolCalls(workspace.id, { limit: 10 }),
    ]);
    return c.html(
      <HomePage
        t={c.get('t')}
        lang={c.get('locale')}
        view={{
          email: user.email,
          mcpUrl: s.config.mcpUrl,
          csrf: csrfToken(c, { secure: s.config.secureCookies }),
          accounts: accounts.map((a) => ({
            connector: a.connectorId,
            name: a.name,
            label: a.label,
            status: a.status,
            enabled: a.enabled,
            identity: typeof a.metadata.identity === 'string' ? a.metadata.identity : null,
          })),
          grants: grants.map((g) => ({
            id: g.id,
            name: g.clientName ?? g.clientId,
            createdAt: g.createdAt,
            lastUsedAt: g.lastUsedAt,
          })),
          calls: calls.map((call) => ({
            toolName: call.toolName,
            status: call.status,
            createdAt: call.createdAt,
            durationMs: call.durationMs,
          })),
        }}
      />,
    );
  });

  app.post('/grants/:id/revoke', async (c) => {
    const s = c.get('services');
    const form = await bodyParams(c);
    if (!verifyCsrf(c, form.csrf, { secure: s.config.secureCookies, publicUrl: s.config.publicUrl })) {
      return c.html(
        <ErrorPage t={c.get('t')} lang={c.get('locale')} message={c.get('t')('error.csrf')} />,
        403,
      );
    }
    const session = await currentSession(c);
    if (!session) return c.redirect('/login', 303);
    const gate = await secondFactorRedirect(c, session, '/');
    if (gate) return c.redirect(gate, 303);
    const workspace = await getDefaultWorkspace(s.db, session.user.id);
    if (workspace) await s.oauth.revokeGrant(workspace.id, c.req.param('id'));
    return c.redirect('/', 303);
  });

  return app;
}
