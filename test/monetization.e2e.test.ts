import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RevenueReport } from '../src/admin/revenue.js';
import type { TestBillingProvider } from '../src/billing/providers/test.js';
import { REFERRAL_PROVIDER } from '../src/billing/referrals.js';
import { createUser } from '../src/core/identity.js';
import type { Principal } from '../src/core/principal.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

const json = (result: { structuredContent?: unknown; content: unknown[] }): any =>
  result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text);

/** Billing emails, the near-limit hint, invites and the revenue report, with the test provider. */
describe('monetization', () => {
  let hub: TestHub;
  const mailer = new MemoryMailer();
  let admin: { userId: string; workspaceId: string; principal: Principal };

  const s = () => hub.services;
  const age = (workspaceId: string, days: number) =>
    s().database.pool.query(
      `UPDATE workspaces SET created_at = now() - make_interval(days => $2) WHERE id = $1`,
      [workspaceId, days],
    );
  const useActions = (workspaceId: string, n: number) =>
    s().database.pool.query(
      `INSERT INTO usage_counters (workspace_id, day, caller, connector_id, action, calls)
       VALUES ($1, $2, 'seed', 'demo', 'echo', $3)
       ON CONFLICT DO NOTHING`,
      [workspaceId, new Date().toISOString().slice(0, 10), n],
    );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const catalog = await s().hub.getCatalog(admin.principal);
    return s().hub.callTool(admin.principal, catalog, name, args);
  };
  const mailTo = (email: string, tag: string) => mailer.sent.filter((m) => m.to === email && m.tag === tag);
  /** Lets fire-and-forget notices finish. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  /** Buys a plan for a workspace through the test provider (checkout + webhook). */
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
    const token = new URL(outcome.url).searchParams.get('t')!;
    await (s().billing.provider as TestBillingProvider).completeCheckout(token);
  };

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ env: { BILLING_PROVIDER: 'test' }, mailer });
    const user = (await s().db.query.users.findFirst())!;
    const workspaceId = (await s().db.query.workspaces.findFirst())!.id;
    admin = {
      userId: user.id,
      workspaceId,
      principal: { kind: 'api_token', userId: user.id, workspaceId, scopes: ['mcp'] },
    };
  });

  beforeEach(async () => {
    mailer.sent.length = 0;
    await s().database.pool.query('DELETE FROM usage_counters');
    await s().entitlements.setPlan(admin.workspaceId, 'free');
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('hints the AI once at 80% of the monthly actions, then emails once when the limit is reached', async () => {
    await age(admin.workspaceId, 90); // past the trial and the steps: 150 actions
    await useActions(admin.workspaceId, 119);
    const first = await call('demo_echo', { account: 'main', message: 'hi' });
    expect(first.isError).toBeFalsy();
    expect(first.content.at(-1)).toMatchObject({ type: 'text' });
    expect((first.content.at(-1) as { text: string }).text).toMatch(/used 120 of 150 actions/);
    const second = await call('demo_echo', { account: 'main', message: 'hi' });
    expect(JSON.stringify(second.content)).not.toContain('Manyplug note');

    await useActions(admin.workspaceId, 0);
    await s().database.pool.query(`UPDATE usage_counters SET calls = 150 WHERE caller = 'seed'`);
    // The usage cache keeps a snapshot for a few seconds: start from a fresh plan row.
    await s().entitlements.setPlan(admin.workspaceId, 'free');
    const refused = await call('demo_echo', { account: 'main', message: 'hi' });
    expect(refused.isError).toBe(true);
    await call('demo_echo', { account: 'main', message: 'again' });
    await settle();
    const mails = mailTo('owner@example.com', 'billing.limit_reached');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain('150');
    expect(mails[0]!.html).toContain('/app/billing');
  });

  it('reminds once when the Pro trial ends within three days', async () => {
    await age(admin.workspaceId, 12);
    expect(await s().billingNotices.remindTrialEnding()).toBe(1);
    expect(await s().billingNotices.remindTrialEnding()).toBe(0);
    const [mail] = mailTo('owner@example.com', 'billing.trial_ending');
    expect(mail!.subject).toMatch(/ends in 2 days/);
    expect(mail!.text).toContain('500 actions a month');
    await age(admin.workspaceId, 5);
    expect(await s().billingNotices.remindTrialEnding()).toBe(0);
  });

  it('gives the inviter a month of Pro when the invited user pays, and emails a failed payment once', async () => {
    const { user: inviter, workspace: inviterWs } = await createUser(s().db, { email: 'ann@example.com' });
    const { user: friend, workspace: friendWs } = await createUser(s().db, {
      email: 'bob@example.com',
      name: 'Bob Stone',
    });
    await s().database.pool.query(`UPDATE users SET locale = 'ru' WHERE id = $1`, [friend.id]);
    const code = await s().referrals.codeFor(inviter.id);
    expect(await s().referrals.codeFor(inviter.id)).toBe(code);

    // The link sets a cookie on any page; the sign-up then records the invite.
    const visit = await fetch(`${hub.baseUrl}/?ref=${code}`, { redirect: 'manual' });
    expect(visit.headers.get('set-cookie')).toMatch(new RegExp(`mp_ref=${code}`));
    expect(await s().referrals.attach(inviter.id, code)).toBe(false); // not yourself
    expect(await s().referrals.attach(friend.id, 'nosuchcode')).toBe(false);
    expect(await s().referrals.attach(friend.id, code)).toBe(true);
    expect(await s().referrals.attach(friend.id, code)).toBe(false);
    expect((await s().referrals.stats(inviter.id)).invited).toBe(1);

    await buy(friend, friendWs.id);
    const reward = await s().entitlements.subscription(inviterWs.id);
    expect(reward).toMatchObject({ planId: 'pro', provider: REFERRAL_PROVIDER });
    const days = (reward!.currentPeriodEnd!.getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
    expect((await s().entitlements.entitlements(inviterWs.id)).plan.id).toBe('pro');
    expect(mailTo('ann@example.com', 'referral.reward')).toHaveLength(1);
    expect((await s().referrals.stats(inviter.id)).rewarded).toBe(1);

    // A gift can still be bought: checkout is open for Pro.
    await expect(
      s().billing.checkout({
        workspaceId: inviterWs.id,
        userId: inviter.id,
        email: inviter.email,
        planId: 'pro',
        interval: 'month',
        successUrl: hub.baseUrl,
        cancelUrl: hub.baseUrl,
      }),
    ).resolves.toMatchObject({ kind: 'redirect' });

    // The friend's renewal fails: one email in Russian, no repeat on the retry.
    const sub = (await s().entitlements.subscription(friendWs.id))!;
    const provider = s().billing.provider as TestBillingProvider;
    await provider.simulate(sub.externalId!, 'fail');
    await provider.simulate(sub.externalId!, 'fail');
    const failed = mailTo('bob@example.com', 'billing.payment_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.subject).toBe('Оплата Manyplug не прошла');
    expect(failed[0]!.text).toContain('Здравствуйте Bob!');
    expect(failed[0]!.text).toContain('«Личный»');

    const report = await new RevenueReport(s().db).build();
    expect(report).toMatchObject({ paying: 1, mrr: 0, atRisk: 5, gifted: 1 });
    expect(report.referrals).toMatchObject({ invited: 1, rewarded: 1 });
  });

  it('shows the invite link to the AI', async () => {
    const result = json(await call('manyplug_invite'));
    expect(result.link).toMatch(new RegExp(`^${hub.baseUrl}/\\?ref=[a-z0-9]{8}$`));
    expect(result.joined).toBe(0);
  });
});
