import { z } from 'zod';
import type { SubscriptionStatus } from '../../db/schema.js';
import {
  type BillingInterval,
  type BillingProvider,
  BillingProviderError,
  type CheckoutInput,
  type MerchantOfRecord,
  type ProviderSubscriptionRef,
  type SubscriptionChange,
  type WebhookResult,
} from '../provider.js';
import { hexEqual, hmacHex } from './signature.js';

/**
 * Creem (merchant of record: Creem sells to the customer and handles sales tax / VAT). Checkout and
 * the customer portal are Creem's hosted pages; everything else is Creem's REST API and signed
 * webhooks. In Creem every product has exactly one price and billing period, so the hub's "price"
 * for a plan and interval is a Creem product id (`prod_…`).
 * Docs: https://docs.creem.io/api-reference/introduction
 */
export interface CreemOptions {
  apiKey: string;
  webhookSecret: string;
  fetch?: typeof fetch;
}

/** Test-mode keys start with this prefix and only work against the sandbox API. */
export const CREEM_TEST_KEY_PREFIX = 'creem_test_';

const Id = z
  .union([z.string(), z.object({ id: z.string() })])
  .transform((v) => (typeof v === 'string' ? v : v.id));

/** The subscription entity in webhooks (only the fields the hub reads). */
const CreemSubscription = z.object({
  id: z.string(),
  status: z.string(),
  product: z.union([z.string(), z.object({ id: z.string(), billing_period: z.string().nullish() })]),
  customer: Id.nullish(),
  items: z.array(z.object({ units: z.number().int().positive().nullish() })).nullish(),
  current_period_end_date: z.string().nullish(),
  canceled_at: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

const CreemEvent = z.object({
  id: z.string(),
  eventType: z.string(),
  created_at: z.union([z.number(), z.string()]),
  object: z.unknown(),
});

/** `checkout.completed` carries the new subscription next to the metadata the hub sent. */
const CreemCheckout = z.object({
  subscription: z.unknown(),
  customer: Id.nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

/**
 * Creem statuses: `scheduled_cancel` is still paid until the period ends, `unpaid` (renewal
 * retries ran out) stops the plan like Stripe's, `expired` is the end of a cancelled one.
 */
const STATUS: Record<string, SubscriptionStatus> = {
  active: 'active',
  scheduled_cancel: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  unpaid: 'paused',
  paused: 'paused',
  canceled: 'canceled',
  expired: 'canceled',
};

const INTERVAL: Record<string, BillingInterval> = { 'every-month': 'month', 'every-year': 'year' };

export class CreemProvider implements BillingProvider {
  readonly id = 'creem';
  readonly name: string;
  readonly testMode: boolean;
  readonly merchant: MerchantOfRecord = {
    name: 'Creem',
    legalName: 'Creem (Armitage Labs OÜ)',
    buyerTerms: 'creem.io/buyer-terms',
  };
  private readonly base: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: CreemOptions) {
    this.testMode = opts.apiKey.startsWith(CREEM_TEST_KEY_PREFIX);
    this.name = this.testMode ? 'Creem (test mode)' : 'Creem';
    this.base = this.testMode ? 'https://test-api.creem.io/v1' : 'https://api.creem.io/v1';
    this.fetch = opts.fetch ?? fetch;
  }

  async checkout(input: CheckoutInput): Promise<{ url: string }> {
    const res = await this.api<{ checkout_url?: string }>('POST', '/checkouts', {
      product_id: input.priceId,
      units: input.quantity,
      success_url: input.successUrl,
      customer: input.customerId ? { id: input.customerId } : { email: input.email },
      // Copied by Creem onto the subscription: webhooks find the workspace through it.
      metadata: { workspace_id: input.workspaceId, plan: input.planId, user_id: input.userId },
    });
    if (!res.checkout_url) throw new BillingProviderError('Creem returned no checkout URL', 502);
    return { url: res.checkout_url };
  }

  async portal(input: { subscription: ProviderSubscriptionRef }): Promise<{ url: string }> {
    const customer = input.subscription.customerId;
    if (!customer) throw new BillingProviderError('The subscription has no Creem customer', 400);
    const res = await this.api<{ customer_portal_link: string }>('POST', '/customers/billing', {
      customer_id: customer,
    });
    return { url: res.customer_portal_link };
  }

  async changeSubscription(
    subscription: ProviderSubscriptionRef,
    change: { priceId: string; quantity: number },
  ): Promise<void> {
    // A Creem product is the plan and interval together; units stay at the one the hub sells.
    await this.api('POST', `${this.path(subscription)}/upgrade`, {
      product_id: change.priceId,
      update_behavior: 'proration-charge-immediately',
    });
  }

  async setCancelAtPeriodEnd(subscription: ProviderSubscriptionRef, atPeriodEnd: boolean): Promise<void> {
    if (atPeriodEnd) {
      await this.api('POST', `${this.path(subscription)}/cancel`, { mode: 'scheduled', onExecute: 'cancel' });
    } else {
      await this.api('POST', `${this.path(subscription)}/resume`);
    }
  }

  async parseWebhook(request: { body: string; headers: Headers }): Promise<WebhookResult> {
    const signature = request.headers.get('creem-signature');
    if (!signature) return { ok: false, reason: 'no creem-signature header' };
    // Creem signs the raw body only (no timestamp): replays are stopped by the event id, which
    // BillingService stores once, and by ignoring events older than the subscription's state.
    if (!hexEqual(signature.trim(), hmacHex(this.opts.webhookSecret, request.body))) {
      return { ok: false, reason: 'signature mismatch' };
    }
    let event: z.infer<typeof CreemEvent>;
    try {
      event = CreemEvent.parse(JSON.parse(request.body));
    } catch {
      return { ok: false, reason: 'malformed body' };
    }
    let raw: unknown = event.object;
    let extra: {
      metadata?: Record<string, unknown> | null | undefined;
      customer?: string | null | undefined;
    } = {};
    if (event.eventType === 'checkout.completed') {
      const checkout = CreemCheckout.safeParse(event.object);
      if (!checkout.success || !checkout.data.subscription) return { ok: true, changes: [] };
      raw = checkout.data.subscription;
      extra = { metadata: checkout.data.metadata, customer: checkout.data.customer };
    } else if (!event.eventType.startsWith('subscription.')) {
      return { ok: true, changes: [] };
    }
    const parsed = CreemSubscription.safeParse(raw);
    if (!parsed.success) return { ok: true, changes: [] };
    const sub = parsed.data;
    const status = STATUS[sub.status];
    if (!status) return { ok: true, changes: [] };
    const product = typeof sub.product === 'string' ? { id: sub.product, billing_period: null } : sub.product;
    const end = sub.current_period_end_date ?? (status === 'canceled' ? sub.canceled_at : null);
    const workspaceId = sub.metadata?.workspace_id ?? extra.metadata?.workspace_id;
    const change: SubscriptionChange = {
      eventId: event.id,
      type: event.eventType,
      occurredAt: new Date(event.created_at),
      workspaceId: typeof workspaceId === 'string' ? workspaceId : undefined,
      externalId: sub.id,
      customerId: sub.customer ?? extra.customer ?? null,
      priceId: product.id,
      quantity: sub.items?.[0]?.units ?? null,
      interval: INTERVAL[product.billing_period ?? ''] ?? null,
      status,
      periodEnd: end ? new Date(end) : null,
      cancelAtPeriodEnd: sub.status === 'scheduled_cancel',
    };
    return { ok: true, changes: [change] };
  }

  private path(subscription: ProviderSubscriptionRef): string {
    return `/subscriptions/${encodeURIComponent(subscription.externalId)}`;
  }

  private async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(`${this.base}${path}`, {
      method,
      headers: { 'x-api-key': this.opts.apiKey, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const err = JSON.parse(text) as { error?: string; message?: string | string[] };
        const message = Array.isArray(err.message) ? err.message.join('; ') : err.message;
        if (err.error || message) detail = `${err.error ?? ''}: ${message ?? ''}`;
      } catch {}
      throw new BillingProviderError(`Creem ${method} ${path} failed (${res.status}) ${detail}`, res.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}
