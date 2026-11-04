import type { RiskLevel } from '../../connectors/sdk.js';
import type { Middleware } from '../executor.js';

const RANK: Record<RiskLevel, number> = { read: 0, write: 1, dangerous: 2 };

/**
 * Runs the action's optional `assessRisk` and raises `call.risk` when the particular call is
 * riskier than the action in general. Never lowers it; a failing check fails closed (`dangerous`).
 */
export const riskStage: Middleware = async (call, next) => {
  const assess = call.action.assessRisk;
  if (!assess) return next();
  let assessed: { risk: RiskLevel; reason: string } | undefined;
  try {
    assessed = (await assess(call.input, await call.context())) ?? undefined;
  } catch {
    assessed = { risk: 'dangerous', reason: 'The risk check of this action failed' };
  }
  if (assessed && RANK[assessed.risk] > RANK[call.risk]) {
    call.risk = assessed.risk;
    call.audit.riskReason = assessed.reason;
    call.locals.riskReason = assessed.reason;
  }
  return next();
};
