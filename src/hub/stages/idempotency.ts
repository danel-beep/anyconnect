import { createHash } from 'node:crypto';
import { type CallContext, type Middleware, unitKey, unitLabel } from '../executor.js';
import type { IdempotencyStore } from '../idempotency.js';
import type { ExecResult } from '../result.js';

/** JSON with sorted keys, so `{a,b}` and `{b,a}` hash the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function idempotencyKey(call: CallContext): string {
  return createHash('sha256')
    .update(
      [
        call.principal.workspaceId,
        unitKey(call),
        call.connector.id,
        call.action.name,
        stableStringify(call.input),
      ].join('\u0000'),
    )
    .digest('hex');
}

function duplicate(call: CallContext, result: ExecResult, secondsAgo: number | null): ExecResult {
  call.audit.outcome = 'deduplicated';
  const when = secondsAgo === null ? 'is running right now' : `succeeded ${secondsAgo} s ago`;
  return {
    ...result,
    content: [
      {
        type: 'text',
        text: `Not repeated: an identical ${call.connector.name} "${call.action.name}" call on ${unitLabel(call)} ${when}, so it was not executed again (duplicate protection). Its result is below. If the user explicitly wants it done a second time, tell them it was already done and ask them to confirm.`,
      },
      ...result.content,
    ],
  };
}

/**
 * Suppresses identical repeats of non-idempotent writes within a time window, and joins identical
 * concurrent calls into one. Reads and actions marked idempotent pass straight through.
 */
export function idempotencyStage(deps: { store: IdempotencyStore; windowMs: number }): Middleware {
  return async (call, next) => {
    if (call.meta.idempotent || deps.windowMs <= 0) return next();
    const key = idempotencyKey(call);
    const claim = await deps.store.claim(key);
    if (claim.state === 'done') {
      return duplicate(call, claim.result, Math.round((Date.now() - claim.completedAt) / 1000));
    }
    if (claim.state === 'pending') {
      const result = await claim.result;
      return result.isError ? result : duplicate(call, result, null);
    }
    let result: ExecResult;
    try {
      result = await next();
    } catch (error) {
      await deps.store.release(key, { content: [{ type: 'text', text: 'Failed.' }], isError: true });
      throw error;
    }
    if (result.isError) await deps.store.release(key, result);
    else await deps.store.complete(key, result, deps.windowMs);
    return result;
  };
}
