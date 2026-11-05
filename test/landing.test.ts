import { describe, expect, it } from 'vitest';
import { getPlan, PLANS, yearlyFreeMonths } from '../src/billing/plans.js';
import { roughCount } from '../src/web/landing.js';

describe('landing helpers', () => {
  it('rounds service counts down so the page never claims more than it has', () => {
    expect(roughCount(0)).toBe('0');
    expect(roughCount(7)).toBe('7');
    expect(roughCount(10)).toBe('10');
    expect(roughCount(47)).toBe('45+');
    expect(roughCount(50)).toBe('50');
    expect(roughCount(53)).toBe('50+');
  });

  it('promises only the free months every public paid plan really gives on yearly billing', () => {
    // Today every paid plan costs ten months a year.
    expect(yearlyFreeMonths()).toBe(2);
    const pro = getPlan('pro');
    // One plan with a smaller discount lowers the promise for all of them.
    expect(yearlyFreeMonths([...PLANS, { ...pro, id: 'odd', priceMonthly: 10, priceYearly: 115 }])).toBe(0);
    expect(yearlyFreeMonths([{ ...pro, priceMonthly: 10, priceYearly: 90 }])).toBe(3);
    // Hidden and free plans do not count; no paid plans means no promise.
    expect(yearlyFreeMonths([{ ...pro, public: false, priceYearly: 0 }, getPlan('free')])).toBe(0);
  });
});
