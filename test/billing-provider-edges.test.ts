import { describe, expect, it } from 'vitest';
import type { BillingConfig } from '../src/billing/config.js';
import { BillingProviderError } from '../src/billing/provider.js';
import { CreemProvider } from '../src/billing/providers/creem.js';
import { providerDate } from '../src/billing/providers/dates.js';
import { createBillingProvider } from '../src/billing/providers/index.js';
import { PaddleProvider } from '../src/billing/providers/paddle.js';
import { fresh, hexEqual, hmacHex, parseSignatureHeader } from '../src/billing/providers/signature.js';
import { StripeProvider } from '../src/billing/providers/stripe.js';
import { TestBillingProvider } from '../src/billing/providers/test.js';

/**
 * Error branches and odd payloads of the payment providers: what the happy paths in
 * billing-providers.test.ts don't reach. A webhook that is not exactly right must be refused or
 * ignored, never half-applied.
 */

const NOW = new Date('2026-11-04T12:00:00Z');
const ts = Math.floor(NOW.getTime() / 1000);

/** Answers every provider API call with one status and body; records what was called. */
function answering(status: number, body: string) {
  const calls: { url: string; method: string; body: string }[] = [];
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: init.method ?? 'GET', body: String(init.body ?? '') });
    return new Response(body, { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

async function rejection(promise: Promise<unknown>): Promise<BillingProviderError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BillingProviderError);
  return error as BillingProviderError;
}

describe('webhook signature helpers', () => {
  it('compares only whole bytes of hex, so nothing appended to a signature passes', () => {
    const sig = hmacHex('secret', 'body');
    expect(hexEqual(sig, sig)).toBe(true);
    expect(hexEqual(sig.toUpperCase(), sig)).toBe(true);
    expect(hexEqual(`${sig}zz`, sig)).toBe(false);
    expect(hexEqual(`${sig}0`, sig)).toBe(false);
    expect(hexEqual(`${sig.slice(0, 10)}xx${sig.slice(12)}`, sig)).toBe(false);
    expect(hexEqual('', '')).toBe(false);
    expect(hexEqual('00', '0000')).toBe(false);
  });

  it('reads multimap headers and skips parts without a key', () => {
    const parts = parseSignatureHeader('t=1, v1=aa ,v1=bb,=cc,novalue,v0=dd', ',');
    expect(parts.get('t')).toEqual(['1']);
    expect(parts.get('v1')).toEqual(['aa', 'bb']);
    expect(parts.has('')).toBe(false);
    expect(parts.has('novalue')).toBe(false);
  });

  it('accepts timestamps within the tolerance only', () => {
    expect(fresh(ts, NOW)).toBe(true);
    expect(fresh(ts - 299, NOW)).toBe(true);
    expect(fresh(ts + 301, NOW)).toBe(false);
    expect(fresh(Number.NaN, NOW)).toBe(false);
    expect(fresh(ts - 10, NOW, 5)).toBe(false);
  });

  it('turns provider timestamps into real dates or null', () => {
    expect(providerDate('2026-12-04T00:00:00Z')).toEqual(new Date('2026-12-04T00:00:00Z'));
    expect(providerDate(NOW.getTime())).toEqual(NOW);
    expect(providerDate(String(NOW.getTime()))).toEqual(NOW);
    expect(providerDate('not a date')).toBeNull();
    expect(providerDate(Number.MAX_VALUE)).toBeNull();
    expect(providerDate('')).toBeNull();
    expect(providerDate(null)).toBeNull();
    expect(providerDate(undefined)).toBeNull();
  });
});

describe('Stripe provider edges', () => {
  const secret = 'whsec_edges';
  const make = (fetch?: typeof globalThis.fetch, secretKey = 'sk_test_1') =>
    new StripeProvider({ secretKey, webhookSecret: secret, now: () => NOW, ...(fetch ? { fetch } : {}) });
  const signed = (body: string, at = ts) =>
    new Headers({ 'stripe-signature': `t=${at},v1=${hmacHex(secret, `${at}.${body}`)}` });
  const event = (object: unknown, type = 'customer.subscription.updated', created = ts) =>
    JSON.stringify({ id: 'evt_1', type, created, data: { object } });
  const parse = (body: string, headers = signed(body)) => make().parseWebhook({ body, headers });

  it('names test and live keys', () => {
    expect(make(undefined, 'rk_test_1')).toMatchObject({ testMode: true, name: 'Stripe (test mode)' });
    expect(make(undefined, 'sk_live_1')).toMatchObject({ testMode: false, name: 'Stripe' });
  });

  it('refuses unsigned, stale, forged and malformed webhooks', async () => {
    const body = event({ id: 'sub_1', status: 'active' });
    expect(await parse(body, new Headers())).toEqual({ ok: false, reason: 'no Stripe-Signature header' });
    expect(await parse(body, signed(body, ts - 600))).toEqual({
      ok: false,
      reason: 'stale or missing timestamp',
    });
    expect(await parse(body, new Headers({ 'stripe-signature': `v1=${hmacHex(secret, body)}` }))).toEqual({
      ok: false,
      reason: 'stale or missing timestamp',
    });
    const good = signed(body).get('stripe-signature')!;
    expect(await parse(body, new Headers({ 'stripe-signature': `${good}zz` }))).toEqual({
      ok: false,
      reason: 'signature mismatch',
    });
    expect(await parse(body, new Headers({ 'stripe-signature': `t=${ts}` }))).toEqual({
      ok: false,
      reason: 'signature mismatch',
    });
    expect(await parse('{"id":')).toEqual({ ok: false, reason: 'malformed body' });
    expect(await parse(JSON.stringify({ id: 'evt_1', type: 'x' }))).toEqual({
      ok: false,
      reason: 'malformed body',
    });
    expect(
      await parse(event({ id: 'sub_1', status: 'active' }, 'customer.subscription.updated', 1e20)),
    ).toEqual({ ok: false, reason: 'malformed body' });
  });

  it('ignores other events, unreadable subscriptions and statuses it does not act on', async () => {
    expect(await parse(event({ id: 'in_1' }, 'invoice.paid'))).toEqual({ ok: true, changes: [] });
    expect(await parse(event({ status: 'active' }))).toEqual({ ok: true, changes: [] });
    expect(await parse(event({ id: 'sub_1', status: 'incomplete' }))).toEqual({ ok: true, changes: [] });
  });

  it('reads old API versions: period on the subscription, customer object, cancel_at', async () => {
    const result = await parse(
      event({
        id: 'sub_1',
        status: 'unpaid',
        customer: { id: 'cus_obj' },
        cancel_at: ts + 100,
        current_period_end: ts + 3600,
        items: { data: [{ id: 'si_1', price: { id: 'price_w', recurring: { interval: 'week' } } }] },
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      changes: [
        {
          customerId: 'cus_obj',
          priceId: 'price_w',
          quantity: null,
          interval: null,
          status: 'paused',
          periodEnd: new Date((ts + 3600) * 1000),
          cancelAtPeriodEnd: true,
          workspaceId: undefined,
        },
      ],
    });
  });

  it('ends a canceled subscription at ended_at, without a pending cancel and with no items', async () => {
    const result = await parse(
      event(
        { id: 'sub_1', status: 'canceled', cancel_at: ts, ended_at: ts },
        'customer.subscription.deleted',
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      changes: [
        {
          status: 'canceled',
          priceId: null,
          customerId: null,
          periodEnd: new Date(ts * 1000),
          cancelAtPeriodEnd: false,
        },
      ],
    });
    const open = await parse(event({ id: 'sub_2', status: 'active' }));
    expect(open).toMatchObject({ changes: [{ periodEnd: null, cancelAtPeriodEnd: false }] });
  });

  it('opens the portal, changes the plan and cancels through the API', async () => {
    const calls: string[] = [];
    const fetch = (async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input).replace('https://api.stripe.com', '');
      calls.push(`${init.method} ${url} ${String(init.body ?? '')}`);
      if (url.startsWith('/v1/billing_portal')) return Response.json({ url: 'https://billing.stripe/p' });
      if (init.method === 'GET') {
        return Response.json({
          id: 'sub_1',
          status: 'active',
          items: { data: [{ id: 'si_9', price: { id: 'price_old' } }] },
        });
      }
      return Response.json({});
    }) as typeof globalThis.fetch;
    const stripe = make(fetch);
    const ref = { externalId: 'sub_1', customerId: 'cus_1' };
    expect(await stripe.portal({ subscription: ref, returnUrl: 'https://hub.example/app/billing' })).toEqual({
      url: 'https://billing.stripe/p',
    });
    await stripe.changeSubscription(ref, { priceId: 'price_new', quantity: 3 });
    await stripe.setCancelAtPeriodEnd(ref, true);
    expect(calls).toEqual([
      'POST /v1/billing_portal/sessions customer=cus_1&return_url=https%3A%2F%2Fhub.example%2Fapp%2Fbilling',
      'GET /v1/subscriptions/sub_1 ',
      'POST /v1/subscriptions/sub_1 items%5B0%5D%5Bid%5D=si_9&items%5B0%5D%5Bprice%5D=price_new&items%5B0%5D%5Bquantity%5D=3&proration_behavior=create_prorations',
      'POST /v1/subscriptions/sub_1 cancel_at_period_end=true',
    ]);
  });

  it('checks out a known customer by id', async () => {
    const api = answering(200, JSON.stringify({ url: 'https://checkout.stripe.com/x' }));
    await make(api.fetch).checkout({
      workspaceId: 'wsp_1',
      userId: 'usr_1',
      email: 'ann@example.com',
      planId: 'pro',
      interval: 'month',
      priceId: 'price_1',
      quantity: 1,
      customerId: 'cus_known',
      successUrl: 'https://hub.example/ok',
      cancelUrl: 'https://hub.example/no',
    });
    const form = new URLSearchParams(api.calls[0]!.body);
    expect(form.get('customer')).toBe('cus_known');
    expect(form.has('customer_email')).toBe(false);
  });

  it('refuses a portal without a customer and a change without items', async () => {
    const noItems = answering(200, JSON.stringify({ id: 'sub_1', status: 'active', items: { data: [] } }));
    expect(
      (
        await rejection(
          make().portal({ subscription: { externalId: 'sub_1', customerId: null }, returnUrl: '/' }),
        )
      ).status,
    ).toBe(400);
    const error = await rejection(
      make(noItems.fetch).changeSubscription(
        { externalId: 'sub_1', customerId: 'c' },
        { priceId: 'p', quantity: 1 },
      ),
    );
    expect(error.message).toContain('no items');
    expect(noItems.calls).toHaveLength(1);
  });

  it('reports API failures with Stripe’s error code, or the start of a non-JSON body', async () => {
    const ref = { externalId: 'sub_1', customerId: 'c' };
    const json = await rejection(
      make(
        answering(402, JSON.stringify({ error: { code: 'card_declined', message: 'Declined' } })).fetch,
      ).setCancelAtPeriodEnd(ref, false),
    );
    expect(json.status).toBe(402);
    expect(json.message).toBe('Stripe POST /v1/subscriptions/sub_1 failed (402) card_declined: Declined');
    const partial = await rejection(
      make(answering(400, JSON.stringify({ error: {} })).fetch).setCancelAtPeriodEnd(ref, false),
    );
    expect(partial.message).toMatch(/failed \(400\) :\s*$/);
    const text = await rejection(
      make(answering(503, 'upstream down').fetch).setCancelAtPeriodEnd(ref, false),
    );
    expect(text.message).toBe('Stripe POST /v1/subscriptions/sub_1 failed (503) upstream down');
    const plain = await rejection(
      make(answering(500, JSON.stringify({ ok: false })).fetch).setCancelAtPeriodEnd(ref, false),
    );
    expect(plain.message).toContain('{"ok":false}');
  });
});

describe('Paddle provider edges', () => {
  const secret = 'pdl_edges';
  const make = (fetch?: typeof globalThis.fetch, sandbox = true) =>
    new PaddleProvider({
      apiKey: 'pdl_key',
      clientToken: 'live_tok',
      webhookSecret: secret,
      sandbox,
      publicUrl: 'https://hub.example',
      now: () => NOW,
      ...(fetch ? { fetch } : {}),
    });
  const signed = (body: string) =>
    new Headers({ 'paddle-signature': `ts=${ts};h1=${hmacHex(secret, `${ts}:${body}`)}` });
  const event = (data: unknown, type = 'subscription.updated', occurred = NOW.toISOString()) =>
    JSON.stringify({ event_id: 'evt_p', event_type: type, occurred_at: occurred, data });
  const parse = (body: string, headers = signed(body)) => make().parseWebhook({ body, headers });

  it('talks to the live API outside the sandbox and exposes the checkout page settings', () => {
    const live = make(undefined, false);
    expect(live).toMatchObject({ name: 'Paddle', testMode: false });
    expect(live.checkoutPage).toEqual({ clientToken: 'live_tok', sandbox: false });
  });

  it('refuses forged and malformed webhooks, including an impossible event time', async () => {
    const body = event({ id: 'sub_1', status: 'active' });
    expect(
      await parse(
        body,
        new Headers({ 'paddle-signature': `ts=${ts};h1=${hmacHex('other', `${ts}:${body}`)}` }),
      ),
    ).toEqual({ ok: false, reason: 'signature mismatch' });
    expect(await parse(body, new Headers({ 'paddle-signature': `ts=${ts}` }))).toEqual({
      ok: false,
      reason: 'signature mismatch',
    });
    expect(await parse('not json')).toEqual({ ok: false, reason: 'malformed body' });
    expect(await parse(JSON.stringify({ event_id: 'evt_p' }))).toEqual({
      ok: false,
      reason: 'malformed body',
    });
    expect(
      await parse(event({ id: 'sub_1', status: 'active' }, 'subscription.updated', 'yesterday')),
    ).toEqual({
      ok: false,
      reason: 'malformed body',
    });
  });

  it('ignores unreadable subscriptions and statuses it does not act on', async () => {
    expect(await parse(event({ status: 'active' }))).toEqual({ ok: true, changes: [] });
    expect(await parse(event({ id: 'sub_1', status: 'mystery' }))).toEqual({ ok: true, changes: [] });
  });

  it('reads the older item shape and ends a canceled subscription at canceled_at', async () => {
    const result = await parse(
      event(
        {
          id: 'sub_1',
          status: 'canceled',
          custom_data: { workspace_id: 42 },
          items: [{ price_id: 'pri_flat', quantity: 2 }],
          billing_cycle: { interval: 'week' },
          canceled_at: '2026-11-05T00:00:00Z',
        },
        'subscription.canceled',
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      changes: [
        {
          workspaceId: undefined,
          customerId: null,
          priceId: 'pri_flat',
          quantity: 2,
          interval: null,
          status: 'canceled',
          periodEnd: new Date('2026-11-05T00:00:00Z'),
          cancelAtPeriodEnd: false,
        },
      ],
    });
    const noItems = await parse(
      event({ id: 'sub_2', status: 'past_due', canceled_at: '2026-11-05T00:00:00Z' }),
    );
    expect(noItems).toMatchObject({ changes: [{ priceId: null, quantity: null, periodEnd: null }] });
    const badEnd = await parse(
      event({ id: 'sub_3', status: 'active', current_billing_period: { ends_at: 'soon' } }),
    );
    expect(badEnd).toMatchObject({ ok: true, changes: [{ periodEnd: null }] });
  });

  it('checks out a known customer without putting the email in the link', async () => {
    const api = answering(200, JSON.stringify({ data: { id: 'txn_9' } }));
    const { url } = await make(api.fetch, false).checkout({
      workspaceId: 'wsp_1',
      userId: 'usr_1',
      email: 'ann@example.com',
      planId: 'pro',
      interval: 'month',
      priceId: 'pri_1',
      quantity: 1,
      customerId: 'ctm_known',
      successUrl: 'https://hub.example/ok',
      cancelUrl: 'https://hub.example/no',
    });
    expect(url).toBe('https://hub.example/billing/paddle/checkout?txn=txn_9');
    expect(api.calls[0]!.url).toBe('https://api.paddle.com/transactions');
    expect(JSON.parse(api.calls[0]!.body).customer_id).toBe('ctm_known');
  });

  it('refuses a portal without a customer and reports API failures', async () => {
    expect(
      (await rejection(make().portal({ subscription: { externalId: 's', customerId: null } }))).status,
    ).toBe(400);
    const ref = { externalId: 'sub_1', customerId: 'ctm_1' };
    const json = await rejection(
      make(
        answering(409, JSON.stringify({ error: { code: 'conflict', detail: 'Pending change' } })).fetch,
      ).changeSubscription(ref, { priceId: 'p', quantity: 1 }),
    );
    expect(json.message).toBe('Paddle PATCH /subscriptions/sub_1 failed (409) conflict: Pending change');
    const empty = await rejection(
      make(answering(400, JSON.stringify({ error: {} })).fetch).setCancelAtPeriodEnd(ref, true),
    );
    expect(empty.message).toMatch(/cancel failed \(400\) :\s*$/);
    const text = await rejection(
      make(answering(502, '<html>bad gateway').fetch).setCancelAtPeriodEnd(ref, false),
    );
    expect(text.message).toBe('Paddle PATCH /subscriptions/sub_1 failed (502) <html>bad gateway');
    const other = await rejection(
      make(answering(500, '{"message":"x"}').fetch).setCancelAtPeriodEnd(ref, false),
    );
    expect(other.message).toContain('{"message":"x"}');
  });

  it('accepts an empty success body', async () => {
    await expect(
      make(answering(200, '').fetch).setCancelAtPeriodEnd({ externalId: 's', customerId: 'c' }, false),
    ).resolves.toBeUndefined();
  });
});

describe('Creem provider edges', () => {
  const secret = 'whsec_creem_edges';
  const make = (fetch?: typeof globalThis.fetch, apiKey = 'creem_test_k') =>
    new CreemProvider({ apiKey, webhookSecret: secret, ...(fetch ? { fetch } : {}) });
  const signed = (body: string) => new Headers({ 'creem-signature': ` ${hmacHex(secret, body)} ` });
  const event = (object: unknown, eventType = 'subscription.active', created: unknown = NOW.getTime()) =>
    JSON.stringify({ id: 'evt_c', eventType, created_at: created, object });
  const parse = (body: string, headers = signed(body)) => make().parseWebhook({ body, headers });
  const sub = { id: 'sub_c', status: 'active', product: 'prod_flat' };

  it('uses the live API with a live key', async () => {
    const api = answering(200, JSON.stringify({ checkout_url: 'https://creem.io/c' }));
    const live = make(api.fetch, 'creem_live_k');
    expect(live).toMatchObject({ name: 'Creem', testMode: false });
    await live.checkout({
      workspaceId: 'wsp_1',
      userId: 'usr_1',
      email: 'a@example.com',
      planId: 'pro',
      interval: 'month',
      priceId: 'prod_1',
      quantity: 1,
      customerId: null,
      successUrl: 'https://hub.example/ok',
      cancelUrl: 'https://hub.example/no',
    });
    expect(api.calls[0]!.url).toBe('https://api.creem.io/v1/checkouts');
  });

  it('refuses forged and malformed webhooks, including an impossible event time', async () => {
    const body = event(sub);
    expect(await parse(body, new Headers({ 'creem-signature': hmacHex('other', body) }))).toEqual({
      ok: false,
      reason: 'signature mismatch',
    });
    expect(await parse(body, new Headers({ 'creem-signature': `${hmacHex(secret, body)}zz` }))).toEqual({
      ok: false,
      reason: 'signature mismatch',
    });
    expect(await parse('{')).toEqual({ ok: false, reason: 'malformed body' });
    expect(await parse(event(sub, 'subscription.active', 'not-a-date'))).toEqual({
      ok: false,
      reason: 'malformed body',
    });
  });

  it('ignores a checkout without a subscription, unreadable subscriptions and unknown statuses', async () => {
    expect(await parse(event({ id: 'ch_1', metadata: {} }, 'checkout.completed'))).toEqual({
      ok: true,
      changes: [],
    });
    expect(await parse(event('ch_1', 'checkout.completed'))).toEqual({ ok: true, changes: [] });
    expect(await parse(event({ status: 'active' }))).toEqual({ ok: true, changes: [] });
    expect(await parse(event({ ...sub, status: 'incomplete' }))).toEqual({ ok: true, changes: [] });
  });

  it('reads a product given by id, a numeric-string time and a canceled end date', async () => {
    const result = await parse(
      event(
        { ...sub, status: 'canceled', canceled_at: '2026-11-05T00:00:00Z', metadata: { workspace_id: 7 } },
        'subscription.canceled',
        String(NOW.getTime()),
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      changes: [
        {
          occurredAt: NOW,
          workspaceId: undefined,
          customerId: null,
          priceId: 'prod_flat',
          quantity: null,
          interval: null,
          status: 'canceled',
          periodEnd: new Date('2026-11-05T00:00:00Z'),
          cancelAtPeriodEnd: false,
        },
      ],
    });
    const active = await parse(event({ ...sub, canceled_at: '2026-11-05T00:00:00Z', customer: 'cust_s' }));
    expect(active).toMatchObject({ changes: [{ periodEnd: null, customerId: 'cust_s' }] });
  });

  it('refuses a portal without a customer, a checkout without a link, and reports API failures', async () => {
    expect(
      (await rejection(make().portal({ subscription: { externalId: 's', customerId: null } }))).status,
    ).toBe(400);
    const noLink = await rejection(
      make(answering(200, '{}').fetch).checkout({
        workspaceId: 'w',
        userId: 'u',
        email: 'e@example.com',
        planId: 'pro',
        interval: 'month',
        priceId: 'prod_1',
        quantity: 1,
        customerId: null,
        successUrl: 'https://hub.example/ok',
        cancelUrl: 'https://hub.example/no',
      }),
    );
    expect(noLink.status).toBe(502);
    const ref = { externalId: 'sub_c', customerId: 'cust_1' };
    const list = await rejection(
      make(
        answering(400, JSON.stringify({ error: 'Bad Request', message: ['units too big', 'nope'] })).fetch,
      ).changeSubscription(ref, { priceId: 'p', quantity: 1 }),
    );
    expect(list.message).toBe(
      'Creem POST /subscriptions/sub_c/upgrade failed (400) Bad Request: units too big; nope',
    );
    const single = await rejection(
      make(answering(404, JSON.stringify({ message: 'Not found' })).fetch).setCancelAtPeriodEnd(ref, true),
    );
    expect(single.message).toBe('Creem POST /subscriptions/sub_c/cancel failed (404) : Not found');
    const bare = await rejection(
      make(answering(500, JSON.stringify({ ok: 0 })).fetch).setCancelAtPeriodEnd(ref, false),
    );
    expect(bare.message).toContain('{"ok":0}');
    const text = await rejection(make(answering(503, 'maintenance').fetch).setCancelAtPeriodEnd(ref, false));
    expect(text.message).toBe('Creem POST /subscriptions/sub_c/resume failed (503) maintenance');
  });
});

describe('test provider edges', () => {
  const make = () => new TestBillingProvider({ publicUrl: 'https://hub.example', now: () => NOW });

  it('rejects tampered checkout and portal links and unsigned webhooks', async () => {
    const provider = make();
    const { url } = await provider.checkout({
      workspaceId: 'wsp_1',
      userId: 'usr_1',
      email: 'a@example.com',
      planId: 'pro',
      interval: 'year',
      priceId: 'price_pro_year',
      quantity: 1,
      customerId: null,
      successUrl: 'https://hub.example/ok',
      cancelUrl: 'https://hub.example/no',
    });
    const token = new URL(url).searchParams.get('t')!;
    expect(provider.readCheckout(token)).toMatchObject({ workspaceId: 'wsp_1', interval: 'year' });
    expect(provider.readCheckout(`${token}0`)).toBeUndefined();
    expect(provider.readCheckout('nodot')).toBeUndefined();
    expect(await provider.completeCheckout('x.y')).toBeUndefined();
    expect(provider.readPortal('x.y')).toBeUndefined();
    expect(await provider.parseWebhook({ body: '{}', headers: new Headers() })).toEqual({
      ok: false,
      reason: 'signature mismatch',
    });
    // Not connected to a hub: paying cannot deliver its webhook.
    await expect(provider.completeCheckout(token)).rejects.toThrow('not connected');
    await expect(
      provider.changeSubscription(
        { externalId: 'sub_gone', customerId: null },
        { priceId: 'p', quantity: 1 },
      ),
    ).rejects.toThrow('Unknown test subscription');
    await expect(provider.simulate('sub_gone', 'renew')).resolves.toBeUndefined();
  });
});

describe('createBillingProvider', () => {
  const base = { prices: new Map() } as unknown as BillingConfig;
  const fetch = (async () => new Response('{}')) as typeof globalThis.fetch;

  it('builds the configured provider, with or without an injected fetch', () => {
    const paddle = { apiKey: 'k', clientToken: 't', webhookSecret: 's', sandbox: true };
    const creem = { apiKey: 'creem_test_x', webhookSecret: 's' };
    const stripe = { secretKey: 'sk_test_x', webhookSecret: 's' };
    for (const opts of [{ publicUrl: 'https://hub.example' }, { publicUrl: 'https://hub.example', fetch }]) {
      expect(createBillingProvider({ ...base, provider: 'paddle', paddle } as BillingConfig, opts)?.id).toBe(
        'paddle',
      );
      expect(createBillingProvider({ ...base, provider: 'creem', creem } as BillingConfig, opts)?.id).toBe(
        'creem',
      );
      expect(createBillingProvider({ ...base, provider: 'stripe', stripe } as BillingConfig, opts)?.id).toBe(
        'stripe',
      );
    }
    expect(
      createBillingProvider({ ...base, provider: 'test' } as BillingConfig, { publicUrl: 'x' })?.id,
    ).toBe('test');
    expect(createBillingProvider(base, { publicUrl: 'x' })).toBeUndefined();
  });
});
