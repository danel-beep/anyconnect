import type { Locale } from '../i18n.js';

/** A text in every site language. */
export type Localized<T = string> = Record<Locale, T>;

export interface QA {
  q: string;
  a: string;
}

/** Picks the reader's language. */
export const pick = <T>(value: Localized<T>, lang: Locale): T => value[lang];
