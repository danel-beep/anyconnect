import { getPlan, type Limits, type LimitValue, type Metric, type Plan } from './plans.js';

/** One stretch of a new workspace's start (see `Plan.start`), with the limits in force. */
export interface StartPhase {
  kind: 'trial' | 'step';
  /** Inclusive. */
  from: Date;
  /** Exclusive: the next phase (or the plan's own limits) starts here. */
  until: Date;
  limits: Limits;
  /** For the trial: whose limits it has. */
  asPlan?: string;
}

const DAY = 86_400_000;

/** The more generous of two limits (null = no limit). */
const looser = (a: LimitValue, b: LimitValue | undefined): LimitValue =>
  b === undefined ? a : a === null || b === null ? null : Math.max(a, b);

function over(base: Limits, extra: Partial<Limits>): Limits {
  const out = { ...base };
  for (const [metric, value] of Object.entries(extra) as [Metric, LimitValue][]) {
    out[metric] = looser(base[metric], value);
  }
  return out;
}

/**
 * The published start of a workspace on `plan`: the trial, then each step down. Empty for plans
 * without a start. Pure, so the pricing page, the billing page and the AI show the same dates.
 */
export function startSchedule(plan: Plan, createdAt: Date): StartPhase[] {
  if (!plan.start) return [];
  const at = (day: number) => new Date(createdAt.getTime() + day * DAY);
  const { trial, steps } = plan.start;
  // The trial is the other plan's limits as they are (with `except`), not merged with this plan's.
  const trialLimits = { ...getPlan(trial.plan).limits, ...trial.except };
  const phases: StartPhase[] = [
    { kind: 'trial', from: at(0), until: at(trial.days), limits: trialLimits, asPlan: trial.plan },
  ];
  let from = trial.days;
  for (const step of steps) {
    phases.push({
      kind: 'step',
      from: at(from),
      until: at(step.untilDay),
      limits: over(plan.limits, step.limits),
    });
    from = step.untilDay;
  }
  return phases;
}

/** Where a workspace is in its start right now. */
export function startNow(
  plan: Plan,
  createdAt: Date,
  now: Date,
): { phase: StartPhase | undefined; schedule: StartPhase[]; trialEnd: Date | undefined } {
  const schedule = startSchedule(plan, createdAt);
  const phase = schedule.find((p) => p.from.getTime() <= now.getTime() && now.getTime() < p.until.getTime());
  return { phase, schedule, trialEnd: schedule[0]?.until };
}
