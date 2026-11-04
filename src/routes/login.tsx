import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthMethod } from '../core/auth-methods.js';
import { authenticate } from '../core/identity.js';
import { PasskeyError } from '../core/passkeys.js';
import {
  clearCookie,
  clientIp,
  csrfToken,
  readCookie,
  safeNextPath,
  setSecureCookie,
  verifyCsrf,
} from '../web/http.js';
import { ErrorPage, LoginPage } from '../web/pages.js';
import { PENDING_LOGIN_TTL_SECONDS } from '../web/pending-logins.js';
import { VerifyPage } from '../web/security-pages.js';
import {
  type AppContext,
  type AppEnv,
  bodyParams,
  currentSession,
  PENDING_LOGIN_COOKIE,
  resetSessionCache,
  SESSION_COOKIE,
} from './context.js';

const cookieOpts = (c: AppContext) => ({ secure: c.get('services').config.secureCookies });

/** Second-factor code attempts: per user (the pending login's owner) and per client IP. */
function consumeCodeAttempt(c: AppContext, userId: string): boolean {
  const s = c.get('services');
  const byUser = s.rateLimiter.consume(`mfa:user:${userId}`, 5, 5 * 60_000);
  const byIp = s.rateLimiter.consume(`mfa:ip:${clientIp(c, s.config.trustProxy)}`, 30, 15 * 60_000);
  return byUser.allowed && byIp.allowed;
}

/** Passkey ceremonies (options + verification) per client IP. */
function consumePasskeyAttempt(c: AppContext): boolean {
  const s = c.get('services');
  return s.rateLimiter.consume(`passkey:ip:${clientIp(c, s.config.trustProxy)}`, 30, 5 * 60_000).allowed;
}

/**
 * Creates the session once every required factor is in. Replaces a session the browser already
 * had (re-confirmation), so the cookie value changes on every sign-in.
 */
async function finishSignIn(c: AppContext, userId: string, amr: AuthMethod[]): Promise<void> {
  const s = c.get('services');
  const opts = cookieOpts(c);
  await s.sessions.destroy(readCookie(c, SESSION_COOKIE, opts));
  const ip = clientIp(c, s.config.trustProxy);
  const token = await s.sessions.create(userId, { amr, ip, userAgent: c.req.header('user-agent') });
  setSecureCookie(c, SESSION_COOKIE, token, { ...opts, maxAge: s.config.sessionTtlSeconds });
  clearCookie(c, PENDING_LOGIN_COOKIE, opts);
  resetSessionCache(c);
  s.logger.info({ userId, ip, amr }, 'user signed in');
}

const PasskeyRequest = z.object({
  csrf: z.string().max(200),
  flow: z.enum(['passwordless', 'second_factor']),
  next: z.string().max(4096).optional(),
  response: z.unknown().optional(),
});

/** Sign-in: password, second factor (TOTP, recovery code or passkey), passwordless passkey; sign-out. */
export function loginRoutes() {
  const app = new Hono<AppEnv>();

  app.get('/login', async (c) => {
    const next = safeNextPath(c.req.query('next'));
    const reauth = c.req.query('reauth') === '1';
    const session = await currentSession(c);
    if (session && !reauth) return c.redirect(next, 302);
    const csrf = csrfToken(c, cookieOpts(c));
    return c.html(
      <LoginPage
        t={c.get('t')}
        lang={c.get('locale')}
        csrf={csrf}
        next={next}
        reauth={Boolean(session && reauth)}
        {...(session ? { email: session.user.email } : {})}
      />,
    );
  });

  app.post('/login', async (c) => {
    const s = c.get('services');
    const t = c.get('t');
    const form = await bodyParams(c);
    const next = safeNextPath(form.next);
    const opts = cookieOpts(c);
    const csrf = csrfToken(c, opts);
    const render = (error: string, status: 400 | 403 | 429) =>
      c.html(
        <LoginPage
          t={t}
          lang={c.get('locale')}
          csrf={csrf}
          next={next}
          email={form.email ?? ''}
          error={error}
        />,
        status,
      );
    if (!verifyCsrf(c, form.csrf, { ...opts, publicUrl: s.config.publicUrl }))
      return render(t('error.csrf'), 403);
    const ip = clientIp(c, s.config.trustProxy);
    const email = (form.email ?? '').trim().toLowerCase();
    const byIp = s.rateLimiter.consume(`login:ip:${ip}`, 20, 15 * 60_000);
    const byEmail = s.rateLimiter.consume(`login:email:${email}`, 10, 15 * 60_000);
    if (!byIp.allowed || !byEmail.allowed) return render(t('login.rateLimited'), 429);

    const user = await authenticate(s.db, email, form.password ?? '');
    if (!user) {
      s.logger.warn({ ip }, 'failed login');
      return render(t('login.invalid'), 400);
    }
    s.rateLimiter.reset(`login:email:${email}`);
    if (!(await s.secondFactors.hasAny(user.id))) {
      await finishSignIn(c, user.id, ['pwd']);
      return c.redirect(next, 303);
    }
    // Password is right, but no session until the second factor: only a short-lived pending login.
    const pending = await s.pendingLogins.create(user.id, ['pwd']);
    setSecureCookie(c, PENDING_LOGIN_COOKIE, pending, { ...opts, maxAge: PENDING_LOGIN_TTL_SECONDS });
    s.logger.info({ userId: user.id, ip }, 'password accepted, second factor required');
    return c.redirect(`/login/verify?next=${encodeURIComponent(next)}`, 303);
  });

  const renderVerify = async (
    c: AppContext,
    userId: string,
    next: string,
    error?: { message: string; status: 400 | 403 | 429 },
  ) => {
    const s = c.get('services');
    const summary = await s.secondFactors.summary(userId);
    return c.html(
      <VerifyPage
        t={c.get('t')}
        lang={c.get('locale')}
        csrf={csrfToken(c, cookieOpts(c))}
        next={next}
        codes={summary.totp || summary.recoveryCodes > 0}
        totp={summary.totp}
        passkey={summary.passkeys > 0}
        {...(error ? { error: error.message } : {})}
      />,
      error?.status ?? 200,
    );
  };

  app.get('/login/verify', async (c) => {
    const s = c.get('services');
    const next = safeNextPath(c.req.query('next'));
    const pending = await s.pendingLogins.get(readCookie(c, PENDING_LOGIN_COOKIE, cookieOpts(c)));
    if (!pending) return c.redirect(`/login?next=${encodeURIComponent(next)}`, 302);
    return renderVerify(c, pending.userId, next);
  });

  app.post('/login/verify', async (c) => {
    const s = c.get('services');
    const t = c.get('t');
    const form = await bodyParams(c);
    const next = safeNextPath(form.next);
    const opts = cookieOpts(c);
    const pendingToken = readCookie(c, PENDING_LOGIN_COOKIE, opts);
    const pending = await s.pendingLogins.get(pendingToken);
    if (!pending) return c.redirect(`/login?next=${encodeURIComponent(next)}`, 303);
    if (!verifyCsrf(c, form.csrf, { ...opts, publicUrl: s.config.publicUrl }))
      return renderVerify(c, pending.userId, next, { message: t('error.csrf'), status: 403 });
    if (!consumeCodeAttempt(c, pending.userId))
      return renderVerify(c, pending.userId, next, { message: t('login.rateLimited'), status: 429 });

    const method = await s.secondFactors.verifyCode(pending.userId, form.code ?? '');
    if (!method) {
      s.logger.warn({ userId: pending.userId, ip: clientIp(c, s.config.trustProxy) }, 'wrong second factor');
      return renderVerify(c, pending.userId, next, { message: t('verify.invalid'), status: 400 });
    }
    const completed = await s.pendingLogins.consume(pendingToken);
    if (!completed) return c.redirect(`/login?next=${encodeURIComponent(next)}`, 303);
    s.rateLimiter.reset(`mfa:user:${completed.userId}`);
    await finishSignIn(c, completed.userId, [...completed.amr, method]);
    return c.redirect(next, 303);
  });

  // --- Passkeys (JSON, called by /assets/webauthn.js) -----------------------
  const passkeyRequest = async (c: AppContext) => {
    const s = c.get('services');
    const parsed = PasskeyRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return { error: c.json({ error: c.get('t')('passkey.failed') }, 400) };
    const body = parsed.data;
    if (!verifyCsrf(c, body.csrf, { ...cookieOpts(c), publicUrl: s.config.publicUrl }))
      return { error: c.json({ error: c.get('t')('error.csrf') }, 403) };
    if (!consumePasskeyAttempt(c)) return { error: c.json({ error: c.get('t')('login.rateLimited') }, 429) };
    const pendingToken = readCookie(c, PENDING_LOGIN_COOKIE, cookieOpts(c));
    if (body.flow === 'passwordless') return { body, pendingToken, pending: undefined };
    const pending = await s.pendingLogins.get(pendingToken);
    if (!pending) {
      const next = safeNextPath(body.next);
      return { error: c.json({ error: '', redirect: `/login?next=${encodeURIComponent(next)}` }, 400) };
    }
    return { body, pendingToken, pending };
  };

  app.post('/login/passkey/options', async (c) => {
    const s = c.get('services');
    const req = await passkeyRequest(c);
    if ('error' in req) return req.error;
    const options = await s.secondFactors.passkeys.authenticationOptions(
      req.body.csrf,
      req.pending ? { userId: req.pending.userId } : {},
    );
    return c.json(options, 200, { 'Cache-Control': 'no-store' });
  });

  app.post('/login/passkey', async (c) => {
    const s = c.get('services');
    const req = await passkeyRequest(c);
    if ('error' in req) return req.error;
    const next = safeNextPath(req.body.next);
    try {
      const result = await s.secondFactors.passkeys.authenticate(
        req.body.csrf,
        req.body.response,
        req.pending ? { userId: req.pending.userId } : {},
      );
      let amr: AuthMethod[] = ['hwk'];
      if (req.pending) {
        const completed = await s.pendingLogins.consume(req.pendingToken);
        if (!completed)
          return c.json({ error: '', redirect: `/login?next=${encodeURIComponent(next)}` }, 400);
        amr = [...completed.amr, 'hwk'];
      }
      await finishSignIn(c, result.userId, amr);
      return c.json({ redirect: next });
    } catch (error) {
      if (!(error instanceof PasskeyError)) throw error;
      s.logger.warn({ code: error.code, ip: clientIp(c, s.config.trustProxy) }, 'passkey sign-in failed');
      return c.json({ error: c.get('t')('passkey.failed') }, 400);
    }
  });

  app.post('/logout', async (c) => {
    const s = c.get('services');
    const opts = cookieOpts(c);
    const form = await bodyParams(c);
    if (!verifyCsrf(c, form.csrf, { ...opts, publicUrl: s.config.publicUrl })) {
      return c.html(
        <ErrorPage t={c.get('t')} lang={c.get('locale')} message={c.get('t')('error.csrf')} />,
        403,
      );
    }
    await s.sessions.destroy(readCookie(c, SESSION_COOKIE, opts));
    clearCookie(c, SESSION_COOKIE, opts);
    return c.redirect('/login', 303);
  });

  return app;
}
