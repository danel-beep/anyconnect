import type { Child, FC } from 'hono/jsx';
import { BRAND } from '../brand.js';
import { ASSET_URLS } from './asset-urls.js';
import { type JsonLd, serializeJsonLd } from './seo/structured-data.js';
import type { Alternate } from './seo/urls.js';

/** What search engines and link previews read from a public page's head (see `SiteLayout`). */
export interface PageMeta {
  /** The same page in every language (`hreflang`), absolute URLs. */
  alternates?: Alternate[];
  /** Open Graph locale of this page and of its other languages, e.g. en_US. */
  ogLocale?: string;
  ogLocaleAlternates?: string[];
  ogType?: 'website' | 'article';
  /** Absolute URL of the 1200×630 preview image. */
  image?: string;
  imageAlt?: string;
  /** schema.org data of the page. */
  jsonLd?: JsonLd[];
  /** Search console ownership tokens (`google-site-verification`, `msvalidate.01`). */
  verification?: { google?: string | undefined; bing?: string | undefined };
}

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
  meta?: PageMeta;
  children?: Child;
}> = ({ title, lang, description, canonical, noindex, bodyClass, passkeys, meta, children }) => (
  <html lang={lang}>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="referrer" content="no-referrer" />
      <title>{title}</title>
      {description ? <meta name="description" content={description} /> : null}
      {noindex ? <meta name="robots" content="noindex, nofollow" /> : null}
      {canonical ? <link rel="canonical" href={canonical} /> : null}
      {meta?.alternates?.map((a) => (
        <link rel="alternate" hreflang={a.hreflang} href={a.href} />
      ))}
      <meta property="og:title" content={title} />
      {description ? <meta property="og:description" content={description} /> : null}
      <meta property="og:type" content={meta?.ogType ?? 'website'} />
      <meta property="og:site_name" content={BRAND.name} />
      {canonical ? <meta property="og:url" content={canonical} /> : null}
      {meta?.ogLocale ? <meta property="og:locale" content={meta.ogLocale} /> : null}
      {meta?.ogLocaleAlternates?.map((l) => (
        <meta property="og:locale:alternate" content={l} />
      ))}
      {meta?.image ? (
        <>
          <meta property="og:image" content={meta.image} />
          <meta property="og:image:width" content="1200" />
          <meta property="og:image:height" content="630" />
          {meta.imageAlt ? <meta property="og:image:alt" content={meta.imageAlt} /> : null}
          <meta name="twitter:card" content="summary_large_image" />
          <meta name="twitter:image" content={meta.image} />
        </>
      ) : null}
      <meta name="twitter:title" content={title} />
      {description ? <meta name="twitter:description" content={description} /> : null}
      {meta?.verification?.google ? (
        <meta name="google-site-verification" content={meta.verification.google} />
      ) : null}
      {meta?.verification?.bing ? <meta name="msvalidate.01" content={meta.verification.bing} /> : null}
      {meta?.jsonLd?.length ? (
        // A data block, not a script: the CSP does not apply and nothing runs.
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: serializeJsonLd(meta.jsonLd.length === 1 ? meta.jsonLd[0]! : meta.jsonLd),
          }}
        />
      ) : null}
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
