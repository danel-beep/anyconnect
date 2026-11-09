import type { z } from 'zod';

/** How many rounds of fixes are tried; each round can fix several fields at once. */
const MAX_ROUNDS = 3;

/**
 * Validates tool arguments from an AI app with the tool's own schema, forgiving one common slip:
 * a single value where the schema wants a list (`to: "a@b.com"` for `to: ["a@b.com"]`). Such a
 * value is wrapped in a list and checked again. Anything else fails as before, and when wrapping
 * does not make the arguments valid, the original error is returned, so the AI sees what it sent.
 *
 * Pure: the input is never changed; a fixed copy is validated.
 */
export function parseToolInput<T>(schema: z.ZodType<T>, input: unknown): z.ZodSafeParseResult<T> {
  const first = schema.safeParse(input);
  let parsed = first;
  let value = input;
  for (let round = 0; !parsed.success && round < MAX_ROUNDS; round++) {
    const paths = parsed.error.issues
      .filter((issue) => issue.code === 'invalid_type' && issue.expected === 'array')
      .map((issue) => issue.path)
      .filter((path) => isScalar(valueAt(value, path)));
    if (paths.length === 0) break;
    value = paths.reduce<unknown>((current, path) => wrapAt(current, path), value);
    parsed = schema.safeParse(value);
  }
  return parsed.success ? parsed : first;
}

function isScalar(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

/** A copy of `value` with the item at `path` replaced by `[item]`; containers on the way are copied. */
function wrapAt(value: unknown, path: readonly PropertyKey[]): unknown {
  if (path.length === 0) return [value];
  if (typeof value !== 'object' || value === null) return value;
  const [key, ...rest] = path as [PropertyKey, ...PropertyKey[]];
  const copy: Record<PropertyKey, unknown> | unknown[] = Array.isArray(value)
    ? [...value]
    : { ...(value as Record<PropertyKey, unknown>) };
  (copy as Record<PropertyKey, unknown>)[key] = wrapAt((value as Record<PropertyKey, unknown>)[key], rest);
  return copy;
}
