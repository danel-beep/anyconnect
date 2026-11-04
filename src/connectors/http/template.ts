import { getPath } from './json-path.js';

/**
 * `{{ path }}` placeholders for manifests: `"Bearer {{credentials.token}}"`, `"{{input.limit}}"`.
 *
 * - A string that is exactly one placeholder keeps the value's type (numbers stay numbers, objects
 *   stay objects) and resolves to `undefined` when missing, so the key is dropped.
 * - Placeholders inside a longer string are stringified; a missing value makes the whole string
 *   `undefined` (no half-built URLs or headers).
 * - Objects and arrays are rendered recursively; keys whose value is `undefined` are omitted.
 *
 * There is no code execution: a placeholder is only a dot path into the scope.
 */

export type TemplateScope = Record<string, unknown>;

const WHOLE = /^\{\{\s*([\w.-]+)\s*\}\}$/;
const ANY = /\{\{\s*([\w.-]+)\s*\}\}/g;

export function renderString(template: string, scope: TemplateScope): unknown {
  const whole = template.match(WHOLE);
  if (whole) return getPath(scope, whole[1]);
  let missing = false;
  const result = template.replace(ANY, (_match, path: string) => {
    const value = getPath(scope, path);
    if (value === undefined || value === null) {
      missing = true;
      return '';
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
  return missing ? undefined : result;
}

export function render(template: unknown, scope: TemplateScope): unknown {
  if (typeof template === 'string') return renderString(template, scope);
  if (Array.isArray(template)) {
    return template.map((item) => render(item, scope)).filter((item) => item !== undefined);
  }
  if (typeof template === 'object' && template !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      const rendered = render(value, scope);
      if (rendered !== undefined) out[key] = rendered;
    }
    return out;
  }
  return template;
}

/** Placeholder paths used in a template, e.g. to check that a manifest only references known fields. */
export function placeholders(template: unknown): string[] {
  if (typeof template === 'string') return [...template.matchAll(ANY)].map((m) => m[1]!);
  if (Array.isArray(template)) return template.flatMap(placeholders);
  if (typeof template === 'object' && template !== null) return Object.values(template).flatMap(placeholders);
  return [];
}
