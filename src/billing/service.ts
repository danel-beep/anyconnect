import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { billingEvents, subscriptions, workspaces } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../logger.js';
import { type BillingConfig, PAID_PLANS, priceKey } from './config.js';
import type { EntitlementService, SubscriptionRow } from './entitlements.js';
import { findPlan } from './plans.js';
import {
  type BillingInterval,
  type BillingProvider,
  BillingProviderError,
  type SubscriptionChange,
} from './provider.js';

export type BillingEventRow = typeof billingEvents.$inferSelect;

/** What starting a purchase led to. */
export type CheckoutOutcome =
  /** Send the user to the provider's hosted checkout. */
  | { kind: 'redirect'; url: string }
  /** The workspace already pays at the provider: its subscription was moved to the new plan. */
  | { kind: 'changed'; planId: string };

/** Why buying is not possible right now (shown on the billing page and to the AI). */
export class BillingError extends AppError {
  constructor(code: string, message: string, status = 400) {
    super(status, code, message);
  }
}

/** Statuses in which the provider still charges the customer (and the plan is in force). */
const LIVE: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due']);

/**
 * Payments, independent of the provider: which price a plan has, starting a checkout or a plan
 * change, the billing portal, cancelling, and applying provider webhooks to the workspace's plan
 * (through `EntitlementService.setPlan`). Every webhook event is recorded once in `billing_events`,
 * so retries and duplicates change nothing, and an older event never overwrites a newer state.
 */
export class BillingService {
  constructor(
    private readonly deps: {
      db: Db;
      entitlements: EntitlementService;
      config: BillingConfig;
      /** Undefined = payments off. */
      provider: BillingProvider | undefined;
      logger: Logger;
    },
  ) {}

  get provider(): BillingProvider | undefined {
    return this.deps.provider;
  }

  get enabled(): boolean {
    return this.deps.provider !== undefined;
  }

  /** Whether a plan can be bought for an interval right now (payments on and a price set). */
  canBuy(planId: string, interval: BillingInterval): boolean {
    return this.enabled && this.deps.config.prices.has(priceKey(planId, interval));
  }

  /** The plan and interval of a provider price (prices are configured per plan and interval). */
  planForPrice(priceId: string | null): { planId: string; interval: BillingInterval } | undefined {
    if (!priceId) return undefined;
    for (const [key, value] of this.deps.config.prices) {
      if (value !== priceId) continue;
      const [planId, interval] = key.split(':') as [string, BillingInterval];
      return { planId, interval };
    }
    return undefined;
  }

  /** The workspace's subscription when it is managed by the active provider and still charged. */
  liveSubscription(sub: SubscriptionRow | undefined): SubscriptionRow | undefined {
    const provider = this.deps.provider;
    if (!provider || !sub || sub.provider !== provider.id || !sub.externalId) return undefined;
    return LIVE.has(sub.status) ? sub : undefined;
  }

  /** True when the plan is paid through any provider and still charged (admins must not overwrite it). */
  static isPaidByProvider(sub: SubscriptionRow | undefined): boolean {
    return Boolean(sub && sub.provider !== 'manual' && sub.externalId && LIVE.has(sub.status));
  }

  // --- Buying and managing ----------------------------------------------------------

  async checkout(input: {
    workspaceId: string;
    userId: string;
    email: string;
    planId: string;
    interval: BillingInterval;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutOutcome> {
    const provider = this.requireProvider();
    const plan = findPlan(input.planId);
    if (!plan || !PAID_PLANS.includes(plan)) {
      throw new BillingError('unknown_plan', `"${input.planId}" is not a plan that can be bought`);
    }
    const priceId = this.deps.config.prices.get(priceKey(plan.id, input.interval));
    if (!priceId) {
      throw new BillingError(
        'plan_unavailable',
        `The ${plan.id} plan cannot be bought ${input.interval === 'year' ? 'yearly' : 'monthly'} yet`,
      );
    }
    const sub = await this.deps.entitlements.subscription(input.workspaceId);
    const current = this.deps.entitlements.planFor(sub);
    if (!current.public) {
      // The owner's unlimited plan or a partner plan set by an admin: buying would only downgrade.
      throw new BillingError('special_plan', `This workspace is on the special ${current.id} plan`, 409);
    }
    const live = this.liveSubscription(sub);
    if (live) {
      if (live.planId === plan.id && live.interval === input.interval) {
        throw new BillingError('same_plan', `The workspace is already on the ${plan.id} plan`, 409);
      }
      await this.call(() => provider.changePrice(this.ref(live), priceId));
      this.deps.logger.info(
        { workspaceId: input.workspaceId, from: live.planId, to: plan.id, provider: provider.id },
        'billing: plan change requested',
      );
      return { kind: 'changed', planId: plan.id };
    }
    if (BillingService.isPaidByProvider(sub)) {
      // Paid through a provider that is no longer active (e.g. moved from Paddle to Stripe).
      throw new BillingError(
        'other_provider',
        'This workspace pays through another payment provider; cancel that subscription first',
        409,
      );
    }
    const customerId = sub?.provider === provider.id ? sub.customerId : null;
    const { url } = await this.call(() =>
      provider.checkout({ ...input, planId: plan.id, priceId, customerId }),
    );
    return { kind: 'redirect', url };
  }

  /** The provider's page to update the card, download invoices or cancel. */
  async portal(workspaceId: string, returnUrl: string): Promise<{ url: string }> {
    const provider = this.requireProvider();
    const sub = await this.deps.entitlements.subscription(workspaceId);
    if (!sub || sub.provider !== provider.id || !sub.externalId) {
      throw new BillingError('no_subscription', 'This workspace has no paid subscription', 404);
    }
    return this.call(() => provider.portal({ subscription: this.ref(sub), returnUrl }));
  }

  /** Cancels at the end of the paid period (`false` takes the cancellation back). */
  async setCancelAtPeriodEnd(workspaceId: string, cancel: boolean): Promise<SubscriptionRow> {
    const provider = this.requireProvider();
    const sub = this.liveSubscription(await this.deps.entitlements.subscription(workspaceId));
    if (!sub) throw new BillingError('no_subscription', 'This workspace has no paid subscription', 404);
    if (sub.cancelAtPeriodEnd !== cancel) {
      await this.call(() => provider.setCancelAtPeriodEnd(this.ref(sub), cancel));
      // Show the change right away; the provider's webhook confirms it (and wins if it differs).
      await this.deps.db
        .update(subscriptions)
        .set({ cancelAtPeriodEnd: cancel, updatedAt: new Date() })
        .where(eq(subscriptions.workspaceId, workspaceId));
    }
    return { ...sub, cancelAtPeriodEnd: cancel };
  }

  // --- Webhooks ----------------------------------------------------------------------

  /** Verifies and applies a webhook call. Returns the HTTP status for the provider. */
  async handleWebhook(providerId: string, body: string, headers: Headers): Promise<number> {
    const provider = this.deps.provider;
    if (!provider || provider.id !== providerId) return 404;
    const result = await provider.parseWebhook({ body, headers });
    if (!result.ok) {
      this.deps.logger.warn({ provider: providerId, reason: result.reason }, 'billing: webhook rejected');
      return 400;
    }
    for (const change of result.changes) {
      // A failure makes the provider retry the whole call; applied events are skipped then.
      if ((await this.apply(provider.id, change)) === 'failed') return 500;
    }
    return 200;
  }

  /** Applies one normalized event once. */
  async apply(
    providerId: string,
    change: SubscriptionChange,
  ): Promise<'applied' | 'ignored' | 'failed' | 'duplicate'> {
    const [claimed] = await this.deps.db
      .insert(billingEvents)
      .values({
        provider: providerId,
        eventId: change.eventId,
        type: change.type,
        externalId: change.externalId,
        status: change.status,
        outcome: 'processing',
        occurredAt: change.occurredAt,
      })
      .onConflictDoUpdate({
        target: [billingEvents.provider, billingEvents.eventId],
        set: { outcome: 'processing' },
        // Only a failed attempt is retried; anything else is a duplicate delivery.
        setWhere: sql`${billingEvents.outcome} = 'failed'`,
      })
      .returning({ eventId: billingEvents.eventId });
    if (!claimed) return 'duplicate';

    let outcome: 'applied' | 'ignored' | 'failed';
    let detail: string | null = null;
    let workspaceId: string | null = null;
    let planId: string | null = null;
    try {
      const decision = await this.decide(providerId, change);
      workspaceId = decision.workspaceId ?? null;
      planId = decision.planId ?? null;
      if (decision.ignore) {
        outcome = 'ignored';
        detail = decision.ignore;
      } else {
        await this.deps.entitlements.setPlan(decision.workspaceId!, decision.planId!, {
          provider: providerId,
          externalId: change.externalId,
          customerId: change.customerId,
          status: change.status,
          periodEnd: change.periodEnd,
          interval: decision.interval ?? null,
          cancelAtPeriodEnd: change.cancelAtPeriodEnd,
          providerUpdatedAt: change.occurredAt,
        });
        outcome = 'applied';
      }
    } catch (error) {
      outcome = 'failed';
      detail = (error as Error).message.slice(0, 300);
      this.deps.logger.error(
        { provider: providerId, eventId: change.eventId, err: error },
        'billing: event failed',
      );
    }
    await this.deps.db
      .update(billingEvents)
      .set({ outcome, detail, workspaceId, planId })
      .where(and(eq(billingEvents.provider, providerId), eq(billingEvents.eventId, change.eventId)));
    if (outcome !== 'failed') {
      this.deps.logger.info(
        {
          provider: providerId,
          type: change.type,
          workspaceId,
          planId,
          status: change.status,
          outcome,
          detail,
        },
        'billing: event',
      );
    }
    return outcome;
  }

  private async decide(
    providerId: string,
    change: SubscriptionChange,
  ): Promise<{
    workspaceId?: string;
    planId?: string;
    interval?: BillingInterval;
    ignore?: string;
  }> {
    const workspaceId = await this.resolveWorkspace(providerId, change);
    if (!workspaceId) return { ignore: 'unknown workspace' };
    const sub = await this.deps.entitlements.subscription(workspaceId);
    const sameSubscription = sub?.provider === providerId && sub.externalId === change.externalId;
    if (sameSubscription && sub.providerUpdatedAt && change.occurredAt < sub.providerUpdatedAt) {
      return { workspaceId, ignore: 'older than the current state' };
    }
    if (!sameSubscription && sub && LIVE.has(sub.status) && sub.externalId && !LIVE.has(change.status)) {
      // The end of an old subscription must not cancel the one that replaced it.
      return { workspaceId, ignore: 'another subscription is active' };
    }
    if (!sameSubscription && sub && !findPlan(sub.planId)?.public && !BillingService.isPaidByProvider(sub)) {
      return { workspaceId, ignore: `workspace is on the special ${sub.planId} plan` };
    }
    const priced = this.planForPrice(change.priceId);
    if (priced) return { workspaceId, planId: priced.planId, interval: priced.interval };
    // An ended subscription keeps its last plan in the row (it no longer applies).
    if (!LIVE.has(change.status) && sameSubscription) {
      return { workspaceId, planId: sub.planId, ...(sub.interval ? { interval: sub.interval } : {}) };
    }
    return { workspaceId, ignore: `unknown price ${change.priceId ?? '(none)'}` };
  }

  private async resolveWorkspace(
    providerId: string,
    change: SubscriptionChange,
  ): Promise<string | undefined> {
    if (change.workspaceId) {
      const [row] = await this.deps.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, change.workspaceId))
        .limit(1);
      if (row) return row.id;
    }
    const [row] = await this.deps.db
      .select({ workspaceId: subscriptions.workspaceId })
      .from(subscriptions)
      .where(and(eq(subscriptions.provider, providerId), eq(subscriptions.externalId, change.externalId)))
      .limit(1);
    return row?.workspaceId;
  }

  /** Recent webhook events (admin panel), optionally of one workspace. */
  async recentEvents(opts: { workspaceId?: string; limit?: number } = {}): Promise<BillingEventRow[]> {
    return this.deps.db
      .select()
      .from(billingEvents)
      .where(opts.workspaceId ? eq(billingEvents.workspaceId, opts.workspaceId) : undefined)
      .orderBy(desc(billingEvents.createdAt))
      .limit(opts.limit ?? 20);
  }

  // --- Helpers -----------------------------------------------------------------------

  private requireProvider(): BillingProvider {
    if (!this.deps.provider) {
      throw new BillingError('payments_off', 'Payments are not available yet', 503);
    }
    return this.deps.provider;
  }

  private ref(sub: SubscriptionRow) {
    return { externalId: sub.externalId!, customerId: sub.customerId };
  }

  /** Provider calls: their own messages are logged, the user sees a plain one. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.deps.logger.error(
        { provider: this.deps.provider?.id, err: error },
        'billing: provider call failed',
      );
      if (
        error instanceof BillingProviderError &&
        error.status &&
        error.status < 500 &&
        error.status !== 401
      ) {
        throw new BillingError('provider_refused', 'The payment provider refused the request', 502);
      }
      throw new BillingError(
        'provider_unavailable',
        'The payment provider is not responding; try again shortly',
        502,
      );
    }
  }
}
