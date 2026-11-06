import { FIELDS_ARGUMENT } from '../connectors/registry.js';
import { actionRisk } from '../connectors/sdk.js';
import type { Principal } from '../core/principal.js';
import type { CatalogAllow } from '../hub/catalog.js';
import type { CallContext, Middleware } from '../hub/executor.js';
import { type ExecResult, errorResult, type HubQuestion, markUntrusted } from '../hub/result.js';
import { hmac, safeEqual } from '../lib/crypto.js';
import type { ConfirmationCenter } from './confirmations.js';
import type { PendingCallInput, PendingCallRow, PendingCallService, StoredResult } from './pending-calls.js';
import { accessAllows, type PolicyDecision, type PolicyTarget } from './policy.js';
import type { CallerPolicy, PolicyService } from './policy-service.js';
import type { StandingApprovals } from './standing-approvals.js';

/**
 * The security layer's executor stages (see `hub/executor.ts` for the chain):
 *
 * - `policy`: client × account × risk rules and personas; denies before anything is decrypted.
 * - `confirm`: holds risky calls until the user confirms (in the chat via MCP elicitation, else in
 *   Telegram or on the web page, or, when the user chose `confirmIn: chat`, by answering the AI app,
 *   which then repeats the call) and applies undo windows.
 * - `approvals`: records the standing approvals an approved call grants (e.g. "carry on this
 *   conversation"); `confirm` lets calls they cover through without asking again.
 * - `untrusted`: marks third-party content in results as data, not instructions.
 */

const POLICY = 'security.policy';
const QUESTION_KEY = 'manyplug_confirm';
/** Channel of a call the user confirms by answering the AI app in the chat (`confirmIn: chat`). */
export const CHAT_CHANNEL = 'chat';

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
  const where = call.account ? `${call.connector.name} account "${call.account.name}"` : 'the hub settings';
  const what =
    decision.reason === 'persona'
      ? `${call.account ? `Account "${call.account.name}"` : 'The hub settings'} ${call.account ? 'is' : 'are'} not available through this connection.`
      : decision.reason === 'member'
        ? `Account "${call.account?.name ?? ''}" belongs to another team member and is not shared with this user.`
        : `The user's access rules do not allow ${call.risk === 'read' ? 'reading' : 'this action'} on ${where} for this app.`;
  return errorResult(`${what} Do not retry; tell the user if they asked for it.`, 'permission');
}

export function createCatalogFilter(policies: PolicyService) {
  return async (principal: Principal): Promise<CatalogAllow> => {
    const policy = await policies.forPrincipal(principal);
    return (connector, action, account) =>
      accessAllows(
        policy.decide({ connectorId: connector.id, accountId: account?.id ?? null }, 'read').access,
        actionRisk(action),
      );
  };
}

/** What access rules are checked against: the call's account, or the workspace for setup tools. */
function targetOf(call: CallContext): PolicyTarget {
  return { connectorId: call.connector.id, accountId: call.account?.id ?? null };
}

export function policyStage(policies: PolicyService): Middleware {
  const load = policyLoader(policies);
  return async (call, next) => {
    const policy = await load(call.principal);
    call.locals[POLICY] = policy;
    const decision = policy.decide(targetOf(call), call.risk);
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
  /**
   * Called for every call held back here, in the caller's request: keeps what the later run needs
   * and only this request has (the caller's open vault, `VaultScopes.hold`).
   */
  retain?: (row: PendingCallRow) => Promise<void>;
  /** Series of calls the user approved once (see `approvalsStage`). */
  approvals?: StandingApprovals;
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

  /**
   * What the AI is told about a call waiting for the user, in words and as `structuredContent`, so it
   * knows whether to send the user to a link or to ask them in the chat.
   */
  const awaiting = async (row: PendingCallRow, how: string): Promise<ExecResult> => {
    if (row.channels.includes(CHAT_CHANNEL)) {
      const d = await center.describe(row);
      const reason = row.reason ? ` (${row.reason})` : '';
      return {
        content: [
          {
            type: 'text',
            text: `${how} The user confirms in this chat, there is no link to open. Ask them now whether to run “${d.action}” on ${d.service} (${d.account})${reason}, and show what exactly will be sent or changed. Only if they clearly say yes, call this tool again with exactly the same arguments: that call runs it. If they say no or do not answer, do not call it again. Never answer for the user, and do not claim it was done before that.`,
          },
        ],
        structuredContent: {
          confirmation: { id: row.id, status: 'awaiting_confirmation', confirm_in: 'chat', next: 'ask_user' },
        },
      };
    }
    const telegram = row.channels.includes('telegram');
    const url = center.confirmUrl(row.id);
    return {
      content: [
        {
          type: 'text',
          text: `${how} The user confirms outside this chat: give them the link ${url}${telegram ? ' (or the button in their Manyplug Telegram chat)' : ''}; a yes in the chat does not confirm it. After they confirm there, call this tool again with exactly the same arguments to get the result. Do not claim it was done before that.`,
        },
      ],
      structuredContent: {
        confirmation: {
          id: row.id,
          status: 'awaiting_confirmation',
          confirm_in: 'link',
          url,
          ...(telegram ? { telegram: true } : {}),
          next: 'send_link',
        },
      },
    };
  };

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
        return awaiting(row, 'This action is waiting for the user’s confirmation.');
    }
  };

  /** Runs a call the user has just approved in the chat (now, or after its undo window). */
  const runApproved = async (
    call: CallContext,
    row: PendingCallRow,
    via: string,
    undoWindowSeconds: number,
    next: () => Promise<ExecResult>,
  ): Promise<ExecResult> => {
    if (undoWindowSeconds > 0) {
      const scheduled = await pending.decide(row.id, true, via);
      if (!scheduled) return outcome(call, (await pending.get(row.id)) ?? row);
      await deps.retain?.(scheduled);
      await center.notify(scheduled);
      return outcome(call, scheduled);
    }
    const claimed = await pending.approveAndClaim(row.id, via);
    if (!claimed) return outcome(call, (await pending.get(row.id)) ?? row);
    call.audit.outcome = 'confirmed';
    const result = await next();
    await pending.complete(row.id, toStored(result));
    await pending.consume(row.id);
    return result;
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
    const target = targetOf(call);
    // The risk stage may have raised the risk after the policy stage: check access again.
    const decision = policy.decide(target, call.risk);
    if (!decision.allowed) return denial(call, decision);
    if (call.preApproved) return next();

    const declaredDelay = call.meta.undo?.kind === 'delay' ? call.meta.undo.seconds : 0;
    const undoWindowSeconds = call.risk === 'read' ? 0 : Math.max(decision.undoWindowSeconds, declaredDelay);
    // Actions that delete data or widen access always need the user, whatever the rules say.
    const floor = call.action.requiresConfirmation === true || call.mustConfirm === true;
    let confirm = decision.confirm || floor;
    // A series the user already approved (e.g. replies in a conversation they asked the AI to carry
    // on) needs no new confirmation, never for what the floor guards. Undo windows still apply.
    if (confirm && !floor && deps.approvals && call.account) {
      const scope = call.action.approvalScope?.(call.input);
      const approval = scope
        ? await deps.approvals.use(call.principal, {
            connectorId: call.connector.id,
            accountId: call.account.id,
            action: call.action.name,
            scope,
          })
        : undefined;
      if (approval) {
        confirm = false;
        call.audit.approval = approval.id;
      }
    }
    if (!confirm && undoWindowSeconds === 0) return next();
    // The user may let the AI app ask them in the chat. Not for what the floor guards (the AI must
    // not lift its own restrictions on its word alone), nor through a team's shared connection.
    // A trigger acting on its own has no chat to ask in.
    const inChat =
      decision.confirmIn === 'chat' &&
      !floor &&
      !call.principal.shared &&
      call.principal.kind !== 'automation';

    const riskReason = typeof call.locals.riskReason === 'string' ? call.locals.riskReason : undefined;
    const input: PendingCallInput = {
      principal: call.principal,
      toolName: call.tool.name,
      connectorId: call.connector.id,
      action: call.action.name,
      accountId: target.accountId,
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
      return runApproved(call, row, 'elicitation', undoWindowSeconds, next);
    }

    // 2. The same call was already held back: report where it stands (or wait a bit more).
    const repeat = await pending.findRepeat(call.principal, call.tool.name, target.accountId, input.args);
    if (repeat) {
      // Asked in the chat: the AI repeats the call once the user said yes, and that runs it.
      if (repeat.status === 'awaiting_confirmation' && repeat.channels.includes(CHAT_CHANNEL) && inChat) {
        return runApproved(call, repeat, CHAT_CHANNEL, undoWindowSeconds, next);
      }
      // The chat client retried without an answer: ask the same question again.
      if (
        repeat.status === 'awaiting_confirmation' &&
        call.interaction?.canAsk &&
        !call.principal.shared &&
        repeat.channels.includes('elicitation')
      ) {
        call.audit.outcome = 'awaiting_confirmation';
        return {
          ...(await awaiting(repeat, 'This action needs the user’s confirmation.')),
          question: await question(call, repeat),
        };
      }
      const current = pending.isFinal(repeat)
        ? repeat
        : ((await pending.waitForOutcome(repeat.id, deps.waitMs, call.signal)) ?? repeat);
      return outcome(call, current);
    }

    // 3. Only an undo window: schedule it and tell the user how to cancel.
    if (!confirm) {
      const row = await pending.schedule({
        ...input,
        channels: await center.channelsFor(call.principal.userId),
      });
      await deps.retain?.(row);
      await center.notify(row);
      return outcome(call, row);
    }

    // 4. Ask in the chat when the client supports it. Not through a team's shared connection:
    //    whoever sits in that chat is not necessarily the person the hub would ask.
    if (call.interaction?.canAsk && !call.principal.shared) {
      const row = await pending.requestConfirmation({ ...input, channels: ['elicitation'] });
      await deps.retain?.(row);
      call.audit.outcome = 'awaiting_confirmation';
      return {
        ...(await awaiting(row, 'This action needs the user’s confirmation.')),
        question: await question(call, row),
      };
    }

    // 4b. The user chose to confirm in the chat, but the client cannot ask them itself: the AI asks
    //     in its own words and repeats the call (step 2) once they said yes.
    if (inChat) {
      const row = await pending.requestConfirmation({ ...input, channels: [CHAT_CHANNEL] });
      await deps.retain?.(row);
      call.audit.outcome = 'awaiting_confirmation';
      return awaiting(row, 'This action needs the user’s confirmation.');
    }

    // 5. Ask out of band (Telegram, web page) and wait a little for the answer.
    const row = await pending.requestConfirmation({
      ...input,
      channels: await center.channelsFor(call.principal.userId),
    });
    await deps.retain?.(row);
    await center.notify(row);
    const final = await pending.waitForOutcome(row.id, deps.waitMs, call.signal);
    return outcome(call, final ?? row);
  };
}

// ---------------------------------------------------------------------------
// Standing approvals
// ---------------------------------------------------------------------------

/**
 * Runs after `confirm`, so only calls the user approved (or that their rules let run without asking)
 * get here: when such a call of an action that `grants` a standing approval succeeds, the approval is
 * recorded for the same caller; an action that `revokes` ends it. Calls run later by the pending-call
 * runner pass through here too, with the caller who asked.
 */
export function approvalsStage(approvals: StandingApprovals): Middleware {
  return async (call, next) => {
    const { action, account } = call;
    if (!account || (!action.grants && !action.revokes)) return next();
    if (action.grants && call.principal.shared) {
      return errorResult(
        'This cannot be started through the team’s shared connection: the user has to connect their own AI app to the team.',
        'permission',
      );
    }
    const result = await next();
    if (result.isError || !call.invoked) return result;
    const target = { connectorId: call.connector.id, accountId: account.id };
    if (action.revokes) {
      await approvals.revoke(call.principal, { ...target, scope: action.revokes(call.input).scope });
    }
    if (action.grants) {
      const approval = await approvals.grant(
        call.principal,
        { ...target, grantedBy: call.tool.name },
        action.grants(call.input),
      );
      call.audit.approval = approval.id;
    }
    return result;
  };
}

// ---------------------------------------------------------------------------
// Untrusted content
// ---------------------------------------------------------------------------

/** Marks every open-world action result as third-party content (see `markUntrusted`). */
export const untrustedStage: Middleware = async (call, next) => {
  const result = await next();
  if (call.action.hints?.openWorld === false) return result;
  const source = call.account ? `${call.connector.name} · ${call.account.name}` : call.connector.name;
  return markUntrusted(result, source);
};
