import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingProviderError, type SubscriptionChange } from '../src/billing/provider.js';
import { BillingService } from '../src/billing/service.js';
import { createUser } from '../src/core/identity.js';
import { billingEvents } from '../src/db/schema.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

/**
 * Branches of `BillingService` that the checkout flow in billing.e2e.test.ts does not reach:
 * events about an old subscription arriving after a new one, special plans, failed events being
 * retried, listeners that throw, and how provider failures are shown to the user.
 */
describe('billing service: webhook decisions and provider failures', () => {
  let hub: TestHub;
  let workspaceId: string;
  let userId: string;
  let email: string;
  let seq = 0;

  const billing = () => hub.services.billing;
  const plan = async () => (await hub.services.entitlements.entitlements(workspaceId)).plan.id;

  const change = (overrides: Partial<SubscriptionChange> = {}): SubscriptionChange => ({
    eventId: `evt_${++seq}`,
    type: 'subscription.updated',
    occurredAt: new Date(Date.now() + seq * 1000),
    workspaceId,
    externalId: 'sub_current',
    customerId: 'cus_1',
    priceId: 'test_pro_month',
    quantity: 1,
    interval: 'month',
    status: 'active',
    periodEnd: new Date(Date.now() + 30 * 86_400_000),
    cancelAtPeriodEnd: false,
    ...overrides,
  });

  const checkout = (planId: string, interval: 'month' | 'year' = 'month') =>
    billing().checkout({
      workspaceId,
      userId,
      email,
      planId,
      interval,
      successUrl: `${hub.baseUrl}/ok`,
      cancelUrl: `${hub.baseUrl}/cancel`,
    });

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ seed: false, env: { BILLING_PROVIDER: 'test' } });
    const created = await createUser(hub.services.db, { email: 'payer@example.com' });
    workspaceId = created.workspace.id;
    userId = created.user.id;
    email = created.user.email;
  });

  beforeEach(async () => {
    await hub.services.db.delete(billingEvents);
    await hub.services.entitlements.setPlan(workspaceId, 'free');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('maps provider prices back to plans', () => {
    expect(billing().planForPrice('test_pro_year')).toEqual({ planId: 'pro', interval: 'year' });
    expect(billing().planForPrice('price_unknown')).toBeUndefined();
    expect(billing().planForPrice(null)).toBeUndefined();
  });

  it('does not let the end of an old subscription cancel the one that replaced it', async () => {
    expect(await billing().apply('test', change({ externalId: 'sub_new' }))).toBe('applied');
    expect(await plan()).toBe('pro');

    const oldEnded = change({ externalId: 'sub_old', status: 'canceled', priceId: 'test_personal_month' });
    expect(await billing().apply('test', oldEnded)).toBe('ignored');
    expect(await plan()).toBe('pro');
    const [event] = await billing().recentEvents({ workspaceId });
    expect(event).toMatchObject({ eventId: oldEnded.eventId, detail: 'another subscription is active' });
  });

  it('keeps the last plan in the row when a subscription ends without a price', async () => {
    expect(await billing().apply('test', change({ externalId: 'sub_end' }))).toBe('applied');
    const ended = change({ externalId: 'sub_end', status: 'canceled', priceId: null, quantity: null });
    expect(await billing().apply('test', ended)).toBe('applied');
    const sub = (await hub.services.entitlements.subscription(workspaceId))!;
    expect(sub).toMatchObject({ planId: 'pro', status: 'canceled', interval: 'month', quantity: 1 });
    // The ended subscription no longer gives the plan.
    expect(await plan()).not.toBe('pro');

    // A live event with a price nobody configured is recorded and ignored.
    const stray = change({ externalId: 'sub_stray', priceId: 'price_from_elsewhere' });
    expect(await billing().apply('test', stray)).toBe('ignored');
    expect((await billing().recentEvents({ workspaceId }))[0]!.detail).toBe(
      'unknown price price_from_elsewhere',
    );
  });

  it('never replaces a special plan set by an admin with a provider event', async () => {
    await hub.services.entitlements.setPlan(workspaceId, 'unlimited');
    expect(await billing().apply('test', change({ externalId: 'sub_other' }))).toBe('ignored');
    expect(await plan()).toBe('unlimited');
    await expect(checkout('pro')).rejects.toMatchObject({ code: 'special_plan', status: 409 });
  });

  it('retries a failed event on the next delivery and skips it once applied', async () => {
    const event = change({ externalId: 'sub_retry' });
    const setPlan = vi
      .spyOn(hub.services.entitlements, 'setPlan')
      .mockRejectedValueOnce(new Error('database went away'));
    expect(await billing().apply('test', event)).toBe('failed');
    expect((await billing().recentEvents({ workspaceId: undefined }))[0]).toMatchObject({
      eventId: event.eventId,
      outcome: 'failed',
      detail: 'database went away',
    });
    expect(await billing().apply('test', event)).toBe('applied');
    expect(await billing().apply('test', event)).toBe('duplicate');
    expect(setPlan).toHaveBeenCalledTimes(2);
    expect(await plan()).toBe('pro');
  });

  it('applies the plan change even when a listener throws', async () => {
    const seen: string[] = [];
    billing().listen({
      subscriptionChanged: async () => {
        throw new Error('listener bug');
      },
    });
    billing().listen({
      subscriptionChanged: async ({ after }) => {
        seen.push(after.planId);
      },
    });
    expect(
      await billing().apply('test', change({ externalId: 'sub_listen', priceId: 'test_personal_month' })),
    ).toBe('applied');
    expect(await plan()).toBe('personal');
    expect(seen).toEqual(['personal']);
  });

  it('answers webhooks for another provider with 404 and a failed event with 500', async () => {
    expect(await billing().handleWebhook('paddle', '{}', new Headers())).toBe(404);
    const provider = billing().provider!;
    vi.spyOn(provider, 'parseWebhook').mockResolvedValue({
      ok: true,
      changes: [change({ externalId: 'sub_hook' })],
    });
    vi.spyOn(hub.services.entitlements, 'setPlan').mockRejectedValueOnce(new Error('boom'));
    expect(await billing().handleWebhook('test', '{}', new Headers())).toBe(500);
  });

  it('refuses to buy the same plan again or over a subscription from another provider', async () => {
    expect(await billing().apply('test', change({ externalId: 'sub_same' }))).toBe('applied');
    await expect(checkout('pro')).rejects.toMatchObject({ code: 'same_plan', status: 409 });
    await expect(checkout('nonexistent')).rejects.toMatchObject({ code: 'unknown_plan' });

    await hub.services.entitlements.setPlan(workspaceId, 'pro', {
      provider: 'paddle',
      externalId: 'sub_paddle',
      customerId: 'ctm_1',
      status: 'active',
      periodEnd: new Date(Date.now() + 86_400_000),
      interval: 'month',
      cancelAtPeriodEnd: false,
      providerUpdatedAt: new Date(),
      quantity: 1,
    });
    expect(BillingService.isPaidByProvider(await hub.services.entitlements.subscription(workspaceId))).toBe(
      true,
    );
    await expect(checkout('personal')).rejects.toMatchObject({ code: 'other_provider', status: 409 });
    // Managing it goes through the provider that charges it, not the active one.
    await expect(billing().portal(workspaceId, hub.baseUrl)).rejects.toMatchObject({
      code: 'no_subscription',
    });
    await expect(billing().setCancelAtPeriodEnd(workspaceId, true)).rejects.toMatchObject({
      code: 'no_subscription',
    });
  });

  it('shows provider failures as a plain message and keeps the plan', async () => {
    expect(await billing().apply('test', change({ externalId: 'sub_fail' }))).toBe('applied');
    const provider = billing().provider!;
    const changeSub = vi.spyOn(provider, 'changeSubscription');

    changeSub.mockRejectedValueOnce(new BillingProviderError('price is archived', 422));
    await expect(checkout('personal')).rejects.toMatchObject({ code: 'provider_refused', status: 502 });
    // A bad key (401) and server errors are "not responding", never "refused": the user cannot fix them.
    changeSub.mockRejectedValueOnce(new BillingProviderError('bad api key', 401));
    await expect(checkout('personal')).rejects.toMatchObject({ code: 'provider_unavailable' });
    changeSub.mockRejectedValueOnce(new Error('socket hang up'));
    const error = await checkout('personal').catch((e: Error) => e);
    expect(error).toMatchObject({ code: 'provider_unavailable' });
    expect((error as Error).message).not.toContain('socket');
    expect(await plan()).toBe('pro');
  });
});
