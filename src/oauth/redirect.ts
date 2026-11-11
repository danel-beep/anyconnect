/**
 * Redirect URI rules (OAuth 2.1 + RFC 8252 for native apps):
 * - https URLs: any host
 * - http URLs: loopback only (localhost, 127.0.0.1, [::1]); the port is ignored when matching
 * - private-use schemes for native apps (e.g. `cursor://...`)
 * - never fragments or dangerous schemes
 */

const FORBIDDEN_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'about:',
  'blob:',
  'ftp:',
  'ws:',
  'wss:',
]);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopbackRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** Returns an error message, or undefined when the URI is acceptable for registration. */
export function validateRedirectUri(uri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return `Invalid redirect URI: ${uri}`;
  }
  if (url.hash || uri.includes('#')) return 'Redirect URIs must not contain a fragment';
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return `Redirect URI scheme ${url.protocol} is not allowed`;
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    return 'http redirect URIs are only allowed for loopback addresses; use https';
  }
  if (url.protocol === 'https:' && !url.hostname) return 'Redirect URI must have a host';
  if (url.username || url.password) return 'Redirect URIs must not contain credentials';
  return undefined;
}

/** Exact match, except loopback http redirects where the port may differ (RFC 8252 §7.3). */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  if (!isLoopbackRedirect(requested)) return false;
  const req = new URL(requested);
  return registered.some((candidate) => {
    if (!isLoopbackRedirect(candidate)) return false;
    const reg = new URL(candidate);
    return (
      reg.protocol === req.protocol &&
      reg.hostname === req.hostname &&
      reg.pathname === req.pathname &&
      reg.search === req.search
    );
  });
}

export { knownAppInName, knownClientName } from '../core/ai-apps.js';
