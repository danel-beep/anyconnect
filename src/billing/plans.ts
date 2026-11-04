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

export interface Plan {
  id: string;
  /** Monthly price in USD; 0 = free. */
  priceMonthly: number;
  /** Price for a year paid at once, in USD. */
  priceYearly: number;
  limits: Limits;
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
    limits: { actions: 10_000, accounts: 15, messengers: 1, backgroundJobs: 5, historyDays: 90, seats: 1 },
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
    public: true,
  },
  {
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
    public: true,
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

export const DEFAULT_PLAN_ID = 'free';

export function findPlan(id: string | null | undefined): Plan | undefined {
  return PLANS.find((p) => p.id === id);
}

export function getPlan(id: string | null | undefined): Plan {
  return findPlan(id) ?? findPlan(DEFAULT_PLAN_ID)!;
}

export const isMetric = (value: string): value is Metric => (METRICS as readonly string[]).includes(value);

/** Adds an extra amount to a limit; null on either side means no limit. */
export function addLimit(base: LimitValue, extra: LimitValue): LimitValue {
  return base === null || extra === null ? null : base + extra;
}
