import type { z } from 'zod';
import type { Principal } from '../core/principal.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import type { AppContext } from './context.js';

/** Parses and validates a JSON request body. */
export async function json<T extends z.ZodType>(c: AppContext, schema: T): Promise<z.output<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('Request body must be JSON');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw badRequest(
      'Invalid request body',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
}

export function principal(c: AppContext): Principal {
  const p = c.get('principal');
  if (!p) throw unauthorized();
  return p;
}
