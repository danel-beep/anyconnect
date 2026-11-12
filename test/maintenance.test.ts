import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMaintenance } from '../src/core/maintenance.js';
import { resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

/**
 * The hourly clean-up of expired security artifacts (`src/core/maintenance.ts`). What it deletes
 * must really be dead (an expired session, a wrap for a revoked token), and what it keeps must
 * still work: a live session, a client that has a grant, a wrap of a live token.
 */
describe('maintenance of expired security artifacts', () => {
  let hub: TestHub;
  let userId: string;
  let workspaceId: string;

  const q = (text: string, values: unknown[] = []) => hub.services.database.pool.query(text, values);
  const count = async (table: string, where = 'true', values: unknown[] = []) =>
    Number((await q(`select count(*)::int as n from ${table} where ${where}`, values)).rows[0].n);

  const registerClient = async (): Promise<string> => {
    const response = await fetch(`${hub.baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://app.example/cb'], token_endpoint_auth_method: 'none' }),
    });
    return ((await response.json()) as { client_id: string }).client_id;
  };
  const grant = async (id: string, clientId: string, revokedDaysAgo: number | null) =>
    q(
      `insert into oauth_grants (id, client_id, user_id, workspace_id, resource, revoked_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        clientId,
        userId,
        workspaceId,
        hub.mcpUrl,
        revokedDaysAgo === null ? null : new Date(Date.now() - revokedDaysAgo * 86_400_000),
      ],
    );

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ seed: false });
    userId = (await hub.services.db.query.users.findFirst())!.id;
    workspaceId = (await hub.services.db.query.workspaces.findFirst())!.id;
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('signs out expired sessions and keeps live ones', async () => {
    const live = new TestBrowser(hub.baseUrl);
    const stale = new TestBrowser(hub.baseUrl);
    expect((await live.login()).status).toBe(303);
    expect((await stale.login()).status).toBe(303);
    expect(await count('web_sessions')).toBe(2);
    await q(
      "update web_sessions set expires_at = now() - interval '1 minute' where token_hash = (select token_hash from web_sessions order by created_at desc limit 1)",
    );

    await runMaintenance(hub.services.db);
    expect(await count('web_sessions')).toBe(1);
    expect((await live.request('/app')).status).toBe(200);
    expect((await stale.request('/app')).status).toBe(302);
  });

  it('forgets abandoned client registrations but keeps clients someone authorized', async () => {
    const abandoned = await registerClient();
    const fresh = await registerClient();
    const used = await registerClient();
    await grant('grt_used', used, null);
    await q("update oauth_clients set created_at = now() - interval '31 days' where id = any($1)", [
      [abandoned, used],
    ]);

    await runMaintenance(hub.services.db);
    const left = (await q('select id from oauth_clients')).rows.map((r) => r.id);
    expect(left).not.toContain(abandoned);
    expect(left).toEqual(expect.arrayContaining([fresh, used]));
  });

  it('keeps revoked grants for the audit trail for 30 days, with their expired tokens a day', async () => {
    const clientId = await registerClient();
    await grant('grt_recent', clientId, 5);
    await grant('grt_old', clientId, 31);
    for (const [hash, grantId, expiredHoursAgo] of [
      ['hash_expired_long_ago', 'grt_recent', 48],
      ['hash_just_expired', 'grt_recent', 1],
    ] as const) {
      await q(
        `insert into oauth_tokens (token_hash, grant_id, type, expires_at) values ($1, $2, 'access', $3)`,
        [hash, grantId, new Date(Date.now() - expiredHoursAgo * 3_600_000)],
      );
    }

    await runMaintenance(hub.services.db);
    const grants = (await q('select id from oauth_grants')).rows.map((r) => r.id);
    expect(grants).toContain('grt_recent');
    expect(grants).not.toContain('grt_old');
    const tokens = (await q('select token_hash from oauth_tokens')).rows.map((r) => r.token_hash);
    expect(tokens).toEqual(['hash_just_expired']);
  });

  it('removes vault wraps whose token is gone, revoked or expired, and keeps the rest', async () => {
    await q("insert into user_vaults (user_id, public_key) values ($1, 'pk') on conflict do nothing", [
      userId,
    ]);
    // Start from a known set: signing in earlier tests opened the vault from a browser.
    await q('delete from vault_wraps');
    const live = await hub.services.apiTokens.create({ workspaceId, userId, name: 'live', scopes: ['mcp'] });
    const revoked = await hub.services.apiTokens.create({
      workspaceId,
      userId,
      name: 'revoked',
      scopes: ['mcp'],
    });
    const expired = await hub.services.apiTokens.create({
      workspaceId,
      userId,
      name: 'expired',
      scopes: ['mcp'],
    });
    await q('update api_tokens set revoked_at = now() where id = $1', [revoked.row.id]);
    await q("update api_tokens set expires_at = now() - interval '1 minute' where id = $1", [expired.row.id]);
    const wraps: [string, string, number][] = [
      ['api_token', live.row.id, 0],
      ['api_token', revoked.row.id, 0],
      ['api_token', expired.row.id, 0],
      ['api_token', 'tok_deleted', 0],
      ['oauth', 'hash_just_expired', 0],
      ['oauth', 'hash_never_existed', 0],
      ['oauth_code', 'code_fresh', 0],
      ['oauth_code', 'code_stale', 2],
      ['device', 'dev_1', 400],
    ];
    for (const [kind, ref, daysAgo] of wraps) {
      await q(
        "insert into vault_wraps (user_id, kind, ref, wrapped, created_at) values ($1, $2, $3, 'w', $4)",
        [userId, kind, ref, new Date(Date.now() - daysAgo * 86_400_000)],
      );
    }

    await runMaintenance(hub.services.db);
    const left = (await q('select kind, ref from vault_wraps order by kind, ref')).rows.map(
      (r) => `${r.kind}:${r.ref}`,
    );
    expect(left).toEqual([
      `api_token:${live.row.id}`,
      'device:dev_1',
      'oauth:hash_just_expired',
      'oauth_code:code_fresh',
    ]);
  });
});
