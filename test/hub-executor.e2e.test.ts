import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import demo from '../src/connectors/builtin/demo.js';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { defineConnector } from '../src/connectors/sdk.js';
import type { Principal } from '../src/core/principal.js';
import { errorResult } from '../src/hub/result.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

let sent = 0;
const outbox = defineConnector({
  id: 'outbox',
  name: 'Outbox',
  description: 'Sends things',
  version: '1.0.0',
  actions: (action) => [
    action({
      name: 'send',
      description: 'Sends a message',
      input: z.object({ to: z.string(), text: z.string() }),
      risk: 'write',
      assessRisk: ({ to }) =>
        to === 'stranger' ? { risk: 'dangerous', reason: 'New recipient' } : undefined,
      run: ({ to }) => {
        sent++;
        return { id: `msg_${sent}`, to };
      },
    }),
    action({
      name: 'list',
      description: 'Lists many items',
      input: z.object({}),
      hints: { readOnly: true },
      response: { fields: ['subject', 'from'] },
      run: () =>
        Array.from({ length: 500 }, (_, i) => ({
          id: `${i}`,
          subject: `Item ${i}`,
          from: 'x',
          body: 'y'.repeat(200),
        })),
    }),
  ],
});

describe('executor in the running hub', () => {
  let hub: TestHub;
  let principal: Principal;

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await hub?.close();
    sent = 0;
    hub = await startTestHub({
      connectors: new ConnectorRegistry().register(demo).register(outbox),
      stages: {
        // A stand-in for the security layer's policy: dangerous calls are denied.
        confirm: async (call, next) => {
          if (call.risk === 'dangerous') {
            call.audit.outcome = 'declined';
            return errorResult(`Needs confirmation: ${String(call.locals.riskReason)}`, 'permission');
          }
          return next();
        },
      },
    });
    const workspace = (await hub.services.db.query.workspaces.findFirst())!;
    const user = (await hub.services.db.query.users.findFirst())!;
    principal = { kind: 'api_token', userId: user.id, workspaceId: workspace.id, scopes: ['mcp'] };
    await hub.services.accounts.create(workspace.id, { connectorId: 'outbox', name: 'main', label: 'Main' });
  });

  afterAll(async () => {
    await hub?.close();
  });

  const run = async (tool: string, args: Record<string, unknown>) => {
    const catalog = await hub.services.hub.getCatalog(principal);
    return hub.services.hub.callTool(principal, catalog, tool, args);
  };

  it('suppresses an accidental duplicate write and audits it', async () => {
    const first = await run('outbox_send', { to: 'bob', text: 'hi' });
    const second = await run('outbox_send', { to: 'bob', text: 'hi' });
    expect(first.isError).toBeFalsy();
    expect(JSON.stringify(second.content)).toContain('Not repeated');
    expect(sent).toBe(1);
    const calls = await hub.services.hub.recentToolCalls(principal.workspaceId);
    expect(calls.map((c) => [c.toolName, c.status, c.outcome, c.risk])).toEqual([
      ['outbox_send', 'ok', 'deduplicated', 'write'],
      ['outbox_send', 'ok', null, 'write'],
    ]);
  });

  it('lets an action raise the risk of one call so a confirm stage can stop it', async () => {
    const result = await run('outbox_send', { to: 'stranger', text: 'hi' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('New recipient');
    expect(sent).toBe(0);
    const [audit] = await hub.services.hub.recentToolCalls(principal.workspaceId);
    expect(audit).toMatchObject({ status: 'error', outcome: 'declined', risk: 'dangerous' });
  });

  it('keeps large results within the budget and honours fields', async () => {
    const catalog = await hub.services.hub.getCatalog(principal);
    const list = catalog.tools.find((t) => t.name === 'outbox_list')!;
    expect((list.inputSchema.properties as Record<string, unknown>).fields).toBeDefined();
    const big = await run('outbox_list', {});
    const text = (big.content[0] as { text: string }).text;
    expect(text.length).toBeLessThan(2000 * 4);
    expect(text).toContain('"truncated"');
    const slim = await run('outbox_list', { fields: ['subject'] });
    const items = (slim.structuredContent as { items: Array<Record<string, unknown>> }).items;
    expect(Object.keys(items[0]!)).toEqual(['id', 'subject']);
    // The internal executor details never reach the client.
    expect(slim).not.toHaveProperty('data');
    expect(slim).not.toHaveProperty('error');
  });

  it('records calls rejected before execution', async () => {
    await run('outbox_send', { to: 'bob' });
    const [audit] = await hub.services.hub.recentToolCalls(principal.workspaceId);
    expect(audit).toMatchObject({ toolName: 'outbox_send', status: 'error', outcome: 'hub' });
  });
});
