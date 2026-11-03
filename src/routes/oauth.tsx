import { Hono } from 'hono';
import { authenticate, getDefaultWorkspace } from '../core/identity.js';
import { OAuthProtocolError } from '../oauth/clients.js';
import { isLoopbackRedirect, knownClientName } from '../oauth/redirect.js';
import type { AuthorizationRequest } from '../oauth/server.js';
import {
  clearCookie,
  clientIp,
  csrfToken,
  publicCors,
  readCookie,
  safeNextPath,
  setSecureCookie,
  verifyCsrf,
} from '../web/http.js';
import { ConsentPage, ErrorPage, LoginPage } from '../web/pages.js';
import { type AppContext, type AppEnv, bodyParams, currentUser, SESSION_COOKIE } from './context.js';

const OAUTH_PARAMS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'state',
  'code_challenge',
  'code_challenge_method',
  'scope',
  'resource',
] as const;

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function pickOAuthParams(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of OAUTH_PARAMS) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function oauthErrorResponse(c: AppContext, error: unknown) {
  if (error instanceof OAuthProtocolError) {
    const headers: Record<string, string> = { ...NO_STORE };
    if (error.status === 401 && c.req.header('authorization')?.toLowerCase().startsWith('basic ')) {
      headers['WWW-Authenticate'] = 'Basic realm="anyconnect"';
    }
    return c.json(error.toJSON(), error.status as 400 | 401, headers);
  }
  throw error;
}

function rateLimited(c: AppContext, key: string, limit: number, windowMs: number) {
  const result = c.get('services').rateLimiter.consume(key, limit, windowMs);
  if (result.allowed) return undefined;
  return c.json({ error: 'slow_down', error_description: 'Too many requests' }, 429, {
    'Retry-After': String(result.retryAfterSeconds),
  });
}

function displayName(request: AuthorizationRequest): { clientName: string; verifiedDomain?: string } {
  const verifiedDomain =
    request.client.registrationType === 'metadata_document' ? new URL(request.client.id).host : undefined;
  const clientName =
    request.client.metadata.client_name ??
    verifiedDomain ??
    knownClientName(new URL(request.redirectUri).host) ??
    'Application';
  return verifiedDomain ? { clientName, verifiedDomain } : { clientName };
}

async function renderConsent(c: AppContext, request: AuthorizationRequest, params: Record<string, string>) {
  const s = c.get('services');
  const user = (await currentUser(c))!;
  const workspace = await getDefaultWorkspace(s.db, user.id);
  if (!workspace)
    return c.html(<ErrorPage t={c.get('t')} lang={c.get('locale')} message="No workspace" />, 500);
  const accounts = await s.accounts.list(workspace.id);
  const redirect = new URL(request.redirectUri);
  const redirectHost = redirect.host || `${redirect.protocol}//`;
  const { clientName, verifiedDomain } = displayName(request);
  const knownApp =
    knownClientName(redirect.host) ?? (verifiedDomain ? knownClientName(verifiedDomain) : undefined);
  return c.html(
    <ConsentPage
      t={c.get('t')}
      lang={c.get('locale')}
      view={{
        clientName,
        ...(verifiedDomain ? { verifiedDomain } : {}),
        redirectHost,
        ...(knownApp && redirect.protocol === 'https:' ? { knownApp } : {}),
        loopback: isLoopbackRedirect(request.redirectUri),
        workspaceName: workspace.name,
        activeAccounts: accounts.filter((a) => a.enabled).length,
        email: user.email,
        csrf: csrfToken(c, { secure: s.config.secureCookies }),
        hidden: params,
      }}
    />,
  );
}

/** OAuth authorization server endpoints plus the login and consent pages they rely on. */
export function oauthRoutes() {
  const app = new Hono<AppEnv>();

  // --- Discovery ------------------------------------------------------------
  app.use('/.well-known/*', publicCors());
  app.get('/.well-known/oauth-authorization-server', (c) => c.json(c.get('services').oauth.metadata()));
  app.get('/.well-known/oauth-protected-resource', (c) =>
    c.json(c.get('services').oauth.protectedResourceMetadata()),
  );
  app.get('/.well-known/oauth-protected-resource/mcp', (c) =>
    c.json(c.get('services').oauth.protectedResourceMetadata()),
  );

  // --- Client registration, token, revocation (machine endpoints) ----------
  app.use('/oauth/register', publicCors());
  app.use('/oauth/token', publicCors());
  app.use('/oauth/revoke', publicCors());

  app.post('/oauth/register', async (c) => {
    const s = c.get('services');
    const limited = rateLimited(c, `register:${clientIp(c, s.config.trustProxy)}`, 30, 60 * 60_000);
    if (limited) return limited;
    const body = await c.req.json().catch(() => undefined);
    try {
      return c.json(await s.clients.register(body), 201, NO_STORE);
    } catch (error) {
      return oauthErrorResponse(c, error);
    }
  });

  app.post('/oauth/token', async (c) => {
    const s = c.get('services');
    const limited = rateLimited(c, `token:${clientIp(c, s.config.trustProxy)}`, 120, 60_000);
    if (limited) return limited;
    try {
      const tokens = await s.oauth.token(await bodyParams(c), c.req.header('authorization'));
      return c.json(tokens, 200, NO_STORE);
    } catch (error) {
      return oauthErrorResponse(c, error);
    }
  });

  app.post('/oauth/revoke', async (c) => {
    const s = c.get('services');
    try {
      await s.oauth.revoke(await bodyParams(c), c.req.header('authorization'));
      return c.body(null, 200, NO_STORE);
    } catch (error) {
      return oauthErrorResponse(c, error);
    }
  });

  // --- Authorization (browser) ---------------------------------------------
  app.get('/oauth/authorize', async (c) => {
    const s = c.get('services');
    const params = pickOAuthParams(c.req.query());
    const validation = await s.oauth.validateAuthorizationRequest(params);
    if (validation.kind === 'error_page') {
      return c.html(
        <ErrorPage t={c.get('t')} lang={c.get('locale')} message={validation.description} />,
        400,
      );
    }
    if (validation.kind === 'error_redirect') return c.redirect(validation.location, 302);
    if (!(await currentUser(c))) {
      const url = new URL(c.req.url);
      return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
    }
    return renderConsent(c, validation.request, params);
  });

  app.post('/oauth/authorize', async (c) => {
    const s = c.get('services');
    const form = await bodyParams(c);
    if (!verifyCsrf(c, form.csrf, { secure: s.config.secureCookies, publicUrl: s.config.publicUrl })) {
      return c.html(
        <ErrorPage t={c.get('t')} lang={c.get('locale')} message={c.get('t')('error.csrf')} />,
        403,
      );
    }
    const params = pickOAuthParams(form);
    const user = await currentUser(c);
    if (!user) {
      return c.redirect(
        `/login?next=${encodeURIComponent(`/oauth/authorize?${new URLSearchParams(params)}`)}`,
        303,
      );
    }
    const validation = await s.oauth.validateAuthorizationRequest(params);
    if (validation.kind === 'error_page') {
      return c.html(
        <ErrorPage t={c.get('t')} lang={c.get('locale')} message={validation.description} />,
        400,
      );
    }
    if (validation.kind === 'error_redirect') return c.redirect(validation.location, 303);
    if (form.decision !== 'approve') return c.redirect(s.oauth.deny(validation.request), 303);
    const workspace = await getDefaultWorkspace(s.db, user.id);
    if (!workspace)
      return c.html(<ErrorPage t={c.get('t')} lang={c.get('locale')} message="No workspace" />, 500);
    const location = await s.oauth.approve(validation.request, user.id, workspace.id);
    s.logger.info({ clientId: validation.request.client.id, userId: user.id }, 'oauth access approved');
    return c.redirect(location, 303);
  });

  // --- Login / logout -------------------------------------------------------
  app.get('/login', async (c) => {
    const s = c.get('services');
    const next = safeNextPath(c.req.query('next'));
    if (await currentUser(c)) return c.redirect(next, 302);
    const csrf = csrfToken(c, { secure: s.config.secureCookies });
    return c.html(<LoginPage t={c.get('t')} lang={c.get('locale')} csrf={csrf} next={next} />);
  });

  app.post('/login', async (c) => {
    const s = c.get('services');
    const t = c.get('t');
    const form = await bodyParams(c);
    const next = safeNextPath(form.next);
    const cookieOpts = { secure: s.config.secureCookies };
    const csrf = csrfToken(c, cookieOpts);
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
    if (!verifyCsrf(c, form.csrf, { ...cookieOpts, publicUrl: s.config.publicUrl }))
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
    const token = await s.sessions.create(user.id, { ip, userAgent: c.req.header('user-agent') });
    setSecureCookie(c, SESSION_COOKIE, token, { ...cookieOpts, maxAge: s.config.sessionTtlSeconds });
    s.logger.info({ userId: user.id, ip }, 'user signed in');
    return c.redirect(next, 303);
  });

  app.post('/logout', async (c) => {
    const s = c.get('services');
    const cookieOpts = { secure: s.config.secureCookies };
    const form = await bodyParams(c);
    if (!verifyCsrf(c, form.csrf, { ...cookieOpts, publicUrl: s.config.publicUrl })) {
      return c.html(
        <ErrorPage t={c.get('t')} lang={c.get('locale')} message={c.get('t')('error.csrf')} />,
        403,
      );
    }
    await s.sessions.destroy(readCookie(c, SESSION_COOKIE, cookieOpts));
    clearCookie(c, SESSION_COOKIE, cookieOpts);
    return c.redirect('/login', 303);
  });

  return app;
}
