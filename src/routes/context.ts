import type { Context } from 'hono';
import type { Principal } from '../core/principal.js';
import type { Services } from '../services.js';
import { readCookie } from '../web/http.js';
import type { Locale, Translate } from '../web/i18n.js';
import type { SessionUser } from '../web/sessions.js';

export interface AppEnv {
  Variables: {
    services: Services;
    locale: Locale;
    t: Translate;
    principal?: Principal;
  };
}

export type AppContext = Context<AppEnv>;

export const SESSION_COOKIE = 'ac_session';

export async function currentUser(c: AppContext): Promise<SessionUser | undefined> {
  const services = c.get('services');
  const token = readCookie(c, SESSION_COOKIE, { secure: services.config.secureCookies });
  return services.sessions.get(token);
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
