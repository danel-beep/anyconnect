import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { ConnectorError, defineConnector } from '../src/connectors/sdk.js';
import type { Principal } from '../src/core/principal.js';
import type { Catalog } from '../src/hub/catalog-types.js';
import { isUntrusted, resultText, type ToolCallResult } from '../src/hub/result.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

/** Whether each executed unit could ask the user in the chat. */
const asked: boolean[] = [];
const sent: Array<{ service: string; account: string; chat: string; text: string }> = [];

/** A small messenger: two of them make the unified `messages_*` tools appear. */
function messenger(id: string, day: string) {
  return defineConnector({
    id,
    name: id.toUpperCase(),
    description: `${id} messenger`,
    version: '1.0.0',
    actions: (action) => [
      action({
        name: 'search',
        description: 'Searches messages',
        input: z.object({ query: z.string(), limit: z.number().optional() }),
        hints: { readOnly: true },
        capability: 'messages.search',
        run: ({ query }, ctx) => {
          if (ctx.account.name === 'broken') throw new ConnectorError('permission', 'No access to search');
          return [
            {
              id: `${id}_${ctx.account.name}_1`,
              chat_id: 'c1',
              text: `${query} from ${id}/${ctx.account.name}`,
              date: `${day}T10:00:00Z`,
              internal: 'dropped by the unified schema',
            },
          ];
        },
      }),
      action({
        name: 'send',
        description: 'Sends a message',
        input: z.object({ chat: z.string(), text: z.string() }),
        risk: 'write',
        capability: 'messages.send',
        run: ({ chat, text }, ctx) => {
          sent.push({ service: id, account: ctx.account.name, chat, text });
          return { id: `m${sent.length}`, status: 'sent' };
        },
      }),
    ],
  });
}

describe('hub dispatch: unified tools, fan-out, call_tool(s)', () => {
  let hub: TestHub;
  let principal: Principal;
  let catalog: Catalog;

  const call = (tool: string, args: Record<string, unknown>) =>
    hub.services.hub.callTool(principal, catalog, tool, args);
  // Results with third-party content arrive wrapped in ⟦untrusted⟧ markers.
  const unwrap = (text: string) =>
    text.replace(/^⟦untrusted (\w+) source="[^"]*"⟧\n([\s\S]*)\n⟦\/untrusted \1⟧$/, '$2');
  const json = (result: ToolCallResult): any =>
    result.structuredContent ?? JSON.parse(unwrap((result.content[0] as { text: string }).text));

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({
      connectors: new ConnectorRegistry()
        .register(messenger('alpha', '2026-11-02'))
        .register(messenger('beta', '2026-11-03')),
      seed: false,
      stages: {
        confirm: (call, next) => {
          asked.push(Boolean(call.interaction));
          return next();
        },
      },
      env: { TOOL_LIST_TOKEN_BUDGET: '100000' },
    });
    const workspace = (await hub.services.db.query.workspaces.findFirst())!;
    const user = (await hub.services.db.query.users.findFirst())!;
    principal = { kind: 'api_token', userId: user.id, workspaceId: workspace.id, scopes: ['mcp'] };
    for (const [connectorId, name] of [
      ['alpha', 'main'],
      ['alpha', 'broken'],
      ['beta', 'main'],
    ] as const) {
      await hub.services.accounts.create(workspace.id, { connectorId, name, label: name });
    }
    catalog = await hub.services.hub.getCatalog(principal);
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('lists unified tools next to the service tools', () => {
    const names = catalog.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['messages_search', 'messages_send', 'alpha_search']));
  });

  it('runs a unified list tool on every account, merged and newest first, with partial errors', async () => {
    const result = await call('messages_search', { query: 'invoice' });
    expect(result.isError).toBeFalsy();
    const data = json(result);
    expect(data.items.map((i: { account: string }) => i.account)).toEqual(['beta:main', 'alpha:main']);
    expect(data.items[0]).toMatchObject({ service: 'beta', text: 'invoice from beta/main' });
    // Fields outside the canonical schema are left out.
    expect(data.items[0].internal).toBeUndefined();
    expect(data.errors).toEqual([{ account: 'alpha:broken', error: expect.stringContaining('No access') }]);
    // The merged messages stay marked as third-party text, with nothing unmarked beside them.
    expect(isUntrusted(result)).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(resultText(result)).toMatch(/^⟦untrusted \w+ source="messages_search"⟧/);
  });

  it('narrows a unified tool to one service or one account', async () => {
    const byService = json(await call('messages_search', { query: 'x', account: 'beta' }));
    expect(byService.items.map((i: { account: string }) => i.account)).toEqual(['beta:main']);
    const byAccount = json(await call('messages_search', { query: 'x', account: 'alpha:main' }));
    expect(byAccount.items.map((i: { account: string }) => i.account)).toEqual(['alpha:main']);
    const unknown = await call('messages_search', { query: 'x', account: 'gamma' });
    expect(unknown.isError).toBe(true);
  });

  it('sends through a unified single tool only from one named account', async () => {
    const ambiguous = await call('messages_send', { chat: 'c1', text: 'hi' });
    expect(ambiguous.isError).toBe(true);
    expect(sent).toHaveLength(0);
    const ok = await call('messages_send', { account: 'beta:main', chat: 'c1', text: 'hi' });
    expect(json(ok)).toMatchObject({ service: 'beta', account: 'beta:main', id: 'm1', status: 'sent' });
    expect(sent).toEqual([{ service: 'beta', account: 'main', chat: 'c1', text: 'hi' }]);
  });

  it('fans a service read tool out over its accounts by default', async () => {
    const fanned = await call('alpha_search', { query: 'q' });
    // Merging keeps the third-party marking of the units.
    expect(isUntrusted(fanned)).toBe(true);
    expect(resultText(fanned)).toMatch(/^⟦untrusted \w+ source="alpha_search"⟧/);
    const data = json(fanned);
    expect(data.items.map((i: { account: string }) => i.account)).toEqual(['main']);
    expect(data.errors).toEqual([{ account: 'broken', error: expect.stringContaining('No access') }]);
    const one = json(await call('alpha_search', { query: 'q', account: 'main' }));
    expect(one).toEqual([expect.objectContaining({ id: 'alpha_main_1' })]);
  });

  it('fails a fan-out only when every account failed', async () => {
    const result = await call('alpha_search', { query: 'q', account: 'broken' });
    expect(result.isError).toBe(true);
  });

  it('runs several tools in one call_tools step, reporting each outcome', async () => {
    const data = json(
      await call('manyplug_call_tools', {
        calls: [
          { name: 'beta_search', arguments: { query: 'a' } },
          { name: 'no_such_tool', arguments: {} },
          { name: 'manyplug_call_tools', arguments: { calls: [] } },
        ],
      }),
    );
    expect(data.results.map((r: { name: string; ok: boolean }) => [r.name, r.ok])).toEqual([
      ['beta_search', true],
      ['no_such_tool', false],
      ['manyplug_call_tools', false],
    ]);
  });

  it('rejects empty and oversized batches, and nesting through call_tool', async () => {
    expect((await call('manyplug_call_tools', { calls: [] })).isError).toBe(true);
    const many = Array.from({ length: 11 }, () => ({ name: 'beta_search', arguments: { query: 'a' } }));
    expect((await call('manyplug_call_tools', { calls: many })).isError).toBe(true);
    const nested = await call('manyplug_call_tool', { name: 'manyplug_call_tools', arguments: {} });
    expect(nested.isError).toBe(true);
  });

  it('runs any catalog tool through call_tool', async () => {
    const result = await call('manyplug_call_tool', { name: 'beta_search', arguments: { query: 'z' } });
    expect(json(result)).toEqual([expect.objectContaining({ id: 'beta_main_1' })]);
  });

  it('finds tools and their schemas with search_tools', async () => {
    const data = json(await call('manyplug_search_tools', { query: 'send a message' }));
    expect(data.tools[0].name).toBe('messages_send');
    expect(data.tools[0].inputSchema).toBeDefined();
  });

  it('asks for English words when a search in another language finds nothing', async () => {
    const data = json(await call('manyplug_search_tools', { query: '未读邮件' }));
    expect(data.tools).toEqual([]);
    expect(data.hint).toContain('search again in English');
    const plain = json(await call('manyplug_search_tools', { query: 'zzzz qqqq' }));
    expect(plain.hint).not.toContain('English');
  });

  it('lets only a single unit ask the user in the chat', async () => {
    const interaction = { answers: {}, canAsk: true };
    asked.length = 0;
    await hub.services.hub.callTool(principal, catalog, 'beta_search', { query: 'a' }, { interaction });
    expect(asked).toEqual([true]);
    asked.length = 0;
    await hub.services.hub.callTool(principal, catalog, 'alpha_search', { query: 'a' }, { interaction });
    await hub.services.hub.callTool(
      principal,
      catalog,
      'manyplug_call_tools',
      { calls: [{ name: 'beta_search', arguments: { query: 'a' } }] },
      { interaction },
    );
    expect(asked).toEqual([false, false, false]);
  });
});
