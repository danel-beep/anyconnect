import type { Principal } from '../core/principal.js';
import type { WorkspaceBilling } from '../hub/billing-tools.js';
import { AppError } from '../lib/errors.js';
import type { EntitlementService, PlanUse, UsageSummary } from './entitlements.js';
import { PLANS, type Plan } from './plans.js';
import type { ReferralService } from './referrals.js';
import { BillingError, type BillingService } from './service.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const limit = (v: number | null) => v ?? 'unlimited';

/** What of a team a person's plan pays for (`PlanUse.covers`), for the AI. */
const COVERS: Record<PlanUse['covers'], string> = {
  everyone: 'everyone in the team',
  team: 'the team’s own accounts and shared key, and the user’s own use',
  self: 'only the user’s own use (in this team everyone uses their own plan)',
};

/**
 * The plan tools' view of billing (`manyplug_plan`, `manyplug_buy_plan`, `manyplug_cancel_plan`,
 * `manyplug_team_billing`): compact JSON for the AI and links to the billing page, where the user
 * pays. A plan is always the user's own (`/app/billing`); in a team the tools show who pays for it
 * and let a member pay for it with their own plan (`billing/payers.ts`).
 */
export class WorkspaceBillingTools implements WorkspaceBilling {
  constructor(
    private readonly deps: {
      entitlements: EntitlementService;
      billing: BillingService;
      referrals: ReferralService;
      publicUrl: string;
    },
  ) {}

  private get payers() {
    return this.deps.entitlements.payers;
  }

  /** The user's own workspace, where their plan lives (also when they ask from a team). */
  private async home(principal: Principal): Promise<string> {
    if (principal.shared) {
      throw new AppError(
        403,
        'shared_connection',
        'The team’s shared connection has no plan of its own: a member signs in as themselves to see or change theirs.',
      );
    }
    if (!(await this.payers.team(principal.workspaceId))) return principal.workspaceId;
    const home = await this.payers.home(principal.userId);
    if (!home) throw new AppError(404, 'no_workspace', 'The user has no workspace of their own');
    return home;
  }

  async status(principal: Principal): Promise<Record<string, unknown>> {
    if (await this.payers.team(principal.workspaceId)) return this.teamStatus(principal);
    const { entitlements: ent, billing } = this.deps;
    const summary = await ent.summary(principal.workspaceId);
    const paid = billing.liveSubscription(summary.subscription);
    const teams = await this.teamsOnPlan(principal.userId);
    return {
      ...planStatus(summary),
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
      ...(teams.length ? { teams_on_this_plan: teams } : {}),
      plans: summary.plan.public ? publicPlans() : [],
      online_payment: billing.enabled,
      manage_url: `${this.deps.publicUrl}/app/billing`,
      ...(billing.provider?.testMode ? { test_mode: true } : {}),
    };
  }

  /** In a team: who pays for it, with which plan and how much of it is used; the member's own plan. */
  private async teamStatus(principal: Principal): Promise<Record<string, unknown>> {
    const viewer = principal.shared ? null : principal.userId;
    const view = await this.deps.entitlements.teamBilling(principal.workspaceId, viewer);
    const { team, pool, mine } = view;
    const you = viewer !== null && team.payerUserId === viewer;
    return {
      team_billing: {
        mode: team.mode,
        how:
          team.mode === 'each'
            ? 'Everyone in the team uses their own plan; the payer’s plan covers only the team’s own accounts and its shared key.'
            : 'One person’s plan pays for everyone in the team.',
        paid_by: you ? 'the user' : team.payerName,
        ...planStatus(pool),
        actions_in_this_team_this_month: view.teamActions,
        shared_with:
          'The plan’s limits cover its owner’s own space and every team they pay for, together: one pool.',
      },
      ...(mine && !you
        ? {
            your_plan: {
              ...planStatus(mine),
              pays_for_your_use_here: team.mode === 'each',
            },
          }
        : {}),
      ...(viewer !== null ? { can_pay_for_team: view.canPay } : {}),
      how_to_change:
        'Any member may pay for the team with their own plan when it gives at least what the team has now (manyplug_team_billing pay=true; the owner can always take paying back), after buying one with manyplug_buy_plan if needed. Whoever pays may stop (pay=false) and the owner pays again. Owners and admins switch between one payer and everyone paying for themselves (mode).',
      plans: publicPlans(),
      online_payment: this.deps.billing.enabled,
      manage_url: `${this.deps.publicUrl}/app/team/${encodeURIComponent(team.slug)}#plan`,
    };
  }

  /** The teams a person's plan pays for (all or part of), with what each used of it this month. */
  private async teamsOnPlan(userId: string) {
    const { teams } = await this.deps.entitlements.planUses(userId);
    return teams.map((use) => ({
      team: use.team.name,
      covers: COVERS[use.covers],
      actions_this_month: use.actions,
    }));
  }

  async buyLink(principal: Principal, planId: string, interval: 'month' | 'year') {
    const plan = PLANS.find((p) => p.id === planId && p.public && p.priceMonthly > 0);
    if (!plan)
      throw new BillingError(
        'unknown_plan',
        `"${planId}" is not a plan that can be bought (see manyplug_plan)`,
      );
    const home = await this.home(principal);
    const { subscription: sub, plan: current } = await this.deps.entitlements.entitlements(home);
    if (!current.public)
      throw new BillingError('special_plan', `The user is on the special ${current.id} plan`, 409);
    const team = await this.payers.team(principal.workspaceId);
    const url = new URL('/app/billing', this.deps.publicUrl);
    url.searchParams.set('plan', plan.id);
    url.searchParams.set('interval', interval);
    // Back from paying, the billing page offers the way back to the team.
    if (team) url.searchParams.set('team', team.slug);
    return {
      url: url.toString(),
      switching: this.deps.billing.liveSubscription(sub) !== undefined,
      inTeam: team !== undefined,
    };
  }

  async setCancelAtPeriodEnd(principal: Principal, cancel: boolean) {
    const sub = await this.deps.billing.setCancelAtPeriodEnd(await this.home(principal), cancel);
    const teams = (await this.deps.entitlements.planUses(principal.userId)).teams.map((u) => u.team.name);
    return { planId: sub.planId, until: iso(sub.currentPeriodEnd), teams };
  }

  async changeTeamBilling(principal: Principal, change: { pay?: boolean; mode?: 'payer' | 'each' }) {
    const team = await this.payers.team(principal.workspaceId);
    if (!team) {
      throw new AppError(
        400,
        'not_a_team',
        'This connection is the user’s personal space: who pays is set in a team (through its connector or its page).',
      );
    }
    if (principal.shared) await this.home(principal); // refuses: the shared key changes nothing
    await this.deps.entitlements.changeTeamBilling(principal.userId, team.teamId, change);
    return this.teamStatus(principal);
  }

  async invite(userId: string) {
    const stats = await this.deps.referrals.stats(userId);
    return {
      link: stats.link,
      joined: stats.invited,
      rewarded: stats.rewarded,
      reward: `A month of Pro (${stats.rewardDays} days) for each person who joins through the link and starts a paid plan.`,
      manage_url: `${this.deps.publicUrl}/app/billing#invite`,
    };
  }
}

/** A plan with its start, limits and what it used, for the AI. */
function planStatus(summary: UsageSummary): Record<string, unknown> {
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
      resets_on: iso(summary.period.resetsAt),
    },
  };
}

const publicPlans = () => PLANS.filter((p) => p.public).map(planJson);

function planJson(p: Plan) {
  return {
    id: p.id,
    usd_per_month: p.priceMonthly,
    usd_per_year: p.priceYearly,
    actions_per_month: limit(p.limits.actions),
    accounts: limit(p.limits.accounts),
  };
}
