import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthMethod } from '../core/auth-methods.js';
import { ExternalLoginError } from '../core/external-login.js';
import { authenticate } from '../core/identity.js';
import { PasskeyError } from '../core/passkeys.js';
import { type ExternalProfile, SignInRefused } from '../core/users.js';
import {
  clearCookie,
  clientIp,
  clientRateKey,
  csrfToken,
  readCookie,
  safeNextPath,
  setSecureCookie,
  verifyCsrf,
} from '../web/http.js';
import { ErrorPage, type LoginMode, LoginPage } from '../web/pages.js';
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
import { cookieOpts, saveLocale } from './page-helpers.js';

/** Second-factor code attempts: per user (the pending login's owner) and per client IP. */
function consumeCodeAttempt(c: AppContext, userId: string): boolean {
  const s = c.get('services');
  const byUser = s.rateLimiter.consume(`mfa:user:${userId}`, 5, 5 * 60_000);
  const byIp = s.rateLimiter.consume(`mfa:ip:${clientRateKey(c, s.config.trustProxy)}`, 30, 15 * 60_000);
  return byUser.allowed && byIp.allowed;
}

/** Passkey ceremonies (options + verification) per client IP. */
function consumePasskeyAttempt(c: AppContext): boolean {
  const s = c.get('services');
  return s.rateLimiter.consume(`passkey:ip:${clientRateKey(c, s.config.trustProxy)}`, 30, 5 * 60_000).allowed;
}

/**
 * Creates the session once every required factor is in. Replaces a session the browser already
 * had (re-confirmation), so the cookie value changes on every sign-in. Suspended users are refused
 * here, whatever the sign-in method; admins get the unlimited plan; the saved language is applied.
 */
async function finishSignIn(c: AppContext, userId: string, amr: AuthMethod[]): Promise<void> {
  const s = c.get('services');
  const user = await s.users.require(userId);
  if (user.status !== 'active') throw new SignInRefused('suspended');
  // Admin emails are promoted in `signInExternal` (where the address is proven), not here.
  if (user.role === 'admin') {
    // Administrators run the hub: their own workspace is not limited by visitor plans.
    const owned = await s.users.personalWorkspace(user.id);
    if (owned) await s.entitlements.ensurePlan(owned.id, 'unlimited');
  }
  const opts = cookieOpts(c);
  await s.sessions.destroy(readCookie(c, SESSION_COOKIE, opts));
  const ip = clientIp(c, s.config.trustProxy);
  const token = await s.sessions.create(userId, { amr, ip, userAgent: c.req.header('user-agent') });
  setSecureCookie(c, SESSION_COOKIE, token, { ...opts, maxAge: s.config.sessionTtlSeconds });
  clearCookie(c, PENDING_LOGIN_COOKIE, opts);
  if (user.locale === 'ru' || user.locale === 'en') saveLocale(c, user.locale);
  resetSessionCache(c);
  s.logger.info({ userId, ip, amr }, 'user signed in');
}

/** Holds the external sign-in state in the browser that started it (checked on the callback). */
const EXTERNAL_STATE_COOKIE = 'ac_login';

/** Messages a redirect back to /login may show (`?error=`); anything else is ignored. */
const LOGIN_ERRORS = {
  externalFailed: 'login.externalFailed',
  expired: 'login.expired',
  suspended: 'login.refused.suspended',
  signups_closed: 'login.refused.signups_closed',
  email_unverified: 'login.refused.email_unverified',
} as const;
type LoginError = keyof typeof LOGIN_ERRORS;

const loginError = (c: AppContext): string | undefined => {
  const code = c.req.query('error');
  return code && code in LOGIN_ERRORS ? c.get('t')(LOGIN_ERRORS[code as LoginError]) : undefined;
};

/** The default place after signing in: the dashboard. */
const nextOf = (value: unknown) => safeNextPath(value, '/app');

const PasskeyRequest = z.object({
  csrf: z.string().max(200),
  flow: z.enum(['passwordless', 'second_factor']),
  next: z.string().max(4096).optional(),
  response: z.unknown().optional(),
});

/** Sign-in: password, second factor (TOTP, recovery code or passkey), passwordless passkey; sign-out. */
export function loginRoutes() {
  const app = new Hono<AppEnv>();

  const renderLogin = (
    c: AppContext,
    opts: {
      mode: LoginMode;
      next: string;
      email?: string;
      error?: string;
      passwordOpen?: boolean;
      status?: 200 | 400 | 403 | 429;
    },
  ) => {
    const s = c.get('services');
    return c.html(
      <LoginPage
        t={c.get('t')}
        lang={c.get('locale')}
        csrf={csrfToken(c, cookieOpts(c))}
        next={opts.next}
        mode={opts.mode}
        google={s.externalLogin.get('google') !== undefined}
        signupsOpen={s.config.site.signups === 'open'}
        fromApp={opts.next.startsWith('/oauth/authorize')}
        {...(opts.email ? { email: opts.email } : {})}
        {...(opts.error ? { error: opts.error } : {})}
        {...(opts.passwordOpen ? { passwordOpen: true } : {})}
      />,
      opts.status ?? 200,
    );
  };

  app.get('/login', async (c) => {
    const next = nextOf(c.req.query('next'));
    const reauth = c.req.query('reauth') === '1';
    const session = await currentSession(c);
    if (session && !reauth) return c.redirect(next, 302);
    const error = loginError(c);
    return renderLogin(c, {
      mode: session && reauth ? 'reauth' : 'login',
      next,
      ...(session ? { email: session.user.email } : {}),
      ...(error ? { error } : {}),
    });
  });

  app.get('/signup', async (c) => {
    const next = nextOf(c.req.query('next'));
    if (await currentSession(c)) return c.redirect(next, 302);
    const error = loginError(c);
    return renderLogin(c, { mode: 'signup', next, ...(error ? { error } : {}) });
  });

  // --- Sign-in with Google (and other OpenID Connect providers) --------------
  app.get('/auth/:provider', async (c) => {
    const s = c.get('services');
    const providerId = c.req.param('provider');
    const next = nextOf(c.req.query('next'));
    if (!s.externalLogin.get(providerId)) return c.notFound();
    if (
      !s.rateLimiter.consume(`external-login:ip:${clientRateKey(c, s.config.trustProxy)}`, 30, 15 * 60_000)
        .allowed
    )
      return renderLogin(c, { mode: 'login', next, error: c.get('t')('login.rateLimited'), status: 429 });
    const { url, state } = await s.externalLogin.start(providerId, next);
    setSecureCookie(c, EXTERNAL_STATE_COOKIE, state, { ...cookieOpts(c), maxAge: 10 * 60 });
    return c.redirect(url, 302);
  });

  app.get('/auth/:provider/callback', async (c) => {
    const s = c.get('services');
    const providerId = c.req.param('provider');
    if (!s.externalLogin.get(providerId)) return c.notFound();
    const opts = cookieOpts(c);
    const browserState = readCookie(c, EXTERNAL_STATE_COOKIE, opts);
    clearCookie(c, EXTERNAL_STATE_COOKIE, opts);
    const back = (code: LoginError) => c.redirect(`/login?error=${code}`, 302);
    let result: { profile: ExternalProfile; next: string };
    try {
      result = await s.externalLogin.complete(
        providerId,
        { state: c.req.query('state'), code: c.req.query('code'), error: c.req.query('error') },
        browserState,
      );
    } catch (error) {
      if (!(error instanceof ExternalLoginError)) throw error;
      s.logger.warn({ provider: providerId, reason: error.message }, 'external sign-in failed');
      return back(browserState ? 'externalFailed' : 'expired');
    }
    const next = nextOf(result.next);
    try {
      const { user, created } = await s.users.signInExternal(result.profile);
      if (created) s.logger.info({ userId: user.id, provider: providerId }, 'user signed up');
      if (await s.secondFactors.hasAny(user.id)) {
        const pending = await s.pendingLogins.create(user.id, ['fed']);
        setSecureCookie(c, PENDING_LOGIN_COOKIE, pending, { ...opts, maxAge: PENDING_LOGIN_TTL_SECONDS });
        return c.redirect(`/login/verify?next=${encodeURIComponent(next)}`, 302);
      }
      await finishSignIn(c, user.id, ['fed']);
      return c.redirect(created && next === '/app' ? '/app?welcome=1' : next, 302);
    } catch (error) {
      if (!(error instanceof SignInRefused)) throw error;
      s.logger.warn({ provider: providerId, reason: error.reason }, 'external sign-in refused');
      return back(error.reason);
    }
  });

  app.post('/login', async (c) => {
    const s = c.get('services');
    const t = c.get('t');
    const form = await bodyParams(c);
    const next = nextOf(form.next);
    const opts = cookieOpts(c);
    const render = (error: string, status: 400 | 403 | 429) =>
      renderLogin(c, {
        mode: form.reauth === '1' ? 'reauth' : 'login',
        next,
        email: form.email ?? '',
        error,
        passwordOpen: true,
        status,
      });
    if (!verifyCsrf(c, form.csrf, { ...opts, publicUrl: s.config.publicUrl }))
      return render(t('error.csrf'), 403);
    const ip = clientIp(c, s.config.trustProxy);
    const email = (form.email ?? '').trim().toLowerCase();
    // The address first: a client over its limit does not use up the account's attempts too.
    if (!s.rateLimiter.consume(`login:ip:${clientRateKey(c, s.config.trustProxy)}`, 20, 15 * 60_000).allowed)
      return render(t('login.rateLimited'), 429);
    if (!s.rateLimiter.consume(`login:email:${email}`, 10, 15 * 60_000).allowed)
      return render(t('login.rateLimited'), 429);

    const user = await authenticate(s.db, email, form.password ?? '');
    if (!user) {
      s.logger.warn({ ip }, 'failed login');
      return render(t('login.invalid'), 400);
    }
    s.rateLimiter.reset(`login:email:${email}`);
    if (user.status !== 'active') return render(t('login.suspended'), 403);
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
    const next = nextOf(c.req.query('next'));
    const pending = await s.pendingLogins.get(readCookie(c, PENDING_LOGIN_COOKIE, cookieOpts(c)));
    if (!pending) return c.redirect(`/login?next=${encodeURIComponent(next)}`, 302);
    return renderVerify(c, pending.userId, next);
  });

  app.post('/login/verify', async (c) => {
    const s = c.get('services');
    const t = c.get('t');
    const form = await bodyParams(c);
    const next = nextOf(form.next);
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
    try {
      await finishSignIn(c, completed.userId, [...completed.amr, method]);
    } catch (error) {
      if (!(error instanceof SignInRefused)) throw error;
      return c.redirect('/login?error=suspended', 303);
    }
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
      const next = nextOf(body.next);
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
    const next = nextOf(req.body.next);
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
      if (error instanceof SignInRefused) return c.json({ error: c.get('t')('login.suspended') }, 403);
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
    return c.redirect('/', 303);
  });

  return app;
}
