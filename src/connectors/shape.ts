/**
 * Response-shaping helpers for connectors. Every token a tool result spends is context the AI
 * cannot use for the task, so connectors should return only what is useful: plain text instead of
 * HTML, a page of items with a cursor instead of everything, selected fields instead of raw API
 * objects. The hub applies a final size budget to every result as well (see `src/hub/shaping.ts`),
 * but shaping at the source keeps the most relevant data.
 *
 * Part of the connector SDK: no imports from app code.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const BLOCK_TAGS =
  /<\/?(p|div|br|li|ul|ol|tr|table|h[1-6]|blockquote|section|article|header|footer|pre|hr)\b[^>]*>/gi;

/**
 * Converts HTML (emails, rich-text fields) to readable plain text: drops scripts, styles and
 * comments, keeps paragraphs and list items as lines, keeps link targets as `text (url)`.
 */
export function htmlToText(html: string, options: { maxLength?: number } = {}): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|svg)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner) => {
      const label = String(inner)
        .replace(/<[^>]+>/g, '')
        .trim();
      if (!label || label === href || href.startsWith('mailto:') || href.startsWith('#')) return label;
      return `${label} (${href})`;
    })
    .replace(/<\/li\s*>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(BLOCK_TAGS, '\n')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return options.maxLength ? truncateText(text, options.maxLength) : text;
}

/** Cuts text to `max` characters on a word boundary and says how much was left out. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  if (space > max * 0.8) cut = cut.slice(0, space);
  return `${cut}… [+${text.length - cut.length} chars]`;
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let current = target;
  for (const key of path.slice(0, -1)) {
    const next = current[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[path[path.length - 1]!] = value;
}

function pickOne(value: unknown, paths: string[][]): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const picked = getPath(value, path);
    if (picked !== undefined) setPath(out, path, picked);
  }
  return out;
}

/**
 * Keeps only the given fields (dotted paths like `from.email`) of an object, of every object in an
 * array, or of every item in a `{ items: [...] }` page. `id` is always kept so items stay addressable.
 */
export function pickFields<T>(value: T, fields: readonly string[]): T {
  const paths = [...new Set(['id', ...fields])].map((f) => f.split('.'));
  if (Array.isArray(value)) return value.map((item) => pickOne(item, paths)) as T;
  if (typeof value === 'object' && value !== null && Array.isArray((value as { items?: unknown }).items)) {
    const page = value as unknown as { items: unknown[] };
    return { ...page, items: page.items.map((item) => pickOne(item, paths)) } as T;
  }
  return pickOne(value, paths) as T;
}

/** The canonical page shape for list results. */
export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` to get the next page; absent on the last page. */
  nextCursor?: string;
  /** Total matches, when the service reports it. */
  total?: number;
}

/** Builds a page, dropping an empty cursor so the AI is not told there is more when there is not. */
export function page<T>(items: T[], options: { nextCursor?: string | null; total?: number } = {}): Page<T> {
  return {
    items,
    ...(options.nextCursor ? { nextCursor: options.nextCursor } : {}),
    ...(options.total !== undefined ? { total: options.total } : {}),
  };
}

/** Opaque cursor helpers: connectors keep any state (offset, API page token) inside the cursor. */
export function encodeCursor(state: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

export function decodeCursor<T extends Record<string, unknown>>(cursor: string | undefined): T | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}

/** Removes `null`, `undefined`, empty strings and empty arrays/objects, recursively. */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact).filter((v) => !isEmpty(v)) as T;
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = compact(entry);
      if (!isEmpty(next)) out[key] = next;
    }
    return out as T;
  }
  return value;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value as object).length === 0;
  }
  return false;
}
