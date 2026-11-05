import { DEFAULT_LOCALE, type Locale } from '../i18n.js';

/**
 * Addresses of public pages per language. English lives at the plain path; another language adds
 * `?lang=<code>`, so search engines and shared links can reach every language without a cookie
 * (the RU/EN switch still remembers the choice in a cookie for people).
 */
export const SITE_LOCALES: readonly Locale[] = ['en', 'ru'];

/** Query parameter that picks the page language for one request. */
export const LANG_PARAM = 'lang';

export const OG_LOCALE: Record<Locale, string> = { en: 'en_US', ru: 'ru_RU' };

export function parseLocale(value: unknown): Locale | undefined {
  return typeof value === 'string' && (SITE_LOCALES as readonly string[]).includes(value)
    ? (value as Locale)
    : undefined;
}

const BASE = 'https://local.invalid';

/** `path` (with any query) without the language parameter. */
export function withoutLang(path: string): string {
  const url = new URL(path, BASE);
  url.searchParams.delete(LANG_PARAM);
  return url.pathname + url.search + url.hash;
}

/** The address of a page in a language: `/docs` for English, `/docs?lang=ru` for Russian. */
export function localizedPath(path: string, lang: Locale): string {
  const url = new URL(path, BASE);
  url.searchParams.delete(LANG_PARAM);
  if (lang !== DEFAULT_LOCALE) url.searchParams.set(LANG_PARAM, lang);
  return url.pathname + url.search + url.hash;
}

export interface Alternate {
  /** A language code, or `x-default` for visitors whose language has no version. */
  hreflang: string;
  href: string;
}

/** `<link rel="alternate" hreflang>` entries of a page: every language plus `x-default` (English). */
export function alternates(publicUrl: string, path: string): Alternate[] {
  return [
    ...SITE_LOCALES.map((lang) => ({ hreflang: lang, href: `${publicUrl}${localizedPath(path, lang)}` })),
    { hreflang: 'x-default', href: `${publicUrl}${localizedPath(path, DEFAULT_LOCALE)}` },
  ];
}
