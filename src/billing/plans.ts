/**
 * The plan catalog: what each plan costs and allows. Yearly = two months free. Plain data, so the website (pricing, billing
 * page), the admin panel and the limit checks all read the same source. Prices are hypotheses from
 * the business model; changing a number here changes it everywhere.
 *
 * Adding a plan: add an entry to `PLANS` (and its texts in `src/web/i18n.ts`, `plan.<id>.*`).
 * Adding a metric: add it to `METRICS`, give every plan a value, and enforce it where the resource is
 * created (see `EntitlementService.assertCanAdd`) or counted (stage `quota` for actions).
 */

export const METRICS = [
  /** Tool calls that reached a service, per calendar month (UTC). Enforced by the `quota` stage. */
  'actions',
  /** Connected service accounts at any time. Enforced when an account is created. */
  'accounts',
  /** Cloud messenger sessions (Telegram/WhatsApp) the hub keeps online. Enforced by messenger connectors. */
  'messengers',
  /** Background tasks (schedules, triggers). Enforced by the jobs layer. */
  'backgroundJobs',
  /** How long the activity log is kept, in days. Enforced by the daily job `activity.prune`. */
  'historyDays',
] as const;

export type Metric = (typeof METRICS)[number];

/** Metrics measured per billing period (reset monthly), as opposed to a count of things that exist. */
export const PERIODIC_METRICS: ReadonlySet<Metric> = new Set(['actions']);

/** A limit value: a number, or null for "no limit". */
export type LimitValue = number | null;
export type Limits = Record<Metric, LimitValue>;

/**
 * A plan always belongs to a person (their own workspace). A team has no plan of its own: it runs
 * on the plan of whoever pays for it, or each member's own (see `billing/payers.ts`).
 */
export interface Plan {
  id: string;
  /** Monthly price in USD; 0 = free. */
  priceMonthly: number;
  /** Price for a year paid at once, in USD. */
  priceYearly: number;
  limits: Limits;
  /**
   * How a person starts on this plan, counted from the day their workspace was created: a trial
   * with another plan's limits, then published steps down to the plan's own limits. Everything here
   * is shown on the pricing page and to the AI, so nobody's limits change by surprise.
   */
  start?: PlanStart;
  /** Shown on the pricing page. Hidden plans (internal, partners) are assigned by admins only. */
  public: boolean;
  /** Highlighted on the pricing page. */
  featured?: boolean;
}

export interface PlanStart {
  /** Days 1…`days`: the limits of plan `plan`, with `except` on top (e.g. no cloud messengers). */
  trial: { days: number; plan: string; except?: Partial<Limits> };
  /** Then, until each `untilDay` (counted from creation), these limits over the plan's own. */
  steps: { untilDay: number; limits: Partial<Limits> }[];
}

export const PLANS: readonly Plan[] = [
  {
    id: 'free',
    priceMonthly: 0,
    priceYearly: 0,
    limits: { actions: 150, accounts: 3, messengers: 0, backgroundJobs: 1, historyDays: 7 },
    // 14 days of Pro without a card, then 500 → 300 → 150 actions a month (business model, Nov 2026).
    // Once per person: a team gets no trial of its own.
    start: {
      trial: { days: 14, plan: 'pro', except: { messengers: 0 } },
      steps: [
        { untilDay: 30, limits: { actions: 500 } },
        { untilDay: 60, limits: { actions: 300 } },
      ],
    },
    public: true,
  },
  {
    id: 'personal',
    priceMonthly: 5,
    priceYearly: 50,
    limits: { actions: 10_000, accounts: 15, messengers: 1, backgroundJobs: 5, historyDays: 90 },
    public: true,
    featured: true,
  },
  {
    id: 'pro',
    priceMonthly: 12,
    priceYearly: 120,
    limits: {
      actions: 50_000,
      accounts: null,
      messengers: 3,
      backgroundJobs: null,
      historyDays: 365,
    },
    public: true,
  },
  {
    /** Not offered (Nov 2026): kept for admins to assign, e.g. to someone who pays for a big team. */
    id: 'business',
    priceMonthly: 29,
    priceYearly: 290,
    limits: {
      actions: 200_000,
      accounts: null,
      messengers: 10,
      backgroundJobs: null,
      historyDays: 365,
    },
    public: false,
  },
  {
    /** The hub owner's own workspace and other internal use. */
    id: 'unlimited',
    priceMonthly: 0,
    priceYearly: 0,
    limits: {
      actions: null,
      accounts: null,
      messengers: null,
      backgroundJobs: null,
      historyDays: 365,
    },
    public: false,
  },
];

/**
 * The smallest number any plan, trial or step of a plan's start gives a metric ("no limit" is not
 * a number and is skipped); undefined when none does. Grants only add on top.
 */
export function smallestLimit(metric: Metric, plans: readonly Plan[] = PLANS): number | undefined {
  const values = plans.flatMap((plan) => [
    plan.limits[metric],
    plan.start?.trial.except?.[metric],
    ...(plan.start?.steps ?? []).map((step) => step.limits[metric]),
  ]);
  const numbers = values.filter((value): value is number => typeof value === 'number');
  return numbers.length ? Math.min(...numbers) : undefined;
}

/**
 * Whole months a yearly payment saves against twelve monthly ones (yearly prices are set as "two
 * months free"), the smallest across the public paid plans, so the label is true for every plan.
 */
export function yearlyFreeMonths(plans: readonly Plan[] = PLANS): number {
  const paid = plans.filter((p) => p.public && p.priceMonthly > 0);
  if (!paid.length) return 0;
  return Math.max(
    0,
    Math.min(...paid.map((p) => Math.floor((p.priceMonthly * 12 - p.priceYearly) / p.priceMonthly + 1e-9))),
  );
}

export const DEFAULT_PLAN_ID = 'free';

export function findPlan(id: string | null | undefined): Plan | undefined {
  return PLANS.find((p) => p.id === id);
}

export function getPlan(id: string | null | undefined): Plan {
  return findPlan(id) ?? findPlan(DEFAULT_PLAN_ID)!;
}

export const isMetric = (value: string): value is Metric => (METRICS as readonly string[]).includes(value);

/** Whether `value` is at least `than` (null is no limit, above any number). */
const atLeastLimit = (value: LimitValue, than: LimitValue): boolean =>
  value === null || (than !== null && value >= than);

/**
 * Whether plan `a` gives at least what plan `b` gives (actions and accounts). Someone may take over
 * paying for a team only with a plan that does not leave the team with less.
 */
export const coversPlan = (a: Plan, b: Plan): boolean =>
  atLeastLimit(a.limits.actions, b.limits.actions) && atLeastLimit(a.limits.accounts, b.limits.accounts);

/** Adds an extra amount to a limit; null on either side means no limit. */
export function addLimit(base: LimitValue, extra: LimitValue): LimitValue {
  return base === null || extra === null ? null : base + extra;
}
