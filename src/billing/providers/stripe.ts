import { z } from 'zod';
import type { SubscriptionStatus } from '../../db/schema.js';
import {
  type BillingInterval,
  type BillingProvider,
  BillingProviderError,
  type CheckoutInput,
  type ProviderSubscriptionRef,
  type SubscriptionChange,
  type WebhookResult,
} from '../provider.js';
import { fresh, hexEqual, hmacHex, parseSignatureHeader } from './signature.js';

/**
 * Stripe Billing: hosted Checkout, the customer portal and signed webhooks, over Stripe's REST API
 * (no SDK). Keys starting with `sk_test_` run in test mode.
 * Docs: https://docs.stripe.com/billing/subscriptions/build-subscriptions
 */
export interface StripeOptions {
  secretKey: string;
  webhookSecret: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

const StripeSubscription = z.object({
  id: z.string(),
  status: z.string(),
  customer: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
  cancel_at_period_end: z.boolean().nullish(),
  cancel_at: z.number().nullish(),
  current_period_end: z.number().nullish(),
  ended_at: z.number().nullish(),
  items: z
    .object({
      data: z.array(
        z.object({
          id: z.string(),
          current_period_end: z.number().nullish(),
          quantity: z.number().int().positive().nullish(),
          price: z.object({ id: z.string(), recurring: z.object({ interval: z.string() }).nullish() }),
        }),
      ),
    })
    .nullish(),
});

const StripeEvent = z.object({
  id: z.string(),
  type: z.string(),
  created: z.number(),
  data: z.object({ object: z.unknown() }),
});

/** Stripe statuses the hub acts on; `incomplete` (first payment pending) changes nothing yet. */
const STATUS: Record<string, SubscriptionStatus> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  // Retries are exhausted: Stripe keeps the subscription, the plan no longer applies.
  unpaid: 'paused',
  paused: 'paused',
  canceled: 'canceled',
  incomplete_expired: 'canceled',
};

export class StripeProvider implements BillingProvider {
  readonly id = 'stripe';
  readonly name: string;
  readonly testMode: boolean;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: StripeOptions) {
    this.testMode = opts.secretKey.startsWith('sk_test_') || opts.secretKey.startsWith('rk_test_');
    this.name = this.testMode ? 'Stripe (test mode)' : 'Stripe';
    this.fetch = opts.fetch ?? fetch;
  }

  async checkout(input: CheckoutInput): Promise<{ url: string }> {
    const session = await this.api<{ url: string }>('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      'line_items[0][price]': input.priceId,
      'line_items[0][quantity]': String(input.quantity),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.workspaceId,
      ...(input.customerId ? { customer: input.customerId } : { customer_email: input.email }),
      // Copied onto the subscription: webhooks find the workspace through it.
      'subscription_data[metadata][workspace_id]': input.workspaceId,
      'subscription_data[metadata][plan]': input.planId,
      allow_promotion_codes: 'true',
    });
    return { url: session.url };
  }

  async portal(input: {
    subscription: ProviderSubscriptionRef;
    returnUrl: string;
  }): Promise<{ url: string }> {
    if (!input.subscription.customerId) {
      throw new BillingProviderError('The subscription has no Stripe customer', 400);
    }
    const session = await this.api<{ url: string }>('POST', '/v1/billing_portal/sessions', {
      customer: input.subscription.customerId,
      return_url: input.returnUrl,
    });
    return { url: session.url };
  }

  async changeSubscription(
    subscription: ProviderSubscriptionRef,
    change: { priceId: string; quantity: number },
  ): Promise<void> {
    const path = `/v1/subscriptions/${encodeURIComponent(subscription.externalId)}`;
    const current = StripeSubscription.parse(await this.api('GET', path));
    const item = current.items?.data[0];
    if (!item) throw new BillingProviderError('The Stripe subscription has no items', 400);
    await this.api('POST', path, {
      'items[0][id]': item.id,
      'items[0][price]': change.priceId,
      'items[0][quantity]': String(change.quantity),
      proration_behavior: 'create_prorations',
    });
  }

  async setCancelAtPeriodEnd(subscription: ProviderSubscriptionRef, atPeriodEnd: boolean): Promise<void> {
    await this.api('POST', `/v1/subscriptions/${encodeURIComponent(subscription.externalId)}`, {
      cancel_at_period_end: String(atPeriodEnd),
    });
  }

  async parseWebhook(request: { body: string; headers: Headers }): Promise<WebhookResult> {
    const header = request.headers.get('stripe-signature');
    if (!header) return { ok: false, reason: 'no Stripe-Signature header' };
    const parts = parseSignatureHeader(header, ',');
    const t = Number(parts.get('t')?.[0]);
    if (!fresh(t, this.opts.now?.() ?? new Date()))
      return { ok: false, reason: 'stale or missing timestamp' };
    const expected = hmacHex(this.opts.webhookSecret, `${t}.${request.body}`);
    if (!(parts.get('v1') ?? []).some((sig) => hexEqual(sig, expected))) {
      return { ok: false, reason: 'signature mismatch' };
    }
    let event: z.infer<typeof StripeEvent>;
    try {
      event = StripeEvent.parse(JSON.parse(request.body));
    } catch {
      return { ok: false, reason: 'malformed body' };
    }
    if (!event.type.startsWith('customer.subscription.')) return { ok: true, changes: [] };
    const parsed = StripeSubscription.safeParse(event.data.object);
    if (!parsed.success) return { ok: true, changes: [] };
    const sub = parsed.data;
    const status = STATUS[sub.status];
    if (!status) return { ok: true, changes: [] };
    const item = sub.items?.data[0];
    const interval = item?.price.recurring?.interval;
    // API versions from 2025 keep the period on the item; older ones on the subscription.
    const end = item?.current_period_end ?? sub.current_period_end ?? sub.ended_at ?? null;
    const change: SubscriptionChange = {
      eventId: event.id,
      type: event.type,
      occurredAt: new Date(event.created * 1000),
      workspaceId: sub.metadata?.workspace_id,
      externalId: sub.id,
      customerId: typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id ?? null),
      priceId: item?.price.id ?? null,
      quantity: item?.quantity ?? null,
      interval: interval === 'month' || interval === 'year' ? (interval as BillingInterval) : null,
      status,
      periodEnd: end ? new Date(end * 1000) : null,
      cancelAtPeriodEnd:
        Boolean(sub.cancel_at_period_end) || (sub.cancel_at != null && status !== 'canceled'),
    };
    return { ok: true, changes: [change] };
  }

  private async api<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    form?: Record<string, string>,
  ): Promise<T> {
    const res = await this.fetch(`https://api.stripe.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.secretKey}`,
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const err = (JSON.parse(text) as { error?: { code?: string; message?: string } }).error;
        if (err) detail = `${err.code ?? ''}: ${err.message ?? ''}`;
      } catch {}
      throw new BillingProviderError(`Stripe ${method} ${path} failed (${res.status}) ${detail}`, res.status);
    }
    return JSON.parse(text) as T;
  }
}
