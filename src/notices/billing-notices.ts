import { and, gt, lte } from 'drizzle-orm';
import type { EntitlementListener, EntitlementService, Entitlements } from '../billing/entitlements.js';
import { type BillingListener, BillingService } from '../billing/service.js';
import type { Db } from '../db/client.js';
import { workspaces } from '../db/schema.js';
import type { NoticeService } from './notices.js';

const DAY = 86_400_000;
/** How long before the trial ends its reminder goes out. */
const TRIAL_REMINDER_DAYS = 3;

/**
 * The billing emails: the trial is ending (a daily job), the monthly limit is reached (when the
 * quota refuses a call) and a payment failed (a webhook moves the subscription to `past_due`).
 * Each goes out once per occasion through `NoticeService`.
 */
export class BillingNotices implements EntitlementListener, BillingListener {
  constructor(
    private readonly deps: {
      db: Db;
      notices: NoticeService;
      entitlements: EntitlementService;
      publicUrl: string;
      now?: () => Date;
    },
  ) {}

  private get billingUrl(): string {
    return `${this.deps.publicUrl}/app/billing`;
  }

  /** Reminds workspaces whose trial ends within three days. Run daily; safe to run more often. */
  async remindTrialEnding(): Promise<number> {
    if (!this.deps.notices.enabled) return 0;
    const now = this.deps.now?.() ?? new Date();
    // Only workspaces whose 14-day trial ends in the next three days (the free plan's start).
    const candidates = await this.deps.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          gt(workspaces.createdAt, new Date(now.getTime() - 14 * DAY)),
          lte(workspaces.createdAt, new Date(now.getTime() - (14 - TRIAL_REMINDER_DAYS) * DAY)),
        ),
      )
      .limit(5000);
    let sent = 0;
    for (const { id } of candidates) {
      const ent = await this.deps.entitlements.entitlements(id);
      if (ent.phase?.kind !== 'trial' || BillingService.isPaidByProvider(ent.subscription)) continue;
      if ((await this.trialEnding(id, ent, now)) === 'sent') sent++;
    }
    return sent;
  }

  private trialEnding(workspaceId: string, ent: Entitlements, now: Date) {
    const end = ent.phase!.until;
    const next = ent.schedule[1]?.limits ?? ent.plan.limits;
    const daysLeft = Math.max(1, Math.ceil((end.getTime() - now.getTime()) / DAY));
    const count = (n: number | null) => (n === null ? '∞' : n);
    return this.deps.notices.notify(workspaceId, 'trial_ending', end.toISOString().slice(0, 10), {
      tag: 'billing.trial_ending',
      subject: 'email.trialEnding.subject',
      paragraphs: ['email.trialEnding.body', 'email.trialEnding.keep'],
      cta: { label: 'email.trialEnding.cta', url: this.billingUrl },
      vars: {
        n: daysLeft,
        actions: count(next.actions),
        after: count(ent.plan.limits.actions),
        accounts: count(ent.plan.limits.accounts),
      },
      dates: { date: end },
    });
  }

  async limitReached(workspaceId: string, ent: Entitlements, limit: number): Promise<void> {
    await this.deps.notices.notify(workspaceId, 'limit_reached', ent.countFrom, {
      tag: 'billing.limit_reached',
      subject: 'email.limitReached.subject',
      paragraphs: ['email.limitReached.body', 'email.limitReached.upgrade'],
      cta: { label: 'email.limitReached.cta', url: this.billingUrl },
      vars: { limit },
      dates: { date: ent.period.resetsAt },
      plan: ent.plan.id,
    });
  }

  async subscriptionChanged({
    workspaceId,
    before,
    after,
  }: Parameters<BillingListener['subscriptionChanged']>[0]): Promise<void> {
    if (after.status !== 'past_due' || before?.status === 'past_due') return;
    const key = `${after.externalId ?? ''}:${after.currentPeriodEnd?.toISOString().slice(0, 10) ?? ''}`;
    await this.deps.notices.notify(workspaceId, 'payment_failed', key, {
      tag: 'billing.payment_failed',
      subject: 'email.paymentFailed.subject',
      paragraphs: ['email.paymentFailed.body', 'email.paymentFailed.fix'],
      cta: { label: 'email.paymentFailed.cta', url: this.billingUrl },
      vars: {},
      plan: after.planId,
    });
  }
}
