/**
 * Encrypted full-text search, the blind-index way.
 *
 * Message text is stored encrypted, so Postgres cannot read it. Instead, every word is turned
 * into keyed 32-bit hashes of its prefixes (3..12 letters) and stored in an int[] column with a
 * GIN index. A query word is reduced to a stem-like prefix and hashed the same way, so "встреча"
 * finds "встречу", "встречи", "встречаемся" and "meeting" finds "meetings". Candidates found by
 * the index are decrypted and checked again ({@link matchesQuery}), which removes hash collisions.
 *
 * The index reveals neither words nor their order, only that two messages share a prefix hash.
 */

const MIN_PREFIX = 3;
const MAX_PREFIX = 12;
/** Bounds the index size of very long messages. */
const MAX_TOKENS = 800;
const MAX_QUERY_TERMS = 8;

export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replaceAll('ё', 'е');
}

export function words(text: string): string[] {
  return normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Index tokens for a text, namespaced (`t` = message text, `f` = sender, `c` = chat title). */
export function indexTerms(text: string, namespace: string): string[] {
  const out = new Set<string>();
  for (const word of words(text)) {
    if (word.length < 2) continue;
    if (word.length <= MIN_PREFIX) {
      out.add(`${namespace}:${word}`);
      continue;
    }
    const max = Math.min(word.length, MAX_PREFIX);
    for (let len = MIN_PREFIX; len <= max; len++) out.add(`${namespace}:${word.slice(0, len)}`);
    if (out.size >= MAX_TOKENS) break;
  }
  return [...out].slice(0, MAX_TOKENS);
}

// Common inflectional endings, longest first. Stripping them turns a query word into a prefix
// that all its forms share. Deliberately simple: the post-filter keeps results correct.
const RU_ENDINGS = [
  'иями',
  'ями',
  'ами',
  'его',
  'ого',
  'ему',
  'ому',
  'ыми',
  'ими',
  'ией',
  'иях',
  'иям',
  'ах',
  'ях',
  'ов',
  'ев',
  'ей',
  'ой',
  'ий',
  'ый',
  'ая',
  'яя',
  'ое',
  'ее',
  'ые',
  'ие',
  'ую',
  'юю',
  'ом',
  'ем',
  'ам',
  'ям',
  'ть',
  'ся',
  'сь',
  'ы',
  'и',
  'а',
  'я',
  'о',
  'е',
  'у',
  'ю',
  'ь',
  'й',
];
const EN_ENDINGS = ['ings', 'ing', 'ies', 'ied', 'es', 'ed', 's'];

export function stem(word: string): string {
  const endings = /[а-я]/.test(word) ? RU_ENDINGS : EN_ENDINGS;
  for (const ending of endings) {
    if (word.endsWith(ending) && word.length - ending.length >= MIN_PREFIX) {
      return word.slice(0, word.length - ending.length);
    }
  }
  return word;
}

/** Query terms: each word becomes one prefix token. All of them must match. */
export function queryTerms(query: string, namespace: string): string[] {
  const out = new Set<string>();
  for (const word of words(query)) {
    if (word.length < 2) continue;
    const base = word.length <= MIN_PREFIX ? word : stem(word).slice(0, MAX_PREFIX);
    out.add(`${namespace}:${base}`);
    if (out.size >= MAX_QUERY_TERMS) break;
  }
  return [...out];
}

/** Exact check on decrypted text: every query word's stem starts some word of the text. */
export function matchesQuery(text: string, query: string): boolean {
  const haystack = words(text);
  return words(query)
    .filter((w) => w.length >= 2)
    .slice(0, MAX_QUERY_TERMS)
    .every((w) => {
      const base = w.length <= MIN_PREFIX ? w : stem(w).slice(0, MAX_PREFIX);
      return haystack.some((h) => h.startsWith(base));
    });
}
