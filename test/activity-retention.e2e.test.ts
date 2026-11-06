import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { smallestLimit } from '../src/billing/plans.js';
import { createUser } from '../src/core/identity.js';
import { toolCalls, workspaces } from '../src/db/schema.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

const DAY = 86_400_000;

/**
 * The activity log is kept as long as the plan says (`historyDays`: Free 7, Personal 90, Pro 365),
 * a team's as long as its payer's plan. The privacy policy and the pricing page promise this.
 */
describe('activity log retention follows the plan', () => {
  let hub: TestHub;

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ seed: false });
  });

  afterAll(async () => {
    await hub?.close();
  });

  /** A person whose sign-up was `ageDays` ago (past the trial unless it is recent). */
  async function person(email: string, ageDays: number) {
    const { user, workspace } = await createUser(hub.services.db, { email, name: email });
    await hub.services.db
      .update(workspaces)
      .set({ createdAt: new Date(Date.now() - ageDays * DAY) })
      .where(eq(workspaces.id, workspace.id));
    return { user, workspaceId: workspace.id };
  }

  /** Log entries made `days` ago in a workspace. */
  async function logged(workspaceId: string, ...days: number[]) {
    await hub.services.db.insert(toolCalls).values(
      days.map((d) => ({
        workspaceId,
        toolName: `call_${d}d`,
        principalType: 'session' as const,
        status: 'ok' as const,
        durationMs: 1,
        createdAt: new Date(Date.now() - d * DAY),
      })),
    );
  }

  const kept = async (workspaceId: string) =>
    (
      await hub.services.db
        .select({ tool: toolCalls.toolName })
        .from(toolCalls)
        .where(eq(toolCalls.workspaceId, workspaceId))
    )
      .map((r) => r.tool)
      .sort();

  it('deletes entries past each plan’s history and keeps the rest', async () => {
    const { entitlements, activity, teams } = hub.services;
    const free = await person('free@example.com', 100);
    const trial = await person('trial@example.com', 3);
    const personal = await person('personal@example.com', 100);
    const pro = await person('pro@example.com', 400);
    await entitlements.setPlan(personal.workspaceId, 'personal');
    await entitlements.setPlan(pro.workspaceId, 'pro');
    // A team runs on its owner's plan (Pro here).
    const team = await teams.create({ id: pro.user.id, name: 'Pro', email: 'pro@example.com' }, 'Studio');

    await logged(free.workspaceId, 1, 6, 8, 30);
    await logged(trial.workspaceId, 1, 2);
    await logged(personal.workspaceId, 6, 8, 89, 91, 200);
    await logged(pro.workspaceId, 8, 91, 364, 366);
    await logged(team.id, 8, 91, 366);

    expect(entitlements.minimumHistoryDays).toBe(smallestLimit('historyDays'));
    expect(await entitlements.historyDays(free.workspaceId)).toBe(7);
    expect(await entitlements.historyDays(trial.workspaceId)).toBe(365); // the Pro trial
    expect(await entitlements.historyDays(team.id)).toBe(365);

    const { workspaces: pruned } = await activity.prune(entitlements);
    expect(pruned).toBe(4); // the trial has nothing older than the shortest history

    expect(await kept(free.workspaceId)).toEqual(['call_1d', 'call_6d']);
    expect(await kept(trial.workspaceId)).toEqual(['call_1d', 'call_2d']);
    expect(await kept(personal.workspaceId)).toEqual(['call_6d', 'call_89d', 'call_8d']);
    expect(await kept(pro.workspaceId)).toEqual(['call_364d', 'call_8d', 'call_91d']);
    expect(await kept(team.id)).toEqual(['call_8d', 'call_91d']);
  });

  it('keeps going when one workspace fails and reports the failure', async () => {
    const { activity } = hub.services;
    const a = await person('a@example.com', 100);
    const b = await person('b@example.com', 100);
    await logged(a.workspaceId, 30);
    await logged(b.workspaceId, 30);
    const retention = {
      minimumHistoryDays: 7,
      historyDays: async (id: string) => {
        if (id === a.workspaceId) throw new Error('lookup failed');
        return 7;
      },
    };
    await expect(activity.prune(retention)).rejects.toThrow(/1 workspace/);
    expect(await kept(a.workspaceId)).toEqual(['call_30d']);
    expect(await kept(b.workspaceId)).toEqual([]);
  });
});
