import { compact, pickFields, truncateText } from '../connectors/shape.js';
import { serialize } from './result.js';
import { charsForTokens, estimateTokens } from './tokens.js';

/**
 * The hub's final size budget for tool results. Connectors shape their own output (see
 * `connectors/shape.ts`); this is the safety net so one oversized result never floods the model
 * context. A pure function, covered by tests.
 */
export interface ShapeOptions {
  maxTokens: number;
  /** Fields the AI selected with the `fields` argument. */
  fields?: readonly string[];
}

export interface Shaped {
  data: unknown;
  /** Set when the budget forced items or text to be cut. */
  truncated: boolean;
}

const fits = (value: unknown, maxTokens: number) => estimateTokens(serialize(value)) <= maxTokens;

function capStrings(value: unknown, max: number): unknown {
  if (typeof value === 'string') return value.length > max ? truncateText(value, max) : value;
  if (Array.isArray(value)) return value.map((v) => capStrings(v, max));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capStrings(v, max)]));
  }
  return value;
}

/** The array that dominates the result: the value itself, or its largest array property. */
function mainList(value: unknown): { key: string | null; items: unknown[] } | undefined {
  if (Array.isArray(value)) return { key: null, items: value };
  if (typeof value !== 'object' || value === null) return undefined;
  let best: { key: string; items: unknown[]; size: number } | undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (!Array.isArray(entry)) continue;
    const size = serialize(entry).length;
    if (!best || size > best.size) best = { key, items: entry, size };
  }
  return best && { key: best.key, items: best.items };
}

function withItems(value: unknown, key: string | null, items: unknown[], omitted: number): unknown {
  const note = {
    omitted,
    hint: `Showing ${items.length} of ${items.length + omitted} items to stay within the size limit. Narrow the request (filters, a smaller limit, fields) or fetch the next page.`,
  };
  if (key === null) return { items, truncated: note };
  return { ...(value as Record<string, unknown>), [key]: items, truncated: note };
}

export function shapeData(input: unknown, options: ShapeOptions): Shaped {
  let data = options.fields?.length ? pickFields(input, options.fields) : input;
  data = compact(data);
  if (fits(data, options.maxTokens)) return { data, truncated: false };

  const maxChars = charsForTokens(options.maxTokens);
  if (typeof data === 'string') return { data: truncateText(data, maxChars), truncated: true };

  // 1. Long strings (bodies, descriptions) are the usual culprit.
  data = capStrings(data, Math.max(300, Math.floor(maxChars / 4)));
  if (fits(data, options.maxTokens)) return { data, truncated: true };

  // 2. Keep as many list items as fit (binary search).
  const list = mainList(data);
  if (list && list.items.length > 0) {
    let low = 0;
    let high = list.items.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = withItems(data, list.key, list.items.slice(0, mid), list.items.length - mid);
      if (fits(candidate, options.maxTokens)) low = mid;
      else high = mid - 1;
    }
    const candidate = withItems(data, list.key, list.items.slice(0, low), list.items.length - low);
    if (low > 0 && fits(candidate, options.maxTokens)) return { data: candidate, truncated: true };
  }

  // 3. Last resort: plain text cut.
  return { data: truncateText(serialize(data), maxChars), truncated: true };
}
