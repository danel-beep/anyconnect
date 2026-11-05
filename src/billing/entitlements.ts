import { and, count, desc, eq, gt, isNull, or, sql, sum } from 'drizzle-orm';
import type { AccountLimits } from '../core/accounts.js';
import { type Principal, usageCaller } from '../core/principal.js';
import type { TeamLimits } from '../core/teams.js';
import type { Db } from '../db/client.js';
import {
  accounts,
  limitGrants,
  planRequests,
  type SubscriptionStatus,
  subscriptions,
  usageCounters,
  type WorkspaceKind,
  workspaceMembers,
  workspaces,
} from '../db/schema.js';
import type { QuotaDecision, QuotaGate } from '../hub/quota.js';
import type { UsageMeter } from '../hub/usage.js';
import { AppError, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { monthPeriod, type Period } from './period.js';
import {
  addLimit,
  DEFAULT_PLAN_ID,
  findPlan,
  getPlan,
  isMetric,
  type Limits,
  limitsFor,
  METRICS,
  type Metric,
  type Plan,
} from './plans.js';
import { type StartPhase, startNow } from './start.js';

export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type LimitGrantRow = typeof limitGrants.$inferSelect;

/** What a workspace may use right now: its plan, its start (trial, steps) and admin grants applied. */
export interface Entitlements {
  plan: Plan;
  subscription: SubscriptionRow | undefined;
  /** A person's own workspace or a team's. */
  workspaceKind: WorkspaceKind;
  limits: Limits;
  /** The trial or step of the plan's start in force now (see `Plan.start`). */
  phase: StartPhase | undefined;
  /** The whole published start of this workspace (empty when the plan has none). */
  schedule: StartPhase[];
  grants: LimitGrantRow[];
  period: Period;
  /**
   * First day whose actions count against this month's limit (`YYYY-MM-DD`): the period start, or
   * the day the trial ended when that was this month, so trial use does not eat the free allowance.
   */
  countFrom: string;
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
 * Plans, limits and grants of workspaces. Implements the hub's `QuotaGate` (actions per month, and
 * seats in a team), the account service's `AccountLimits` and the team service's `TeamLimits`.
 * Payment providers and admins change plans through `setPlan`; admins add limits with `grant`.
 */
export class EntitlementService implements QuotaGate, AccountLimits, TeamLimits {
  /** Short-lived snapshot of usage per workspace, bumped locally between refreshes. */
  private readonly usageCache = new Map<string, { at: number; period: string; actions: number }>();
  private readonly callerCache = new Map<string, { at: number; period: string; actions: number }>();
  /** Who holds a team's seats, per workspace and seat count. */
  private readonly seatCache = new Map<string, { at: number; holders: Set<string> }>();

  constructor(
    private readonly deps: {
      db: Db;
      usage: UsageMeter;
      /** Absolute URL of the pricing page, quoted to the AI when a limit is reached. */
      pricingUrl: string;
      /** Absolute URL of the teams page, where a team's owner buys seats. */
      teamsUrl?: string;
      now?: () => Date;
    },
  ) {}

  private get teamsUrl(): string {
    return this.deps.teamsUrl ?? this.deps.pricingUrl;
  }

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
    const inactive = subscription.status === 'canceled' || subscription.status === 'paused';
    if (inactive || ended) return getPlan(DEFAULT_PLAN_ID);
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
      .select({ createdAt: workspaces.createdAt, kind: workspaces.kind })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!workspace) throw notFound('Workspace');
    const [subscription, grants] = await Promise.all([
      this.subscription(workspaceId),
      this.grants(workspaceId, { activeOnly: true }),
    ]);
    const plan = this.planFor(subscription, now);
    const { phase, schedule, trialEnd } = startNow(plan, workspace.createdAt, now);
    const limits = { ...(phase?.limits ?? limitsFor(plan, subscription?.quantity)) };
    for (const grant of grants) {
      if (isMetric(grant.metric)) limits[grant.metric] = addLimit(limits[grant.metric], grant.amount);
    }
    const period = monthPeriod(now);
    const trialEndDay =
      trialEnd && trialEnd.getTime() <= now.getTime() ? trialEnd.toISOString().slice(0, 10) : '';
    // Trial usage does not eat into the first post-trial month (ISO days compare as strings).
    const countFrom = [period.start, trialEndDay].sort().at(-1) ?? period.start;
    return {
      plan,
      subscription,
      workspaceKind: workspace.kind,
      limits,
      phase,
      schedule,
      grants,
      period,
      countFrom,
    };
  }

  /** Actions since `from` (`YYYY-MM-DD`, see `Entitlements.countFrom`). */
  async actionsUsed(workspaceId: string, from: string): Promise<number> {
    const [row] = await this.deps.db
      .select({ calls: sum(usageCounters.calls) })
      .from(usageCounters)
      .where(and(eq(usageCounters.workspaceId, workspaceId), sql`${usageCounters.day} >= ${from}`))
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
      this.actionsUsed(workspaceId, ent.countFrom),
      this.accountsUsed(workspaceId),
    ]);
    return { ...ent, used: { actions, accounts: accountsCount } };
  }

  // --- Enforcing ---------------------------------------------------------------

  async checkAction(principal: Principal): Promise<QuotaDecision> {
    const ent = await this.entitlements(principal.workspaceId);
    const seats = await this.seatCheck(principal, ent);
    if (!seats.allowed) return seats;
    const limit = ent.limits.actions;
    if (limit === null) return { allowed: true };
    const used = await this.cachedUsage(this.usageCache, principal.workspaceId, ent.countFrom, () =>
      this.actionsUsed(principal.workspaceId, ent.countFrom),
    );
    if (used >= limit) return { allowed: false, message: this.actionsMessage(ent, limit) };
    // The free allowance belongs to the person at the AI provider, not to a sign-up: several hub
    // accounts used from one ChatGPT account share it.
    if (ent.plan.priceMonthly === 0 && principal.aiSubject) {
      const caller = usageCaller(principal);
      const byCaller = await this.cachedUsage(this.callerCache, caller, ent.countFrom, () =>
        this.deps.usage.callerTotal(caller, ent.countFrom),
      );
      if (byCaller >= limit) return { allowed: false, message: this.actionsMessage(ent, limit) };
      this.bump(this.callerCache, caller);
    }
    this.bump(this.usageCache, principal.workspaceId);
    return { allowed: true };
  }

  /**
   * In a team, as many people as the plan has seats use it: the owner and those who joined first.
   * More members than seats happen when a trial ends or seats are removed; the others are told to
   * ask for seats instead of being removed. The team's shared connection is nobody's seat.
   */
  private async seatCheck(principal: Principal, ent: Entitlements): Promise<QuotaDecision> {
    const seats = ent.limits.seats;
    if (ent.workspaceKind !== 'team' || seats === null || principal.shared) return { allowed: true };
    let holders = await this.seatHolders(principal.workspaceId, seats);
    // A free seat means the cached list may predate someone who just joined: look again.
    if (!holders.has(principal.userId) && holders.size < seats)
      holders = await this.seatHolders(principal.workspaceId, seats, true);
    if (holders.has(principal.userId)) return { allowed: true };
    return {
      allowed: false,
      message:
        `This team’s ${ent.plan.id} plan has ${seats} seat${seats === 1 ? '' : 's'}, all taken by members ` +
        `who joined earlier, so this user cannot use the team’s services right now. Tell the user to ask ` +
        `the team’s owner to add seats at ${this.teamsUrl}. Do not retry.`,
    };
  }

  private async seatHolders(workspaceId: string, seats: number, fresh = false): Promise<Set<string>> {
    const key = `${workspaceId}:${seats}`;
    const hit = this.seatCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.holders;
    const rows = await this.deps.db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .orderBy(sql`(${workspaceMembers.role} = 'owner') desc`, workspaceMembers.createdAt)
      .limit(seats);
    const holders = new Set(rows.map((r) => r.userId));
    this.seatCache.set(key, { at: Date.now(), holders });
    if (this.seatCache.size > 10_000) this.seatCache.delete(this.seatCache.keys().next().value!);
    return holders;
  }

  /** Throws `PlanLimitError` when `taken` seats (members and open invitations) fill the team's plan. */
  async assertCanAddMember(workspaceId: string, taken: number): Promise<void> {
    const ent = await this.entitlements(workspaceId);
    const limit = ent.limits.seats;
    if (limit === null || taken < limit) return;
    throw new PlanLimitError(
      'seats',
      limit,
      `The team’s ${ent.plan.id} plan has ${limit} seat${limit === 1 ? '' : 's'} and members and open ` +
        `invitations take all of them. Add seats at ${this.teamsUrl} or take back an invitation.`,
    );
  }

  private actionsMessage(ent: Entitlements, limit: number): string {
    const reset = ent.period.resetsAt.toISOString().slice(0, 10);
    return (
      `The Manyplug plan limit is reached: ${limit} actions this month on the ${ent.plan.id} plan ` +
      `(resets on ${reset}). Tell the user; they can upgrade at ${this.deps.pricingUrl}. Do not retry.`
    );
  }

  private async cachedUsage(
    cache: Map<string, { at: number; period: string; actions: number }>,
    key: string,
    /** Where counting starts; a new month or the end of the trial starts a new count. */
    from: string,
    load: () => Promise<number>,
  ): Promise<number> {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.period === from && now - hit.at < CACHE_MS) return hit.actions;
    const actions = await load();
    cache.set(key, { at: now, period: from, actions });
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
      /** Payment provider details (see `BillingService`). */
      customerId?: string | null;
      interval?: 'month' | 'year' | null;
      cancelAtPeriodEnd?: boolean;
      providerUpdatedAt?: Date | null;
      /** Seats bought on a per-seat plan (1 for other plans). */
      quantity?: number | null;
    } = {},
  ): Promise<SubscriptionRow> {
    if (!findPlan(planId)) throw new AppError(400, 'unknown_plan', `Unknown plan "${planId}"`);
    const quantity = opts.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000)
      throw new AppError(400, 'bad_quantity', 'The number of seats must be a whole number from 1');
    const values = {
      planId,
      quantity,
      status: opts.status ?? ('active' as const),
      provider: opts.provider ?? 'manual',
      externalId: opts.externalId ?? null,
      currentPeriodEnd: opts.periodEnd ?? null,
      cancelAtPeriodEnd: opts.cancelAtPeriodEnd ?? false,
      customerId: opts.customerId ?? null,
      interval: opts.interval ?? null,
      providerUpdatedAt: opts.providerUpdatedAt ?? null,
      note: opts.note ?? null,
    };
    const [row] = await this.deps.db
      .insert(subscriptions)
      .values({ workspaceId, ...values })
      .onConflictDoUpdate({ target: subscriptions.workspaceId, set: { ...values, updatedAt: new Date() } })
      .returning();
    this.usageCache.delete(workspaceId);
    for (const key of this.seatCache.keys())
      if (key.startsWith(`${workspaceId}:`)) this.seatCache.delete(key);
    await this.closeRequests(workspaceId);
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
      throw new AppError(
        400,
        'unknown_limit',
        `Unknown limit "${input.metric}" (one of ${METRICS.join(', ')})`,
      );
    if (
      input.amount !== null &&
      (!Number.isInteger(input.amount) || input.amount <= 0 || input.amount > 1e9)
    ) {
      throw new AppError(400, 'bad_amount', 'The amount must be a positive whole number');
    }
    if (input.expiresAt && input.expiresAt.getTime() <= this.now().getTime()) {
      throw new AppError(400, 'past_date', 'The end date must be in the future');
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

  // --- Manual plan requests (until a payment provider is wired) ------------------

  /** Records "I want this plan"; a workspace has at most one open request (the latest wins). */
  async requestPlan(
    workspaceId: string,
    userId: string,
    planId: string,
    interval: 'month' | 'year',
  ): Promise<void> {
    const plan = findPlan(planId);
    if (!plan?.public || plan.priceMonthly === 0)
      throw new AppError(400, 'unknown_plan', `Unknown plan "${planId}"`);
    await this.deps.db.transaction(async (tx) => {
      await tx
        .update(planRequests)
        .set({ closedAt: this.now() })
        .where(and(eq(planRequests.workspaceId, workspaceId), isNull(planRequests.closedAt)));
      await tx.insert(planRequests).values({ id: newId('preq'), workspaceId, userId, planId, interval });
    });
  }

  /** The workspace's open request, if any (shown on its billing page). */
  async openRequest(workspaceId: string) {
    const [row] = await this.deps.db
      .select()
      .from(planRequests)
      .where(and(eq(planRequests.workspaceId, workspaceId), isNull(planRequests.closedAt)))
      .limit(1);
    return row;
  }

  /** Open requests across the hub, newest first (admin panel). */
  async openRequests(limit = 20) {
    return this.deps.db
      .select()
      .from(planRequests)
      .where(isNull(planRequests.closedAt))
      .orderBy(desc(planRequests.createdAt))
      .limit(limit);
  }

  /** How many requests wait for an admin (the admin sidebar badge). */
  async countOpenRequests(): Promise<number> {
    const [row] = await this.deps.db
      .select({ n: count() })
      .from(planRequests)
      .where(isNull(planRequests.closedAt));
    return row?.n ?? 0;
  }

  async closeRequests(workspaceId: string): Promise<void> {
    await this.deps.db
      .update(planRequests)
      .set({ closedAt: this.now() })
      .where(and(eq(planRequests.workspaceId, workspaceId), isNull(planRequests.closedAt)));
  }
}
