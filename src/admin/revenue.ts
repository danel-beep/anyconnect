import { and, count, eq, gt, gte, inArray, isNotNull, lte, notInArray, sql } from 'drizzle-orm';
import { DEFAULT_PLAN_ID, findPlan } from '../billing/plans.js';
import { REFERRAL_PROVIDER } from '../billing/referrals.js';
import type { Db } from '../db/client.js';
import { referrals, subscriptions, users, workspaceMembers, workspaces } from '../db/schema.js';

const DAY = 86_400_000;
/** Subscriptions nobody pays for: set by an admin or given for an invite. */
const UNPAID_PROVIDERS = ['manual', REFERRAL_PROVIDER];
const CHARGED = ['active', 'trialing', 'past_due'] as const;
/** The free plan's trial length (see `PLANS[free].start`). */
const TRIAL_DAYS = findPlan(DEFAULT_PLAN_ID)?.start?.trial.days ?? 0;

export interface RevenueView {
  /** Monthly recurring revenue in USD from subscriptions in good standing (yearly counted as /12). */
  mrr: number;
  arr: number;
  /** MRR of subscriptions whose last payment failed (`past_due`). */
  atRisk: number;
  paying: number;
  cancelling: number;
  byPlan: { planId: string; interval: string; n: number; mrr: number }[];
  /** Free workspaces still in their Pro trial. */
  inTrial: number;
  /** Workspaces whose trial ended in the last 30 days, and how many of them pay now. */
  trialCohort: { ended: number; paying: number };
  /** Sign-ups of the last 30 days, and how many of them pay now. */
  signups30: { total: number; paying: number };
  /** Everyone: users and paying workspaces. */
  overall: { users: number; paying: number };
  canceled30: number;
  referrals: { invited: number; rewarded: number; paying: number };
  gifted: number;
}

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);
export const conversion = pct;

/**
 * Money and conversion for the admin panel, computed from `subscriptions` (what providers report
 * through webhooks), workspaces and invites. Prices come from `plans.ts`, so the numbers are list
 * prices before tax and the provider's fee.
 */
export class RevenueReport {
  constructor(private readonly db: Db) {}

  async build(now = new Date()): Promise<RevenueView> {
    const db = this.db;
    const paidSub = and(
      notInArray(subscriptions.provider, UNPAID_PROVIDERS),
      isNotNull(subscriptions.externalId),
      inArray(subscriptions.status, [...CHARGED]),
    );
    const since30 = new Date(now.getTime() - 30 * DAY);
    const trialStart = new Date(now.getTime() - TRIAL_DAYS * DAY);
    const cohortFrom = new Date(trialStart.getTime() - 30 * DAY);
    // Plans and trials are people's (their own workspaces); a team runs on its payer's plan.
    const personal = eq(workspaces.kind, 'personal');
    /** Paying people among those whose workspace was created in `[from, to)`. */
    const cohort = (from: Date, to: Date) =>
      db
        .select({
          total: count(),
          paying: sql<number>`count(${subscriptions.workspaceId})`.mapWith(Number),
        })
        .from(workspaces)
        .leftJoin(subscriptions, and(eq(subscriptions.workspaceId, workspaces.id), paidSub))
        .where(and(personal, gte(workspaces.createdAt, from), lte(workspaces.createdAt, to)));

    const [groups, [trial], [trialCohort], [recent], [userTotal], [canceled], [refs], [gifted]] =
      await Promise.all([
        db
          .select({
            planId: subscriptions.planId,
            interval: subscriptions.interval,
            status: subscriptions.status,
            cancelling: subscriptions.cancelAtPeriodEnd,
            n: count(),
          })
          .from(subscriptions)
          .where(paidSub)
          .groupBy(
            subscriptions.planId,
            subscriptions.interval,
            subscriptions.status,
            subscriptions.cancelAtPeriodEnd,
          ),
        db
          .select({ n: count() })
          .from(workspaces)
          .leftJoin(subscriptions, eq(subscriptions.workspaceId, workspaces.id))
          .where(
            and(
              personal,
              gt(workspaces.createdAt, trialStart),
              sql`(${subscriptions.workspaceId} is null or ${subscriptions.planId} = ${DEFAULT_PLAN_ID})`,
            ),
          ),
        cohort(cohortFrom, trialStart),
        cohort(since30, now),
        db.select({ n: count() }).from(users),
        db
          .select({ n: count() })
          .from(subscriptions)
          .where(
            and(
              notInArray(subscriptions.provider, UNPAID_PROVIDERS),
              eq(subscriptions.status, 'canceled'),
              gte(subscriptions.updatedAt, since30),
            ),
          ),
        db
          .select({
            invited: count(),
            rewarded: sql<number>`count(*) filter (where ${referrals.status} = 'rewarded')`.mapWith(Number),
            paying: sql<number>`count(*) filter (where ${referrals.status} <> 'signed_up')`.mapWith(Number),
          })
          .from(referrals),
        db
          .select({ n: count() })
          .from(subscriptions)
          .where(and(eq(subscriptions.provider, REFERRAL_PROVIDER), gt(subscriptions.currentPeriodEnd, now))),
      ]);

    const monthly = (planId: string, interval: string | null) => {
      const plan = findPlan(planId);
      if (!plan) return 0;
      return interval === 'year' ? plan.priceYearly / 12 : plan.priceMonthly;
    };
    const byPlan = new Map<string, { planId: string; interval: string; n: number; mrr: number }>();
    let mrr = 0;
    let atRisk = 0;
    let paying = 0;
    let cancelling = 0;
    for (const g of groups) {
      const each = monthly(g.planId, g.interval);
      paying += g.n;
      if (g.cancelling) cancelling += g.n;
      if (g.status === 'past_due') atRisk += each * g.n;
      else mrr += each * g.n;
      const key = `${g.planId}:${g.interval ?? 'month'}`;
      const row = byPlan.get(key) ?? { planId: g.planId, interval: g.interval ?? 'month', n: 0, mrr: 0 };
      row.n += g.n;
      row.mrr += each * g.n;
      byPlan.set(key, row);
    }
    const round = (n: number) => Math.round(n * 100) / 100;
    const [payingWorkspaces] = await db
      .select({ n: sql<number>`count(distinct ${workspaceMembers.workspaceId})`.mapWith(Number) })
      .from(workspaceMembers)
      .innerJoin(subscriptions, and(eq(subscriptions.workspaceId, workspaceMembers.workspaceId), paidSub));
    return {
      mrr: round(mrr),
      arr: round(mrr * 12),
      atRisk: round(atRisk),
      paying,
      cancelling,
      byPlan: [...byPlan.values()].map((r) => ({ ...r, mrr: round(r.mrr) })).sort((a, b) => b.mrr - a.mrr),
      inTrial: trial?.n ?? 0,
      trialCohort: { ended: trialCohort?.total ?? 0, paying: trialCohort?.paying ?? 0 },
      signups30: { total: recent?.total ?? 0, paying: recent?.paying ?? 0 },
      overall: { users: userTotal?.n ?? 0, paying: payingWorkspaces?.n ?? 0 },
      canceled30: canceled?.n ?? 0,
      referrals: { invited: refs?.invited ?? 0, rewarded: refs?.rewarded ?? 0, paying: refs?.paying ?? 0 },
      gifted: gifted?.n ?? 0,
    };
  }
}
