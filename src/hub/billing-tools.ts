import { z } from 'zod';
import type { ActionDefinition, AnyObjectSchema } from '../connectors/sdk.js';
import { AppError } from '../lib/errors.js';
import type { SetupActionSpec } from './setup-tools.js';

/**
 * What the plan tools need from the billing layer. Defined here, implemented by
 * `WorkspaceBillingTools` (`src/billing/assistant.ts`), so the hub does not depend on billing.
 */
export interface WorkspaceBilling {
  /** Plan, limits, usage, subscription and what can be bought: plain JSON for the AI. */
  status(workspaceId: string): Promise<Record<string, unknown>>;
  /** A link to the billing page with the plan ready to buy or switch to. */
  buyLink(
    workspaceId: string,
    planId: string,
    interval: 'month' | 'year',
  ): Promise<{ url: string; switching: boolean }>;
  /** Cancels the paid subscription at the end of its period (`false` takes that back). */
  setCancelAtPeriodEnd(
    workspaceId: string,
    cancel: boolean,
  ): Promise<{ planId: string; until: string | null }>;
  /** The user's invite link and what invites have brought so far. */
  invite(userId: string): Promise<Record<string, unknown>>;
}

/**
 * The plan tools (`manyplug_plan`, `manyplug_buy_plan`, `manyplug_cancel_plan`, `manyplug_invite`): the user sees and
 * changes their plan from the chat. Paying always happens on the provider's secure page (the AI
 * only gets a link), so the AI can never spend money on its own; cancelling needs confirmation.
 */
export function billingActions(
  define: <T extends AnyObjectSchema>(spec: SetupActionSpec<T>) => ActionDefinition,
): ActionDefinition[] {
  const billing = (ctx: { billing?: WorkspaceBilling }): WorkspaceBilling => {
    // Every hub built by `createServices` has billing; a bare test hub may not.
    if (!ctx.billing) throw new AppError(501, 'no_billing', 'Plans are not available on this server');
    return ctx.billing;
  };
  return [
    define({
      name: 'plan',
      title: 'Plan and usage',
      description:
        'Shows the current plan, its limits, usage this month, the paid subscription (renewal, cancellation) and the plans with prices.',
      input: z.object({}),
      risk: 'read',
      hints: { readOnly: true, idempotent: true, openWorld: false },
      async run(_input, ctx) {
        return billing(ctx).status(ctx.principal.workspaceId);
      },
    }),
    define({
      name: 'buy_plan',
      title: 'Upgrade or change the plan',
      description:
        'Returns a link where the user buys a plan or switches the paid one (prices: manyplug_plan). Payment happens on a secure page, never in the chat; give the user the link.',
      input: z.object({
        plan: z.string().min(1).max(40).describe('Plan id, e.g. "pro"'),
        interval: z.enum(['month', 'year']).default('month'),
      }),
      risk: 'read',
      hints: { readOnly: true, idempotent: true, openWorld: false },
      async run({ plan, interval }, ctx) {
        const link = await billing(ctx).buyLink(ctx.principal.workspaceId, plan, interval);
        return {
          url: link.url,
          instructions: link.switching
            ? 'Ask the user to open the link and confirm the switch; the price difference for the current period is charged or credited. Check the result with manyplug_plan.'
            : 'Ask the user to open the link and pay on the secure checkout page. The plan switches within a minute; check with manyplug_plan.',
        };
      },
    }),
    define({
      name: 'invite',
      title: 'Invite friends',
      description:
        "Returns the user's invite link and how many people joined through it. When someone who joined through the link starts a paid plan, the user gets a month of Pro.",
      input: z.object({}),
      risk: 'read',
      hints: { readOnly: true, idempotent: true, openWorld: false },
      async run(_input, ctx) {
        return billing(ctx).invite(ctx.principal.userId);
      },
    }),
    define({
      name: 'cancel_plan',
      title: 'Cancel the paid plan',
      description:
        'Cancels the paid subscription at the end of the paid period (the plan stays until then), or with undo=true takes a cancellation back. The user always confirms.',
      input: z.object({ undo: z.boolean().default(false) }),
      risk: 'dangerous',
      requiresConfirmation: true,
      hints: { destructive: true, idempotent: true, openWorld: false },
      async run({ undo }, ctx) {
        const result = await billing(ctx).setCancelAtPeriodEnd(ctx.principal.workspaceId, !undo);
        return undo
          ? { resumed: true, plan: result.planId, renews: result.until }
          : { canceled: true, plan: result.planId, plan_stays_until: result.until, after_that: 'free' };
      },
    }),
  ];
}
