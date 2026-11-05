import { Hono } from 'hono';
import { connectorGuide } from '../connectors/sdk.js';
import { notFound } from '../lib/errors.js';
import type { TelegramLinkView } from '../messaging/telegram-automation.js';
import { csrfToken, safeNextPath, verifyCsrf } from '../web/http.js';
import { ErrorPage } from '../web/pages.js';
import { TelegramConnectPage, type TelegramConnectView } from '../web/telegram-connect.js';
import { renderConnected } from './connect.js';
import { type AppContext, type AppEnv, bodyParams, currentUser } from './context.js';
import { renderInApp } from './page-helpers.js';

/**
 * The page of a Telegram Chat Automation link (`/connect/telegram/link/:linkId`, made by
 * `GET /connect/telegram`): the QR code, the bot's code typed here (`POST …/confirm`), then the last
 * step in Telegram, then the "Connected" page. Only the user who made the link sees it. The site script asks `…/state` every few seconds and
 * reloads the page when the state changes; without scripts, "Check now" does the same.
 */
export function telegramConnectRoutes() {
  const app = new Hono<AppEnv>();

  const signIn = (c: AppContext, status: 302 | 303) => {
    const url = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, status);
  };

  const base = (linkId: string) => `/connect/telegram/link/${encodeURIComponent(linkId)}`;

  /** `/connect/telegram` with what the link was made with: a new QR code, or the form. */
  const startUrl = async (c: AppContext, link: TelegramLinkView, via?: 'form') => {
    const s = c.get('services');
    const url = new URL('/connect/telegram', s.config.publicUrl);
    const team = await s.teams.slugOf(link.workspaceId);
    if (team) url.searchParams.set('team', team);
    if (link.draft.owner?.userId === null) url.searchParams.set('owner', 'team');
    if (link.reconnectAccountId) url.searchParams.set('account', link.reconnectAccountId);
    if (link.draft.label) url.searchParams.set('label', link.draft.label);
    if (link.draft.name) url.searchParams.set('name', link.draft.name);
    if (link.returnTo) url.searchParams.set('returnTo', link.returnTo);
    if (via) url.searchParams.set('via', via);
    return url.pathname + url.search;
  };

  app.get('/connect/telegram/link/:linkId', async (c) => {
    const s = c.get('services');
    const user = await currentUser(c);
    if (!user) return signIn(c, 302);
    const link = await s.telegramAutomation?.view(user.id, c.req.param('linkId'));
    if (!link) throw notFound('Link');
    c.header('cache-control', 'no-store');
    const locale = c.get('locale');
    const connector = await s.connectors.get(link.workspaceId, 'telegram');
    const account = link.accountId
      ? await s.accounts.get(link.workspaceId, link.accountId).catch(() => undefined)
      : undefined;
    if (link.state === 'connected' && account) {
      const identity = typeof account.metadata.identity === 'string' ? account.metadata.identity : undefined;
      return renderConnected(c, user, connector, {
        account,
        created: account.createdAt.getTime() >= link.createdAt.getTime(),
        identity,
        problem: account.status === 'active' ? undefined : (account.statusMessage ?? undefined),
        returnTo: safeNextPath(link.returnTo, '/app/services'),
      });
    }
    const reconnecting = link.reconnectAccountId
      ? await s.accounts.get(link.workspaceId, link.reconnectAccountId).catch(() => undefined)
      : undefined;
    const view: TelegramConnectView = {
      // Connected without the account (it was deleted since): nothing left to wait for.
      state: link.state === 'connected' ? 'expired' : link.state,
      bot: link.bot,
      deepLink: link.deepLink,
      telegram: link.telegram,
      error: link.error,
      tooManyCodes: link.tooManyCodes,
      codeWrong: c.req.query('code') === 'wrong',
      reconnecting: reconnecting?.label,
      csrf: csrfToken(c, { secure: s.config.secureCookies }),
      pageUrl: base(link.id),
      stateUrl: `${base(link.id)}/state`,
      cancelUrl: `${base(link.id)}/cancel`,
      confirmUrl: `${base(link.id)}/confirm`,
      restartUrl: await startUrl(c, link),
      formUrl: await startUrl(c, link, 'form'),
      guide: connector ? connectorGuide(connector, locale, 'app').setup : undefined,
    };
    return renderInApp(c, user, 'services', <TelegramConnectPage t={c.get('t')} lang={locale} view={view} />);
  });

  /** `{ state }` for the page to follow. */
  app.get('/connect/telegram/link/:linkId/state', async (c) => {
    const s = c.get('services');
    c.header('cache-control', 'no-store');
    const user = await currentUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const state = await s.telegramAutomation?.state(user.id, c.req.param('linkId'));
    if (!state) return c.json({ error: 'not_found' }, 404);
    return c.json({ state });
  });

  /** The code the bot sent, typed by the signed-in user who made the link. */
  app.post('/connect/telegram/link/:linkId/confirm', async (c) => {
    const s = c.get('services');
    const user = await currentUser(c);
    if (!user) return signIn(c, 303);
    const form = await bodyParams(c);
    if (!verifyCsrf(c, form.csrf, { secure: s.config.secureCookies, publicUrl: s.config.publicUrl })) {
      const t = c.get('t');
      return c.html(<ErrorPage t={t} lang={c.get('locale')} message={t('error.csrf')} />, 403);
    }
    const linkId = c.req.param('linkId');
    const code = typeof form.code === 'string' ? form.code.slice(0, 20) : '';
    const result = await s.telegramAutomation?.confirm(user.id, linkId, code);
    if (!result) throw notFound('Link');
    return c.redirect(result === 'wrong' ? `${base(linkId)}?code=wrong` : base(linkId), 303);
  });

  app.post('/connect/telegram/link/:linkId/cancel', async (c) => {
    const s = c.get('services');
    const user = await currentUser(c);
    if (!user) return signIn(c, 303);
    const form = await bodyParams(c);
    if (!verifyCsrf(c, form.csrf, { secure: s.config.secureCookies, publicUrl: s.config.publicUrl })) {
      const t = c.get('t');
      return c.html(<ErrorPage t={t} lang={c.get('locale')} message={t('error.csrf')} />, 403);
    }
    const linkId = c.req.param('linkId');
    await s.telegramAutomation?.cancel(user.id, linkId);
    return c.redirect(base(linkId), 303);
  });

  return app;
}
