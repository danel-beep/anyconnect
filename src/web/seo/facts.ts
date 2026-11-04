import { PLANS } from '../../billing/plans.js';

/**
 * Numbers the docs and search pages quote about Manyplug, read from the plan catalogue so a text
 * never disagrees with the pricing page.
 */
export interface PlanFacts {
  /** Actions a month on the free plan. */
  actions: number;
  /** New workspaces start with a free trial of a bigger plan: its length and plan id (0 / '' without one). */
  trialDays: number;
  trialPlan: string;
  /** Accounts on the free plan. */
  accounts: number;
  /** The cheapest paid plan per month, e.g. "$5". */
  from: string;
}

export function planFacts(): PlanFacts {
  const free = PLANS.find((p) => p.public && p.priceMonthly === 0);
  const cheapest = PLANS.filter((p) => p.public && p.priceMonthly > 0).sort(
    (a, b) => a.priceMonthly - b.priceMonthly,
  )[0];
  return {
    actions: free?.limits.actions ?? 0,
    trialDays: free?.start?.trial.days ?? 0,
    trialPlan: free?.start?.trial.plan ?? '',
    accounts: free?.limits.accounts ?? 0,
    from: cheapest ? `$${cheapest.priceMonthly}` : '',
  };
}

/**
 * `planFacts` as text variables for the translator (plain numbers, so plural forms can read them);
 * `trialPlan` is the plan's name in the reader's language.
 */
export function planVars(planName: (id: string) => string = (id) => id): Record<string, string | number> {
  const f = planFacts();
  return {
    actions: f.actions,
    days: f.trialDays,
    trialPlan: f.trialPlan ? planName(f.trialPlan) : '',
    accounts: f.accounts,
    from: f.from,
  };
}

/** Fills `{name}` placeholders of a content text (articles, comparisons). */
export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}
