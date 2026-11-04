import type { Locale, Translate } from './i18n.js';

/** What every page needs about the request: language, path, who is signed in, what the hub offers. */
export interface PageCtx {
  t: Translate;
  lang: Locale;
  /** Current path with query, for the language switch and "next" links. */
  path: string;
  /** Public origin, e.g. https://manyplug.app (canonical links, Open Graph). */
  publicUrl: string;
  mcpUrl: string;
  user?: { email: string; name: string | null; isAdmin: boolean } | undefined;
  /** "Sign in with Google" is configured. */
  google: boolean;
  signupsOpen: boolean;
  supportEmail?: string | undefined;
  /** A payment provider is connected (otherwise paid plans are assigned by the team). */
  billing: boolean;
  /** CSRF token for forms on the page (sign-out, actions). */
  csrf: string;
}
