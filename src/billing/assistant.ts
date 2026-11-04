import type { WorkspaceBilling } from '../hub/billing-tools.js';
import type { EntitlementService } from './entitlements.js';
import { PLANS } from './plans.js';
import { BillingError, type BillingService } from './service.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * The plan tools' view of billing (`manyplug_plan`, `manyplug_buy_plan`, `manyplug_cancel_plan`):
 * compact JSON for the AI and links to the billing page, where the user pays.
 */
export class WorkspaceBillingTools implements WorkspaceBilling {
  constructor(
    private readonly deps: { entitlements: EntitlementService; billing: BillingService; publicUrl: string },
  ) {}

  async status(workspaceId: string): Promise<Record<string, unknown>> {
    const { entitlements: ent, billing } = this.deps;
    const summary = await ent.summary(workspaceId);
    const paid = billing.liveSubscription(summary.subscription);
    const limit = (v: number | null) => v ?? 'unlimited';
    return {
      plan: summary.plan.id,
      ...(summary.intro ? { intro_limits_until: iso(summary.intro.until) } : {}),
      usage: {
        actions_this_month: summary.used.actions,
        actions_limit: limit(summary.limits.actions),
        accounts: summary.used.accounts,
        accounts_limit: limit(summary.limits.accounts),
        resets_on: iso(summary.period.resetsAt),
      },
      ...(paid
        ? {
            subscription: {
              status: paid.status,
              interval: paid.interval,
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
        ? PLANS.filter((p) => p.public).map((p) => ({
            id: p.id,
            usd_per_month: p.priceMonthly,
            usd_per_year: p.priceYearly,
            actions_per_month: limit(p.limits.actions),
            accounts: limit(p.limits.accounts),
          }))
        : [],
      online_payment: billing.enabled,
      manage_url: `${this.deps.publicUrl}/app/billing`,
      ...(billing.provider?.testMode ? { test_mode: true } : {}),
    };
  }

  async buyLink(workspaceId: string, planId: string, interval: 'month' | 'year') {
    const plan = PLANS.find((p) => p.id === planId && p.public && p.priceMonthly > 0);
    if (!plan)
      throw new BillingError(
        'unknown_plan',
        `"${planId}" is not a plan that can be bought (see manyplug_plan)`,
      );
    const sub = await this.deps.entitlements.subscription(workspaceId);
    const current = this.deps.entitlements.planFor(sub);
    if (!current.public)
      throw new BillingError('special_plan', `The workspace is on the special ${current.id} plan`, 409);
    const url = new URL('/app/billing', this.deps.publicUrl);
    url.searchParams.set('plan', plan.id);
    url.searchParams.set('interval', interval);
    // Without online payment the page lets the user request the plan from the team.
    return { url: url.toString(), switching: this.deps.billing.liveSubscription(sub) !== undefined };
  }

  async setCancelAtPeriodEnd(workspaceId: string, cancel: boolean) {
    const sub = await this.deps.billing.setCancelAtPeriodEnd(workspaceId, cancel);
    return { planId: sub.planId, until: iso(sub.currentPeriodEnd) };
  }
}
