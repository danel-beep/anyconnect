import { describe, expect, it } from 'vitest';
import { missingPrices, readBillingConfig } from '../src/billing/config.js';
import { PaddleProvider } from '../src/billing/providers/paddle.js';
import { hmacHex } from '../src/billing/providers/signature.js';
import { StripeProvider } from '../src/billing/providers/stripe.js';

const NOW = new Date('2026-11-04T12:00:00Z');
const ts = Math.floor(NOW.getTime() / 1000);

/** Records provider API calls and answers them. */
function fakeApi(answer: (url: string, init: RequestInit) => unknown) {
  const calls: { url: string; method: string; body: string; auth: string }[] = [];
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: String(init.body ?? ''),
      auth: new Headers(init.headers).get('authorization') ?? '',
    });
    return new Response(JSON.stringify(answer(url, init)), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('billing config', () => {
  it('is off by default and reads a provider with its prices', () => {
    expect(readBillingConfig({}, { isProduction: true }).provider).toBeUndefined();
    const config = readBillingConfig(
      {
        BILLING_PROVIDER: 'paddle',
        PADDLE_API_KEY: 'pdl_key',
        PADDLE_CLIENT_TOKEN: 'test_tok',
        PADDLE_WEBHOOK_SECRET: 'pdl_ntfset',
        PADDLE_PRICE_PRO_MONTH: 'pri_pro_m',
        PADDLE_PRICE_PRO_YEAR: 'pri_pro_y',
      },
      { isProduction: true },
    );
    expect(config.provider).toBe('paddle');
    expect(config.paddle?.sandbox).toBe(true);
    expect(config.prices.get('pro:year')).toBe('pri_pro_y');
    expect(missingPrices(config)).toEqual(expect.arrayContaining(['personal:month', 'team:year']));
    expect(missingPrices(config)).not.toContain('business:year');
    expect(missingPrices(config)).not.toContain('pro:month');
  });

  it('refuses missing keys and the test provider in production', () => {
    expect(() => readBillingConfig({ BILLING_PROVIDER: 'stripe' }, { isProduction: false })).toThrow(
      /STRIPE_SECRET_KEY/,
    );
    expect(() => readBillingConfig({ BILLING_PROVIDER: 'test' }, { isProduction: true })).toThrow(
      /development only/,
    );
    expect(() => readBillingConfig({ BILLING_PROVIDER: 'paypal' }, { isProduction: false })).toThrow();
    expect(readBillingConfig({ BILLING_PROVIDER: 'test' }, { isProduction: false }).prices.size).toBe(6);
  });
});

describe('Paddle provider', () => {
  const secret = 'pdl_ntfset_secret';
  const make = (fetch?: typeof globalThis.fetch) =>
    new PaddleProvider({
      apiKey: 'pdl_sdbx_apikey',
      clientToken: 'test_token',
      webhookSecret: secret,
      sandbox: true,
      publicUrl: 'https://hub.example',
      now: () => NOW,
      ...(fetch ? { fetch } : {}),
    });
  const signed = (body: string, at = ts) =>
    new Headers({ 'paddle-signature': `ts=${at};h1=${hmacHex(secret, `${at}:${body}`)}` });
  const event = (data: Record<string, unknown>, type = 'subscription.updated') =>
    JSON.stringify({ event_id: 'evt_1', event_type: type, occurred_at: NOW.toISOString(), data });
  const subscription = {
    id: 'sub_01',
    status: 'active',
    customer_id: 'ctm_01',
    custom_data: { workspace_id: 'wsp_1', plan: 'pro' },
    items: [{ price: { id: 'pri_pro_m' } }],
    billing_cycle: { interval: 'month', frequency: 1 },
    current_billing_period: { starts_at: '2026-11-04T00:00:00Z', ends_at: '2026-12-04T00:00:00Z' },
    scheduled_change: { action: 'cancel', effective_at: '2026-12-04T00:00:00Z' },
  };

  it('creates a transaction and sends the user to the hub page that opens Paddle checkout', async () => {
    const api = fakeApi(() => ({ data: { id: 'txn_01abc' } }));
    const { url } = await make(api.fetch).checkout({
      workspaceId: 'wsp_1',
      userId: 'usr_1',
      email: 'ann@example.com',
      planId: 'pro',
      interval: 'month',
      priceId: 'pri_pro_m',
      quantity: 1,
      customerId: null,
      successUrl: 'https://hub.example/app/billing?paid=1',
      cancelUrl: 'https://hub.example/app/billing',
    });
    expect(api.calls[0]!.url).toBe('https://sandbox-api.paddle.com/transactions');
    expect(api.calls[0]!.auth).toBe('Bearer pdl_sdbx_apikey');
    expect(JSON.parse(api.calls[0]!.body)).toMatchObject({
      items: [{ price_id: 'pri_pro_m', quantity: 1 }],
      custom_data: { workspace_id: 'wsp_1', plan: 'pro' },
    });
    expect(url).toBe('https://hub.example/billing/paddle/checkout?txn=txn_01abc&email=ann%40example.com');
  });

  it('changes, cancels and opens the portal through the API', async () => {
    const api = fakeApi((url) =>
      url.includes('portal-sessions')
        ? { data: { urls: { general: { overview: 'https://portal.paddle/x' } } } }
        : { data: {} },
    );
    const paddle = make(api.fetch);
    const ref = { externalId: 'sub_01', customerId: 'ctm_01' };
    await paddle.changeSubscription(ref, { priceId: 'pri_team_m', quantity: 5 });
    await paddle.setCancelAtPeriodEnd(ref, true);
    await paddle.setCancelAtPeriodEnd(ref, false);
    expect(await paddle.portal({ subscription: ref })).toEqual({
      url: 'https://portal.paddle/x',
    });
    expect(
      api.calls.map((c) => `${c.method} ${c.url.replace('https://sandbox-api.paddle.com', '')} ${c.body}`),
    ).toEqual([
      'PATCH /subscriptions/sub_01 {"items":[{"price_id":"pri_team_m","quantity":5}],"proration_billing_mode":"prorated_immediately"}',
      'POST /subscriptions/sub_01/cancel {"effective_from":"next_billing_period"}',
      'PATCH /subscriptions/sub_01 {"scheduled_change":null}',
      'POST /customers/ctm_01/portal-sessions {"subscription_ids":["sub_01"]}',
    ]);
  });

  it('verifies webhook signatures and normalizes subscription events', async () => {
    const paddle = make();
    const body = event(subscription);
    const result = await paddle.parseWebhook({ body, headers: signed(body) });
    expect(result).toEqual({
      ok: true,
      changes: [
        {
          eventId: 'evt_1',
          type: 'subscription.updated',
          occurredAt: NOW,
          workspaceId: 'wsp_1',
          externalId: 'sub_01',
          customerId: 'ctm_01',
          priceId: 'pri_pro_m',
          quantity: null,
          interval: 'month',
          status: 'active',
          periodEnd: new Date('2026-12-04T00:00:00Z'),
          cancelAtPeriodEnd: true,
        },
      ],
    });
    expect(await paddle.parseWebhook({ body: `${body} `, headers: signed(body) })).toMatchObject({
      ok: false,
    });
    expect(await paddle.parseWebhook({ body, headers: signed(body, ts - 3600) })).toMatchObject({
      ok: false,
      reason: 'stale or missing timestamp',
    });
    expect(await paddle.parseWebhook({ body, headers: new Headers() })).toMatchObject({ ok: false });
    const other = event({ id: 'txn_1' }, 'transaction.completed');
    expect(await paddle.parseWebhook({ body: other, headers: signed(other) })).toEqual({
      ok: true,
      changes: [],
    });
  });
});

describe('Stripe provider', () => {
  const secret = 'whsec_test';
  const make = (fetch?: typeof globalThis.fetch) =>
    new StripeProvider({
      secretKey: 'sk_test_123',
      webhookSecret: secret,
      now: () => NOW,
      ...(fetch ? { fetch } : {}),
    });
  const signed = (body: string) =>
    new Headers({ 'stripe-signature': `t=${ts},v1=${hmacHex(secret, `${ts}.${body}`)}` });

  it('opens Checkout with the workspace in the subscription metadata', async () => {
    const api = fakeApi(() => ({ url: 'https://checkout.stripe.com/c/pay/cs_1' }));
    const stripe = make(api.fetch);
    expect(stripe.testMode).toBe(true);
    const { url } = await stripe.checkout({
      workspaceId: 'wsp_1',
      userId: 'usr_1',
      email: 'ann@example.com',
      planId: 'personal',
      interval: 'year',
      priceId: 'price_p_y',
      quantity: 1,
      customerId: null,
      successUrl: 'https://hub.example/app/billing?paid=1',
      cancelUrl: 'https://hub.example/app/billing',
    });
    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_1');
    const form = new URLSearchParams(api.calls[0]!.body);
    expect(form.get('mode')).toBe('subscription');
    expect(form.get('line_items[0][price]')).toBe('price_p_y');
    expect(form.get('line_items[0][quantity]')).toBe('1');
    expect(form.get('subscription_data[metadata][workspace_id]')).toBe('wsp_1');
    expect(form.get('customer_email')).toBe('ann@example.com');
  });

  it('verifies webhooks and reads the period from the item (new API versions)', async () => {
    const stripe = make();
    const body = JSON.stringify({
      id: 'evt_s1',
      type: 'customer.subscription.updated',
      created: ts,
      data: {
        object: {
          id: 'sub_s1',
          status: 'past_due',
          customer: 'cus_1',
          metadata: { workspace_id: 'wsp_1' },
          cancel_at_period_end: false,
          items: {
            data: [
              {
                id: 'si_1',
                current_period_end: ts + 86_400,
                quantity: 4,
                price: { id: 'price_p_y', recurring: { interval: 'year' } },
              },
            ],
          },
        },
      },
    });
    const result = await stripe.parseWebhook({ body, headers: signed(body) });
    expect(result).toMatchObject({
      ok: true,
      changes: [
        {
          eventId: 'evt_s1',
          workspaceId: 'wsp_1',
          externalId: 'sub_s1',
          customerId: 'cus_1',
          priceId: 'price_p_y',
          quantity: 4,
          interval: 'year',
          status: 'past_due',
          periodEnd: new Date((ts + 86_400) * 1000),
          cancelAtPeriodEnd: false,
        },
      ],
    });
    expect(
      await stripe.parseWebhook({ body, headers: new Headers({ 'stripe-signature': `t=${ts},v1=00` }) }),
    ).toMatchObject({
      ok: false,
    });
  });
});
