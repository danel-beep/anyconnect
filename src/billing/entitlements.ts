import { and, count, desc, eq, gt, isNull, or, sql, sum } from 'drizzle-orm';
import type { AccountLimits } from '../core/accounts.js';
import { type Principal, usageCaller } from '../core/principal.js';
import type { Db } from '../db/client.js';
import {
  accounts,
  limitGrants,
  type SubscriptionStatus,
  subscriptions,
  usageCounters,
  workspaces,
} from '../db/schema.js';
import type { QuotaDecision, QuotaGate } from '../hub/quota.js';
import type { UsageMeter } from '../hub/usage.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { monthPeriod, type Period } from './period.js';
import {
  addLimit,
  DEFAULT_PLAN_ID,
  findPlan,
  getPlan,
  isMetric,
  type Limits,
  type LimitValue,
  METRICS,
  type Metric,
  type Plan,
} from './plans.js';

export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type LimitGrantRow = typeof limitGrants.$inferSelect;

/** What a workspace may use right now: its plan, the intro period and admin grants applied. */
export interface Entitlements {
  plan: Plan;
  subscription: SubscriptionRow | undefined;
  limits: Limits;
  /** Set while the plan's more generous start applies. */
  intro: { until: Date } | undefined;
  grants: LimitGrantRow[];
  period: Period;
}

export interface UsageSummary extends Entitlements {
  used: { actions: number; accounts: number };
}

/** A refused limit check: HTTP 402 with a code the website turns into an upgrade hint. */
export class PlanLimitError extends AppError {
  constructor(
    readonly metric: Metric,
    readonly limit: number,
    message: string,
  ) {
    super(402, 'plan_limit', message, { metric, limit });
  }
}

const CACHE_MS = 10_000;

/**
 * Plans, limits and grants of workspaces. Implements the hub's `QuotaGate` (actions per month) and
 * the account service's `AccountLimits`. Payment providers and admins change plans through
 * `setPlan`; admins add limits with `grant`.
 */
export class EntitlementService implements QuotaGate, AccountLimits {
  /** Short-lived snapshot of usage per workspace, bumped locally between refreshes. */
  private readonly usageCache = new Map<string, { at: number; period: string; actions: number }>();
  private readonly callerCache = new Map<string, { at: number; period: string; actions: number }>();

  constructor(
    private readonly deps: {
      db: Db;
      usage: UsageMeter;
      /** Absolute URL of the pricing page, quoted to the AI when a limit is reached. */
      pricingUrl: string;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // --- Reading -----------------------------------------------------------------

  async subscription(workspaceId: string): Promise<SubscriptionRow | undefined> {
    const [row] = await this.deps.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId))
      .limit(1);
    return row;
  }

  /** The plan in force: a subscription that ended or was canceled falls back to the free plan. */
  planFor(subscription: SubscriptionRow | undefined, at = this.now()): Plan {
    if (!subscription) return getPlan(DEFAULT_PLAN_ID);
    const ended = subscription.currentPeriodEnd && subscription.currentPeriodEnd.getTime() <= at.getTime();
    if (subscription.status === 'canceled' || ended) return getPlan(DEFAULT_PLAN_ID);
    return getPlan(subscription.planId);
  }

  async grants(workspaceId: string, opts: { activeOnly?: boolean } = {}): Promise<LimitGrantRow[]> {
    const now = this.now();
    const active = and(
      isNull(limitGrants.revokedAt),
      or(isNull(limitGrants.expiresAt), gt(limitGrants.expiresAt, now)),
    );
    return this.deps.db
      .select()
      .from(limitGrants)
      .where(and(eq(limitGrants.workspaceId, workspaceId), opts.activeOnly ? active : undefined))
      .orderBy(desc(limitGrants.createdAt));
  }

  async entitlements(workspaceId: string): Promise<Entitlements> {
    const now = this.now();
    const [workspace] = await this.deps.db
      .select({ createdAt: workspaces.createdAt })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!workspace) throw notFound('Workspace');
    const [subscription, grants] = await Promise.all([
      this.subscription(workspaceId),
      this.grants(workspaceId, { activeOnly: true }),
    ]);
    const plan = this.planFor(subscription, now);
    const limits = { ...plan.limits };
    let intro: Entitlements['intro'];
    if (plan.intro) {
      const until = new Date(workspace.createdAt.getTime() + plan.intro.days * 86_400_000);
      if (until.getTime() > now.getTime()) {
        intro = { until };
        for (const [metric, value] of Object.entries(plan.intro.limits) as [Metric, LimitValue][]) {
          const base = limits[metric];
          limits[metric] = base === null || value === null ? null : Math.max(base, value);
        }
      }
    }
    for (const grant of grants) {
      if (isMetric(grant.metric)) limits[grant.metric] = addLimit(limits[grant.metric], grant.amount);
    }
    return { plan, subscription, limits, intro, grants, period: monthPeriod(now) };
  }

  async actionsUsed(workspaceId: string, period: Period): Promise<number> {
    const [row] = await this.deps.db
      .select({ calls: sum(usageCounters.calls) })
      .from(usageCounters)
      .where(and(eq(usageCounters.workspaceId, workspaceId), sql`${usageCounters.day} >= ${period.start}`))
      .limit(1);
    return Number(row?.calls ?? 0);
  }

  async accountsUsed(workspaceId: string): Promise<number> {
    const [row] = await this.deps.db
      .select({ n: count() })
      .from(accounts)
      .where(eq(accounts.workspaceId, workspaceId));
    return row?.n ?? 0;
  }

  async summary(workspaceId: string): Promise<UsageSummary> {
    const ent = await this.entitlements(workspaceId);
    const [actions, accountsCount] = await Promise.all([
      this.actionsUsed(workspaceId, ent.period),
      this.accountsUsed(workspaceId),
    ]);
    return { ...ent, used: { actions, accounts: accountsCount } };
  }

  // --- Enforcing ---------------------------------------------------------------

  async checkAction(principal: Principal): Promise<QuotaDecision> {
    const ent = await this.entitlements(principal.workspaceId);
    const limit = ent.limits.actions;
    if (limit === null) return { allowed: true };
    const used = await this.cachedUsage(this.usageCache, principal.workspaceId, ent.period, () =>
      this.actionsUsed(principal.workspaceId, ent.period),
    );
    if (used >= limit) return { allowed: false, message: this.actionsMessage(ent, limit) };
    // The free allowance belongs to the person at the AI provider, not to a sign-up: several hub
    // accounts used from one ChatGPT account share it.
    if (ent.plan.priceMonthly === 0 && principal.aiSubject) {
      const caller = usageCaller(principal);
      const byCaller = await this.cachedUsage(this.callerCache, caller, ent.period, () =>
        this.deps.usage.callerTotal(caller, ent.period.start),
      );
      if (byCaller >= limit) return { allowed: false, message: this.actionsMessage(ent, limit) };
      this.bump(this.callerCache, caller);
    }
    this.bump(this.usageCache, principal.workspaceId);
    return { allowed: true };
  }

  private actionsMessage(ent: Entitlements, limit: number): string {
    const reset = ent.period.resetsAt.toISOString().slice(0, 10);
    return (
      `The AnyConnect plan limit is reached: ${limit} actions this month on the ${ent.plan.id} plan ` +
      `(resets on ${reset}). Tell the user; they can upgrade at ${this.deps.pricingUrl}. Do not retry.`
    );
  }

  private async cachedUsage(
    cache: Map<string, { at: number; period: string; actions: number }>,
    key: string,
    period: Period,
    load: () => Promise<number>,
  ): Promise<number> {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.period === period.start && now - hit.at < CACHE_MS) return hit.actions;
    const actions = await load();
    cache.set(key, { at: now, period: period.start, actions });
    if (cache.size > 10_000) cache.delete(cache.keys().next().value!);
    return actions;
  }

  private bump(cache: Map<string, { at: number; period: string; actions: number }>, key: string): void {
    const hit = cache.get(key);
    if (hit) hit.actions += 1;
  }

  /** Throws `PlanLimitError` when one more account would exceed the plan. */
  async assertCanAddAccount(workspaceId: string): Promise<void> {
    const ent = await this.entitlements(workspaceId);
    const limit = ent.limits.accounts;
    if (limit === null) return;
    const used = await this.accountsUsed(workspaceId);
    if (used >= limit) {
      throw new PlanLimitError(
        'accounts',
        limit,
        `The ${ent.plan.id} plan allows ${limit} connected accounts and all of them are in use. ` +
          `Remove an account or upgrade at ${this.deps.pricingUrl}.`,
      );
    }
  }

  // --- Changing ----------------------------------------------------------------

  async setPlan(
    workspaceId: string,
    planId: string,
    opts: {
      provider?: string;
      externalId?: string | null;
      status?: SubscriptionStatus;
      periodEnd?: Date | null;
      note?: string | null;
    } = {},
  ): Promise<SubscriptionRow> {
    if (!findPlan(planId)) throw badRequest(`Unknown plan "${planId}"`);
    const values = {
      planId,
      status: opts.status ?? ('active' as const),
      provider: opts.provider ?? 'manual',
      externalId: opts.externalId ?? null,
      currentPeriodEnd: opts.periodEnd ?? null,
      cancelAtPeriodEnd: false,
      note: opts.note ?? null,
    };
    const [row] = await this.deps.db
      .insert(subscriptions)
      .values({ workspaceId, ...values })
      .onConflictDoUpdate({ target: subscriptions.workspaceId, set: { ...values, updatedAt: new Date() } })
      .returning();
    this.usageCache.delete(workspaceId);
    return row!;
  }

  /** Gives a plan only when the workspace has none yet (e.g. the hub owner's workspace). */
  async ensurePlan(workspaceId: string, planId: string): Promise<void> {
    if (!(await this.subscription(workspaceId))) await this.setPlan(workspaceId, planId);
  }

  async grant(
    workspaceId: string,
    input: {
      metric: string;
      /** Extra units; null lifts the limit. */
      amount: number | null;
      expiresAt?: Date | null;
      reason?: string | null;
      grantedBy?: string | null;
    },
  ): Promise<LimitGrantRow> {
    if (!isMetric(input.metric))
      throw badRequest(`Unknown limit "${input.metric}" (one of ${METRICS.join(', ')})`);
    if (
      input.amount !== null &&
      (!Number.isInteger(input.amount) || input.amount <= 0 || input.amount > 1e9)
    ) {
      throw badRequest('The amount must be a positive whole number');
    }
    if (input.expiresAt && input.expiresAt.getTime() <= this.now().getTime()) {
      throw badRequest('The end date must be in the future');
    }
    const [row] = await this.deps.db
      .insert(limitGrants)
      .values({
        id: newId('lim'),
        workspaceId,
        metric: input.metric,
        amount: input.amount,
        expiresAt: input.expiresAt ?? null,
        reason: input.reason?.slice(0, 500) ?? null,
        grantedBy: input.grantedBy ?? null,
      })
      .returning();
    return row!;
  }

  async revokeGrant(workspaceId: string, grantId: string): Promise<LimitGrantRow> {
    const [row] = await this.deps.db
      .update(limitGrants)
      .set({ revokedAt: this.now() })
      .where(
        and(
          eq(limitGrants.workspaceId, workspaceId),
          eq(limitGrants.id, grantId),
          isNull(limitGrants.revokedAt),
        ),
      )
      .returning();
    if (!row) throw notFound('Limit grant');
    return row;
  }
}
