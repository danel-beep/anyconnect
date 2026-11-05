import type { Principal } from '../core/principal.js';

/** Whether a unit may run under the workspace's plan; see stage `quota`. */
export type QuotaDecision =
  /** `notice`: a short line for the AI added after the result (e.g. the limit is getting close). */
  { allowed: true; notice?: string } | { allowed: false; message: string };

/**
 * Plans and limits as the hub sees them: one question per unit about to reach a service. The
 * billing layer implements it (`EntitlementService`); without it nothing is limited.
 */
export interface QuotaGate {
  checkAction(principal: Principal, unit: { connectorId: string; action: string }): Promise<QuotaDecision>;
}
