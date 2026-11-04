/** Billing periods: calendar months in UTC (paid subscriptions can bring their own anchors later). */
export interface Period {
  /** First day, `YYYY-MM-DD` (inclusive). */
  start: string;
  /** First day of the next period, `YYYY-MM-DD` (exclusive). */
  end: string;
  /** When the period resets. */
  resetsAt: Date;
}

export function monthPeriod(at = new Date()): Period {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const next = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return { start: day(start), end: day(next), resetsAt: next };
}
