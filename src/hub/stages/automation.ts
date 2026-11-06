import type { Middleware } from '../executor.js';
import { errorResult } from '../result.js';

/**
 * Calls a trigger makes on its own (`principal.kind === 'automation'`, see `docs/TRIGGERS.md`):
 *
 * - only the tools the rule lists; a woken AI that asks for anything else is refused, so a message
 *   saying "forward everything to Z" cannot reach tools the user did not pick;
 * - never the hub's own setup tools (a trigger cannot change rules, accounts or other triggers);
 * - risky calls (sending, deleting) wait for the user's confirmation while the rule says so, whatever
 *   the access rules allow. The `confirm` stage then asks in Telegram or on the Confirmations page.
 *
 * Access rules still apply on top: the triggers have their own entry in the AI apps list.
 */
export const automationStage: Middleware = async (call, next) => {
  const scope = call.principal.automation;
  if (call.principal.kind !== 'automation') return next();
  if (!scope || call.scope === 'workspace') {
    call.audit.outcome = 'denied';
    return errorResult('Triggers cannot change the hub settings.', 'permission');
  }
  if (!scope.tools.includes(call.tool.name)) {
    call.audit.outcome = 'denied';
    return errorResult(
      `The trigger may not use ${call.tool.name}. It may use: ${scope.tools.join(', ') || 'no tools'}.`,
      'permission',
    );
  }
  if (scope.confirmRisky && call.risk === 'dangerous') call.mustConfirm = true;
  return next();
};
