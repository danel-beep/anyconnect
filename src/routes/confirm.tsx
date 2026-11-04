import { Hono } from 'hono';
import { actionText, connectorText } from '../connectors/sdk.js';
import { getDefaultWorkspace } from '../core/identity.js';
import { safeEqual } from '../lib/crypto.js';
import { argumentFields } from '../security/confirmations.js';
import type { PendingCallRow } from '../security/pending-calls.js';
import { ConfirmListPage, ConfirmPage, type PendingCallView } from '../web/confirm-pages.js';
import { csrfToken, verifyCsrf } from '../web/http.js';
import { ErrorPage } from '../web/pages.js';
import type { SessionUser } from '../web/sessions.js';
import {
  type AppContext,
  type AppEnv,
  bodyParams,
  currentSession,
  loginUrl,
  secondFactorRedirect,
} from './context.js';
import { renderInApp } from './page-helpers.js';

export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

export async function pendingCallView(c: AppContext, row: PendingCallRow): Promise<PendingCallView> {
  const s = c.get('services');
  const locale = c.get('locale');
  const [d, connector, account] = await Promise.all([
    s.confirmations.describe(row),
    s.connectors.get(row.workspaceId, row.connectorId).catch(() => undefined),
    row.accountId ? s.accounts.get(row.workspaceId, row.accountId).catch(() => undefined) : undefined,
  ]);
  // Service and action in the page language when the connector has texts for it.
  const action = connector?.actions.find((a) => a.name === row.action);
  return {
    id: row.id,
    status: row.status,
    client: d.client,
    connectorId: row.connectorId,
    service: connector ? connectorText(connector, locale).name : d.service,
    account: account?.label ?? d.account,
    action: connector && action ? actionText(connector, action, locale).title : d.action,
    risk: row.risk,
    reason: row.reason ?? undefined,
    fields: argumentFields(s.pendingCalls.args(row)),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    executeAt: row.executeAt,
  };
}

/**
 * Confirmation pages (`/confirm`, `/confirm/<id>`) for actions the hub holds back, linking the
 * owner's Telegram chat, and the Telegram bot webhook.
 */
export function confirmRoutes() {
  const app = new Hono<AppEnv>();

  /** The signed-in user and workspace, or where to send the browser first (sign-in, 2FA). */
  const session = async (
    c: AppContext,
    next: string,
  ): Promise<{ redirect: string } | { user: SessionUser; workspace: { id: string } }> => {
    const s = c.get('services');
    const web = await currentSession(c);
    if (!web) return { redirect: loginUrl(next) };
    const gate = await secondFactorRedirect(c, web, next);
    if (gate) return { redirect: gate };
    const workspace = await getDefaultWorkspace(s.db, web.user.id);
    return workspace ? { user: web.user, workspace } : { redirect: '/' };
  };
  const csrfFailed = (c: AppContext) =>
    c.html(<ErrorPage t={c.get('t')} lang={c.get('locale')} message={c.get('t')('error.csrf')} />, 403);

  const renderList = async (c: AppContext, linkUrl?: string) => {
    const s = c.get('services');
    const auth = await session(c, '/confirm');
    if ('redirect' in auth) return c.redirect(auth.redirect, 302);
    const [rows, channels, security] = await Promise.all([
      s.pendingCalls.listOpen(auth.workspace.id),
      s.notificationChannels.status(auth.user.id),
      s.admin.security(auth.workspace.id),
    ]);
    const calls = await Promise.all(rows.map((row) => pendingCallView(c, row)));
    return renderInApp(
      c,
      auth.user,
      'confirm',
      <ConfirmListPage
        t={c.get('t')}
        lang={c.get('locale')}
        calls={calls}
        csrf={csrfToken(c, { secure: s.config.secureCookies })}
        rule={c.get('t')(`app.rules.confirm.${security.defaultConfirm}` as const)}
        telegram={{
          enabled: s.confirmations.telegramEnabled,
          linked: channels.telegram.linked,
          label: channels.telegram.label,
          ...(linkUrl ? { linkUrl } : {}),
        }}
      />,
    );
  };

  app.get('/confirm', (c) => renderList(c));

  app.get('/confirm/:id', async (c) => {
    const s = c.get('services');
    const id = c.req.param('id');
    const auth = await session(c, `/confirm/${id}`);
    if ('redirect' in auth) return c.redirect(auth.redirect, 302);
    const row = await s.pendingCalls.getInWorkspace(auth.workspace.id, id);
    return renderInApp(
      c,
      auth.user,
      'confirm',
      <ConfirmPage
        t={c.get('t')}
        lang={c.get('locale')}
        call={await pendingCallView(c, row)}
        csrf={csrfToken(c, { secure: s.config.secureCookies })}
      />,
    );
  });

  app.post('/confirm/:id', async (c) => {
    const s = c.get('services');
    const id = c.req.param('id');
    const form = await bodyParams(c);
    if (!verifyCsrf(c, form.csrf, { secure: s.config.secureCookies, publicUrl: s.config.publicUrl }))
      return csrfFailed(c);
    const auth = await session(c, `/confirm/${id}`);
    if ('redirect' in auth) return c.redirect(auth.redirect, 303);
    await s.pendingCalls.getInWorkspace(auth.workspace.id, id);
    const decision = form.decision;
    if (decision === 'approve' || decision === 'deny' || decision === 'cancel') {
      await s.confirmations.decide(id, decision, 'web');
      s.logger.info({ pendingCall: id, decision, userId: auth.user.id }, 'pending call decided');
    }
    return c.redirect(`/confirm/${id}`, 303);
  });

  // --- Telegram -------------------------------------------------------------
  app.post('/telegram/link', async (c) => {
    const s = c.get('services');
    const form = await bodyParams(c);
    if (!verifyCsrf(c, form.csrf, { secure: s.config.secureCookies, publicUrl: s.config.publicUrl }))
      return csrfFailed(c);
    const auth = await session(c, '/confirm');
    if ('redirect' in auth) return c.redirect(auth.redirect, 303);
    if (!s.telegramBot) return c.redirect('/confirm', 303);
    const code = await s.notificationChannels.startTelegramLink(auth.user.id);
    const username = await s.telegramBot.getUsername();
    return renderList(c, `https://t.me/${username}?start=${code}`);
  });

  app.post('/telegram/unlink', async (c) => {
    const s = c.get('services');
    const form = await bodyParams(c);
    if (!verifyCsrf(c, form.csrf, { secure: s.config.secureCookies, publicUrl: s.config.publicUrl }))
      return csrfFailed(c);
    const auth = await session(c, '/confirm');
    if ('redirect' in auth) return c.redirect(auth.redirect, 303);
    await s.notificationChannels.unlinkTelegram(auth.user.id);
    return c.redirect('/confirm', 303);
  });

  app.post('/telegram/webhook', async (c) => {
    const s = c.get('services');
    const secret = c.req.header(TELEGRAM_SECRET_HEADER) ?? '';
    if (!s.telegramBot || !safeEqual(secret, s.telegramWebhookSecret)) return c.body(null, 401);
    const update = await c.req.json().catch(() => undefined);
    try {
      await s.confirmations.handleTelegramUpdate(update);
    } catch (error) {
      s.logger.warn({ err: error }, 'telegram update failed');
    }
    // Always 200: Telegram retries failed deliveries, and a retry would not succeed either.
    return c.body(null, 200);
  });

  return app;
}
