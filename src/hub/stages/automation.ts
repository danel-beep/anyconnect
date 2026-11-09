import type { ArgumentLimits } from '../../db/schema.js';
import type { CallContext, Middleware } from '../executor.js';
import { errorResult } from '../result.js';

/**
 * Calls a trigger makes on its own (`principal.kind === 'automation'`, see `docs/TRIGGERS.md`):
 *
 * - only the tools the rule lists; a woken AI that asks for anything else is refused, so a message
 *   saying "forward everything to Z" cannot reach tools the user did not pick;
 * - only the argument values the rule allows (`allow`, e.g. `telegram_send` only to one chat),
 *   checked here, not by the AI;
 * - never the hub's own setup tools (a trigger cannot change rules, accounts or other triggers);
 * - risky calls (sending, deleting) wait for the user's confirmation while the rule says so. When the
 *   user approved a rule that acts without asking, that approval stands in for the access rules'
 *   "ask first" (`ruleApproved`), so the trigger does not need "never ask" on the whole account.
 *   The floor (`requiresConfirmation`, `assessRisk`) still asks. The `confirm` stage asks in
 *   Telegram or on the Confirmations page.
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
  const outside = outsideLimits(scope.allow?.[call.tool.name], call);
  if (outside) {
    call.audit.outcome = 'denied';
    return errorResult(
      `The trigger may use ${call.tool.name} only with ${outside.argument}: ${outside.allowed.join(', ')}.`,
      'permission',
    );
  }
  if (scope.confirmRisky) {
    if (call.risk === 'dangerous') call.mustConfirm = true;
  } else {
    call.ruleApproved = true;
  }
  return next();
};

/** The first limited argument the call does not keep to, or undefined when it keeps to all. */
export function outsideLimits(
  limits: ArgumentLimits[string] | undefined,
  call: Pick<CallContext, 'input' | 'account' | 'connector'>,
): { argument: string; allowed: string[] } | undefined {
  if (!limits) return undefined;
  for (const [argument, allowed] of Object.entries(limits)) {
    const values =
      argument === 'account'
        ? call.account
          ? [call.account.name, `${call.connector.id}:${call.account.name}`]
          : []
        : listOf(call.input[argument]);
    const ok =
      argument === 'account'
        ? values.some((v) => allowed.includes(v))
        : values.length > 0 && values.every((v) => allowed.includes(v));
    if (!ok) return { argument, allowed };
  }
  return undefined;
}

/** A value as the strings it holds; nothing for a missing value or one that is not text or a number. */
function listOf(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  if (!items.every((v) => typeof v === 'string' || typeof v === 'number')) return [];
  return items.map(String);
}
