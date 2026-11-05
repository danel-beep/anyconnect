import { and, count, desc, eq, gt, isNull, or } from 'drizzle-orm';
import type { AccountLimits } from '../core/accounts.js';
import { type Principal, usageCaller } from '../core/principal.js';
import type { Db } from '../db/client.js';
import {
  limitGrants,
  planRequests,
  type SubscriptionStatus,
  subscriptions,
  type TeamBillingMode,
  workspaces,
} from '../db/schema.js';
import type { QuotaDecision, QuotaGate } from '../hub/quota.js';
import type { UsageMeter } from '../hub/usage.js';
import { AppError, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { type Payers, payingUser, type TeamBilling } from './payers.js';
import { monthPeriod, type Period } from './period.js';
import {
  addLimit,
  coversPlan,
  DEFAULT_PLAN_ID,
  findPlan,
  getPlan,
  isMetric,
  type Limits,
  METRICS,
  type Metric,
  type Plan,
} from './plans.js';
import { type StartPhase, startNow } from './start.js';

export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type LimitGrantRow = typeof limitGrants.$inferSelect;

/**
 * What a person may use right now: their plan, its start (trial, steps) and admin grants applied.
 * Asked for a team, these are the entitlements of whoever pays for it (see `billing/payers.ts`).
 */
export interface Entitlements {
  plan: Plan;
  subscription: SubscriptionRow | undefined;
  /** The person's own workspace whose plan this is: the workspace asked for, or a team's payer's. */
  payerId: string;
  /** Set when asked for a team: how it pays, and whether the plan is the asking member's own. */
  team?: TeamPayment;
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

/** How a team pays, as seen by the member asking (see `Entitlements.team`). */
export interface TeamPayment {
  slug: string;
  mode: TeamBillingMode;
  /** Who pays for the team as a whole. */
  payer: { userId: string; name: string };
  /** The plan is the asking member's own: they pay for the team, or everyone pays for themselves. */
  own: boolean;
}

export interface UsageSummary extends Entitlements {
  /** Counted against the plan: everything it pays for (a person's own space and their teams). */
  used: { actions: number; accounts: number };
}

/** A team's plan and payment as the team page and the AI show them to one member. */
export interface TeamBillingView {
  team: TeamBilling;
  /** The plan that pays for the team as a whole (its payer's), and what that plan has used. */
  pool: UsageSummary;
  /** Actions taken in the team this month, whoever paid for them. */
  teamActions: number;
  /** The viewer's own plan (in `each` mode it pays for their use of the team). */
  mine?: UsageSummary | undefined;
  /** The viewer may pay for the team with their own plan now. */
  canPay: boolean;
}

/** A team a person's plan pays for, and how much of it (see `EntitlementService.planUses`). */
export interface PlanUse {
  team: TeamBilling;
  /**
   * `everyone`: all use of the team · `team`: the team's own accounts and shared key, and the
   * person's own use (they pay, everyone else uses their own plan) · `self`: only the person's own use.
   */
  covers: 'everyone' | 'team' | 'self';
  /** Actions the team took from the plan this month. */
  actions: number;
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

/** Shares of the monthly action limit at which the AI is told, once, that the limit is getting close. */
const NEAR_LIMIT_LEVELS = [0.8, 0.95] as const;

/** Things that happen while limits are enforced (notices subscribe; see `src/notices/`). */
export interface EntitlementListener {
  /** A call was refused because the monthly action limit is used up. */
  limitReached?(workspaceId: string, ent: Entitlements, limit: number): Promise<void>;
}

/** Refusals of team billing changes, with codes the website shows in the user's language. */
export const billingError = {
  adminOnly: () =>
    new AppError(403, 'team_admin_only', 'Only the team’s owner and admins can change how the team pays.'),
  planTooSmall: (mine: string, theirs: string, payer: string, url: string) =>
    new AppError(
      409,
      'plan_too_small',
      `The user’s ${mine} plan gives the team less than the ${theirs} plan ${payer} pays for it with. ` +
        `Move to a bigger plan first (${url}), then pay for the team.`,
    ),
  notPayer: () => new AppError(400, 'not_team_payer', 'The user does not pay for this team.'),
  ownerPays: () =>
    new AppError(
      400,
      'team_owner_pays',
      'The team’s owner pays for it unless another member takes over. To have everyone pay for ' +
        'themselves instead, switch the team to everyone using their own plan (mode "each").',
    ),
};

/**
 * Plans, limits and grants. A plan belongs to a person (their own workspace); a team runs on its
 * payer's plan, or each member's own (`billing/payers.ts`). Implements the hub's `QuotaGate`
 * (actions per month, charged to the payer) and the account service's `AccountLimits`.
 * Payment providers and admins change plans through `setPlan`; admins add limits with `grant`;
 * members change who pays for a team with `changeTeamBilling`.
 */
export class EntitlementService implements QuotaGate, AccountLimits {
  /** Short-lived snapshot of usage per payer, bumped locally between refreshes. */
  private readonly usageCache = new Map<string, { at: number; period: string; actions: number }>();
  private readonly callerCache = new Map<string, { at: number; period: string; actions: number }>();
  /** `payer:countFrom:level` already hinted to the AI or notified (per process; notices dedupe in the DB). */
  private readonly told = new Set<string>();
  private readonly listeners: EntitlementListener[] = [];

  constructor(
    private readonly deps: {
      db: Db;
      usage: UsageMeter;
      payers: Payers;
      /** Absolute URL of the billing page, quoted to the AI when a limit is reached. */
      pricingUrl: string;
      /** A team's page (where its members see and change who pays), by slug. */
      teamUrl: (slug: string) => string;
      now?: () => Date;
    },
  ) {}

  get payers(): Payers {
    return this.deps.payers;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  listen(listener: EntitlementListener): void {
    this.listeners.push(listener);
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

  /**
   * What `userId` may use in `workspaceId` (`null`: the workspace as a whole): a person's own
   * workspace answers for itself; a team answers with its payer's plan, or in `each` mode with the
   * member's own.
   */
  async entitlements(workspaceId: string, userId: string | null = null): Promise<Entitlements> {
    const team = await this.deps.payers.team(workspaceId);
    if (!team) return this.planOf(workspaceId);
    const ent = await this.planOf(await this.deps.payers.payerOf(workspaceId, userId));
    const own = userId !== null && payingUser(team, userId) === userId;
    return {
      ...ent,
      team: {
        slug: team.slug,
        mode: team.mode,
        payer: { userId: team.payerUserId, name: team.payerName },
        own,
      },
    };
  }

  /** The entitlements of a person's own workspace (where plans live). */
  private async planOf(workspaceId: string): Promise<Entitlements> {
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
    // The start (trial, steps) is a person's, once: a team never gets one of its own.
    const { phase, schedule, trialEnd } =
      workspace.kind === 'personal' ? startNow(plan, workspace.createdAt, now) : { schedule: [] };
    const limits = { ...(phase?.limits ?? plan.limits) };
    for (const grant of grants) {
      if (isMetric(grant.metric)) limits[grant.metric] = addLimit(limits[grant.metric], grant.amount);
    }
    const period = monthPeriod(now);
    const trialEndDay =
      trialEnd && trialEnd.getTime() <= now.getTime() ? trialEnd.toISOString().slice(0, 10) : '';
    // Trial usage does not eat into the first post-trial month (ISO days compare as strings).
    const countFrom = [period.start, trialEndDay].sort().at(-1) ?? period.start;
    return { plan, subscription, payerId: workspaceId, limits, phase, schedule, grants, period, countFrom };
  }

  /** Actions charged to a payer's plan since `from` (`YYYY-MM-DD`, see `Entitlements.countFrom`). */
  async actionsUsed(payerId: string, from: string): Promise<number> {
    return this.deps.usage.billedTotal(payerId, from);
  }

  /** Accounts that count against a payer's plan: their own and those of the teams they pay for. */
  async accountsUsed(payerId: string): Promise<number> {
    return this.deps.payers.accountsOf(payerId);
  }

  /** What `userId` may use in a workspace and what that plan has used (see {@link entitlements}). */
  async summary(workspaceId: string, userId: string | null = null): Promise<UsageSummary> {
    const ent = await this.entitlements(workspaceId, userId);
    const [actions, accountsCount] = await Promise.all([
      this.actionsUsed(ent.payerId, ent.countFrom),
      this.accountsUsed(ent.payerId),
    ]);
    return { ...ent, used: { actions, accounts: accountsCount } };
  }

  /** Where a payer's actions went this month: their own space and each team they paid for. */
  async usageByWorkspace(payerId: string): Promise<{ workspaceId: string; calls: number }[]> {
    const ent = await this.planOf(payerId);
    return this.deps.usage.billedByWorkspace(payerId, ent.countFrom);
  }

  /**
   * What a person's plan pays for besides their own space: the teams they pay for, and the teams
   * where everyone uses their own plan; with the actions each took from the plan this month.
   */
  async planUses(userId: string): Promise<{ own: number; teams: PlanUse[] }> {
    const home = await this.deps.payers.home(userId);
    if (!home) return { own: 0, teams: [] };
    const [teams, byWorkspace] = await Promise.all([
      this.deps.payers.teamsOf(userId),
      this.usageByWorkspace(home),
    ]);
    const calls = new Map(byWorkspace.map((r) => [r.workspaceId, r.calls]));
    return {
      own: calls.get(home) ?? 0,
      teams: teams
        .filter((t) => t.payerUserId === userId || t.mode === 'each')
        .map((t) => ({
          team: t,
          covers: t.payerUserId !== userId ? 'self' : t.mode === 'each' ? 'team' : 'everyone',
          actions: calls.get(t.teamId) ?? 0,
        })),
    };
  }

  /** A team's payment for one member's page or chat (`viewerId` null: the team's shared key). */
  async teamBilling(teamId: string, viewerId: string | null): Promise<TeamBillingView> {
    const team = await this.deps.payers.team(teamId);
    if (!team) throw notFound('Team');
    const member = viewerId !== null && team.members.has(viewerId) ? viewerId : null;
    const [pool, mine] = await Promise.all([
      this.summary(teamId, null),
      member === null
        ? undefined
        : team.mode === 'each' || member === team.payerUserId
          ? this.summary(teamId, member)
          : this.ownSummary(member),
    ]);
    const teamActions = await this.deps.usage.workspaceTotal(teamId, pool.period.start);
    const canPay =
      member !== null &&
      member !== team.payerUserId &&
      (member === team.ownerUserId || (mine !== undefined && coversPlan(mine.plan, pool.plan)));
    return { team, pool, teamActions, mine, canPay };
  }

  /** A person's own plan and use, wherever they are asking from. */
  private async ownSummary(userId: string): Promise<UsageSummary | undefined> {
    const home = await this.deps.payers.home(userId);
    return home ? this.summary(home) : undefined;
  }

  // --- Enforcing ---------------------------------------------------------------

  /** Whose plan a caller's use counts against (stage `meter` charges executed calls to it). */
  payerOf(principal: Principal): Promise<string> {
    return this.deps.payers.payerOf(principal.workspaceId, principal.shared ? null : principal.userId);
  }

  async checkAction(principal: Principal): Promise<QuotaDecision> {
    const ent = await this.entitlements(principal.workspaceId, principal.shared ? null : principal.userId);
    const limit = ent.limits.actions;
    if (limit === null) return { allowed: true };
    const payer = ent.payerId;
    const used = await this.cachedUsage(this.usageCache, payer, ent.countFrom, () =>
      this.actionsUsed(payer, ent.countFrom),
    );
    if (used >= limit) {
      this.limitReached(payer, ent, limit);
      return { allowed: false, message: this.actionsMessage(ent, limit) };
    }
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
    this.bump(this.usageCache, payer);
    const notice = this.nearLimitNotice(ent, limit, used + 1);
    return notice ? { allowed: true, notice } : { allowed: true };
  }

  /** Whose plan this is, for the AI: the user's own, or the one a teammate pays for the team with. */
  private whose(ent: Entitlements): string {
    if (!ent.team) return `the ${ent.plan.id} plan`;
    if (ent.team.own)
      return ent.team.mode === 'each'
        ? `the user’s own ${ent.plan.id} plan (in this team everyone uses their own)`
        : `the user’s ${ent.plan.id} plan, which also pays for this team`;
    return `the ${ent.plan.id} plan ${ent.team.payer.name} pays for this team with`;
  }

  /** How to get more, for the AI: a bigger plan, or (in someone else's team plan) asking or paying. */
  private upgradeHint(ent: Entitlements): string {
    if (!ent.team || ent.team.own) return `they can upgrade at ${this.deps.pricingUrl}`;
    return (
      `${ent.team.payer.name} can move to a bigger plan, or the user can pay for the team with a plan ` +
      `of their own (${this.deps.teamUrl(ent.team.slug)})`
    );
  }

  /**
   * A gentle line for the AI when this call crosses 80% or 95% of the monthly actions: said once
   * per level and month, so the assistant can mention it in passing instead of the user hitting
   * the wall unannounced.
   */
  private nearLimitNotice(ent: Entitlements, limit: number, used: number): string | undefined {
    const level = [...NEAR_LIMIT_LEVELS].reverse().find((l) => used >= Math.ceil(limit * l));
    if (!level || used >= limit) return undefined;
    const key = `${ent.payerId}:${ent.countFrom}:${level}`;
    if (this.told.has(key)) return undefined;
    this.remember(key);
    const reset = ent.period.resetsAt.toISOString().slice(0, 10);
    if (!ent.team) {
      return (
        `Manyplug note (not from the service): the user has used ${used} of ${limit} actions this month ` +
        `on the ${ent.plan.id} plan; the count resets on ${reset}. Finish the task, then mention this ` +
        `once, briefly and without pressure; a bigger plan is at ${this.deps.pricingUrl}.`
      );
    }
    return (
      `Manyplug note (not from the service): ${used} of ${limit} actions this month are used on ` +
      `${this.whose(ent)}; the count resets on ${reset}. Finish the task, then mention this once, ` +
      `briefly and without pressure: ${this.upgradeHint(ent)}.`
    );
  }

  private limitReached(payerId: string, ent: Entitlements, limit: number): void {
    const key = `${payerId}:${ent.countFrom}:reached`;
    if (this.told.has(key) || !this.listeners.length) return;
    this.remember(key);
    for (const listener of this.listeners) {
      // Never delays or fails the refused call; the notice service logs its own failures.
      listener.limitReached?.(payerId, ent, limit).catch(() => this.told.delete(key));
    }
  }

  private remember(key: string): void {
    this.told.add(key);
    if (this.told.size > 20_000) this.told.delete(this.told.values().next().value!);
  }

  private actionsMessage(ent: Entitlements, limit: number): string {
    const reset = ent.period.resetsAt.toISOString().slice(0, 10);
    if (!ent.team) {
      return (
        `The Manyplug plan limit is reached: ${limit} actions this month on the ${ent.plan.id} plan ` +
        `(resets on ${reset}). Tell the user; they can upgrade at ${this.deps.pricingUrl}. Do not retry.`
      );
    }
    return (
      `The Manyplug plan limit is reached: ${limit} actions this month on ${this.whose(ent)} ` +
      `(resets on ${reset}). Tell the user; ${this.upgradeHint(ent)}. Do not retry.`
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

  /**
   * Throws `PlanLimitError` when one more account would exceed the plan that pays for it: in a team,
   * the payer's, or in `each` mode the owner's own for a member's account (`ownerUserId`; `null` is
   * an account of the team).
   */
  async assertCanAddAccount(workspaceId: string, ownerUserId: string | null = null): Promise<void> {
    const ent = await this.entitlements(workspaceId, ownerUserId);
    const limit = ent.limits.accounts;
    if (limit === null) return;
    const used = await this.accountsUsed(ent.payerId);
    if (used < limit) return;
    if (!ent.team) {
      throw new PlanLimitError(
        'accounts',
        limit,
        `The ${ent.plan.id} plan allows ${limit} connected accounts and all of them are in use. ` +
          `Remove an account or upgrade at ${this.deps.pricingUrl}.`,
      );
    }
    throw new PlanLimitError(
      'accounts',
      limit,
      `The connected accounts of ${this.whose(ent)} are all in use: it allows ${limit} across ` +
        `everything it pays for. Remove an account; ${this.upgradeHint(ent)}.`,
    );
  }

  // --- Who pays for a team --------------------------------------------------------

  /**
   * Changes how a team pays. Any member may pay for it with their own plan when that plan gives
   * the team at least what it has now (so nobody shrinks the team's limits by accident); the owner
   * may always take paying back. Whoever pays may stop, and the owner pays again. Only the owner and
   * admins switch between one payer and each member paying for themselves.
   */
  async changeTeamBilling(
    actorId: string,
    teamId: string,
    change: { pay?: boolean; mode?: TeamBillingMode },
  ): Promise<TeamBilling> {
    const team = await this.deps.payers.team(teamId, { fresh: true });
    const role = team?.members.get(actorId);
    if (!team || !role) throw notFound('Team');
    let payerUserId: string | null | undefined;
    if (change.pay === true && actorId !== team.payerUserId) {
      if (actorId !== team.ownerUserId) {
        const home = await this.deps.payers.home(actorId);
        const [mine, theirs] = await Promise.all([
          home ? this.planOf(home).then((e) => e.plan) : getPlan(DEFAULT_PLAN_ID),
          this.entitlements(teamId, null).then((e) => e.plan),
        ]);
        if (!coversPlan(mine, theirs))
          throw billingError.planTooSmall(mine.id, theirs.id, team.payerName, this.deps.pricingUrl);
      }
      payerUserId = actorId === team.ownerUserId ? null : actorId;
    }
    if (change.pay === false) {
      if (actorId !== team.payerUserId) throw billingError.notPayer();
      if (actorId === team.ownerUserId) throw billingError.ownerPays();
      payerUserId = null;
    }
    const mode = change.mode !== undefined && change.mode !== team.mode ? change.mode : undefined;
    if (mode !== undefined && role === 'member') throw billingError.adminOnly();
    await this.deps.payers.set(teamId, {
      ...(mode !== undefined ? { mode } : {}),
      ...(payerUserId !== undefined ? { payerUserId } : {}),
    });
    return (await this.deps.payers.team(teamId, { fresh: true }))!;
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
      /** How many of the provider's price were bought (see `subscriptions.quantity`). */
      quantity?: number | null;
    } = {},
  ): Promise<SubscriptionRow> {
    if (!findPlan(planId)) throw new AppError(400, 'unknown_plan', `Unknown plan "${planId}"`);
    const quantity = opts.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000)
      throw new AppError(400, 'bad_quantity', 'The quantity must be a whole number from 1');
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
