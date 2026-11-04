import type { RiskAssessment, RiskLevel } from '../../connectors/sdk.js';
import type { Middleware } from '../executor.js';

const RANK: Record<RiskLevel, number> = { read: 0, write: 1, dangerous: 2 };

/**
 * Runs the action's optional `assessRisk` and raises `call.risk` when the particular call is
 * riskier than the action in general, and marks calls that must be confirmed whatever the rules
 * say. Never lowers either; a failing check fails closed (`dangerous`).
 */
export const riskStage: Middleware = async (call, next) => {
  const assess = call.action.assessRisk;
  if (!assess) return next();
  let assessed: RiskAssessment | undefined;
  try {
    assessed = (await assess(call.input, await call.context())) ?? undefined;
  } catch {
    assessed = { risk: 'dangerous', reason: 'The risk check of this action failed' };
  }
  if (assessed && (RANK[assessed.risk] > RANK[call.risk] || assessed.confirm)) {
    if (RANK[assessed.risk] > RANK[call.risk]) call.risk = assessed.risk;
    if (assessed.confirm) call.mustConfirm = true;
    call.audit.riskReason = assessed.reason;
    call.locals.riskReason = assessed.reason;
  }
  return next();
};
