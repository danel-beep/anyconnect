import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from '../src/core/identity.js';
import { ADMIN, resetDatabase, startTestHub, type TestHub } from './helpers.js';

/**
 * The data-protection endpoints of the REST API (`src/routes/api-security.ts`): default policy,
 * AI clients, personas, access rules and held-back calls. Every id-addressed route must stay
 * inside the caller's workspace, so each test also tries the same id from another workspace.
 */
describe('REST API: security settings stay inside their workspace', () => {
  let hub: TestHub;
  let mine: { token: string; workspaceId: string; userId: string };
  let theirs: { token: string; workspaceId: string; userId: string };

  const api = async (
    who: { token: string },
    path: string,
    init: { method?: string; body?: unknown } = {},
  ) => {
    const headers: Record<string, string> = { authorization: `Bearer ${who.token}` };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${hub.baseUrl}/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub();
    const s = hub.services;
    const owner = (await s.db.query.users.findFirst({ where: (u, { eq }) => eq(u.email, ADMIN.email) }))!;
    const ownerWs = (await s.db.query.workspaces.findFirst())!;
    const other = await createUser(s.db, { email: 'mallory@example.com', name: 'Mallory' });
    const token = async (workspaceId: string, userId: string) =>
      (await s.apiTokens.create({ workspaceId, userId, name: 'api', scopes: ['mcp', 'api'] })).token;
    mine = { workspaceId: ownerWs.id, userId: owner.id, token: await token(ownerWs.id, owner.id) };
    theirs = {
      workspaceId: other.workspace.id,
      userId: other.user.id,
      token: await token(other.workspace.id, other.user.id),
    };
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('reads and changes the default policy of the caller’s workspace only', async () => {
    const before = await api(mine, '/security');
    expect(before.status).toBe(200);
    expect(before.body).toHaveProperty('defaultAccess');

    const changed = await api(mine, '/security', {
      method: 'PATCH',
      body: { defaultConfirm: 'always', undoWindowSeconds: 30 },
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ defaultConfirm: 'always', undoWindowSeconds: 30 });
    expect((await api(mine, '/security')).body).toMatchObject({
      defaultConfirm: 'always',
      undoWindowSeconds: 30,
    });
    // The other workspace keeps its defaults.
    expect((await api(theirs, '/security')).body).toEqual(before.body);

    for (const body of [{ undoWindowSeconds: 4000 }, { defaultAccess: 'root' }, { undoWindowSeconds: 1.5 }]) {
      expect((await api(mine, '/security', { method: 'PATCH', body })).status).toBe(400);
    }
  });

  it('renames and deletes AI clients, never another workspace’s', async () => {
    const s = hub.services;
    const client = await s.aiClients.createUnique(mine.workspaceId, 'Script', 'other' as never);

    const listed = await api(mine, '/clients');
    expect(listed.status).toBe(200);
    expect(listed.body.map((c: { id: string }) => c.id)).toContain(client.id);
    expect((await api(theirs, '/clients')).body.map((c: { id: string }) => c.id)).not.toContain(client.id);

    expect(
      (await api(theirs, `/clients/${client.id}`, { method: 'PATCH', body: { name: 'Hijacked' } })).status,
    ).toBe(404);
    expect((await api(theirs, `/clients/${client.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await api(mine, `/clients/${client.id}`, { method: 'PATCH', body: { name: '  ' } })).status).toBe(
      400,
    );

    const renamed = await api(mine, `/clients/${client.id}`, {
      method: 'PATCH',
      body: { name: 'Nightly script' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Nightly script');
    expect((await api(mine, `/clients/${client.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(mine, `/clients/${client.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('manages personas and refuses accounts from another workspace', async () => {
    const s = hub.services;
    const myAccount = await s.accounts.create(mine.workspaceId, {
      connectorId: 'demo',
      label: 'Mine',
      credentials: { secret: 'mine-secret' },
    });
    const theirAccount = await s.accounts.create(theirs.workspaceId, {
      connectorId: 'demo',
      label: 'Theirs',
      credentials: { secret: 'their-secret' },
    });

    // An access profile cannot be made to include someone else's account.
    const smuggled = await api(mine, '/personas', {
      method: 'POST',
      body: { slug: 'smuggle', name: 'Smuggle', accountIds: [theirAccount.id] },
    });
    expect(smuggled.status).toBe(400);
    expect(JSON.stringify(smuggled.body)).toContain('Unknown accounts');

    const created = await api(mine, '/personas', {
      method: 'POST',
      body: { slug: 'work', name: 'Work', accountIds: [myAccount.id], maxAccess: 'read' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ slug: 'work', accountIds: [myAccount.id], maxAccess: 'read' });
    const id = created.body.id as string;

    expect(
      (await api(mine, '/personas', { method: 'POST', body: { slug: 'work', name: 'Again' } })).status,
    ).toBe(409);
    expect(
      (await api(mine, '/personas', { method: 'POST', body: { slug: 'Bad Slug!', name: 'x' } })).status,
    ).toBe(400);

    expect((await api(mine, `/personas/${id}`)).body.name).toBe('Work');
    expect((await api(theirs, `/personas/${id}`)).status).toBe(404);
    expect((await api(theirs, '/personas')).body).toEqual([]);
    expect(
      (await api(theirs, `/personas/${id}`, { method: 'PATCH', body: { name: 'Mine now' } })).status,
    ).toBe(404);
    expect((await api(theirs, `/personas/${id}`, { method: 'DELETE' })).status).toBe(404);

    expect(
      (await api(mine, `/personas/${id}`, { method: 'PATCH', body: { accountIds: [theirAccount.id] } }))
        .status,
    ).toBe(400);
    const updated = await api(mine, `/personas/${id}`, { method: 'PATCH', body: { name: 'Work only' } });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ name: 'Work only', slug: 'work', accountIds: [myAccount.id] });

    expect((await api(mine, `/personas/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(mine, `/personas/${id}`)).status).toBe(404);
  });

  it('creates access rules only over the caller’s own clients and accounts', async () => {
    const s = hub.services;
    const myAccount = await s.accounts.create(mine.workspaceId, {
      connectorId: 'demo',
      label: 'Rules',
      credentials: { secret: 'rules-secret' },
    });
    const theirAccount = await s.accounts.create(theirs.workspaceId, {
      connectorId: 'demo',
      label: 'Their rules',
      credentials: { secret: 'their-rules-secret' },
    });
    const theirClient = await s.aiClients.createUnique(theirs.workspaceId, 'Their app', 'other' as never);

    for (const body of [
      { accountId: theirAccount.id, access: 'none' },
      { aiClientId: theirClient.id, access: 'none' },
    ]) {
      const refused = await api(mine, '/rules', { method: 'POST', body });
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain('Unknown');
    }
    // A rule must say what it changes.
    expect((await api(mine, '/rules', { method: 'POST', body: { accountId: myAccount.id } })).status).toBe(
      400,
    );

    const created = await api(mine, '/rules', {
      method: 'POST',
      body: { accountId: myAccount.id, confirm: 'always', note: 'ask first' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ accountId: myAccount.id, confirm: 'always', note: 'ask first' });
    const id = created.body.id as string;

    expect((await api(mine, '/rules')).body.map((r: { id: string }) => r.id)).toContain(id);
    expect((await api(theirs, '/rules')).body.map((r: { id: string }) => r.id)).not.toContain(id);
    expect((await api(theirs, `/rules/${id}`, { method: 'PUT', body: { access: 'full' } })).status).toBe(404);
    expect((await api(theirs, `/rules/${id}`, { method: 'DELETE' })).status).toBe(404);
    // Updating cannot re-point the rule at another workspace's account either.
    expect(
      (
        await api(mine, `/rules/${id}`, {
          method: 'PUT',
          body: { accountId: theirAccount.id, access: 'read' },
        })
      ).status,
    ).toBe(400);

    const updated = await api(mine, `/rules/${id}`, {
      method: 'PUT',
      body: { accountId: myAccount.id, access: 'read' },
    });
    expect(updated.status).toBe(200);
    // PUT replaces the rule: the confirm level set before is gone.
    expect(updated.body).toMatchObject({ access: 'read', confirm: null, note: null });

    expect((await api(mine, `/rules/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(mine, `/rules/${id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('shows held-back calls to their workspace and lets tokens only cancel them', async () => {
    const s = hub.services;
    const account = await s.accounts.create(mine.workspaceId, {
      connectorId: 'demo',
      label: 'Held',
      credentials: { secret: 'held-secret' },
    });
    const hold = () =>
      s.pendingCalls.requestConfirmation({
        principal: { kind: 'api_token', userId: mine.userId, workspaceId: mine.workspaceId, scopes: ['mcp'] },
        toolName: 'demo_echo',
        connectorId: 'demo',
        action: 'echo',
        accountId: account.id,
        risk: 'write',
        args: { text: 'hello' },
        channels: [],
        undoWindowSeconds: 0,
      });
    const row = await hold();

    const listed = await api(mine, '/pending-calls');
    expect(listed.status).toBe(200);
    expect(listed.body.calls.map((c: { id: string }) => c.id)).toContain(row.id);
    expect((await api(theirs, '/pending-calls')).body.calls).toEqual([]);

    const one = await api(mine, `/pending-calls/${row.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: row.id, status: 'awaiting_confirmation', tool: 'demo_echo' });
    expect(one.body.confirmUrl).toContain(row.id);
    expect((await api(theirs, `/pending-calls/${row.id}`)).status).toBe(404);

    // No token may answer a confirmation, only the signed-in user.
    for (const decision of ['approve', 'deny']) {
      expect((await api(mine, `/pending-calls/${row.id}/${decision}`, { method: 'POST' })).status).toBe(403);
    }
    // Another workspace cannot cancel it either.
    expect((await api(theirs, `/pending-calls/${row.id}/cancel`, { method: 'POST' })).status).toBe(404);
    expect((await s.pendingCalls.get(row.id))!.status).toBe('awaiting_confirmation');

    const cancelled = await api(mine, `/pending-calls/${row.id}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    const again = await api(mine, `/pending-calls/${row.id}/cancel`, { method: 'POST' });
    expect(again.status).toBe(409);
  });
});
