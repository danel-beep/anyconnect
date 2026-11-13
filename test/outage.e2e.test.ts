import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import demo from '../src/connectors/builtin/demo.js';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { defineConnector } from '../src/connectors/sdk.js';
import type { Principal } from '../src/core/principal.js';
import { createDatabase } from '../src/db/client.js';
import { isDatabaseUnavailable } from '../src/db/errors.js';
import { FaultProxy } from './fault-proxy.js';
import { resetDatabase, startTestHub, TEST_DATABASE_URL, TestBrowser, type TestHub } from './helpers.js';

/**
 * The hub while its database is unreachable (restart, failover, network split), through a proxy
 * the test can cut: what AI apps, browsers and OAuth clients get, and that everything works again
 * afterwards without a restart or a new sign-in. See docs/OPERATIONS.md ("Сбой базы данных").
 */
describe('database outage', () => {
  let proxy: FaultProxy;
  let hub: TestHub;
  let token: string;
  let principal: Principal;

  beforeAll(async () => {
    await resetDatabase();
    proxy = await FaultProxy.start(TEST_DATABASE_URL);
    hub = await startTestHub({ databaseUrl: proxy.url(TEST_DATABASE_URL) });
    const user = (await hub.services.db.query.users.findFirst())!;
    const workspace = (await hub.services.db.query.workspaces.findFirst())!;
    principal = { kind: 'api_token', userId: user.id, workspaceId: workspace.id, scopes: ['mcp'] };
    ({ token } = await hub.services.apiTokens.create({
      scopes: ['mcp', 'api'],
      workspaceId: workspace.id,
      userId: user.id,
      name: 'ai',
    }));
  });

  beforeEach(() => proxy.restore());

  afterAll(async () => {
    proxy?.restore();
    await hub?.close();
    await proxy?.close();
  });

  const mcp = (body: unknown) =>
    fetch(hub.mcpUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    });

  it('tells an AI app to come back (503), never to sign in again, and serves it again afterwards', async () => {
    const client = new Client({ name: 'outage-client', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(hub.mcpUrl), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);

    proxy.cut();
    const down = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    // A 401 here would make the app throw away its sign-in and ask the user to connect again.
    expect(down.status).toBe(503);
    expect(down.headers.get('retry-after')).toBe('30');
    expect(down.headers.get('www-authenticate')).toBeNull();
    const body = (await down.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/temporarily unavailable/i);

    proxy.restore();
    // The same connection and token work again, with no restart of the hub.
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    const echoed = await client.callTool({ name: 'demo_echo', arguments: { message: 'back' } });
    expect(echoed.isError).toBeFalsy();
    await client.close();
  });

  it('answers a tool call that hits the outage with a temporary hub problem, not an internal error', async () => {
    const catalog = await hub.services.hub.getCatalog(principal);
    proxy.cut();
    const result = await hub.services.hub.callTool(principal, catalog, 'demo_echo', { message: 'x' });
    proxy.restore();
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/could not reach its database/);
    expect(text).toMatch(/not with the service/);
    expect(text).not.toMatch(/Internal error/);
  });

  it('keeps OAuth clients signed in: the token endpoint answers 503 temporarily_unavailable', async () => {
    proxy.cut();
    const response = await fetch(`${hub.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'ac_rt_whatever',
        client_id: 'client',
      }).toString(),
    });
    // invalid_grant (400) would tell the app its refresh token is dead.
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' });
  });

  it('shows signed-in pages a "back in a moment" page and the API a 503', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await browser.login();
    proxy.cut();
    const page = await browser.request('/app', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(503);
    expect(page.headers.get('retry-after')).toBe('30');
    const html = await page.text();
    expect(html).toContain('Скоро вернёмся');
    expect(html).not.toContain('ref ');

    const api = await fetch(`${hub.baseUrl}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(api.status).toBe(503);
    expect(((await api.json()) as { error: { code: string } }).error.code).toBe('unavailable');

    proxy.restore();
    expect((await browser.request('/app', { headers: { accept: 'text/html' } })).status).toBe(200);
  });

  it('keeps the status page up and has it report the outage', async () => {
    const before = await fetch(`${hub.baseUrl}/status.json`);
    expect(before.status).toBe(200);

    proxy.cut();
    const json = await fetch(`${hub.baseUrl}/status.json`);
    expect(json.status).toBe(200);
    const data = (await json.json()) as {
      status: string;
      components: { id: string; status: string }[];
      incidents: { component: string; endedAt: string | null }[];
    };
    expect(data.status).toBe('down');
    expect(data.components.find((c) => c.id === 'database')?.status).toBe('down');
    // Calls to connected services do not need the database: no outage is claimed for them.
    expect(data.components.some((c) => c.id === 'connections' && c.status === 'down')).toBe(false);
    expect(data.incidents[0]).toMatchObject({ component: 'database', status: 'down', endedAt: null });

    const page = await fetch(`${hub.baseUrl}/status`, { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);

    proxy.restore();
    // Read from the database again: the outage shown above was never written there.
    const after = (await (await fetch(`${hub.baseUrl}/status.json`)).json()) as typeof data;
    expect(after.incidents.some((i) => i.component === 'database' && i.endedAt === null)).toBe(false);
  });

  it('fails a query on a connection that went silent instead of hanging, then reconnects', async () => {
    // A proxy of its own: the hub's connections stay out of the split.
    const split = await FaultProxy.start(TEST_DATABASE_URL);
    const database = createDatabase(split.url(TEST_DATABASE_URL), { poolMax: 2, queryTimeoutMs: 500 });
    try {
      await database.pool.query('select 1');
      // A network split: the connection stays open and nothing comes back.
      split.freeze();
      split.restore();
      const started = Date.now();
      const error = await database.pool.query('select 1').catch((e: unknown) => e);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(isDatabaseUnavailable(error)).toBe(true);
      // The dead connection was dropped: the next query gets a fresh one.
      expect((await database.pool.query('select 1 as ok')).rows[0].ok).toBe(1);
    } finally {
      await split.close();
      await database.close();
    }
  });
});

/** A service that stopped answering: requests hang and never come back. */
const hanging = defineConnector({
  id: 'hanging',
  name: 'Hanging',
  description: 'Never answers',
  version: '1.0.0',
  actions: (action) => [
    action({
      name: 'read',
      description: 'Hangs',
      input: z.object({}),
      hints: { readOnly: true },
      // Ignores the abort signal on purpose: the hub must answer the AI anyway.
      run: () => new Promise(() => {}),
    }),
  ],
});

describe('a service that hangs', () => {
  let hub: TestHub;
  let principal: Principal;

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({
      connectors: new ConnectorRegistry().register(demo).register(hanging),
      env: { TOOL_TIMEOUT_SECONDS: '1' },
    });
    const user = (await hub.services.db.query.users.findFirst())!;
    const workspace = (await hub.services.db.query.workspaces.findFirst())!;
    principal = { kind: 'api_token', userId: user.id, workspaceId: workspace.id, scopes: ['mcp'] };
    await hub.services.accounts.create(workspace.id, { connectorId: 'hanging', name: 'main', label: 'Main' });
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('answers the AI within the call timeout, then stops calling it for a while', async () => {
    const catalog = await hub.services.hub.getCatalog(principal);
    const call = () => hub.services.hub.callTool(principal, catalog, 'hanging_read', {});
    for (let i = 0; i < 5; i++) {
      const started = Date.now();
      const result = await call();
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/timed out after 1 seconds/);
    }
    // Five timeouts in a row: the next call fails at once with when to try again, without waiting.
    const started = Date.now();
    const open = await call();
    expect(Date.now() - started).toBeLessThan(200);
    expect((open.content[0] as { text: string }).text).toMatch(/is not responding .* Try again in \d+ s/);
    // Other services keep working.
    const echoed = await hub.services.hub.callTool(principal, catalog, 'demo_echo', { message: 'ok' });
    expect(echoed.isError).toBeFalsy();
  }, 20_000);
});
