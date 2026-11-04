import type { SubscriptionStatus } from '../db/schema.js';

/**
 * The seam for payments. A provider (Paddle, Stripe, the built-in test provider...) only translates
 * between the hub and the provider's API: it opens hosted pages, changes a subscription on request
 * and turns verified webhooks into {@link SubscriptionChange}s. Everything else — which plan a
 * workspace is on, duplicate and out-of-order events, limits, the admin view — lives in
 * `BillingService` and does not depend on the provider.
 *
 * Adding a provider: implement this interface in `src/billing/providers/<id>.ts`, add its settings
 * to `BillingConfig` (`src/billing/config.ts`) and a case to `createBillingProvider`.
 */

export type BillingInterval = 'month' | 'year';

export interface CheckoutInput {
  workspaceId: string;
  userId: string;
  email: string;
  planId: string;
  interval: BillingInterval;
  /** The provider's price for this plan and interval (from the hub's price map). */
  priceId: string;
  /** The workspace's customer at this provider, when it paid before. */
  customerId: string | null;
  /** Absolute URLs back to the hub. */
  successUrl: string;
  cancelUrl: string;
}

/** A subscription as the provider knows it (the hub's row: provider + externalId + customerId). */
export interface ProviderSubscriptionRef {
  externalId: string;
  customerId: string | null;
}

/**
 * The state of one subscription after a provider event, normalized. Providers emit it from
 * webhooks; `BillingService` decides what it means for the workspace.
 */
export interface SubscriptionChange {
  /** The provider's event id (duplicate protection). */
  eventId: string;
  /** The provider's event type, kept for the admin view. */
  type: string;
  occurredAt: Date;
  /** From the metadata the hub attached at checkout; absent for subscriptions made elsewhere. */
  workspaceId: string | undefined;
  externalId: string;
  customerId: string | null;
  /** The price the subscription is on now (mapped to a plan by the hub). */
  priceId: string | null;
  interval: BillingInterval | null;
  status: SubscriptionStatus;
  /** End of the paid period; access continues until then even after a cancellation. */
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export type WebhookResult =
  /** The signature did not verify: answer 400, change nothing. */
  | { ok: false; reason: string }
  /** Verified; `changes` may be empty for event types the hub does not use. */
  | { ok: true; changes: SubscriptionChange[] };

export interface BillingProvider {
  /** Stored in `subscriptions.provider` and used in `/billing/webhook/:provider`. */
  readonly id: string;
  /** Shown in the admin panel. */
  readonly name: string;
  /** Sandbox / test mode: shown to users so nobody mistakes it for a real charge. */
  readonly testMode: boolean;
  /** A hosted checkout page for a new subscription. */
  checkout(input: CheckoutInput): Promise<{ url: string }>;
  /** A hosted page where the customer updates the card, sees invoices or cancels. */
  portal(input: { subscription: ProviderSubscriptionRef; returnUrl: string }): Promise<{ url: string }>;
  /** Moves an existing subscription to another price (prorated). The webhook confirms it. */
  changePrice(subscription: ProviderSubscriptionRef, priceId: string): Promise<void>;
  /** Cancels at the end of the paid period (`atPeriodEnd: false` takes back a scheduled cancel). */
  setCancelAtPeriodEnd(subscription: ProviderSubscriptionRef, atPeriodEnd: boolean): Promise<void>;
  /** Verifies a webhook call (signature, freshness) and normalizes it. */
  parseWebhook(request: { body: string; headers: Headers }): Promise<WebhookResult>;
}

/** A provider error that is safe to show (the provider's own message is logged, not shown). */
export class BillingProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BillingProviderError';
  }
}
