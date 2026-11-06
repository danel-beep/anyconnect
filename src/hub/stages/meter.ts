import { type Principal, usageCaller } from '../../core/principal.js';
import type { Logger } from '../../logger.js';
import type { Middleware } from '../executor.js';
import type { UsageMeter } from '../usage.js';

/**
 * Counts every unit that reached the service (refused, held for confirmation, deduplicated,
 * answered from an earlier approved run or declared free by the action, e.g. a wait that saw
 * nothing new, are not usage) per workspace, day, caller and action, and
 * charges it to the plan that pays for it (`payer`, from the billing layer; in a team its payer's or
 * the member's own). It never blocks: stage `quota` reads what was charged and refuses before
 * `next()`. Counting failures are logged, never fatal for the call.
 */
export function meterStage(deps: {
  meter: UsageMeter;
  logger: Logger;
  payer?: (principal: Principal) => Promise<string>;
}): Middleware {
  return async (call, next) => {
    const result = await next();
    if (!call.invoked || call.free) return result;
    const { principal } = call;
    try {
      await deps.meter.record({
        workspaceId: principal.workspaceId,
        payerId: deps.payer ? await deps.payer(principal) : principal.workspaceId,
        caller: usageCaller(principal),
        connectorId: call.connector.id,
        action: call.action.name,
        failed: result.isError === true,
      });
    } catch (error) {
      deps.logger.warn({ err: error }, 'failed to count usage');
    }
    return result;
  };
}
