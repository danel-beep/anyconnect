import type { Middleware } from '../executor.js';
import type { QuotaGate } from '../quota.js';
import { errorResult } from '../result.js';

/**
 * Refuses units over the workspace's plan limits (actions per month) before they reach the service,
 * so refused calls are not counted as usage. The hub's own setup tools (workspace scope) always run:
 * a user over the limit can still manage the hub from the assistant.
 */
export function quotaStage(gate: QuotaGate): Middleware {
  return async (call, next) => {
    if (call.scope === 'workspace') return next();
    const decision = await gate.checkAction(call.principal, {
      connectorId: call.connector.id,
      action: call.action.name,
    });
    if (decision.allowed) return next();
    call.audit.outcome = 'quota_exceeded';
    return errorResult(decision.message, 'hub');
  };
}
