import { Hono } from 'hono';
import { z } from 'zod';
import { isRecentAuth } from '../core/auth-methods.js';
import { PASSKEY_NAME_MAX, PasskeyError } from '../core/passkeys.js';
import { hasSecondFactor } from '../core/second-factors.js';
import { csrfToken, safeNextPath, verifyCsrf } from '../web/http.js';
import { ErrorPage } from '../web/pages.js';
import { RecoveryCodesPage, SecurityPage } from '../web/security-pages.js';
import type { WebSession } from '../web/sessions.js';
import { type AppContext, type AppEnv, bodyParams, currentSession, loginUrl } from './context.js';
import { renderInApp } from './page-helpers.js';

type Session = WebSession & { token: string };

/** `next` is optional here: only present when the user was sent to set up a factor first. */
const optionalNext = (value: string | undefined) => (value ? safeNextPath(value) : undefined);
const securityUrl = (next: string | undefined) =>
  next ? `/security?next=${encodeURIComponent(next)}` : '/security';

const PasskeyRegistration = z.object({
  csrf: z.string().max(200),
  name: z.string().max(200).optional(),
  next: z.string().max(4096).optional(),
  response: z.unknown().optional(),
});

const PasskeyName = z.string().trim().min(1).max(PASSKEY_NAME_MAX);

async function renderSecurity(
  c: AppContext,
  session: Session,
  next: string | undefined,
  options: { totpError?: string; status?: 400 | 429 } = {},
) {
  const s = c.get('services');
  const userId = session.user.id;
  const recent = isRecentAuth(session.authenticatedAt);
  const [summary, passkeys, enrollment, sessions, channels] = await Promise.all([
    s.secondFactors.summary(userId),
    s.secondFactors.passkeys.list(userId),
    // The pending secret is shown only within the recent-sign-in window, like every change here.
    recent ? s.secondFactors.totp.pendingEnrollment(session.user) : undefined,
    s.sessions.list(userId),
    s.telegramBot ? s.notificationChannels.status(userId) : undefined,
  ]);
  const hasFactor = hasSecondFactor(summary);
  return renderInApp(
    c,
    session.user,
    'security',
    <SecurityPage
      t={c.get('t')}
      lang={c.get('locale')}
      view={{
        email: session.user.email,
        csrf: csrfToken(c, { secure: s.config.secureCookies }),
        ...(next ? { next } : {}),
        recent,
        reauthUrl: loginUrl(securityUrl(next), { reauth: true }),
        required: s.config.auth.requireSecondFactor && !hasFactor,
        totp: {
          enabled: summary.totp,
          ...(enrollment && !summary.totp ? { enrollment } : {}),
          ...(options.totpError ? { error: options.totpError } : {}),
        },
        hasFactor,
        recoveryCodes: summary.recoveryCodes,
        passkeys: passkeys.map((p) => ({
          id: p.id,
          name: p.name,
          createdAt: p.createdAt,
          lastUsedAt: p.lastUsedAt,
          backedUp: p.backedUp,
        })),
        sessions: sessions.length,
        ...(channels ? { telegram: { linked: channels.telegram.linked } } : {}),
      }}
    />,
    options.status ?? 200,
  );
}

/**
 * Checks for a security change submitted as a form: signed in, valid CSRF token, and signed in
 * (or re-confirmed) within the last 10 minutes. Otherwise returns the response to send instead.
 */
async function guardForm(
  c: AppContext,
): Promise<{ session: Session; form: Record<string, string>; next: string | undefined } | Response> {
  const s = c.get('services');
  const form = await bodyParams(c);
  const next = optionalNext(form.next);
  const session = await currentSession(c);
  if (!session) return c.redirect(loginUrl(securityUrl(next)), 303);
  if (!verifyCsrf(c, form.csrf, { secure: s.config.secureCookies, publicUrl: s.config.publicUrl })) {
    return c.html(
      <ErrorPage t={c.get('t')} lang={c.get('locale')} message={c.get('t')('error.csrf')} />,
      403,
    );
  }
  if (!isRecentAuth(session.authenticatedAt)) {
    return c.redirect(loginUrl(securityUrl(next), { reauth: true }), 303);
  }
  return { session, form, next };
}

/** Same checks for the JSON calls of /assets/webauthn.js. */
async function guardJson(
  c: AppContext,
): Promise<{ session: Session; body: z.infer<typeof PasskeyRegistration> } | Response> {
  const s = c.get('services');
  const t = c.get('t');
  const parsed = PasskeyRegistration.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: t('passkey.failed') }, 400);
  const body = parsed.data;
  const next = optionalNext(body.next);
  const session = await currentSession(c);
  if (!session) return c.json({ error: '', redirect: loginUrl(securityUrl(next)) }, 401);
  if (!verifyCsrf(c, body.csrf, { secure: s.config.secureCookies, publicUrl: s.config.publicUrl })) {
    return c.json({ error: t('error.csrf') }, 403);
  }
  if (!isRecentAuth(session.authenticatedAt)) {
    return c.json({ error: '', redirect: loginUrl(securityUrl(next), { reauth: true }) }, 403);
  }
  return { session, body };
}

/** /security: authenticator app, recovery codes and passkeys of the signed-in user. */
export function securityRoutes() {
  const app = new Hono<AppEnv>();

  app.get('/security', async (c) => {
    const next = optionalNext(c.req.query('next'));
    const session = await currentSession(c);
    if (!session) return c.redirect(loginUrl(securityUrl(next)), 302);
    return renderSecurity(c, session, next);
  });

  // --- Authenticator app (TOTP) ---------------------------------------------
  app.post('/security/totp/setup', async (c) => {
    const guard = await guardForm(c);
    if (guard instanceof Response) return guard;
    await c.get('services').secondFactors.totp.beginEnrollment(guard.session.user);
    return c.redirect(`${securityUrl(guard.next)}#totp`, 303);
  });

  app.post('/security/totp/confirm', async (c) => {
    const s = c.get('services');
    const t = c.get('t');
    const guard = await guardForm(c);
    if (guard instanceof Response) return guard;
    const { session, form, next } = guard;
    const userId = session.user.id;
    if (!s.rateLimiter.consume(`mfa:user:${userId}`, 5, 5 * 60_000).allowed) {
      return renderSecurity(c, session, next, { totpError: t('login.rateLimited'), status: 429 });
    }
    if (!(await s.secondFactors.totp.confirm(userId, form.code ?? ''))) {
      return renderSecurity(c, session, next, { totpError: t('security.totpInvalid'), status: 400 });
    }
    s.rateLimiter.reset(`mfa:user:${userId}`);
    // The code just proved the factor: this session now counts as signed in with it.
    await s.sessions.addAuthMethod(session.token, 'otp');
    s.logger.info({ userId }, 'authenticator app enabled');
    if ((await s.secondFactors.recoveryCodes.remaining(userId)) === 0) {
      const codes = await s.secondFactors.recoveryCodes.regenerate(userId);
      return renderInApp(
        c,
        session.user,
        'security',
        <RecoveryCodesPage t={t} lang={c.get('locale')} codes={codes} continueTo={securityUrl(next)} />,
      );
    }
    return c.redirect(`${securityUrl(next)}#totp`, 303);
  });

  app.post('/security/totp/disable', async (c) => {
    const s = c.get('services');
    const guard = await guardForm(c);
    if (guard instanceof Response) return guard;
    await s.secondFactors.disableTotp(guard.session.user.id);
    s.logger.info({ userId: guard.session.user.id }, 'authenticator app disabled');
    return c.redirect(`${securityUrl(guard.next)}#totp`, 303);
  });

  // --- Recovery codes ---------------------------------------------------------
  app.post('/security/recovery-codes', async (c) => {
    const s = c.get('services');
    const guard = await guardForm(c);
    if (guard instanceof Response) return guard;
    const userId = guard.session.user.id;
    if (!(await s.secondFactors.hasAny(userId))) return c.redirect(securityUrl(guard.next), 303);
    const codes = await s.secondFactors.recoveryCodes.regenerate(userId);
    s.logger.info({ userId }, 'recovery codes regenerated');
    return renderInApp(
      c,
      guard.session.user,
      'security',
      <RecoveryCodesPage
        t={c.get('t')}
        lang={c.get('locale')}
        codes={codes}
        continueTo={securityUrl(guard.next)}
      />,
    );
  });

  // --- Passkeys -----------------------------------------------------------------
  app.post('/security/passkeys/options', async (c) => {
    const guard = await guardJson(c);
    if (guard instanceof Response) return guard;
    const options = await c
      .get('services')
      .secondFactors.passkeys.registrationOptions(guard.session.user, guard.body.csrf);
    return c.json(options, 200, { 'Cache-Control': 'no-store' });
  });

  app.post('/security/passkeys', async (c) => {
    const s = c.get('services');
    const t = c.get('t');
    const guard = await guardJson(c);
    if (guard instanceof Response) return guard;
    const { session, body } = guard;
    const name = PasskeyName.safeParse(body.name ?? '');
    let passkeyId: string;
    try {
      ({ id: passkeyId } = await s.secondFactors.passkeys.register(
        session.user.id,
        body.csrf,
        body.response,
        // The page no longer asks for a name: the default says where the passkey lives.
        name.success
          ? name.data
          : ({ provider, securityKey }) =>
              provider ?? (securityKey ? t('security.passkeySecurityKey') : t('security.passkeyDefaultName')),
      ));
    } catch (error) {
      if (!(error instanceof PasskeyError)) throw error;
      s.logger.warn({ userId: session.user.id, code: error.code }, 'passkey registration failed');
      return c.json({ error: t('passkey.failed') }, 400);
    }
    await s.sessions.addAuthMethod(session.token, 'hwk');
    s.logger.info({ userId: session.user.id }, 'passkey added');
    // The anchor points at the new row, which the page highlights.
    return c.json({ redirect: `${securityUrl(optionalNext(body.next))}#pk-${passkeyId}` });
  });

  app.post('/security/passkeys/:id/rename', async (c) => {
    const s = c.get('services');
    const guard = await guardForm(c);
    if (guard instanceof Response) return guard;
    const name = PasskeyName.safeParse(guard.form.name ?? '');
    if (name.success)
      await s.secondFactors.passkeys.rename(guard.session.user.id, c.req.param('id'), name.data);
    return c.redirect(`${securityUrl(guard.next)}#pk-${encodeURIComponent(c.req.param('id'))}`, 303);
  });

  app.post('/security/passkeys/:id/delete', async (c) => {
    const s = c.get('services');
    const guard = await guardForm(c);
    if (guard instanceof Response) return guard;
    await s.secondFactors.removePasskey(guard.session.user.id, c.req.param('id'));
    s.logger.info({ userId: guard.session.user.id }, 'passkey removed');
    return c.redirect(`${securityUrl(guard.next)}#passkeys`, 303);
  });

  return app;
}
