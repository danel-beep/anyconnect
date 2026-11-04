import { Hono } from 'hono';
import { getDefaultWorkspace } from '../core/identity.js';
import { safeEqual } from '../lib/crypto.js';
import { previewArguments } from '../security/confirmations.js';
import type { PendingCallRow } from '../security/pending-calls.js';
import { ConfirmListPage, ConfirmPage, type PendingCallView } from '../web/confirm-pages.js';
import { csrfToken, verifyCsrf } from '../web/http.js';
import { ErrorPage } from '../web/pages.js';
import { type AppContext, type AppEnv, bodyParams, currentUser } from './context.js';

export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

export async function pendingCallView(c: AppContext, row: PendingCallRow): Promise<PendingCallView> {
  const s = c.get('services');
  const d = await s.confirmations.describe(row);
  return {
    id: row.id,
    status: row.status,
    client: d.client,
    service: d.service,
    account: d.account,
    action: d.action,
    risk: row.risk,
    reason: row.reason ?? undefined,
    arguments: previewArguments(s.pendingCalls.args(row)),
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

  const session = async (c: AppContext) => {
    const s = c.get('services');
    const user = await currentUser(c);
    if (!user) return undefined;
    const workspace = await getDefaultWorkspace(s.db, user.id);
    return workspace ? { user, workspace } : undefined;
  };
  const csrfFailed = (c: AppContext) =>
    c.html(<ErrorPage t={c.get('t')} lang={c.get('locale')} message={c.get('t')('error.csrf')} />, 403);

  const renderList = async (c: AppContext, linkUrl?: string) => {
    const s = c.get('services');
    const auth = await session(c);
    if (!auth) return c.redirect(`/login?next=${encodeURIComponent('/confirm')}`, 302);
    const [rows, channels] = await Promise.all([
      s.pendingCalls.listOpen(auth.workspace.id),
      s.notificationChannels.status(auth.user.id),
    ]);
    const calls = await Promise.all(rows.map((row) => pendingCallView(c, row)));
    return c.html(
      <ConfirmListPage
        t={c.get('t')}
        lang={c.get('locale')}
        calls={calls}
        csrf={csrfToken(c, { secure: s.config.secureCookies })}
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
    const auth = await session(c);
    if (!auth) return c.redirect(`/login?next=${encodeURIComponent(`/confirm/${id}`)}`, 302);
    const row = await s.pendingCalls.getInWorkspace(auth.workspace.id, id);
    return c.html(
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
    const auth = await session(c);
    if (!auth) return c.redirect(`/login?next=${encodeURIComponent(`/confirm/${id}`)}`, 303);
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
    const auth = await session(c);
    if (!auth) return c.redirect('/login', 303);
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
    const auth = await session(c);
    if (!auth) return c.redirect('/login', 303);
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
