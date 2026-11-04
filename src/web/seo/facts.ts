import { PLANS } from '../../billing/plans.js';

/**
 * Numbers the docs and search pages quote about Manyplug, read from the plan catalogue so a text
 * never disagrees with the pricing page.
 */
export interface PlanFacts {
  /** Actions a month on the free plan. */
  actions: number;
  /** Actions a month during the free plan's intro period, and its length in days. */
  intro: number;
  days: number;
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
    intro: free?.intro?.limits.actions ?? free?.limits.actions ?? 0,
    days: free?.intro?.days ?? 0,
    accounts: free?.limits.accounts ?? 0,
    from: cheapest ? `$${cheapest.priceMonthly}` : '',
  };
}

/** `planFacts` as text variables for the translator (plain numbers, so plural forms can read them). */
export function planVars(): Record<string, string | number> {
  const f = planFacts();
  return { actions: f.actions, intro: f.intro, days: f.days, accounts: f.accounts, from: f.from };
}

/** Fills `{name}` placeholders of a content text (articles, comparisons). */
export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}
