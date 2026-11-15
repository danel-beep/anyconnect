import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../src/core/identity.js';
import type { Principal } from '../src/core/principal.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

/**
 * Plans and limit grants refused or undone, and the free allowance that belongs to the person at
 * the AI provider: several hub sign-ups used from one ChatGPT account share it.
 */
describe('entitlement edges', () => {
  let hub: TestHub;
  let seq = 0;
  const s = () => hub.services;
  const day = () => new Date().toISOString().slice(0, 10);
  const failure = (fn: () => Promise<unknown>) =>
    fn().then(
      () => 'resolved',
      (e: { code?: string }) => e.code,
    );

  /** A workspace past its trial, so the plain Free limits apply. */
  const freeWorkspace = async () => {
    const { user, workspace } = await createUser(s().db, { email: `free${++seq}@example.com` });
    await s().database.pool.query(
      `UPDATE workspaces SET created_at = now() - interval '90 days' WHERE id = $1`,
      [workspace.id],
    );
    await s().entitlements.setPlan(workspace.id, 'free');
    return { user, workspace };
  };

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ seed: false });
  });

  beforeEach(async () => {
    await s().database.pool.query('DELETE FROM usage_counters');
    await s().database.pool.query('DELETE FROM billing_usage');
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('refuses unknown plans and impossible quantities', async () => {
    const { workspace } = await freeWorkspace();
    expect(await failure(() => s().entitlements.setPlan(workspace.id, 'platinum'))).toBe('unknown_plan');
    for (const quantity of [0, 1.5, 10_001]) {
      expect(await failure(() => s().entitlements.setPlan(workspace.id, 'personal', { quantity }))).toBe(
        'bad_quantity',
      );
    }
    await s().entitlements.ensurePlan(workspace.id, 'pro');
    expect((await s().entitlements.subscription(workspace.id))!.planId).toBe('free');
  });

  it('checks limit grants, lifts a limit with an empty amount and takes a grant back', async () => {
    const { workspace } = await freeWorkspace();
    const ent = s().entitlements;
    expect(await failure(() => ent.grant(workspace.id, { metric: 'bananas', amount: 1 }))).toBe(
      'unknown_limit',
    );
    for (const amount of [0, -5, 2.5, 2e9]) {
      expect(await failure(() => ent.grant(workspace.id, { metric: 'actions', amount }))).toBe('bad_amount');
    }
    expect(
      await failure(() =>
        ent.grant(workspace.id, { metric: 'actions', amount: 10, expiresAt: new Date(Date.now() - 1000) }),
      ),
    ).toBe('past_date');

    const before = (await ent.entitlements(workspace.id)).limits.actions!;
    const extra = await ent.grant(workspace.id, { metric: 'actions', amount: 100, reason: 'x'.repeat(600) });
    expect(extra.reason).toHaveLength(500);
    expect((await ent.entitlements(workspace.id)).limits.actions).toBe(before + 100);
    const lifted = await ent.grant(workspace.id, { metric: 'actions', amount: null });
    expect((await ent.entitlements(workspace.id)).limits.actions).toBeNull();

    await ent.revokeGrant(workspace.id, lifted.id);
    expect(await failure(() => ent.revokeGrant(workspace.id, lifted.id))).toBe('not_found');
    expect(await failure(() => ent.revokeGrant('wsp_other', extra.id))).toBe('not_found');
    expect((await ent.grants(workspace.id, { activeOnly: true })).map((g) => g.id)).toEqual([extra.id]);
    expect((await ent.grants(workspace.id)).map((g) => g.id).sort()).toEqual([extra.id, lifted.id].sort());
  });

  it('shares the free allowance of one AI account across hub sign-ups', async () => {
    const first = await freeWorkspace();
    const second = await freeWorkspace();
    const limit = (await s().entitlements.entitlements(second.workspace.id)).limits.actions!;
    const subject = 'openai:abcdef123456';
    // The same ChatGPT user used up the free actions from another hub account.
    await s().database.pool.query(
      `INSERT INTO usage_counters (workspace_id, day, caller, connector_id, action, calls)
       VALUES ($1, $2, $3, 'demo', 'echo', $4)`,
      [first.workspace.id, day(), subject, limit],
    );
    const caller = (workspaceId: string, userId: string, aiSubject?: string): Principal => ({
      kind: 'oauth',
      userId,
      workspaceId,
      scopes: ['mcp'],
      credentialId: `grt_${workspaceId}`,
      ...(aiSubject ? { aiSubject } : {}),
    });
    const refused = await s().entitlements.checkAction(caller(second.workspace.id, second.user.id, subject));
    expect(refused).toMatchObject({ allowed: false });
    expect((refused as { message: string }).message).toContain('the free plan');
    // Without a provider account the hub cannot tell: the workspace's own count decides.
    expect(await s().entitlements.checkAction(caller(second.workspace.id, second.user.id))).toMatchObject({
      allowed: true,
    });
    // A paid plan has no shared free allowance.
    await s().entitlements.setPlan(second.workspace.id, 'personal');
    expect(
      await s().entitlements.checkAction(caller(second.workspace.id, second.user.id, subject)),
    ).toMatchObject({ allowed: true });
  });
});
