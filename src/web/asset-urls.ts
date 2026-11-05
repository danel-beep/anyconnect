import { createHash } from 'node:crypto';
import { PADDLE_CHECKOUT_JS, SITE_JS, THEME_JS } from './client-scripts.js';
import { APP_CSS } from './styles.js';
import { WEBAUTHN_JS } from './webauthn-client.js';

/**
 * Addresses of the site's own styles and scripts with a content version (`?v=<hash>`): a deploy
 * that changes a file changes its address, so browsers load the new file right away instead of
 * keeping the cached copy for an hour. The routes serve the file whatever the version says.
 */
const versioned = (path: string, body: string) =>
  `${path}?v=${createHash('sha256').update(body).digest('hex').slice(0, 12)}`;

export const ASSET_URLS = {
  css: versioned('/assets/app.css', APP_CSS),
  theme: versioned('/assets/theme.js', THEME_JS),
  site: versioned('/assets/site.js', SITE_JS),
  webauthn: versioned('/assets/webauthn.js', WEBAUTHN_JS),
  paddleCheckout: versioned('/assets/paddle-checkout.js', PADDLE_CHECKOUT_JS),
} as const;

const ONE_YEAR = 'public, max-age=31536000, immutable';
const ONE_HOUR = 'public, max-age=3600';

/**
 * `Cache-Control` for one of the files above: a request for the current version (`?v=` matches)
 * may be kept for a year, since a new deploy changes the address; anything else (an old or no
 * version) only for an hour.
 */
export function assetCacheControl(url: string, requestedVersion: string | undefined): string {
  const current = new URL(url, 'https://local.invalid').searchParams.get('v');
  return current && requestedVersion === current ? ONE_YEAR : ONE_HOUR;
}
