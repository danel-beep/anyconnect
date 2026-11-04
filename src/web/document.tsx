import type { Child, FC } from 'hono/jsx';
import { ASSET_URLS } from './asset-urls.js';

/**
 * The HTML document every page shares: fonts and styles from `/assets/app.css`, the theme script
 * (sets the saved light/dark choice before the first paint) and the enhancement script.
 */
export const Doc: FC<{
  title: string;
  lang: string;
  description?: string;
  /** Absolute canonical URL (public pages). */
  canonical?: string;
  /** Pages behind sign-in or with one-time content are not indexed. */
  noindex?: boolean;
  bodyClass?: string;
  /** Adds /assets/webauthn.js (passkeys). */
  passkeys?: boolean;
  children?: Child;
}> = ({ title, lang, description, canonical, noindex, bodyClass, passkeys, children }) => (
  <html lang={lang}>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="referrer" content="no-referrer" />
      <title>{title}</title>
      {description ? <meta name="description" content={description} /> : null}
      {noindex ? <meta name="robots" content="noindex, nofollow" /> : null}
      {canonical ? <link rel="canonical" href={canonical} /> : null}
      <meta property="og:title" content={title} />
      {description ? <meta property="og:description" content={description} /> : null}
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="AnyConnect" />
      {canonical ? <meta property="og:url" content={canonical} /> : null}
      <meta name="theme-color" content="#f6f6f4" media="(prefers-color-scheme: light)" />
      <meta name="theme-color" content="#232326" media="(prefers-color-scheme: dark)" />
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      <link
        rel="preload"
        href="/assets/fonts/onest-latin.woff2"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />
      <link rel="stylesheet" href={ASSET_URLS.css} />
      <script src={ASSET_URLS.theme} />
      <script src={ASSET_URLS.site} defer />
      {passkeys ? <script src={ASSET_URLS.webauthn} defer /> : null}
    </head>
    <body class={bodyClass}>{children}</body>
  </html>
);
