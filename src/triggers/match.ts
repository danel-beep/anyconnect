import type { TriggerFilter, TriggerItem } from './spec.js';

/**
 * Pure helpers of the trigger engine: does an event match a filter, and what do an action's
 * templates become for it. No I/O, so the rules are easy to test and to reason about.
 */

const norm = (value: string) => value.normalize('NFKC').toLocaleLowerCase();

/** Comma-separated alternatives of a filter field, normalised; empty when the field is not set. */
export function alternatives(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => norm(part.trim()))
    .filter(Boolean);
}

const containsAny = (haystack: string | undefined, needles: string[]) => {
  if (needles.length === 0) return true;
  if (!haystack) return false;
  const text = norm(haystack);
  return needles.some((needle) => text.includes(needle));
};

/** Whether the item matches every field the filter sets (an empty filter matches everything). */
export function matchesFilter(filter: TriggerFilter, item: TriggerItem): boolean {
  return (
    containsAny(item.from, alternatives(filter.from)) &&
    containsAny(item.chatTitle, alternatives(filter.chat)) &&
    containsAny(item.subject, alternatives(filter.subject)) &&
    containsAny([item.subject, item.text].filter(Boolean).join('\n'), alternatives(filter.text))
  );
}

/** Text fields a filter or a template can refer to. */
function fieldsOf(item: TriggerItem, trigger: string): Record<string, string> {
  return {
    from: item.from ?? '',
    text: item.text,
    chat: item.chat ?? '',
    chat_title: item.chatTitle ?? '',
    subject: item.subject ?? '',
    id: item.id,
    account: item.account,
    service: item.service,
    trigger,
  };
}

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

/**
 * Fills `{{field}}` placeholders in every string of an action's arguments. Unknown placeholders
 * stay as they are, so a typo is visible in the result instead of silently becoming empty. A string
 * that is exactly one placeholder becomes the field's value as is.
 */
export function renderArgs(args: unknown, item: TriggerItem, trigger: string): unknown {
  const fields = fieldsOf(item, trigger);
  const render = (value: unknown): unknown => {
    if (typeof value === 'string')
      return value.replace(PLACEHOLDER, (all, key: string) => fields[key] ?? all);
    if (Array.isArray(value)) return value.map(render);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, render(v)]));
    return value;
  };
  return render(args);
}

/** Cuts text to at most `max` characters on a word boundary, with an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Start of the current UTC day: daily limits count from here. */
export function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
