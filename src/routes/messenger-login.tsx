import { Hono } from 'hono';
import { ConnectorError, connectorText } from '../connectors/sdk.js';
import { notFound } from '../lib/errors.js';
import { MessengerAccounts } from '../messaging/accounts.js';
import { GatewayUnavailableError, type LoginView, StartLoginInput } from '../messaging/gateway-client.js';
import { csrfToken, verifyCsrf } from '../web/http.js';
import { MessengerLoginPage, type MessengerLoginView } from '../web/messenger-login.js';
import { ErrorPage } from '../web/pages.js';
import type { SessionUser } from '../web/sessions.js';
import { connectTarget, messengerLoginPath } from './connect.js';
import { type AppContext, type AppEnv, bodyParams, currentUser } from './context.js';
import { renderInApp } from './page-helpers.js';

/**
 * The website side of a messenger login (`/connect/messenger/:accountId`): the user picks QR code
 * or phone number, then goes through the steps the gateway reports (scan, code, cloud password).
 * Codes and passwords are posted here and forwarded to the gateway; they are never stored, logged
 * or shown to the AI. `team=<slug>` is carried for accounts of a team.
 */
export function messengerLoginRoutes() {
  const app = new Hono<AppEnv>();

  /** The account, if the signed-in user may manage it, plus what the page needs. */
  const load = async (c: AppContext, user: SessionUser) => {
    const s = c.get('services');
    const team = c.req.query('team') || undefined;
    const { workspace } = await connectTarget(c, user, (key) => (key === 'team' ? team : undefined));
    const account = await s.accounts.get(workspace.id, c.req.param('accountId')!).catch(() => undefined);
    if (!account) throw notFound('Account');
    await s.teams.assertCanManage(workspace.id, user.id, account);
    const connector = await s.connectors.get(workspace.id, account.connectorId);
    if (!connector || !messengerLoginPath(connector, account)) throw notFound('Account');
    return { account, connector, team };
  };

  const page = async (
    c: AppContext,
    user: SessionUser,
    loaded: Awaited<ReturnType<typeof load>>,
    extra: { login?: LoginView; error?: string } = {},
    status: 200 | 400 = 200,
  ) => {
    const s = c.get('services');
    const { account, connector, team } = loaded;
    const row = await s.messaging.accounts.get(account.id);
    const online = row?.state === 'online';
    const statusView = row && !online ? MessengerAccounts.view(row) : undefined;
    const identity = typeof account.metadata?.identity === 'string' ? account.metadata.identity : undefined;
    const view: MessengerLoginView = {
      accountId: account.id,
      connectorId: connector.id,
      service: connectorText(connector, c.get('locale')).name,
      label: account.label,
      csrf: csrfToken(c, { secure: s.config.secureCookies }),
      online,
      available: Boolean(s.messaging.gateway),
      ...(identity ? { identity } : {}),
      ...(statusView?.message ? { status: statusView.message } : {}),
      ...(extra.login ? { login: extra.login } : {}),
      ...(extra.error ? { error: extra.error } : {}),
      ...(team ? { team } : {}),
    };
    c.header('cache-control', 'no-store');
    return renderInApp(
      c,
      user,
      'services',
      <MessengerLoginPage t={c.get('t')} lang={c.get('locale')} view={view} />,
      status,
    );
  };

  const signIn = (c: AppContext, status: 302 | 303 = 303) => {
    const url = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, status);
  };

  /** The page's own URL with the team carried along. */
  const here = (accountId: string, team: string | undefined, rest = '') =>
    `/connect/messenger/${encodeURIComponent(accountId)}${rest}${team ? `?team=${encodeURIComponent(team)}` : ''}`;

  /** Gateway failures become a message on the page instead of an error page. */
  const gatewayMessage = (c: AppContext, error: unknown): string => {
    const t = c.get('t');
    if (error instanceof GatewayUnavailableError) return t('mlogin.unavailableTry');
    if (error instanceof ConnectorError) {
      return error.kind === 'not_found' ? t('mlogin.expired') : error.message;
    }
    throw error;
  };

  const checkCsrf = (c: AppContext, form: Record<string, string>) => {
    const s = c.get('services');
    return verifyCsrf(c, form.csrf, { secure: s.config.secureCookies, publicUrl: s.config.publicUrl });
  };

  const csrfFailed = (c: AppContext) =>
    c.html(<ErrorPage t={c.get('t')} lang={c.get('locale')} message={c.get('t')('error.csrf')} />, 403);

  app.get('/connect/messenger/:accountId', async (c) => {
    const user = await currentUser(c);
    if (!user) return signIn(c, 302);
    const loaded = await load(c, user);
    const s = c.get('services');
    // A new account has no session yet: say so in its status until the login is done.
    if (!(await s.messaging.accounts.get(loaded.account.id))) {
      await s.messaging.accounts.setState(loaded.account.id, { state: 'needs_login' });
    }
    return page(c, user, loaded);
  });

  app.post('/connect/messenger/:accountId', async (c) => {
    const user = await currentUser(c);
    if (!user) return signIn(c);
    const form = await bodyParams(c);
    if (!checkCsrf(c, form)) return csrfFailed(c);
    const loaded = await load(c, user);
    const gateway = c.get('services').messaging.gateway;
    if (!gateway) return page(c, user, loaded);
    const input = StartLoginInput.safeParse({
      method: form.method === 'phone' ? 'phone' : 'qr',
      ...(form.method === 'phone' ? { phone: (form.phone ?? '').replace(/[\s()-]/g, '') } : {}),
    });
    if (!input.success) return page(c, user, loaded, { error: c.get('t')('mlogin.phoneLabel') }, 400);
    try {
      const login = await gateway.startLogin(loaded.account.id, input.data);
      return c.redirect(here(loaded.account.id, loaded.team, `/login/${encodeURIComponent(login.id)}`), 303);
    } catch (error) {
      return page(c, user, loaded, { error: gatewayMessage(c, error) }, 400);
    }
  });

  app.get('/connect/messenger/:accountId/login/:loginId', async (c) => {
    const user = await currentUser(c);
    if (!user) return signIn(c, 302);
    const loaded = await load(c, user);
    const gateway = c.get('services').messaging.gateway;
    if (!gateway) return page(c, user, loaded);
    try {
      const login = await gateway.getLogin(loaded.account.id, c.req.param('loginId'));
      return page(c, user, loaded, { login });
    } catch (error) {
      return page(c, user, loaded, { error: gatewayMessage(c, error) });
    }
  });

  app.post('/connect/messenger/:accountId/login/:loginId', async (c) => {
    const user = await currentUser(c);
    if (!user) return signIn(c);
    const form = await bodyParams(c);
    if (!checkCsrf(c, form)) return csrfFailed(c);
    const loaded = await load(c, user);
    const gateway = c.get('services').messaging.gateway;
    if (!gateway) return page(c, user, loaded);
    const loginId = c.req.param('loginId');
    try {
      const login = await gateway.submitLogin(loaded.account.id, loginId, {
        ...(form.code ? { code: form.code.trim().slice(0, 32) } : {}),
        ...(form.password ? { password: form.password.slice(0, 256) } : {}),
      });
      // The next step (or the same one with its error) is shown by the GET page, so reloading it
      // never posts the code again.
      return c.redirect(here(loaded.account.id, loaded.team, `/login/${encodeURIComponent(login.id)}`), 303);
    } catch (error) {
      return page(c, user, loaded, { error: gatewayMessage(c, error) }, 400);
    }
  });

  app.post('/connect/messenger/:accountId/login/:loginId/cancel', async (c) => {
    const user = await currentUser(c);
    if (!user) return signIn(c);
    const form = await bodyParams(c);
    if (!checkCsrf(c, form)) return csrfFailed(c);
    const loaded = await load(c, user);
    await c
      .get('services')
      .messaging.gateway?.cancelLogin(loaded.account.id, c.req.param('loginId'))
      .catch(() => {});
    return c.redirect(here(loaded.account.id, loaded.team), 303);
  });

  return app;
}
