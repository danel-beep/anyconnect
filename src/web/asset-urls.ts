import { FONT_ASSETS } from './assets.js';
import { PADDLE_CHECKOUT_JS, SITE_JS, THEME_JS } from './client-scripts.js';
import { FAVICON_SVG } from './favicon.js';
import { OG_IMAGE_PNG } from './seo/og-image.js';
import { type StaticAsset, staticAsset } from './static-asset.js';
import { APP_CSS } from './styles.js';
import { WEBAUTHN_JS } from './webauthn-client.js';

const JS = 'text/javascript; charset=utf-8';

/**
 * The site's own static files, each with a content-versioned address (see `StaticAsset`). A new
 * file is one entry here: `assetRoutes()` serves every entry (compressed once, cached by version)
 * and pages link `STATIC_ASSETS.<name>.url`.
 */
export const STATIC_ASSETS = {
  css: staticAsset('/assets/app.css', 'text/css; charset=utf-8', APP_CSS),
  theme: staticAsset('/assets/theme.js', JS, THEME_JS),
  site: staticAsset('/assets/site.js', JS, SITE_JS),
  webauthn: staticAsset('/assets/webauthn.js', JS, WEBAUTHN_JS),
  paddleCheckout: staticAsset('/assets/paddle-checkout.js', JS, PADDLE_CHECKOUT_JS),
  favicon: staticAsset('/favicon.svg', 'image/svg+xml', FAVICON_SVG),
  ogImage: staticAsset('/assets/og.png', 'image/png', new Uint8Array(OG_IMAGE_PNG)),
} as const satisfies Record<string, StaticAsset>;

/** Every file `assetRoutes()` serves: the named ones above and the fonts. */
export const ALL_STATIC_ASSETS: readonly StaticAsset[] = [
  ...Object.values(STATIC_ASSETS),
  ...Object.values(FONT_ASSETS),
];

/** Addresses of the named files, for `<link>` and `<script>` tags. */
export const ASSET_URLS = Object.fromEntries(
  Object.entries(STATIC_ASSETS).map(([name, asset]) => [name, asset.url]),
) as { readonly [K in keyof typeof STATIC_ASSETS]: string };
