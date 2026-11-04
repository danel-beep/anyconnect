/**
 * The seam for payments. Manyplug does not take payments yet; when it does, a provider (Stripe,
 * ЮKassa, Paddle...) implements this interface and is wired in `createServices`. Everything else is
 * already built around it: the pricing and billing pages call `checkout` / `portal` when a provider
 * is configured, `/billing/webhook/:provider` hands events to `handleWebhook`, and the provider
 * records the outcome with `EntitlementService.setPlan(..., { provider: <id>, externalId, periodEnd })`.
 */
export interface CheckoutInput {
  workspaceId: string;
  userId: string;
  email: string;
  planId: string;
  interval: 'month' | 'year';
  /** Absolute URLs back to the hub. */
  successUrl: string;
  cancelUrl: string;
}

export interface BillingProvider {
  /** Stored in `subscriptions.provider`. */
  readonly id: string;
  readonly name: string;
  /** A hosted checkout page for a plan. */
  checkout(input: CheckoutInput): Promise<{ url: string }>;
  /** A hosted page where the customer manages or cancels their subscription. */
  portal?(input: { workspaceId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Verifies and applies a webhook call (signature check is the provider's job). */
  handleWebhook?(request: Request): Promise<Response>;
}
