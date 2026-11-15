import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { defineConnector } from '../src/connectors/sdk.js';
import type { Principal } from '../src/core/principal.js';
import { pendingCalls } from '../src/db/schema.js';
import { resultText } from '../src/hub/result.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

let purged = 0;
const inbox = defineConnector({
  id: 'inbox',
  name: 'Inbox',
  description: 'A test mailbox',
  version: '1.0.0',
  actions: (action) => [
    action({
      name: 'purge',
      description: 'Deletes every email',
      input: z.object({ folder: z.string().optional() }),
      hints: { destructive: true },
      run: () => {
        purged++;
        return { purged: true };
      },
    }),
  ],
});

/**
 * What the AI is told when it repeats a call that waits for the user, by where that call stands:
 * cancelled, expired, running, scheduled, or run with its result lost. A final answer is given once;
 * the next identical call starts a new confirmation.
 */
describe('a held-back call, asked about again', () => {
  let hub: TestHub;
  let principal: Principal;

  const call = async (args: Record<string, unknown> = {}) => {
    const catalog = await hub.services.hub.getCatalog(principal);
    return hub.services.hub.callTool(principal, catalog, 'inbox_purge', { account: 'work', ...args });
  };
  const held = async (args: Record<string, unknown> = {}) => {
    const first = await call(args);
    expect(first.structuredContent).toMatchObject({ confirmation: { status: 'awaiting_confirmation' } });
    const [row] = await hub.services.db.select().from(pendingCalls);
    return row!;
  };
  const setStatus = (id: string, patch: Partial<typeof pendingCalls.$inferInsert>) =>
    hub.services.db.update(pendingCalls).set(patch).where(eq(pendingCalls.id, id));

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({
      connectors: new ConnectorRegistry().register(inbox),
      env: { CONFIRMATION_WAIT_SECONDS: '0' },
      seed: false,
    });
    const s = hub.services;
    const workspaceId = (await s.db.query.workspaces.findFirst())!.id;
    const userId = (await s.db.query.users.findFirst())!.id;
    await s.accounts.create(workspaceId, { connectorId: 'inbox', name: 'work', label: 'Work' });
    const aiClientId = (await s.aiClients.createUnique(workspaceId, 'Claude', 'oauth')).id;
    principal = {
      kind: 'oauth',
      userId,
      workspaceId,
      scopes: ['mcp'],
      clientId: 'client_test',
      credentialId: 'grant_test',
      aiClientId,
    };
  });

  beforeEach(async () => {
    purged = 0;
    await hub.services.db.delete(pendingCalls);
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('keeps asking while the user has not answered', async () => {
    const row = await held();
    const again = await call();
    expect(again.structuredContent).toMatchObject({
      confirmation: { id: row.id, status: 'awaiting_confirmation', confirm_in: 'link', next: 'send_link' },
    });
    expect(resultText(again)).toContain(`/confirm/${row.id}`);
  });

  it('says when the user cancelled or did not answer in time, once', async () => {
    const cancelled = await held();
    await setStatus(cancelled.id, { status: 'cancelled' });
    const told = await call();
    expect(told.isError).toBe(true);
    expect(resultText(told)).toContain('cancelled this action');
    // Told once: the same call again is a new request.
    const fresh = await call();
    expect(fresh.structuredContent).toMatchObject({ confirmation: { status: 'awaiting_confirmation' } });
    expect((fresh.structuredContent as { confirmation: { id: string } }).confirmation.id).not.toBe(
      cancelled.id,
    );

    await hub.services.db.delete(pendingCalls);
    const expired = await held({ folder: 'spam' });
    await setStatus(expired.id, { status: 'expired' });
    expect(resultText(await call({ folder: 'spam' }))).toContain('did not confirm this action in time');
    expect(purged).toBe(0);
  });

  it('says an approved call is running or when it will run', async () => {
    const row = await held();
    await setStatus(row.id, { status: 'running' });
    expect(resultText(await call())).toContain('running now');
    await setStatus(row.id, { status: 'scheduled', executeAt: new Date(Date.now() + 30_000) });
    expect(resultText(await call())).toMatch(/will run in (29|30) s unless the user cancels/);
    await setStatus(row.id, { status: 'scheduled', executeAt: null });
    expect(resultText(await call())).toContain('will run in 0 s');
  });

  it('reports a call that ran without a stored result as unknown, not as done', async () => {
    const row = await held();
    await setStatus(row.id, { status: 'succeeded', resultEncrypted: null });
    const answer = await call();
    expect(answer.isError).toBe(true);
    expect(resultText(answer)).toContain('outcome is unknown');
  });
});
