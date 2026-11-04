import { usageCaller } from '../../core/principal.js';
import type { Logger } from '../../logger.js';
import type { Middleware } from '../executor.js';
import type { UsageMeter } from '../usage.js';

/** Outcomes of units that never reached the service: they are not usage. */
const NOT_EXECUTED = new Set(['denied', 'declined', 'deduplicated', 'rate_limited', 'pending', 'cancelled']);

/**
 * Counts every executed unit per workspace, day, caller and action. Stage 1 only counts and never
 * blocks; plans and free limits will read the counters (and may then refuse before `next()`).
 * Counting failures are logged, never fatal for the call.
 */
export function meterStage(deps: { meter: UsageMeter; logger: Logger }): Middleware {
  return async (call, next) => {
    const result = await next();
    if (call.audit.outcome && NOT_EXECUTED.has(call.audit.outcome)) return result;
    await deps.meter
      .record({
        workspaceId: call.principal.workspaceId,
        caller: usageCaller(call.principal),
        connectorId: call.connector.id,
        action: call.action.name,
        failed: result.isError === true,
      })
      .catch((error) => deps.logger.warn({ err: error }, 'failed to count usage'));
    return result;
  };
}
