import type { Context } from 'hono';
import { isStrongAuth } from '../core/auth-methods.js';
import type { Principal } from '../core/principal.js';
import type { Services } from '../services.js';
import { readCookie } from '../web/http.js';
import type { Locale, Translate } from '../web/i18n.js';
import type { SessionUser, WebSession } from '../web/sessions.js';

export interface AppEnv {
  Variables: {
    services: Services;
    locale: Locale;
    t: Translate;
    principal?: Principal;
    /** Session of this request, looked up once (null = signed out). */
    webSession?: (WebSession & { token: string }) | null;
  };
}

export type AppContext = Context<AppEnv>;

export const SESSION_COOKIE = 'ac_session';
/** Holds the pending-login token between the password and the second-factor step. */
export const PENDING_LOGIN_COOKIE = 'ac_mfa';

export async function currentSession(c: AppContext): Promise<(WebSession & { token: string }) | undefined> {
  const cached = c.get('webSession');
  if (cached !== undefined) return cached ?? undefined;
  const services = c.get('services');
  const token = readCookie(c, SESSION_COOKIE, { secure: services.config.secureCookies });
  const session = await services.sessions.getSession(token);
  const value = session && token ? { ...session, token } : null;
  c.set('webSession', value);
  return value ?? undefined;
}

export async function currentUser(c: AppContext): Promise<SessionUser | undefined> {
  return (await currentSession(c))?.user;
}

/** Forgets the cached session, e.g. after signing in or out within the request. */
export function resetSessionCache(c: AppContext): void {
  c.set('webSession', undefined);
}

export const loginUrl = (next: string, opts: { reauth?: boolean } = {}) =>
  `/login?${opts.reauth ? 'reauth=1&' : ''}next=${encodeURIComponent(next)}`;

/**
 * With REQUIRE_2FA: where a signed-in user has to go before using the panel or approving an
 * app. Users without a second factor set one up on /security; users who have one but signed in
 * without it (an older session) confirm the sign-in again. Undefined = may proceed.
 */
export async function secondFactorRedirect(
  c: AppContext,
  session: WebSession,
  next: string,
): Promise<string | undefined> {
  const s = c.get('services');
  if (!s.config.auth.requireSecondFactor) return undefined;
  if (!(await s.secondFactors.hasAny(session.user.id))) return `/security?next=${encodeURIComponent(next)}`;
  if (!isStrongAuth(session.amr)) return loginUrl(next, { reauth: true });
  return undefined;
}

/** Request params from a form-urlencoded or JSON body, as plain strings. */
export async function bodyParams(c: AppContext): Promise<Record<string, string>> {
  const type = c.req.header('content-type') ?? '';
  let raw: Record<string, unknown> = {};
  if (type.includes('application/json')) {
    raw = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  } else {
    raw = await c.req.parseBody().catch(() => ({}));
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) if (typeof value === 'string') out[key] = value;
  return out;
}
