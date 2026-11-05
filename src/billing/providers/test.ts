import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type {
  BillingInterval,
  BillingProvider,
  CheckoutInput,
  ProviderSubscriptionRef,
  SubscriptionChange,
  WebhookResult,
} from '../provider.js';
import { hexEqual, hmacHex } from './signature.js';

/**
 * A pretend payment provider for development and tests (`BILLING_PROVIDER=test`, refused in
 * production). Its "hosted" pages are served by the hub (`/billing/test/*`) and every change it
 * makes arrives as a signed webhook through the same path as a real provider's, so the whole flow
 * — checkout, plan change, cancel, period end — can be tried without any account or keys.
 */
export interface TestSubscription {
  id: string;
  customerId: string;
  workspaceId: string;
  priceId: string;
  quantity: number;
  interval: BillingInterval;
  status: 'active' | 'past_due' | 'canceled';
  periodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

type Deliver = (body: string, headers: Headers) => Promise<number>;

const CheckoutToken = z.object({
  workspaceId: z.string(),
  planId: z.string(),
  priceId: z.string(),
  quantity: z.number().int().positive(),
  interval: z.enum(['month', 'year']),
  customerId: z.string().nullable(),
  successUrl: z.string(),
  cancelUrl: z.string(),
  exp: z.number(),
});

const SIGNATURE_HEADER = 'x-test-signature';

export class TestBillingProvider implements BillingProvider {
  readonly id = 'test';
  readonly name = 'Test payments';
  readonly testMode = true;
  private readonly secret = randomBytes(32).toString('hex');
  private readonly subs = new Map<string, TestSubscription>();
  private deliver: Deliver | undefined;

  constructor(private readonly opts: { publicUrl: string; now?: () => Date }) {}

  /** The hub's webhook handler; set once the billing service exists. */
  connect(deliver: Deliver): void {
    this.deliver = deliver;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  async checkout(input: CheckoutInput): Promise<{ url: string }> {
    const token = this.sign({
      workspaceId: input.workspaceId,
      planId: input.planId,
      priceId: input.priceId,
      quantity: input.quantity,
      interval: input.interval,
      customerId: input.customerId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      exp: this.now().getTime() + 3_600_000,
    });
    return { url: `${this.opts.publicUrl}/billing/test/checkout?t=${encodeURIComponent(token)}` };
  }

  /** What the test checkout page shows; undefined for a bad or expired link. */
  readCheckout(token: string): z.infer<typeof CheckoutToken> | undefined {
    const data = this.verify(token);
    const parsed = CheckoutToken.safeParse(data);
    if (!parsed.success || parsed.data.exp < this.now().getTime()) return undefined;
    return parsed.data;
  }

  /** "Pay" on the test checkout page: creates the subscription and sends its webhook. */
  async completeCheckout(token: string): Promise<{ successUrl: string } | undefined> {
    const input = this.readCheckout(token);
    if (!input) return undefined;
    const days = input.interval === 'year' ? 365 : 30;
    const sub: TestSubscription = {
      id: `sub_test_${randomBytes(8).toString('hex')}`,
      customerId: input.customerId ?? `cus_${randomBytes(6).toString('hex')}`,
      workspaceId: input.workspaceId,
      priceId: input.priceId,
      quantity: input.quantity,
      interval: input.interval,
      status: 'active',
      periodEnd: new Date(this.now().getTime() + days * 86_400_000),
      cancelAtPeriodEnd: false,
    };
    this.subs.set(sub.id, sub);
    await this.emit('subscription.created', sub);
    return { successUrl: input.successUrl };
  }

  async portal(input: {
    subscription: ProviderSubscriptionRef;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const token = this.sign({ sub: input.subscription.externalId, back: input.returnUrl });
    return { url: `${this.opts.publicUrl}/billing/test/portal?t=${encodeURIComponent(token)}` };
  }

  /** The subscription a test portal link is for. */
  readPortal(token: string): { sub: TestSubscription; back: string } | undefined {
    const data = z.object({ sub: z.string(), back: z.string() }).safeParse(this.verify(token));
    const sub = data.success ? this.subs.get(data.data.sub) : undefined;
    return sub && data.success ? { sub, back: data.data.back } : undefined;
  }

  /** Test portal buttons: the provider-side events a real customer or provider would cause. */
  async simulate(id: string, what: 'cancel' | 'resume' | 'end' | 'renew' | 'fail'): Promise<void> {
    const sub = this.subs.get(id);
    if (!sub) return;
    if (what === 'cancel' || what === 'resume') sub.cancelAtPeriodEnd = what === 'cancel';
    if (what === 'end') sub.status = 'canceled';
    if (what === 'fail') sub.status = 'past_due';
    if (what === 'renew') {
      sub.status = 'active';
      sub.periodEnd = new Date(sub.periodEnd.getTime() + (sub.interval === 'year' ? 365 : 30) * 86_400_000);
    }
    await this.emit(what === 'end' ? 'subscription.canceled' : 'subscription.updated', sub);
  }

  async changeSubscription(
    subscription: ProviderSubscriptionRef,
    change: { priceId: string; quantity: number },
  ): Promise<void> {
    const sub = this.subs.get(subscription.externalId);
    if (!sub) throw new Error('Unknown test subscription (the hub restarted?)');
    sub.priceId = change.priceId;
    sub.quantity = change.quantity;
    sub.interval = change.priceId.endsWith('_year') ? 'year' : 'month';
    await this.emit('subscription.updated', sub);
  }

  async setCancelAtPeriodEnd(subscription: ProviderSubscriptionRef, atPeriodEnd: boolean): Promise<void> {
    await this.simulate(subscription.externalId, atPeriodEnd ? 'cancel' : 'resume');
  }

  async parseWebhook(request: { body: string; headers: Headers }): Promise<WebhookResult> {
    const sig = request.headers.get(SIGNATURE_HEADER) ?? '';
    if (!hexEqual(sig, hmacHex(this.secret, request.body)))
      return { ok: false, reason: 'signature mismatch' };
    const event = JSON.parse(request.body) as Omit<SubscriptionChange, 'occurredAt' | 'periodEnd'> & {
      occurredAt: string;
      periodEnd: string | null;
    };
    return {
      ok: true,
      changes: [
        {
          ...event,
          occurredAt: new Date(event.occurredAt),
          periodEnd: event.periodEnd ? new Date(event.periodEnd) : null,
        },
      ],
    };
  }

  private async emit(type: string, sub: TestSubscription): Promise<void> {
    if (!this.deliver) throw new Error('The test provider is not connected to the hub');
    const change: SubscriptionChange = {
      eventId: `evt_test_${randomBytes(8).toString('hex')}`,
      type,
      occurredAt: this.now(),
      workspaceId: sub.workspaceId,
      externalId: sub.id,
      customerId: sub.customerId,
      priceId: sub.priceId,
      quantity: sub.quantity,
      interval: sub.interval,
      status: sub.status,
      periodEnd: sub.periodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    };
    const body = JSON.stringify(change);
    const status = await this.deliver(body, new Headers({ [SIGNATURE_HEADER]: hmacHex(this.secret, body) }));
    if (status !== 200) throw new Error(`The hub refused the test webhook (${status})`);
  }

  private sign(data: unknown): string {
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    return `${payload}.${hmacHex(this.secret, payload)}`;
  }

  private verify(token: string): unknown {
    const [payload, sig] = token.split('.');
    if (!payload || !sig || !hexEqual(sig, hmacHex(this.secret, payload))) return undefined;
    try {
      return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return undefined;
    }
  }
}
