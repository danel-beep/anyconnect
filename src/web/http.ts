import { randomBytes } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { safeEqual } from '../lib/crypto.js';

/**
 * The client's IP. Behind `hops` proxies that each append the address they saw to X-Forwarded-For,
 * the client is the entry `hops` places from the right; anything further left came from the client
 * and is ignored (it can be forged). A platform header (`header`) wins when it is present.
 */
export function clientIp(c: Context, trust: { hops: number; header?: string }): string {
  if (trust.hops > 0) {
    const platform = trust.header ? c.req.header(trust.header)?.trim() : undefined;
    if (platform) return platform;
    const forwarded = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (forwarded.length) return forwarded[Math.max(0, forwarded.length - trust.hops)]!;
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
      // Scripts only from our own files (/assets/webauthn.js), which call back to our own endpoints.
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'",
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

/**
 * Only allow redirects to paths on this site. Browsers drop tabs and newlines from URLs and treat
 * `\` like `/`, so `/\t/evil.com` or `/\evil.com` would leave the site: control characters and
 * backslashes are refused, and the result is re-read as a URL that must stay on the same origin.
 */
export function safeNextPath(next: unknown, fallback = '/'): string {
  if (typeof next !== 'string' || next.length > 2000 || !next.startsWith('/') || next.startsWith('//'))
    return fallback;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  const base = 'https://local.invalid';
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return fallback;
  }
  if (url.origin !== base) return fallback;
  return url.pathname + url.search + url.hash;
}
