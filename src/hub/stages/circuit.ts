import type { CircuitBreaker } from '../../lib/circuit-breaker.js';
import { type CallContext, type Middleware, type Next, unitKey, unitLabel } from '../executor.js';
import { type ExecResult, errorResult } from '../result.js';

/** Failures that say the service itself is not answering (not the user's input or sign-in). */
const SERVICE_DOWN = new Set(['upstream', 'timeout']);

/**
 * Fails fast while a service keeps failing for an account (see `CircuitBreaker`), so the AI gets
 * a clear answer in milliseconds instead of waiting for timeouts and retries on every call. Sits
 * inside `limits`, so its retries see the open circuit and stop. Only calls that reached the
 * service count; workspace (setup) calls are never affected.
 */
export function circuitStage(breaker: CircuitBreaker): Middleware {
  return async (call, next) => {
    if (call.scope !== 'account') return next();
    const key = `acct:${unitKey(call)}`;
    const decision = breaker.check(key);
    if (!decision.allowed) {
      call.audit.outcome = 'circuit_open';
      return errorResult(
        `${call.connector.name} is not responding for ${unitLabel(call)} right now (${decision.failures} failed calls in a row), so the hub did not call it again. Try again in ${decision.retryAfterSeconds} s; other services and accounts are not affected.`,
        'upstream',
        decision.retryAfterSeconds,
      );
    }
    let result: ExecResult;
    let reached: boolean;
    try {
      ({ result, reached } = await attempt(call, next));
    } catch (error) {
      breaker.release(key);
      throw error;
    }
    const kind = result.error?.kind;
    if (!reached) breaker.release(key);
    else if (result.isError && kind && SERVICE_DOWN.has(kind)) breaker.failure(key);
    // Any other answer (success, a 404, invalid input, a sign-in problem) means the service is up.
    else breaker.success(key);
    return result;
  };
}

/**
 * Runs the rest of the chain once and says whether it reached the service. `limits` may run this
 * stage several times (retries), so each attempt is judged on its own.
 */
async function attempt(call: CallContext, next: Next): Promise<{ result: ExecResult; reached: boolean }> {
  const before = call.invoked === true;
  call.invoked = false;
  try {
    const result = await next();
    return { result, reached: invokedNow(call) };
  } finally {
    call.invoked = before || invokedNow(call);
  }
}

/** Read through a function so the compiler does not narrow `invoked` after the reset above. */
function invokedNow(call: CallContext): boolean {
  return call.invoked === true;
}
