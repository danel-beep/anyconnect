import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestBillingProvider } from '../src/billing/providers/test.js';
import { REFERRAL_PROVIDER } from '../src/billing/referrals.js';
import { createUser } from '../src/core/identity.js';
import { referrals, users } from '../src/db/schema.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

/**
 * What an inviter gets when an invited user starts paying, by the inviter's own plan: Free gets a
 * month of Pro and every further invite adds a month (docs/BILLING.md: rewards stack), a smaller
 * paid plan gets Pro limits on top for a month, Pro and above get nothing (recorded for the admin).
 */
describe('invite rewards', () => {
  let hub: TestHub;
  const mailer = new MemoryMailer();
  let seq = 0;
  const s = () => hub.services;
  const DAY = 86_400_000;

  const person = () => createUser(s().db, { email: `user${++seq}@example.com` });
  const buy = async (user: { id: string; email: string }, workspaceId: string, planId = 'personal') => {
    const outcome = await s().billing.checkout({
      workspaceId,
      userId: user.id,
      email: user.email,
      planId,
      interval: 'month',
      successUrl: `${hub.baseUrl}/app/billing?paid=1`,
      cancelUrl: `${hub.baseUrl}/app/billing`,
    });
    if (outcome.kind !== 'redirect') throw new Error('expected a checkout');
    await (s().billing.provider as TestBillingProvider).completeCheckout(
      new URL(outcome.url).searchParams.get('t')!,
    );
  };
  /** A friend signs up with the inviter's link and starts paying. */
  const invitePaying = async (inviter: { id: string }) => {
    const friend = await person();
    expect(await s().referrals.attach(friend.user.id, await s().referrals.codeFor(inviter.id))).toBe(true);
    await buy(friend.user, friend.workspace.id);
    return friend;
  };
  const referralOf = async (userId: string) =>
    (await s().db.select().from(referrals).where(eq(referrals.referredUserId, userId)))[0]!;

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ env: { BILLING_PROVIDER: 'test' }, mailer, seed: false });
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('adds a month of Pro for each paying friend of a Free inviter', async () => {
    const inviter = await person();
    const first = await invitePaying(inviter.user);
    const gift = await s().entitlements.subscription(inviter.workspace.id);
    expect(gift).toMatchObject({ planId: 'pro', provider: REFERRAL_PROVIDER });
    const firstEnd = gift!.currentPeriodEnd!.getTime();
    expect(Math.round((firstEnd - Date.now()) / DAY)).toBe(30);

    const second = await invitePaying(inviter.user);
    const extended = await s().entitlements.subscription(inviter.workspace.id);
    expect(extended).toMatchObject({ planId: 'pro', provider: REFERRAL_PROVIDER });
    expect(extended!.currentPeriodEnd!.getTime() - firstEnd).toBe(30 * DAY);
    for (const friend of [first, second]) {
      expect(await referralOf(friend.user.id)).toMatchObject({ status: 'rewarded', reward: 'pro_plan' });
    }
    expect(await s().referrals.stats(inviter.user.id)).toMatchObject({ invited: 2, rewarded: 2 });
    expect(
      mailer.sent.filter((m) => m.to === inviter.user.email && m.tag === 'referral.reward'),
    ).toHaveLength(2);
  });

  it('gives Pro limits on top of a smaller paid plan, and nothing more on Pro', async () => {
    const personal = await person();
    await buy(personal.user, personal.workspace.id, 'personal');
    const friend = await invitePaying(personal.user);
    expect(await referralOf(friend.user.id)).toMatchObject({ status: 'rewarded', reward: 'pro_limits' });
    const grants = await s().entitlements.grants(personal.workspace.id, { activeOnly: true });
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((g) => g.reason === 'referral')).toBe(true);
    expect((await s().entitlements.subscription(personal.workspace.id))!.planId).toBe('personal');

    const pro = await person();
    await buy(pro.user, pro.workspace.id, 'pro');
    const proFriend = await invitePaying(pro.user);
    expect(await referralOf(proFriend.user.id)).toMatchObject({ status: 'no_reward', reward: 'already_pro' });
    expect(await s().entitlements.grants(pro.workspace.id, { activeOnly: true })).toEqual([]);
  });

  it('rewards once per friend, and only for a payment that went through', async () => {
    const inviter = await person();
    const friend = await person();
    await s().referrals.attach(friend.user.id, await s().referrals.codeFor(inviter.user.id));
    const after = { provider: 'test', externalId: 'sub_x', status: 'past_due' } as never;
    await s().referrals.subscriptionChanged({
      workspaceId: friend.workspace.id,
      before: undefined,
      after,
    } as never);
    expect(await referralOf(friend.user.id)).toMatchObject({ status: 'signed_up', reward: null });
    await buy(friend.user, friend.workspace.id);
    // A renewal is another "active" event for the same friend: no second reward.
    const sub = (await s().entitlements.subscription(friend.workspace.id))!;
    await (s().billing.provider as TestBillingProvider).simulate(sub.externalId!, 'renew');
    expect(await referralOf(friend.user.id)).toMatchObject({ status: 'rewarded' });
    expect(
      mailer.sent.filter((m) => m.to === inviter.user.email && m.tag === 'referral.reward'),
    ).toHaveLength(1);
  });

  it('ignores malformed codes and inviters who are no longer active', async () => {
    const inviter = await person();
    const friend = await person();
    const code = await s().referrals.codeFor(inviter.user.id);
    expect(await s().referrals.attach(friend.user.id, 'bad code!')).toBe(false);
    await s().db.update(users).set({ status: 'suspended' }).where(eq(users.id, inviter.user.id));
    expect(await s().referrals.attach(friend.user.id, code)).toBe(false);
    expect(s().referrals.linkFor(code)).toBe(`${hub.baseUrl}/?ref=${code}`);
    expect(await s().referrals.stats(friend.user.id)).toMatchObject({ invited: 0, rewarded: 0 });
  });
});
