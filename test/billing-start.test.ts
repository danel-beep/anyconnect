import { describe, expect, it } from 'vitest';
import { getPlan } from '../src/billing/plans.js';
import { startNow, startSchedule } from '../src/billing/start.js';

const created = new Date('2026-11-01T10:00:00Z');
const day = (n: number) => new Date(created.getTime() + n * 86_400_000);

describe('free plan start', () => {
  const free = getPlan('free');

  it('publishes a 14-day Pro trial without messengers, then 500 → 300 → 150 actions', () => {
    const schedule = startSchedule(free, created);
    expect(schedule.map((p) => [p.kind, p.from, p.until, p.limits.actions])).toEqual([
      ['trial', day(0), day(14), getPlan('pro').limits.actions],
      ['step', day(14), day(30), 500],
      ['step', day(30), day(60), 300],
    ]);
    expect(schedule[0]!.limits.accounts).toBe(getPlan('pro').limits.accounts);
    expect(schedule[0]!.limits.messengers).toBe(0);
    // Steps change only actions; the rest is the Free plan.
    expect(schedule[1]!.limits.accounts).toBe(free.limits.accounts);
  });

  it('finds the current phase and ends on the plan limits', () => {
    expect(startNow(free, created, day(3)).phase?.kind).toBe('trial');
    expect(startNow(free, created, day(14)).phase?.limits.actions).toBe(500);
    expect(startNow(free, created, day(59.9)).phase?.limits.actions).toBe(300);
    const after = startNow(free, created, day(60));
    expect(after.phase).toBeUndefined();
    expect(after.trialEnd).toEqual(day(14));
  });

  it('paid plans have no start', () => {
    expect(startSchedule(getPlan('pro'), created)).toEqual([]);
  });
});
