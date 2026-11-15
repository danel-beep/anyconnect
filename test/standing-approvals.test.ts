import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../src/core/principal.js';
import { standingApprovals } from '../src/db/schema.js';
import {
  approvalHolder,
  MAX_APPROVAL_MINUTES,
  MAX_APPROVAL_USES,
  StandingApprovals,
} from '../src/security/standing-approvals.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

/**
 * "Carry on this conversation" approvals: bounded in time and uses, held by one caller, used up
 * atomically, ended by the caller or from the panel, never held by a shared team connection.
 */
describe('standing approvals', () => {
  let hub: TestHub;
  let approvals: StandingApprovals;
  let workspaceId: string;
  let accountId: string;
  let claude: Principal;
  let chatgpt: Principal;

  const target = () => ({ connectorId: 'demo', accountId, grantedBy: 'pnd_1' });
  const covered = (action = 'send') => ({ connectorId: 'demo', accountId, action, scope: 'chat:1' });
  const spec = (extra: Record<string, unknown> = {}) => ({
    scope: 'chat:1',
    actions: ['send'],
    minutes: 60,
    maxUses: 2,
    ...extra,
  });

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ seed: false });
    approvals = new StandingApprovals(hub.services.db, hub.services.secrets);
    workspaceId = (await hub.services.db.query.workspaces.findFirst())!.id;
    const userId = (await hub.services.db.query.users.findFirst())!.id;
    accountId = (
      await hub.services.accounts.create(workspaceId, {
        connectorId: 'demo',
        name: 'main',
        label: 'Main',
        credentials: { secret: 's' },
      })
    ).id;
    claude = {
      kind: 'oauth',
      userId,
      workspaceId,
      scopes: ['mcp'],
      credentialId: 'grt_1',
      aiClientId: 'aic_claude',
    };
    chatgpt = {
      kind: 'oauth',
      userId,
      workspaceId,
      scopes: ['mcp'],
      credentialId: 'grt_2',
      aiClientId: 'aic_gpt',
    };
  });

  beforeEach(async () => {
    await hub.services.db.delete(standingApprovals);
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('names the holder by AI app, then connection, then user', () => {
    expect(approvalHolder(claude)).toBe('ai:aic_claude');
    expect(approvalHolder({ ...claude, aiClientId: undefined })).toBe('oauth:grt_1');
    expect(approvalHolder({ kind: 'session', userId: 'usr_1', workspaceId, scopes: [] })).toBe('user:usr_1');
  });

  it('keeps time and uses within bounds and stores the purpose encrypted', async () => {
    const long = await approvals.grant(
      claude,
      target(),
      spec({ minutes: 10 ** 9, maxUses: 10 ** 9, purpose: 'Ask Alex about Friday' }),
    );
    expect(long.usesLeft).toBe(MAX_APPROVAL_USES);
    expect(long.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(MAX_APPROVAL_MINUTES * 60_000);
    expect(long.purpose).toBe('Ask Alex about Friday');
    const [row] = await hub.services.db
      .select()
      .from(standingApprovals)
      .where(eq(standingApprovals.id, long.id));
    expect(row!.purposeEncrypted).not.toContain('Alex');
    const tiny = await approvals.grant(claude, target(), spec({ scope: 'chat:2', minutes: 0, maxUses: 0 }));
    expect(tiny.usesLeft).toBe(1);
    expect(tiny.purpose).toBeUndefined();
  });

  it('is used up atomically, by its holder only, for the actions it lists', async () => {
    await approvals.grant(claude, target(), spec());
    expect(await approvals.use(chatgpt, covered())).toBeUndefined();
    expect(await approvals.use(claude, covered('delete'))).toBeUndefined();
    const results = await Promise.all([1, 2, 3].map(() => approvals.use(claude, covered())));
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await approvals.find(claude, covered())).toBeUndefined();
  });

  it('replaces the caller’s approval for the same scope, and never goes to a shared connection', async () => {
    const first = await approvals.grant(claude, target(), spec());
    const second = await approvals.grant(claude, target(), spec({ maxUses: 5 }));
    expect((await approvals.find(claude, covered()))?.id).toBe(second.id);
    expect((await approvals.listActive(workspaceId)).map((a) => a.id)).toEqual([second.id]);
    expect(first.id).not.toBe(second.id);
    const shared = { ...claude, shared: true };
    await expect(approvals.grant(shared, target(), spec())).rejects.toThrow('shared team connection');
    expect(await approvals.find(shared, covered())).toBeUndefined();
  });

  it('ends by the caller or from the panel, and is pruned a day after it ended', async () => {
    await approvals.grant(claude, target(), spec());
    expect(await approvals.revoke(chatgpt, { connectorId: 'demo', accountId, scope: 'chat:1' })).toBe(0);
    expect(await approvals.revoke(claude, { connectorId: 'demo', accountId, scope: 'chat:1' })).toBe(1);
    expect(await approvals.listActive(workspaceId)).toEqual([]);

    const panel = await approvals.grant(chatgpt, target(), spec());
    expect(await approvals.revokeById('wsp_other', panel.id)).toBe(false);
    expect(await approvals.revokeById(workspaceId, panel.id)).toBe(true);
    expect(await approvals.revokeById(workspaceId, panel.id)).toBe(false);

    const live = await approvals.grant(claude, target(), spec({ scope: 'chat:9' }));
    await hub.services.db
      .update(standingApprovals)
      .set({ revokedAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(eq(standingApprovals.id, panel.id));
    await approvals.prune();
    const left = await hub.services.db.select({ id: standingApprovals.id }).from(standingApprovals);
    expect(left.map((r) => r.id)).not.toContain(panel.id);
    expect(left.map((r) => r.id)).toContain(live.id);
  });
});
