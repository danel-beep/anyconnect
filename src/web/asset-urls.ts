import { createHash } from 'node:crypto';
import { SITE_JS, THEME_JS } from './client-scripts.js';
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
} as const;
