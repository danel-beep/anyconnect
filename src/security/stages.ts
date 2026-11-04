import { randomBytes } from 'node:crypto';
import { FIELDS_ARGUMENT } from '../connectors/registry.js';
import { actionRisk } from '../connectors/sdk.js';
import type { Principal } from '../core/principal.js';
import type { CatalogAllow } from '../hub/catalog.js';
import type { CallContext, Middleware } from '../hub/executor.js';
import { type ExecResult, errorResult, type HubQuestion, markUntrusted } from '../hub/result.js';
import { hmac, safeEqual } from '../lib/crypto.js';
import type { ConfirmationCenter } from './confirmations.js';
import type { PendingCallInput, PendingCallRow, PendingCallService, StoredResult } from './pending-calls.js';
import { accessAllows, type PolicyDecision } from './policy.js';
import type { CallerPolicy, PolicyService } from './policy-service.js';

/**
 * The security layer's executor stages (see `hub/executor.ts` for the chain):
 *
 * - `policy`: client × account × risk rules and personas; denies before anything is decrypted.
 * - `confirm`: holds risky calls until the user confirms (in the chat via MCP elicitation, else in
 *   Telegram or on the web page) and applies undo windows.
 * - `untrusted`: marks third-party content in results as data, not instructions.
 */

const POLICY = 'security.policy';
const QUESTION_KEY = 'anyconnect_confirm';

/** The caller's policy, loaded once per request (all units of a fan-out share the principal). */
function policyLoader(policies: PolicyService) {
  const cache = new WeakMap<Principal, Promise<CallerPolicy>>();
  return (principal: Principal): Promise<CallerPolicy> => {
    let loaded = cache.get(principal);
    if (!loaded) {
      loaded = policies.forPrincipal(principal);
      cache.set(principal, loaded);
    }
    return loaded;
  };
}

function denial(call: CallContext, decision: PolicyDecision): ExecResult {
  call.audit.outcome = 'denied';
  call.audit.policyRules = decision.ruleIds;
  const what =
    decision.reason === 'persona'
      ? `Account "${call.account.name}" is not available through this connection.`
      : `The user's access rules do not allow ${call.risk === 'read' ? 'reading' : 'this action'} on ${call.connector.name} account "${call.account.name}" for this app.`;
  return errorResult(`${what} Do not retry; tell the user if they asked for it.`, 'permission');
}

export function createCatalogFilter(policies: PolicyService) {
  return async (principal: Principal): Promise<CatalogAllow> => {
    const policy = await policies.forPrincipal(principal);
    return (connector, action, account) =>
      accessAllows(
        policy.decide({ connectorId: connector.id, accountId: account.id }, 'read').access,
        actionRisk(action),
      );
  };
}

export function policyStage(policies: PolicyService): Middleware {
  const load = policyLoader(policies);
  return async (call, next) => {
    const policy = await load(call.principal);
    call.locals[POLICY] = policy;
    const decision = policy.decide({ connectorId: call.connector.id, accountId: call.account.id }, call.risk);
    if (!decision.allowed) return denial(call, decision);
    return next();
  };
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

export interface ConfirmStageDeps {
  policies: PolicyService;
  pending: PendingCallService;
  center: ConfirmationCenter;
  /** Signs the chat question state so it cannot be forged or moved to another call. */
  stateKey: Buffer;
  /** How long a call waits inline for a Telegram/web decision before returning "pending". */
  waitMs: number;
}

export function toStored(result: ExecResult): StoredResult {
  return {
    content: result.content as StoredResult['content'],
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError ? { isError: true } : {}),
  };
}

function fromStored(stored: StoredResult): ExecResult {
  return stored as ExecResult;
}

export function confirmStage(deps: ConfirmStageDeps): Middleware {
  const { pending, center } = deps;
  const load = policyLoader(deps.policies);
  const sign = (id: string, principal: Principal) =>
    hmac(deps.stateKey, `${id}|${principal.workspaceId}|${principal.credentialId ?? principal.userId}`);

  const verifyState = (state: string | undefined, principal: Principal): string | undefined => {
    if (!state) return undefined;
    const [id, mac] = state.split('.');
    if (!id || !mac || !safeEqual(mac, sign(id, principal))) return undefined;
    return id;
  };

  const pendingText = (row: PendingCallRow, how: string) =>
    `${how} Ask the user to confirm it ${row.channels.includes('telegram') ? 'with the button in their AnyConnect Telegram chat or ' : ''}at ${center.confirmUrl(row.id)} — then call this tool again with exactly the same arguments to get the result. Do not claim it was done before that.`;

  /** What the caller gets for a held-back call, depending on where it stands. */
  const outcome = async (call: CallContext, row: PendingCallRow): Promise<ExecResult> => {
    switch (row.status) {
      case 'succeeded':
      case 'failed': {
        await pending.consume(row.id);
        call.audit.outcome = 'confirmed';
        const stored = pending.result(row);
        return stored ? fromStored(stored) : errorResult('The call ran but its outcome is unknown.', 'hub');
      }
      case 'denied':
      case 'cancelled':
      case 'expired':
        await pending.consume(row.id);
        call.audit.outcome = 'declined';
        return errorResult(
          row.status === 'expired'
            ? 'The user did not confirm this action in time, so nothing was done.'
            : `The user ${row.status === 'denied' ? 'declined' : 'cancelled'} this action, so nothing was done. Do not retry unless they ask again.`,
          'permission',
        );
      case 'scheduled':
      case 'running': {
        call.audit.outcome = 'scheduled';
        const at = row.executeAt ? Math.max(0, Math.round((row.executeAt.getTime() - Date.now()) / 1000)) : 0;
        return {
          content: [
            {
              type: 'text',
              text:
                row.status === 'running'
                  ? 'The action is running now. Call this tool again with the same arguments in a few seconds to get the result.'
                  : `Approved. The action will run in ${at} s unless the user cancels it (undo window). Call this tool again with the same arguments afterwards to get the result.`,
            },
          ],
        };
      }
      default:
        call.audit.outcome = 'awaiting_confirmation';
        return {
          content: [
            { type: 'text', text: pendingText(row, 'This action is waiting for the user’s confirmation.') },
          ],
        };
    }
  };

  const question = async (call: CallContext, row: PendingCallRow): Promise<HubQuestion> => {
    const d = await center.describe(row);
    const reason = row.reason ? ` ${row.reason}.` : '';
    return {
      key: QUESTION_KEY,
      message: `${d.client} wants to run “${d.action}” on ${d.service} (${d.account}).${reason} Allow it?`,
      schema: {
        type: 'object',
        properties: { approve: { type: 'boolean', title: 'Allow this action', default: false } },
        required: ['approve'],
      },
      state: `${row.id}.${sign(row.id, call.principal)}`,
    };
  };

  return async (call, next) => {
    const policy = (call.locals[POLICY] as CallerPolicy | undefined) ?? (await load(call.principal));
    const target = { connectorId: call.connector.id, accountId: call.account.id };
    // The risk stage may have raised the risk after the policy stage: check access again.
    const decision = policy.decide(target, call.risk);
    if (!decision.allowed) return denial(call, decision);
    if (call.preApproved) return next();

    const declaredDelay = call.meta.undo?.kind === 'delay' ? call.meta.undo.seconds : 0;
    const undoWindowSeconds = call.risk === 'read' ? 0 : Math.max(decision.undoWindowSeconds, declaredDelay);
    if (!decision.confirm && undoWindowSeconds === 0) return next();

    const riskReason = typeof call.locals.riskReason === 'string' ? call.locals.riskReason : undefined;
    const input: PendingCallInput = {
      principal: call.principal,
      toolName: call.tool.name,
      connectorId: call.connector.id,
      action: call.action.name,
      accountId: call.account.id,
      risk: call.risk,
      reason: riskReason,
      // Hub options are part of the call: the approved call later runs exactly as requested.
      args: call.options.fields ? { ...call.input, [FIELDS_ARGUMENT]: call.options.fields } : call.input,
      channels: [],
      undoWindowSeconds,
    };

    // 1. The user answered our question in the chat (MCP multi round-trip).
    const answeredId = verifyState(call.interaction?.state, call.principal);
    if (answeredId) {
      const row = await pending.get(answeredId);
      if (!row || row.argsHash !== pending.hashOf(input) || !pending.belongsTo(row, call.principal)) {
        return errorResult('The confirmation does not match this call; call the tool again.', 'hub');
      }
      const answer = call.interaction?.answers[QUESTION_KEY] as
        | { action?: string; content?: { approve?: unknown } }
        | undefined;
      const approved = answer?.action === 'accept' && answer.content?.approve === true;
      if (!approved) {
        await pending.decide(row.id, false, 'elicitation');
        await pending.consume(row.id);
        call.audit.outcome = 'declined';
        return errorResult('The user declined this action, so nothing was done.', 'permission');
      }
      if (undoWindowSeconds > 0) {
        const scheduled = await pending.decide(row.id, true, 'elicitation');
        if (!scheduled) return outcome(call, (await pending.get(row.id)) ?? row);
        await center.notify(scheduled);
        return outcome(call, scheduled);
      }
      const claimed = await pending.approveAndClaim(row.id, 'elicitation');
      if (!claimed) return outcome(call, (await pending.get(row.id)) ?? row);
      call.audit.outcome = 'confirmed';
      const result = await next();
      await pending.complete(row.id, toStored(result));
      await pending.consume(row.id);
      return result;
    }

    // 2. The same call was already held back: report where it stands (or wait a bit more).
    const repeat = await pending.findRepeat(call.principal, call.tool.name, call.account.id, input.args);
    if (repeat) {
      // The chat client retried without an answer: ask the same question again.
      if (
        repeat.status === 'awaiting_confirmation' &&
        call.interaction?.canAsk &&
        repeat.channels.includes('elicitation')
      ) {
        call.audit.outcome = 'awaiting_confirmation';
        return {
          content: [
            { type: 'text', text: pendingText(repeat, 'This action needs the user’s confirmation.') },
          ],
          question: await question(call, repeat),
        };
      }
      const current = pending.isFinal(repeat)
        ? repeat
        : ((await pending.waitForOutcome(repeat.id, deps.waitMs, call.signal)) ?? repeat);
      return outcome(call, current);
    }

    // 3. Only an undo window: schedule it and tell the user how to cancel.
    if (!decision.confirm) {
      const row = await pending.schedule({
        ...input,
        channels: await center.channelsFor(call.principal.userId),
      });
      await center.notify(row);
      return outcome(call, row);
    }

    // 4. Ask in the chat when the client supports it.
    if (call.interaction?.canAsk) {
      const row = await pending.requestConfirmation({ ...input, channels: ['elicitation'] });
      call.audit.outcome = 'awaiting_confirmation';
      return {
        content: [{ type: 'text', text: pendingText(row, 'This action needs the user’s confirmation.') }],
        question: await question(call, row),
      };
    }

    // 5. Ask out of band (Telegram, web page) and wait a little for the answer.
    const row = await pending.requestConfirmation({
      ...input,
      channels: await center.channelsFor(call.principal.userId),
    });
    await center.notify(row);
    const final = await pending.waitForOutcome(row.id, deps.waitMs, call.signal);
    return outcome(call, final ?? row);
  };
}

// ---------------------------------------------------------------------------
// Untrusted content
// ---------------------------------------------------------------------------

/** Marks every open-world action result as third-party content (see `markUntrusted`). */
export const untrustedStage: Middleware = async (call, next) => {
  const result = await next();
  if (call.action.hints?.openWorld === false) return result;
  return markUntrusted(result, `${call.connector.name} · ${call.account.name}`);
};
