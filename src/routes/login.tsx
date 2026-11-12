import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthMethod } from '../core/auth-methods.js';
import { ExternalLoginError } from '../core/external-login.js';
import { authenticate, normalizeEmail, type User } from '../core/identity.js';
import { PasskeyError } from '../core/passkeys.js';
import { type ExternalProfile, SignInRefused } from '../core/users.js';
import { EMAIL_LOGIN_TTL_SECONDS } from '../web/email-logins.js';
import { composeEmail } from '../web/emails.js';
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
import { DEVICE_COOKIE, DEVICE_COOKIE_MAX_AGE } from '../web/known-devices.js';
import {
  EmailLinkConfirmPage,
  EmailLinkSentPage,
  ErrorPage,
  type LoginMode,
  LoginPage,
} from '../web/pages.js';
import { PENDING_LOGIN_TTL_SECONDS } from '../web/pending-logins.js';
import { VerifyPage } from '../web/security-pages.js';
import { agentName } from '../web/user-agent.js';
import { analyticsRequest } from './analytics.js';
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
import { attachReferral } from './referral.js';

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
  const ip = clientIp(c, s.config.trustProxy);
  const userAgent = c.req.header('user-agent');
  // A browser is known by its cookie, or (cookies get cleared) by a session from the same address
  // and browser. Checked before the old session goes.
  const devices = readCookie(c, DEVICE_COOKIE, opts);
  const known = s.knownDevices.knows(devices, userId) || (await s.sessions.seenFrom(userId, ip, userAgent));
  await s.sessions.destroy(readCookie(c, SESSION_COOKIE, opts));
  const token = await s.sessions.create(userId, { amr, ip, userAgent });
  setSecureCookie(c, SESSION_COOKIE, token, { ...opts, maxAge: s.config.sessionTtlSeconds });
  setSecureCookie(c, DEVICE_COOKIE, s.knownDevices.remember(devices, userId), {
    ...opts,
    maxAge: DEVICE_COOKIE_MAX_AGE,
  });
  // The very first sign-in is the sign-up itself: there is nothing to compare it with.
  if (!known && user.lastLoginAt)
    void s.securityNotices.report(userId, 'sign_in', agentName(userAgent) ?? '');
  clearCookie(c, PENDING_LOGIN_COOKIE, opts);
  if (user.locale === 'ru' || user.locale === 'en') saveLocale(c, user.locale);
  resetSessionCache(c);
  s.logger.info({ userId, ip, amr }, 'user signed in');
}

/**
 * After the first factor (an external sign-in or an email link) is proven: counts a new sign-up,
 * then asks for the second factor if the user has one, or signs them in.
 */
async function completeFirstFactor(
  c: AppContext,
  result: { user: User; created: boolean },
  via: { source: string; method: AuthMethod; next: string; status: 302 | 303 },
) {
  const s = c.get('services');
  const { user, created } = result;
  const { next, status } = via;
  if (created) {
    s.logger.info({ userId: user.id, provider: via.source }, 'user signed up');
    await attachReferral(c, user.id);
    s.analytics.track('signup', via.source);
    // Where they came from: the visit of the same browser today or yesterday (docs/ANALYTICS.md).
    await s.analytics.attributeSignup(user.id, analyticsRequest(c));
  }
  if (await s.secondFactors.hasAny(user.id)) {
    const pending = await s.pendingLogins.create(user.id, [via.method]);
    setSecureCookie(c, PENDING_LOGIN_COOKIE, pending, {
      ...cookieOpts(c),
      maxAge: PENDING_LOGIN_TTL_SECONDS,
    });
    return c.redirect(`/login/verify?next=${encodeURIComponent(next)}`, status);
  }
  await finishSignIn(c, user.id, [via.method]);
  return c.redirect(created && next === '/app' ? '/app?welcome=1' : next, status);
}

/** Sign-in links: per client, per address, and for the whole hub (the mail provider's quota). */
const EMAIL_LINK_LIMITS = {
  ip: { max: 10, windowMs: 15 * 60_000 },
  address: { max: 3, windowMs: 15 * 60_000 },
  hub: { max: 120, windowMs: 60 * 60_000 },
} as const;

/** Holds the external sign-in state in the browser that started it (checked on the callback). */
const EXTERNAL_STATE_COOKIE = 'ac_login';

/** Messages a redirect back to /login may show (`?error=`); anything else is ignored. */
const LOGIN_ERRORS = {
  externalFailed: 'login.externalFailed',
  externalCancelled: 'login.externalCancelled',
  expired: 'login.expired',
  suspended: 'login.refused.suspended',
  signups_closed: 'login.refused.signups_closed',
  signups_closed_email: 'login.refused.signups_closed_email',
  linkExpired: 'login.linkExpired',
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
        emailLink={s.emailLogins.enabled}
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
    // Back to the sign-in page, still on the way to where the user was going (e.g. an app's consent).
    const back = (code: LoginError, next?: string) => {
      const target = next === undefined ? '/app' : nextOf(next);
      const query = target === '/app' ? '' : `&next=${encodeURIComponent(target)}`;
      return c.redirect(`/login?error=${code}${query}`, 302);
    };
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
      if (!browserState) return back('expired');
      return back(error.cancelled ? 'externalCancelled' : 'externalFailed', error.next);
    }
    const next = nextOf(result.next);
    try {
      const signedIn = await s.users.signInExternal(result.profile);
      return await completeFirstFactor(c, signedIn, {
        source: providerId,
        method: 'fed',
        next,
        status: 302,
      });
    } catch (error) {
      if (!(error instanceof SignInRefused)) throw error;
      s.logger.warn({ provider: providerId, reason: error.reason }, 'external sign-in refused');
      return back(error.reason, next);
    }
  });

  // --- Sign-in link by email ------------------------------------------------
  // Ask for a link → the mail → a confirmation page → the button signs in. The answer to "send me
  // a link" is the same for every address, so it does not tell who has an account.
  app.post('/login/email', async (c) => {
    const s = c.get('services');
    const t = c.get('t');
    if (!s.emailLogins.enabled || !s.mailer) return c.notFound();
    const form = await bodyParams(c);
    const next = nextOf(form.next);
    const render = (error: string, status: 400 | 403 | 429) =>
      renderLogin(c, { mode: 'login', next, email: form.email ?? '', error, status });
    if (!verifyCsrf(c, form.csrf, { ...cookieOpts(c), publicUrl: s.config.publicUrl }))
      return render(t('error.csrf'), 403);
    const address = z.string().trim().max(254).email().safeParse(form.email);
    if (!address.success) return render(t('login.link.invalid'), 400);
    const email = normalizeEmail(address.data);
    const limits = EMAIL_LINK_LIMITS;
    const ipKey = `email-link:ip:${clientRateKey(c, s.config.trustProxy)}`;
    if (!s.rateLimiter.consume(ipKey, limits.ip.max, limits.ip.windowMs).allowed)
      return render(t('login.rateLimited'), 429);
    // Past the per-address or hub-wide limit nothing is sent, quietly: the page stays the same.
    const send =
      s.rateLimiter.consume(`email-link:to:${email}`, limits.address.max, limits.address.windowMs).allowed &&
      s.rateLimiter.consume('email-link:hub', limits.hub.max, limits.hub.windowMs).allowed &&
      (await s.users.canSignInByEmail(email));
    if (send) {
      const token = await s.emailLogins.create(email, next);
      try {
        await s.mailer.send(
          composeEmail(
            { email, name: null, locale: c.get('locale') },
            {
              tag: 'auth.sign_in_link',
              subject: 'email.signIn.subject',
              paragraphs: ['email.signIn.body', 'email.signIn.ignore'],
              cta: {
                label: 'email.signIn.cta',
                url: `${s.config.publicUrl}/login/email/confirm?token=${encodeURIComponent(token)}`,
              },
              vars: { minutes: EMAIL_LOGIN_TTL_SECONDS / 60 },
              footer: 'email.signIn.footer',
            },
            { billingUrl: `${s.config.publicUrl}/app/billing` },
          ),
        );
      } catch (error) {
        s.ops.errors.capture(error, { source: 'email-login' });
      }
    }
    return c.html(<EmailLinkSentPage t={t} lang={c.get('locale')} email={email} next={next} />);
  });

  app.get('/login/email/confirm', async (c) => {
    const s = c.get('services');
    const token = c.req.query('token');
    const link = await s.emailLogins.get(token);
    if (!link || !token) return c.redirect('/login?error=linkExpired', 302);
    return c.html(
      <EmailLinkConfirmPage
        t={c.get('t')}
        lang={c.get('locale')}
        csrf={csrfToken(c, cookieOpts(c))}
        token={token}
        email={link.email}
      />,
    );
  });

  app.post('/login/email/confirm', async (c) => {
    const s = c.get('services');
    const t = c.get('t');
    const form = await bodyParams(c);
    const refuse = (message: string, status: 403 | 429) =>
      c.html(<ErrorPage t={t} lang={c.get('locale')} message={message} />, status);
    if (!verifyCsrf(c, form.csrf, { ...cookieOpts(c), publicUrl: s.config.publicUrl }))
      return refuse(t('error.csrf'), 403);
    const ipKey = `email-link:confirm:${clientRateKey(c, s.config.trustProxy)}`;
    if (!s.rateLimiter.consume(ipKey, 30, 15 * 60_000).allowed) return refuse(t('login.rateLimited'), 429);
    const link = await s.emailLogins.consume(form.token);
    if (!link) return c.redirect('/login?error=linkExpired', 303);
    const next = nextOf(link.next);
    try {
      const signedIn = await s.users.signInEmail(link.email);
      return await completeFirstFactor(c, signedIn, { source: 'email', method: 'eml', next, status: 303 });
    } catch (error) {
      if (!(error instanceof SignInRefused)) throw error;
      s.logger.warn({ reason: error.reason }, 'email sign-in refused');
      const code: LoginError = error.reason === 'signups_closed' ? 'signups_closed_email' : error.reason;
      const query = next === '/app' ? '' : `&next=${encodeURIComponent(next)}`;
      return c.redirect(`/login?error=${code}${query}`, 303);
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
