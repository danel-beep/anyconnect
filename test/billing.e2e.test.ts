import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPlan } from '../src/billing/plans.js';
import { PaddleProvider } from '../src/billing/providers/paddle.js';
import { hmacHex } from '../src/billing/providers/signature.js';
import type { Principal } from '../src/core/principal.js';
import { billingEvents } from '../src/db/schema.js';
import type { ToolCallResult } from '../src/hub/result.js';
import { resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

const json = (result: ToolCallResult): any =>
  result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text);

/** The whole payment flow with the built-in test provider: no keys, same webhook path as Paddle/Stripe. */
describe('payments with the test provider', () => {
  let hub: TestHub;
  let browser: TestBrowser;
  let workspaceId: string;
  let principal: Principal;

  const plan = async () => (await hub.services.entitlements.entitlements(workspaceId)).plan.id;
  const sub = async () => (await hub.services.entitlements.subscription(workspaceId))!;
  const csrf = async () =>
    TestBrowser.hiddenInputs(await (await browser.request('/app/billing')).text()).csrf!;
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const catalog = await hub.services.hub.getCatalog(principal);
    return hub.services.hub.callTool(principal, catalog, name, args);
  };

  /** Buys a plan through the dashboard and the test checkout page. */
  const buy = async (planId: string, interval: 'month' | 'year' = 'month') => {
    const start = await browser.request('/app/billing/checkout', {
      form: { csrf: await csrf(), plan: planId, interval },
    });
    expect(start.status).toBe(303);
    const checkout = new URL(start.headers.get('location')!);
    expect(checkout.pathname).toBe('/billing/test/checkout');
    const page = await browser.request(checkout.pathname + checkout.search);
    const html = await page.text();
    expect(html).toContain('Тестовая оплата');
    const paid = await browser.request('/billing/test/checkout', { form: TestBrowser.hiddenInputs(html) });
    expect(paid.headers.get('location')).toContain('/app/billing?paid=1');
  };

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({
      seed: false,
      env: { BILLING_PROVIDER: 'test', CONFIRMATION_WAIT_SECONDS: '0' },
    });
    const user = (await hub.services.db.query.users.findFirst())!;
    workspaceId = (await hub.services.db.query.workspaces.findFirst())!.id;
    principal = { kind: 'api_token', userId: user.id, workspaceId, scopes: ['mcp'] };
    browser = new TestBrowser(hub.baseUrl);
    expect((await browser.login()).status).toBe(303);
  });

  beforeEach(async () => {
    // The owner starts on the unlimited plan; the tests buy as a regular free user.
    await hub.services.db.delete(billingEvents);
    await hub.services.entitlements.setPlan(workspaceId, 'free');
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('buys a plan: checkout, webhook, plan and limits switch', async () => {
    await buy('personal');
    expect(await plan()).toBe('personal');
    const row = await sub();
    expect(row).toMatchObject({
      provider: 'test',
      status: 'active',
      interval: 'month',
      cancelAtPeriodEnd: false,
    });
    expect(row.externalId).toMatch(/^sub_test_/);
    expect((await hub.services.entitlements.entitlements(workspaceId)).limits.actions).toBe(10_000);
    const page = await (await browser.request('/app/billing?paid=1')).text();
    expect(page).toContain('Спасибо! Теперь у вас тариф «Личный»');
    expect(page).toContain('Тестовый режим');
    expect(page).toContain('Управление оплатой и счета');
  });

  it('switches a paid plan without a second checkout, and cancels at the period end', async () => {
    await buy('personal');
    const change = await browser.request('/app/billing/checkout', {
      form: { csrf: await csrf(), plan: 'pro', interval: 'year' },
    });
    expect(change.headers.get('location')).toBe('/app/billing');
    expect(await plan()).toBe('pro');
    expect((await sub()).interval).toBe('year');

    await browser.request('/app/billing/cancel', { form: { csrf: await csrf() } });
    expect((await sub()).cancelAtPeriodEnd).toBe(true);
    expect(await plan()).toBe('pro');
    expect(await (await browser.request('/app/billing')).text()).toContain('Подписка отменена');
    await browser.request('/app/billing/cancel', { form: { csrf: await csrf(), undo: '1' } });
    expect((await sub()).cancelAtPeriodEnd).toBe(false);
  });

  it('moves to free when the subscription ends, through the provider portal', async () => {
    await buy('pro');
    const portal = await browser.request('/app/billing/portal', { form: { csrf: await csrf() } });
    const url = new URL(portal.headers.get('location')!);
    expect(url.pathname).toBe('/billing/test/portal');
    const html = await (await browser.request(url.pathname + url.search)).text();
    const token = TestBrowser.hiddenInputs(html).t!;
    const fail = await browser.request('/billing/test/portal', {
      form: { csrf: TestBrowser.hiddenInputs(html).csrf!, t: token, what: 'fail' },
    });
    expect(fail.status).toBe(303);
    expect((await sub()).status).toBe('past_due');
    expect(await plan()).toBe('pro');
    expect(await (await browser.request('/app/billing')).text()).toContain('Последний платёж не прошёл');
    await browser.request('/billing/test/portal', {
      form: { csrf: TestBrowser.hiddenInputs(html).csrf!, t: token, what: 'end' },
    });
    expect((await sub()).status).toBe('canceled');
    expect(await plan()).toBe('free');
    // A new purchase starts a new checkout and keeps the customer.
    const customer = (await sub()).customerId;
    await buy('personal');
    expect((await sub()).customerId).toBe(customer);
  });

  it('applies each webhook event once and ignores stale ones', async () => {
    const billing = hub.services.billing;
    await buy('personal');
    const row = await sub();
    const base = {
      workspaceId,
      externalId: row.externalId!,
      customerId: row.customerId,
      priceId: 'test_business_month',
      interval: 'month' as const,
      status: 'active' as const,
      periodEnd: new Date(Date.now() + 86_400_000),
      cancelAtPeriodEnd: false,
    };
    const newer = {
      ...base,
      eventId: 'evt_new',
      type: 'subscription.updated',
      occurredAt: new Date(Date.now() + 60_000),
    };
    expect(await billing.apply('test', newer)).toBe('applied');
    expect(await billing.apply('test', newer)).toBe('duplicate');
    const older = {
      ...base,
      priceId: 'test_pro_month',
      eventId: 'evt_old',
      type: 'subscription.updated',
      occurredAt: new Date(Date.now() - 60_000),
    };
    expect(await billing.apply('test', older)).toBe('ignored');
    expect(await plan()).toBe('business');
    const unknown = {
      ...base,
      workspaceId: undefined,
      externalId: 'sub_elsewhere',
      eventId: 'evt_x',
      type: 'subscription.created',
      occurredAt: new Date(),
    };
    expect(await billing.apply('test', unknown)).toBe('ignored');
    const events = await billing.recentEvents({ limit: 50 });
    expect(events.find((e) => e.eventId === 'evt_old')).toMatchObject({
      outcome: 'ignored',
      detail: 'older than the current state',
    });
    expect(events.find((e) => e.eventId === 'evt_x')).toMatchObject({
      outcome: 'ignored',
      detail: 'unknown workspace',
    });
  });

  it('never lets an admin overwrite a paid plan, and the owner plan cannot be bought over', async () => {
    await buy('personal');
    const user = (await hub.services.db.query.users.findFirst())!;
    await expect(
      hub.services.adminPanel.setPlan({ userId: user.id, email: user.email }, user.id, {
        planId: 'business',
        periodEnd: null,
      }),
    ).rejects.toMatchObject({ code: 'paid_subscription' });

    await hub.services.entitlements.setPlan(workspaceId, 'unlimited');
    const refused = await browser.request('/app/billing/checkout', {
      form: { csrf: await csrf(), plan: 'pro', interval: 'month' },
    });
    expect(refused.headers.get('location')).toBe('/app/billing');
    expect(await (await browser.request('/app/billing')).text()).toContain('особый тариф');
    expect(await plan()).toBe('unlimited');
  });

  it('lets the AI assistant see the plan, get a buy link and cancel with confirmation', async () => {
    const status = json(await tool('manyplug_plan'));
    expect(status).toMatchObject({ plan: 'free', online_payment: true, test_mode: true });
    expect(status.plans.map((p: { id: string }) => p.id)).toEqual(['free', 'personal', 'pro', 'business']);

    const link = json(await tool('manyplug_buy_plan', { plan: 'pro', interval: 'year' }));
    expect(link.url).toBe(`${hub.baseUrl}/app/billing?plan=pro&interval=year`);
    const page = await (await browser.request('/app/billing?plan=pro&interval=year')).text();
    expect(page).toContain('Подключить тариф «Про»');
    expect(page).toContain('$120 в год');
    expect((await tool('manyplug_buy_plan', { plan: 'unlimited' })).isError).toBe(true);

    await buy('pro', 'year');
    expect(json(await tool('manyplug_plan')).subscription).toMatchObject({
      status: 'active',
      interval: 'year',
    });
    // Cancelling needs the user's confirmation: the call waits for it instead of running.
    const pending = await tool('manyplug_cancel_plan');
    expect(JSON.stringify(pending)).toMatch(/confirm/i);
    expect((await sub()).cancelAtPeriodEnd).toBe(false);
  });

  it('starts a new free workspace on a Pro trial, then steps down on the published dates', async () => {
    const ent = async () => hub.services.entitlements.entitlements(workspaceId);
    const pool = hub.services.database.pool;
    const age = (days: number) =>
      pool.query(`UPDATE workspaces SET created_at = now() - make_interval(days => $2) WHERE id = $1`, [
        workspaceId,
        days,
      ]);
    try {
      await age(2);
      expect((await ent()).phase?.kind).toBe('trial');
      expect((await ent()).limits.actions).toBe(getPlan('pro').limits.actions);
      const status = json(await tool('manyplug_plan'));
      expect(status.start.now).toBe('pro trial');
      expect(status.start.schedule.map((p: any) => p.actions_per_month)).toEqual([
        getPlan('pro').limits.actions,
        500,
        300,
      ]);
      expect(status.start.after_that.actions_per_month).toBe(150);
      expect(await (await browser.request('/app/billing')).text()).toContain('start-schedule');

      await age(20);
      expect((await ent()).limits.actions).toBe(500);
      await age(45);
      expect((await ent()).limits.actions).toBe(300);
      await age(90);
      const done = await ent();
      expect(done.phase).toBeUndefined();
      expect(done.limits.actions).toBe(150);
      expect(done.countFrom).toBe(done.period.start);
    } finally {
      await age(0);
    }
  });
});

/** Paddle's signed webhooks reach the plan through the HTTP route. */
describe('Paddle webhooks', () => {
  const secret = 'pdl_ntfset_e2e';
  let hub: TestHub;
  let workspaceId: string;

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({
      seed: false,
      env: {
        BILLING_PROVIDER: 'paddle',
        PADDLE_API_KEY: 'pdl_sdbx_x',
        PADDLE_CLIENT_TOKEN: 'test_client',
        PADDLE_WEBHOOK_SECRET: secret,
        PADDLE_PRICE_PRO_MONTH: 'pri_pro_m',
      },
    });
    workspaceId = (await hub.services.db.query.workspaces.findFirst())!.id;
    await hub.services.entitlements.setPlan(workspaceId, 'free');
  });

  afterAll(async () => {
    await hub?.close();
  });

  const post = (body: string, signature: string) =>
    fetch(`${hub.baseUrl}/billing/webhook/paddle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'paddle-signature': signature },
      body,
    });

  it('applies a signed subscription event and rejects forged ones', async () => {
    expect(hub.services.billing.provider).toBeInstanceOf(PaddleProvider);
    const body = JSON.stringify({
      event_id: 'evt_paddle_1',
      event_type: 'subscription.created',
      occurred_at: new Date().toISOString(),
      data: {
        id: 'sub_paddle_1',
        status: 'active',
        customer_id: 'ctm_1',
        custom_data: { workspace_id: workspaceId },
        items: [{ price: { id: 'pri_pro_m' } }],
        billing_cycle: { interval: 'month' },
        current_billing_period: { ends_at: new Date(Date.now() + 30 * 86_400_000).toISOString() },
        scheduled_change: null,
      },
    });
    const ts = Math.floor(Date.now() / 1000);
    expect((await post(body, `ts=${ts};h1=${'0'.repeat(64)}`)).status).toBe(400);
    expect((await hub.services.entitlements.entitlements(workspaceId)).plan.id).toBe('free');
    expect((await post(body, `ts=${ts};h1=${hmacHex(secret, `${ts}:${body}`)}`)).status).toBe(200);
    expect((await hub.services.entitlements.entitlements(workspaceId)).plan.id).toBe('pro');
    expect(await hub.services.entitlements.subscription(workspaceId)).toMatchObject({
      provider: 'paddle',
      externalId: 'sub_paddle_1',
      customerId: 'ctm_1',
    });
    // Another provider's route does not exist.
    expect(
      (await fetch(`${hub.baseUrl}/billing/webhook/stripe`, { method: 'POST', body: '{}' })).status,
    ).toBe(404);
  });

  it('serves the checkout page with a policy that allows only Paddle', async () => {
    const res = await fetch(`${hub.baseUrl}/billing/paddle/checkout?txn=txn_01abc&email=ann%40example.com`);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self' https://cdn.paddle.com");
    expect(csp).toContain('frame-src https://*.paddle.com');
    const html = await res.text();
    expect(html).toContain('data-txn="txn_01abc"');
    expect(html).toContain('data-sandbox="1"');
    expect(
      (await fetch(`${hub.baseUrl}/billing/paddle/checkout?txn=bad"`, { redirect: 'manual' })).status,
    ).toBe(302);
    // Other pages keep the strict policy.
    expect((await fetch(`${hub.baseUrl}/login`)).headers.get('content-security-policy')).toContain(
      "script-src 'self';",
    );
  });
});
