import { randomBytes } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { safeEqual } from '../lib/crypto.js';

export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0]!.trim();
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface CookieOptions {
  secure: boolean;
}

/** `__Host-` prefixed cookies (https only) cannot be set by subdomains or over plain http. */
export const cookieName = (base: string, opts: CookieOptions) => (opts.secure ? `__Host-${base}` : base);

export function setSecureCookie(
  c: Context,
  base: string,
  value: string,
  opts: CookieOptions & { maxAge: number },
) {
  setCookie(c, cookieName(base, opts), value, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: opts.maxAge,
  });
}

export function readCookie(c: Context, base: string, opts: CookieOptions): string | undefined {
  return getCookie(c, cookieName(base, opts));
}

export function clearCookie(c: Context, base: string, opts: CookieOptions) {
  deleteCookie(c, cookieName(base, opts), { path: '/', secure: opts.secure });
}

// ---------------------------------------------------------------------------
// CSRF: double-submit cookie + Origin check
// ---------------------------------------------------------------------------

const CSRF_COOKIE = 'ac_csrf';

/** Returns the CSRF token for forms, issuing the cookie when needed. */
export function csrfToken(c: Context, opts: CookieOptions): string {
  const existing = readCookie(c, CSRF_COOKIE, opts);
  if (existing && existing.length >= 32) return existing;
  const token = randomBytes(24).toString('base64url');
  setSecureCookie(c, CSRF_COOKIE, token, { ...opts, maxAge: 60 * 60 * 24 });
  return token;
}

export function verifyCsrf(
  c: Context,
  formToken: unknown,
  opts: CookieOptions & { publicUrl: string },
): boolean {
  const origin = c.req.header('origin');
  if (origin && origin !== 'null' && origin !== opts.publicUrl) return false;
  const cookie = readCookie(c, CSRF_COOKIE, opts);
  return typeof formToken === 'string' && Boolean(cookie) && safeEqual(formToken, cookie!);
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/** Sets response headers, copying the response first if its headers are immutable (e.g. redirects). */
export function setResponseHeaders(c: Context, headers: Record<string, string>): void {
  try {
    for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
  } catch {
    c.res = new Response(c.res.body, c.res);
    for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
  }
}

/** Strict headers for the hub's own HTML pages (login, consent, home). */
export function pageSecurityHeaders(opts: { hsts: boolean }): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const type = c.res.headers.get('content-type') ?? '';
    if (!type.includes('text/html')) return;
    setResponseHeaders(c, {
      // No form-action: Chrome applies it to the redirect after the consent form, which must reach the AI app.
      'Content-Security-Policy':
        "default-src 'none'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      ...(opts.hsts ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    });
  };
}

/** Permissive CORS for endpoints used by browser-based MCP clients (bearer tokens, no cookies). */
export function publicCors(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers':
            'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    await next();
    setResponseHeaders(c, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version',
    });
  };
}

/** Only allow redirects to local paths after login. */
export function safeNextPath(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.includes('\\'))
    return '/';
  return next;
}
