import type { WorkspaceBilling } from '../hub/billing-tools.js';
import type { EntitlementService } from './entitlements.js';
import { PLANS, type Plan, planFits } from './plans.js';
import { BillingError, type BillingService } from './service.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * The plan tools' view of billing (`manyplug_plan`, `manyplug_buy_plan`, `manyplug_cancel_plan`):
 * compact JSON for the AI and links to the billing page, where the user pays. A team's plan is
 * managed on the team's page, a person's own on `/app/billing`.
 */
export class WorkspaceBillingTools implements WorkspaceBilling {
  constructor(
    private readonly deps: {
      entitlements: EntitlementService;
      billing: BillingService;
      publicUrl: string;
      /** The slug of a team workspace (undefined for a personal one). */
      teamSlug?: (workspaceId: string) => Promise<string | undefined>;
    },
  ) {}

  /** Where the workspace's plan is bought and managed. */
  private async billingPage(workspaceId: string): Promise<URL> {
    const slug = await this.deps.teamSlug?.(workspaceId);
    return new URL(slug ? `/app/team/${slug}` : '/app/billing', this.deps.publicUrl);
  }

  async status(workspaceId: string): Promise<Record<string, unknown>> {
    const { entitlements: ent, billing } = this.deps;
    const summary = await ent.summary(workspaceId);
    const paid = billing.liveSubscription(summary.subscription);
    const limit = (v: number | null) => v ?? 'unlimited';
    const team = summary.workspaceKind === 'team';
    const page = await this.billingPage(workspaceId);
    return {
      plan: summary.plan.id,
      ...(summary.phase
        ? {
            // The published start: the AI can tell the user exactly when limits change.
            start: {
              now: summary.phase.kind === 'trial' ? `${summary.phase.asPlan} trial` : 'step down',
              until: iso(summary.phase.until),
              schedule: summary.schedule.map((p) => ({
                from: iso(p.from),
                until: iso(p.until),
                ...(p.asPlan ? { limits_of_plan: p.asPlan } : {}),
                actions_per_month: limit(p.limits.actions),
                accounts: limit(p.limits.accounts),
              })),
              after_that: {
                actions_per_month: limit(summary.plan.limits.actions),
                accounts: limit(summary.plan.limits.accounts),
              },
            },
          }
        : {}),
      usage: {
        actions_this_month: summary.used.actions,
        actions_limit: limit(summary.limits.actions),
        accounts: summary.used.accounts,
        accounts_limit: limit(summary.limits.accounts),
        ...(team ? { seats: limit(summary.limits.seats) } : {}),
        resets_on: iso(summary.period.resetsAt),
      },
      ...(paid
        ? {
            subscription: {
              status: paid.status,
              interval: paid.interval,
              ...(summary.plan.perSeat ? { seats: paid.quantity } : {}),
              [paid.cancelAtPeriodEnd ? 'ends_on' : 'renews_on']: iso(paid.currentPeriodEnd),
              paid_through: billing.provider?.name,
            },
          }
        : {}),
      ...(summary.grants.length
        ? {
            extra_limits: summary.grants.map((g) => ({
              limit: g.metric,
              extra: g.amount ?? 'unlimited',
              until: iso(g.expiresAt),
            })),
          }
        : {}),
      plans: summary.plan.public
        ? PLANS.filter((p) => p.public && planFits(p, summary.workspaceKind)).map((p) => planJson(p, limit))
        : [],
      online_payment: billing.enabled,
      manage_url: page.toString(),
      ...(billing.provider?.testMode ? { test_mode: true } : {}),
    };
  }

  async buyLink(workspaceId: string, planId: string, interval: 'month' | 'year', seats?: number) {
    const plan = PLANS.find((p) => p.id === planId && p.public && p.priceMonthly > 0);
    if (!plan)
      throw new BillingError(
        'unknown_plan',
        `"${planId}" is not a plan that can be bought (see manyplug_plan)`,
      );
    const {
      workspaceKind,
      subscription: sub,
      plan: current,
    } = await this.deps.entitlements.entitlements(workspaceId);
    if (!current.public)
      throw new BillingError('special_plan', `The workspace is on the special ${current.id} plan`, 409);
    if (!planFits(plan, workspaceKind)) {
      throw new BillingError(
        'plan_mismatch',
        workspaceKind === 'team'
          ? `A team buys the team plan, not ${plan.id}`
          : `The ${plan.id} plan is for teams: the user creates a team first (manyplug_team shows how)`,
      );
    }
    const url = await this.billingPage(workspaceId);
    url.searchParams.set('plan', plan.id);
    url.searchParams.set('interval', interval);
    if (plan.perSeat && seats) {
      const { min, max } = plan.perSeat;
      url.searchParams.set('seats', String(Math.min(max, Math.max(min, seats))));
    }
    if (plan.perSeat) url.hash = 'plan';
    // Without online payment the page lets the user request the plan from the team.
    return { url: url.toString(), switching: this.deps.billing.liveSubscription(sub) !== undefined };
  }

  async setCancelAtPeriodEnd(workspaceId: string, cancel: boolean) {
    const sub = await this.deps.billing.setCancelAtPeriodEnd(workspaceId, cancel);
    return { planId: sub.planId, until: iso(sub.currentPeriodEnd) };
  }
}

/** One plan for the AI: per-person plans say so, with their seat range. */
function planJson(p: Plan, limit: (v: number | null) => number | string) {
  return {
    id: p.id,
    usd_per_month: p.priceMonthly,
    usd_per_year: p.priceYearly,
    ...(p.perSeat
      ? {
          priced: 'per person',
          people: `${p.perSeat.min}-${p.perSeat.max}`,
          actions_per_month_per_person: limit(p.limits.actions),
        }
      : { actions_per_month: limit(p.limits.actions) }),
    accounts: limit(p.limits.accounts),
  };
}
