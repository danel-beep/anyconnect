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
 * Paddle Billing (merchant of record: Paddle sells to the customer and handles sales tax / VAT).
 * Checkout runs in Paddle.js on the hub's own page `/billing/paddle/checkout` (Paddle's "default
 * payment link" must point there; after paying it returns to the billing page); everything else is
 * Paddle's REST API and signed webhooks.
 * Docs: https://developer.paddle.com/api-reference/overview
 */
export interface PaddleOptions {
  apiKey: string;
  clientToken: string;
  webhookSecret: string;
  sandbox: boolean;
  /** The hub's origin, for the checkout page. */
  publicUrl: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** The subscription entity in webhooks (only the fields the hub reads). */
const PaddleSubscription = z.object({
  id: z.string(),
  status: z.string(),
  customer_id: z.string().nullish(),
  custom_data: z.record(z.string(), z.unknown()).nullish(),
  items: z
    .array(z.object({ price: z.object({ id: z.string() }).nullish(), price_id: z.string().nullish() }))
    .default([]),
  billing_cycle: z.object({ interval: z.string() }).nullish(),
  current_billing_period: z.object({ ends_at: z.string() }).nullish(),
  scheduled_change: z.object({ action: z.string() }).nullish(),
  canceled_at: z.string().nullish(),
});

const PaddleEvent = z.object({
  event_id: z.string(),
  event_type: z.string(),
  occurred_at: z.string(),
  data: z.unknown(),
});

const STATUS: Record<string, SubscriptionStatus> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  paused: 'paused',
  canceled: 'canceled',
};

export class PaddleProvider implements BillingProvider {
  readonly id = 'paddle';
  readonly name: string;
  readonly testMode: boolean;
  private readonly base: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: PaddleOptions) {
    this.testMode = opts.sandbox;
    this.name = opts.sandbox ? 'Paddle (sandbox)' : 'Paddle';
    this.base = opts.sandbox ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
    this.fetch = opts.fetch ?? fetch;
  }

  /** What the hub's checkout page needs to start Paddle.js (the client token is public by design). */
  get checkoutPage() {
    return { clientToken: this.opts.clientToken, sandbox: this.opts.sandbox };
  }

  async checkout(input: CheckoutInput): Promise<{ url: string }> {
    const body = {
      items: [{ price_id: input.priceId, quantity: 1 }],
      collection_mode: 'automatic',
      ...(input.customerId ? { customer_id: input.customerId } : {}),
      // Copied by Paddle onto the subscription: webhooks find the workspace through it.
      custom_data: { workspace_id: input.workspaceId, plan: input.planId, user_id: input.userId },
    };
    const res = await this.api<{ data: { id: string } }>('POST', '/transactions', body);
    const url = new URL('/billing/paddle/checkout', this.opts.publicUrl);
    url.searchParams.set('txn', res.data.id);
    if (!input.customerId) url.searchParams.set('email', input.email);
    return { url: url.toString() };
  }

  async portal(input: { subscription: ProviderSubscriptionRef }): Promise<{ url: string }> {
    const customer = input.subscription.customerId;
    if (!customer) throw new BillingProviderError('The subscription has no Paddle customer', 400);
    const res = await this.api<{ data: { urls: { general: { overview: string } } } }>(
      'POST',
      `/customers/${encodeURIComponent(customer)}/portal-sessions`,
      { subscription_ids: [input.subscription.externalId] },
    );
    return { url: res.data.urls.general.overview };
  }

  async changePrice(subscription: ProviderSubscriptionRef, priceId: string): Promise<void> {
    await this.api('PATCH', `/subscriptions/${encodeURIComponent(subscription.externalId)}`, {
      items: [{ price_id: priceId, quantity: 1 }],
      proration_billing_mode: 'prorated_immediately',
    });
  }

  async setCancelAtPeriodEnd(subscription: ProviderSubscriptionRef, atPeriodEnd: boolean): Promise<void> {
    const path = `/subscriptions/${encodeURIComponent(subscription.externalId)}`;
    if (atPeriodEnd) await this.api('POST', `${path}/cancel`, { effective_from: 'next_billing_period' });
    else await this.api('PATCH', path, { scheduled_change: null });
  }

  async parseWebhook(request: { body: string; headers: Headers }): Promise<WebhookResult> {
    const header = request.headers.get('paddle-signature');
    if (!header) return { ok: false, reason: 'no Paddle-Signature header' };
    const parts = parseSignatureHeader(header, ';');
    const ts = Number(parts.get('ts')?.[0]);
    if (!fresh(ts, this.opts.now?.() ?? new Date()))
      return { ok: false, reason: 'stale or missing timestamp' };
    const expected = hmacHex(this.opts.webhookSecret, `${ts}:${request.body}`);
    if (!(parts.get('h1') ?? []).some((sig) => hexEqual(sig, expected))) {
      return { ok: false, reason: 'signature mismatch' };
    }
    let event: z.infer<typeof PaddleEvent>;
    try {
      event = PaddleEvent.parse(JSON.parse(request.body));
    } catch {
      return { ok: false, reason: 'malformed body' };
    }
    if (!event.event_type.startsWith('subscription.')) return { ok: true, changes: [] };
    const parsed = PaddleSubscription.safeParse(event.data);
    if (!parsed.success) return { ok: true, changes: [] };
    const sub = parsed.data;
    const status = STATUS[sub.status];
    if (!status) return { ok: true, changes: [] };
    const item = sub.items[0];
    const interval = sub.billing_cycle?.interval;
    const end = sub.current_billing_period?.ends_at ?? (status === 'canceled' ? sub.canceled_at : null);
    const workspaceId = sub.custom_data?.workspace_id;
    const change: SubscriptionChange = {
      eventId: event.event_id,
      type: event.event_type,
      occurredAt: new Date(event.occurred_at),
      workspaceId: typeof workspaceId === 'string' ? workspaceId : undefined,
      externalId: sub.id,
      customerId: sub.customer_id ?? null,
      priceId: item?.price?.id ?? item?.price_id ?? null,
      interval: interval === 'month' || interval === 'year' ? (interval as BillingInterval) : null,
      status,
      periodEnd: end ? new Date(end) : null,
      cancelAtPeriodEnd: sub.scheduled_change?.action === 'cancel',
    };
    return { ok: true, changes: [change] };
  }

  private async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
        'Paddle-Version': '1',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const err = (JSON.parse(text) as { error?: { code?: string; detail?: string } }).error;
        if (err) detail = `${err.code ?? ''}: ${err.detail ?? ''}`;
      } catch {}
      throw new BillingProviderError(`Paddle ${method} ${path} failed (${res.status}) ${detail}`, res.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}
