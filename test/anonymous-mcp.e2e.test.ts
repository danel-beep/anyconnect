import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import demo from '../src/connectors/builtin/demo.js';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

/** MCP_ANONYMOUS: an AI app connects before the user signs in, and is sent to sign in when needed. */
describe('anonymous /mcp (connect first, sign in when needed)', () => {
  let hub: TestHub;
  let token: string;

  const rpc = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(hub.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const callTool = (name: string, id = 1) =>
    ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } }) as const;

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({
      connectors: new ConnectorRegistry().register(demo),
      env: { MCP_ANONYMOUS: 'true', MCP_ANONYMOUS_RATE_LIMIT: '12' },
    });
    const workspace = (await hub.services.db.query.workspaces.findFirst())!;
    const user = (await hub.services.db.query.users.findFirst())!;
    ({ token } = await hub.services.apiTokens.create({
      workspaceId: workspace.id,
      userId: user.id,
      name: 'tests',
    }));
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('lists what the hub can do and the services, without signing in', async () => {
    const client = new Client({ name: 'visitor', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(hub.mcpUrl)));
    expect(client.getInstructions()).toContain('has not signed in yet');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['anyconnect_connect_account', 'anyconnect_services']);

    const result = await client.callTool({ name: 'anyconnect_services', arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { services: Array<Record<string, unknown>> };
    expect(data.services).toEqual([
      expect.objectContaining({ service: 'demo', connect: 'form', ready: true }),
    ]);
    // Nothing about any workspace leaks to a visitor.
    expect(data.services[0]).not.toHaveProperty('accounts');
    await client.close();
  });

  it('answers a call that needs an account with a sign-in challenge', async () => {
    for (const name of ['anyconnect_connect_account', 'demo_echo', 'anyconnect_list_accounts']) {
      const res = await rpc(callTool(name));
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain(
        `resource_metadata="${hub.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
      );
    }
    // A batch with one such call is refused as a whole.
    const batch = await rpc([callTool('anyconnect_services', 1), callTool('demo_echo', 2)]);
    expect(batch.status).toBe(401);
  });

  it('keeps signed-in apps and bad tokens as before', async () => {
    const client = new Client({ name: 'signed-in', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(hub.mcpUrl), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['demo_echo', 'anyconnect_list_accounts']));
    await client.close();

    const bad = await rpc(callTool('anyconnect_services'), { authorization: 'Bearer ac_pat_invalid' });
    expect(bad.status).toBe(401);
  });

  it('limits requests without sign-in per IP address', async () => {
    let limited: Response | undefined;
    for (let i = 0; i < 15 && !limited; i++) {
      const res = await rpc({ jsonrpc: '2.0', id: i, method: 'tools/list' });
      if (res.status === 429) limited = res;
    }
    expect(limited).toBeDefined();
    expect(Number(limited!.headers.get('retry-after'))).toBeGreaterThan(0);
    // Signed-in requests are not counted against it.
    const signedIn = await rpc(
      { jsonrpc: '2.0', id: 99, method: 'tools/list' },
      { authorization: `Bearer ${token}` },
    );
    expect(signedIn.status).toBe(200);
  });
});
