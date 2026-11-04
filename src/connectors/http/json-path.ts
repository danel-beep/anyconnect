/**
 * Tiny dot-path helpers for reading and projecting JSON responses (`data.items`, `user.email`,
 * `items.0.id`). Deliberately not a query language: anything richer belongs in code.
 */

export function getPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const key of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(key);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]!] = value;
}

/** Keeps only the listed paths of an object (or of every item of an array), preserving nesting. */
export function pickFields(value: unknown, fields: string[] | undefined): unknown {
  if (!fields || fields.length === 0) return value;
  if (Array.isArray(value)) return value.map((item) => pickFields(item, fields));
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const picked = getPath(value, field);
    if (picked !== undefined) setPath(out, field, picked);
  }
  return out;
}
