import { z } from 'zod';
import type { ActionDefinition, AnyObjectSchema } from '../connectors/sdk.js';
import type { Principal } from '../core/principal.js';
import { AppError } from '../lib/errors.js';
import type { SetupActionSpec } from './setup-tools.js';

/**
 * What the plan tools need from the billing layer. Defined here, implemented by
 * `WorkspaceBillingTools` (`src/billing/assistant.ts`), so the hub does not depend on billing.
 * A plan is always the caller's own; in a team the tools also show who pays for it.
 */
export interface WorkspaceBilling {
  /** Plan, limits, usage, subscription and what can be bought (in a team: who pays for it): plain JSON for the AI. */
  status(principal: Principal): Promise<Record<string, unknown>>;
  /** A link to the user's own billing page with the plan ready to buy or switch to. */
  buyLink(
    principal: Principal,
    planId: string,
    interval: 'month' | 'year',
  ): Promise<{ url: string; switching: boolean; inTeam: boolean }>;
  /** Cancels the user's own paid subscription at the end of its period (`false` takes that back). */
  setCancelAtPeriodEnd(
    principal: Principal,
    cancel: boolean,
  ): Promise<{ planId: string; until: string | null; teams: string[] }>;
  /** Changes who pays for the caller's team, then shows how it pays. */
  changeTeamBilling(
    principal: Principal,
    change: { pay?: boolean; mode?: 'payer' | 'each' },
  ): Promise<Record<string, unknown>>;
  /** The user's invite link and what invites have brought so far. */
  invite(userId: string): Promise<Record<string, unknown>>;
}

/**
 * The plan tools (`manyplug_plan`, `manyplug_buy_plan`, `manyplug_cancel_plan`,
 * `manyplug_team_billing`): the user sees and changes their plan, and who pays for their team, from
 * the chat. Paying always happens on the provider's secure page (the AI only gets a link), so the
 * AI can never spend money on its own; cancelling needs confirmation.
 */
const billing = (ctx: { billing?: WorkspaceBilling }): WorkspaceBilling => {
  // Every hub built by `createServices` has billing; a bare test hub may not.
  if (!ctx.billing) throw new AppError(501, 'no_billing', 'Plans are not available on this server');
  return ctx.billing;
};

export function billingActions(
  define: <T extends AnyObjectSchema>(spec: SetupActionSpec<T>) => ActionDefinition,
): ActionDefinition[] {
  return [
    define({
      name: 'plan',
      tags: ['commerce'],
      title: 'Plan and usage',
      description:
        'Shows the user’s plan, its limits, usage this month, the paid subscription (renewal, cancellation) and the plans with prices. In a team: who pays for the team, with which plan, and how much of it is used.',
      input: z.object({}),
      risk: 'read',
      hints: { readOnly: true, idempotent: true, openWorld: false },
      async run(_input, ctx) {
        return billing(ctx).status(ctx.principal);
      },
    }),
    define({
      name: 'buy_plan',
      tags: ['commerce'],
      title: 'Upgrade or change the plan',
      description:
        'Returns a link where the user buys a plan for themselves or switches their paid one (prices: manyplug_plan). Payment happens on a secure page, never in the chat; give the user the link.',
      input: z.object({
        plan: z.string().min(1).max(40).describe('Plan id, e.g. "pro"'),
        interval: z.enum(['month', 'year']).default('month'),
      }),
      risk: 'read',
      hints: { readOnly: true, idempotent: true, openWorld: false },
      async run({ plan, interval }, ctx) {
        await ctx.admin.authorize(ctx.principal, 'member');
        const link = await billing(ctx).buyLink(ctx.principal, plan, interval);
        const then = link.inTeam
          ? ' Once it is active the user can pay for the team with it (manyplug_team_billing pay=true).'
          : '';
        return {
          url: link.url,
          instructions:
            (link.switching
              ? 'Ask the user to open the link and confirm the switch; the price difference for the current period is charged or credited. Check the result with manyplug_plan.'
              : 'Ask the user to open the link and pay on the secure checkout page. The plan switches within a minute; check with manyplug_plan.') +
            then,
        };
      },
    }),
    define({
      name: 'cancel_plan',
      tags: ['commerce'],
      title: 'Cancel the paid plan',
      description:
        'Cancels the user’s own paid subscription at the end of the paid period (the plan stays until then), or with undo=true takes a cancellation back. Teams the user pays for move with their plan. The user always confirms.',
      input: z.object({ undo: z.boolean().default(false) }),
      risk: 'dangerous',
      requiresConfirmation: true,
      hints: { destructive: true, idempotent: true, openWorld: false },
      async run({ undo }, ctx) {
        await ctx.admin.authorize(ctx.principal, 'member');
        const result = await billing(ctx).setCancelAtPeriodEnd(ctx.principal, !undo);
        const teams = result.teams.length ? { teams_on_this_plan: result.teams } : {};
        return undo
          ? { resumed: true, plan: result.planId, renews: result.until, ...teams }
          : {
              canceled: true,
              plan: result.planId,
              plan_stays_until: result.until,
              after_that: 'free',
              ...teams,
            };
      },
    }),
    define({
      name: 'team_billing',
      tags: ['commerce'],
      title: 'Who pays for the team',
      description:
        'Changes who pays for the team. pay=true: the user pays for it with their own plan (it must give at least what the team has; the owner can always take paying back); pay=false: they stop and the owner pays again. Owners and admins set mode: "payer" (one person’s plan covers everyone) or "each" (everyone uses their own plan). manyplug_plan shows how the team pays now.',
      input: z.object({
        pay: z
          .boolean()
          .optional()
          .describe('true: the user pays for the team with their own plan; false: they stop paying'),
        mode: z
          .enum(['payer', 'each'])
          .optional()
          .describe('payer: one person’s plan pays for everyone · each: every member uses their own plan'),
      }),
      risk: 'write',
      hints: { idempotent: true, openWorld: false },
      async assessRisk({ mode }) {
        if (!mode) return undefined;
        // Moves everyone in the team onto other limits: the user confirms.
        return {
          risk: 'dangerous',
          confirm: true,
          reason:
            mode === 'each'
              ? 'Everyone in the team will use their own plan'
              : 'One person’s plan will pay for everyone in the team',
        };
      },
      async run({ pay, mode }, ctx) {
        await ctx.admin.authorize(ctx.principal, 'member');
        if (pay === undefined && mode === undefined) {
          throw new AppError(
            400,
            'nothing_to_change',
            'Say what to change: pay (true or false) or mode ("payer" or "each"). manyplug_plan shows how the team pays now.',
          );
        }
        return billing(ctx).changeTeamBilling(ctx.principal, {
          ...(pay !== undefined ? { pay } : {}),
          ...(mode ? { mode } : {}),
        });
      },
    }),
  ];
}

/**
 * The invite tool (`manyplug_invite`): the user's referral link and stats. Rarely needed, so the
 * setup list puts it last (it is still found by search when the tool list is full).
 */
export function referralActions(
  define: <T extends AnyObjectSchema>(spec: SetupActionSpec<T>) => ActionDefinition,
): ActionDefinition[] {
  return [
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
  ];
}
