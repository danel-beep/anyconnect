import { Hono } from 'hono';
import { getDefaultWorkspace } from '../core/identity.js';
import { badRequest } from '../lib/errors.js';
import { safeNextPath } from '../web/http.js';
import { ConnectedPage } from '../web/pages.js';
import { type AppEnv, currentUser } from './context.js';

/**
 * Browser side of connecting accounts through OAuth:
 *
 * - `GET /connect/:connectorId?account=&app=&label=&name=&returnTo=` starts a flow for the signed-in
 *   user and redirects to the provider (the panel and links in chat use it; `POST /api/v1/connect`
 *   is the API equivalent);
 * - `GET /connect/callback` is the single redirect URI registered at every provider.
 */
export function connectRoutes() {
  const app = new Hono<AppEnv>();

  const loginRedirect = (path: string) => `/login?next=${encodeURIComponent(path)}`;

  app.get('/connect/callback', async (c) => {
    const s = c.get('services');
    const user = await currentUser(c);
    if (!user) {
      const url = new URL(c.req.url);
      return c.redirect(loginRedirect(url.pathname + url.search), 302);
    }
    const result = await s.connect.complete(user.id, {
      state: c.req.query('state'),
      code: c.req.query('code'),
      error: c.req.query('error'),
      errorDescription: c.req.query('error_description'),
    });
    const connector = await s.connectors.get(result.account.workspaceId, result.account.connectorId);
    const identity =
      typeof result.account.metadata.identity === 'string' ? result.account.metadata.identity : undefined;
    return c.html(
      <ConnectedPage
        t={c.get('t')}
        lang={c.get('locale')}
        view={{
          service: connector?.name ?? result.account.connectorId,
          label: result.account.label,
          created: result.created,
          identity,
          problem:
            result.account.status === 'active' ? undefined : (result.account.statusMessage ?? undefined),
          returnTo: safeNextPath(result.returnTo ?? '/'),
        }}
      />,
    );
  });

  app.get('/connect/:connectorId', async (c) => {
    const s = c.get('services');
    const user = await currentUser(c);
    if (!user) {
      const url = new URL(c.req.url);
      return c.redirect(loginRedirect(url.pathname + url.search), 302);
    }
    const workspace = await getDefaultWorkspace(s.db, user.id);
    if (!workspace) throw badRequest('No workspace');
    const q = (key: string) => c.req.query(key) || undefined;
    const returnTo = q('returnTo');
    const { authorizationUrl } = await s.connect.start(
      { workspaceId: workspace.id, userId: user.id },
      {
        connectorId: c.req.param('connectorId'),
        ...(q('account') ? { accountId: q('account') } : {}),
        ...(q('app') ? { appId: q('app') } : {}),
        ...(q('label') ? { label: q('label') } : {}),
        ...(q('name') ? { name: q('name') } : {}),
        ...(q('description') ? { description: q('description') } : {}),
        ...(returnTo ? { returnTo: safeNextPath(returnTo) } : {}),
      },
    );
    return c.redirect(authorizationUrl, 302);
  });

  return app;
}
