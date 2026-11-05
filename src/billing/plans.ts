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
  /** How long the activity log is kept, in days. */
  'historyDays',
  /** People who can use one workspace. */
  'seats',
] as const;

export type Metric = (typeof METRICS)[number];

/** Metrics measured per billing period (reset monthly), as opposed to a count of things that exist. */
export const PERIODIC_METRICS: ReadonlySet<Metric> = new Set(['actions']);

/** A limit value: a number, or null for "no limit". */
export type LimitValue = number | null;
export type Limits = Record<Metric, LimitValue>;

/** Which workspaces a plan is for: a person's own, or a team's (see `core/teams.ts`). */
export type PlanAudience = 'personal' | 'team';

export interface Plan {
  id: string;
  /** Monthly price in USD; 0 = free. Per seat for `perSeat` plans. */
  priceMonthly: number;
  /** Price for a year paid at once, in USD. Per seat for `perSeat` plans. */
  priceYearly: number;
  /** For `perSeat` plans, the limits of one seat (see {@link limitsFor}). */
  limits: Limits;
  /**
   * Priced per person: the team buys `min`…`max` seats, `seats` is the number bought and each
   * `scaled` limit is multiplied by it (a pool the whole team shares); other limits are the team's.
   */
  perSeat?: { min: number; max: number; scaled: readonly Metric[] };
  /** Only workspaces of this kind can be on the plan; undefined: any. */
  audience?: PlanAudience;
  /**
   * How a new workspace starts on this plan, counted from the day it was created: a trial with
   * another plan's limits, then published steps down to the plan's own limits. Everything here is
   * shown on the pricing page and to the AI, so nobody's limits change by surprise.
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
    limits: { actions: 150, accounts: 3, messengers: 0, backgroundJobs: 1, historyDays: 7, seats: 1 },
    // 14 days of Pro without a card, then 500 → 300 → 150 actions a month (business model, Nov 2026).
    // A new team tries itself with up to 3 people.
    start: {
      trial: { days: 14, plan: 'pro', except: { messengers: 0, seats: 3 } },
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
    limits: { actions: 10_000, accounts: 15, messengers: 1, backgroundJobs: 5, historyDays: 90, seats: 1 },
    audience: 'personal',
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
      seats: 1,
    },
    audience: 'personal',
    public: true,
  },
  {
    /**
     * Teams: one connector URL, each person signs in as themselves (`docs/TEAMS.md`). Per seat; the
     * actions and cloud messengers of every seat form one pool.
     */
    id: 'team',
    priceMonthly: 10,
    priceYearly: 100,
    limits: {
      actions: 25_000,
      accounts: null,
      messengers: 2,
      backgroundJobs: null,
      historyDays: 365,
      seats: 1,
    },
    perSeat: { min: 2, max: 200, scaled: ['actions', 'messengers'] },
    audience: 'team',
    public: true,
  },
  {
    /**
     * Superseded by `team` (Nov 2026): no longer offered, kept for admins and anyone already on it.
     */
    id: 'business',
    priceMonthly: 29,
    priceYearly: 290,
    limits: {
      actions: 200_000,
      accounts: null,
      messengers: 10,
      backgroundJobs: null,
      historyDays: 365,
      seats: 3,
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
      seats: null,
    },
    public: false,
  },
];

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

/** The seats a subscription of `quantity` gives on a `perSeat` plan (undefined for other plans). */
export function seatsFor(plan: Plan, quantity: number | null | undefined): number | undefined {
  if (!plan.perSeat) return undefined;
  const { min, max } = plan.perSeat;
  return Math.min(max, Math.max(min, Math.floor(quantity ?? min)));
}

/** A plan's limits for a subscription of `quantity` seats (the plan's own limits unless `perSeat`). */
export function limitsFor(plan: Plan, quantity?: number | null): Limits {
  const seats = seatsFor(plan, quantity);
  if (seats === undefined) return { ...plan.limits };
  const limits: Limits = { ...plan.limits, seats };
  for (const metric of plan.perSeat!.scaled) {
    const one = plan.limits[metric];
    limits[metric] = one === null ? null : one * seats;
  }
  return limits;
}

/** Whether a workspace of this kind can be on the plan. */
export const planFits = (plan: Plan, kind: PlanAudience): boolean =>
  plan.audience === undefined || plan.audience === kind;

/** Adds an extra amount to a limit; null on either side means no limit. */
export function addLimit(base: LimitValue, extra: LimitValue): LimitValue {
  return base === null || extra === null ? null : base + extra;
}
