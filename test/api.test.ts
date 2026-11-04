import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import demo from '../src/connectors/builtin/demo.js';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { ConnectorError, defineConnector } from '../src/connectors/sdk.js';
import { ADMIN, resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

/** A connector used to exercise failure paths. */
const flaky = defineConnector({
  id: 'flaky',
  name: 'Flaky',
  description: 'Fails on purpose',
  version: '1.0.0',
  credentials: z.object({ apiKey: z.string().min(3) }),
  actions: (action) => [
    action({
      name: 'expired',
      description: 'Pretends the credentials expired',
      input: z.object({}),
      run: () => {
        throw new ConnectorError('auth', 'token expired');
      },
    }),
    action({
      name: 'slow',
      description: 'Never finishes in time',
      input: z.object({}),
      hints: { readOnly: true },
      run: (_input, ctx) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve('late'), 10_000);
          ctx.signal.addEventListener('abort', () => clearTimeout(timer));
        }),
    }),
    action({
      name: 'crash',
      description: 'Throws an unexpected error',
      input: z.object({}),
      run: () => {
        throw new Error('database password is hunter2');
      },
    }),
  ],
});

describe('REST API, personal tokens and account management', () => {
  let hub: TestHub;
  let token: string;

  const api = async (path: string, init: { method?: string; body?: unknown; auth?: string | null } = {}) => {
    const headers: Record<string, string> = {};
    const auth = init.auth === undefined ? token : init.auth;
    if (auth) headers.authorization = `Bearer ${auth}`;
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
  });

  beforeEach(async () => {
    await hub?.close();
    hub = await startTestHub({
      connectors: new ConnectorRegistry().register(demo).register(flaky),
      env: { TOOL_TIMEOUT_SECONDS: '1' },
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

  it('requires authentication', async () => {
    expect((await api('/me', { auth: null })).status).toBe(401);
    expect((await api('/me', { auth: 'ac_pat_invalid' })).status).toBe(401);
    const me = await api('/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(ADMIN.email);
    expect(me.body.mcpUrl).toBe(hub.mcpUrl);
  });

  it('describes connectors with JSON schemas for building forms', async () => {
    const { body } = await api('/connectors');
    const flakyInfo = body.find((c: { id: string }) => c.id === 'flaky');
    expect(flakyInfo.credentialsSchema.properties.apiKey.type).toBe('string');
    expect(flakyInfo.actions.map((a: { name: string }) => a.name)).toEqual(['expired', 'slow', 'crash']);
  });

  it('creates accounts with encrypted credentials and never returns them', async () => {
    const created = await api('/accounts', {
      method: 'POST',
      body: { connectorId: 'flaky', label: 'Рабочий ключ', credentials: { apiKey: 'sk-live-123456' } },
    });
    expect(created.status).toBe(201);
    expect(created.body.account.name).toBe('rabochiy_klyuch');
    expect(created.body.account.hasCredentials).toBe(true);
    expect(JSON.stringify(created.body)).not.toContain('sk-live-123456');

    const { rows } = await hub.services.database.pool.query(
      'SELECT credentials_encrypted FROM accounts WHERE id = $1',
      [created.body.account.id],
    );
    expect(rows[0].credentials_encrypted).toMatch(/^d1\./);
    expect(rows[0].credentials_encrypted).not.toContain('sk-live');

    const invalid = await api('/accounts', {
      method: 'POST',
      body: { connectorId: 'flaky', label: 'Bad', credentials: { apiKey: 'x' } },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details[0].path).toBe('apiKey');

    const duplicate = await api('/accounts', {
      method: 'POST',
      body: { connectorId: 'demo', name: 'main', label: 'Dup', credentials: { secret: 's' } },
    });
    expect(duplicate.status).toBe(409);
  });

  it('updates, disables and deletes accounts, and the catalog follows', async () => {
    const accounts = (await api('/accounts')).body as { id: string; name: string }[];
    const second = accounts.find((a) => a.name === 'second')!;

    const patched = await api(`/accounts/${second.id}`, {
      method: 'PATCH',
      body: { label: 'Renamed', settings: { disabledActions: ['fail'] } },
    });
    expect(patched.body.label).toBe('Renamed');

    let tools = (await api('/tools')).body.tools as { name: string; inputSchema: any }[];
    const fail = tools.find((t) => t.name === 'demo_fail')!;
    expect(fail.inputSchema.properties.account.enum).toEqual(['main']);

    await api(`/accounts/${second.id}`, { method: 'PATCH', body: { enabled: false } });
    tools = (await api('/tools')).body.tools;
    expect(tools.find((t) => t.name === 'demo_echo')!.inputSchema.properties.account.enum).toEqual(['main']);

    expect((await api(`/accounts/${second.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(`/accounts/${second.id}`)).status).toBe(404);
  });

  it('switches the workspace to one tool per account', async () => {
    await api('/workspace', { method: 'PATCH', body: { settings: { toolExposure: 'per_account' } } });
    const { body } = await api('/tools');
    expect(body.exposure).toBe('per_account');
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining(['demo_main_echo', 'demo_second_echo']),
    );
    const called = await api('/tools/demo_second_echo/call', {
      method: 'POST',
      body: { arguments: { message: 'yo' } },
    });
    expect(called.body.content[0].text).toContain('(second): yo');
  });

  it('flags accounts whose credentials stopped working, times out slow calls and hides internal errors', async () => {
    const created = await api('/accounts', {
      method: 'POST',
      body: { connectorId: 'flaky', name: 'ci', label: 'CI', credentials: { apiKey: 'abcdef' } },
    });
    const expired = await api('/tools/flaky_expired/call', { method: 'POST', body: { arguments: {} } });
    expect(expired.body.isError).toBe(true);
    expect(expired.body.content[0].text).toContain('reconnect');
    expect((await api(`/accounts/${created.body.account.id}`)).body.status).toBe('needs_reauth');

    const slow = await api('/tools/flaky_slow/call', { method: 'POST', body: { arguments: {} } });
    expect(slow.body.content[0].text).toContain('timed out');

    const crash = await api('/tools/flaky_crash/call', { method: 'POST', body: { arguments: {} } });
    expect(crash.body.isError).toBe(true);
    expect(crash.body.content[0].text).not.toContain('hunter2');
    expect(crash.body.content[0].text).toMatch(/Internal error .*ref/);
  });

  it('lets MCP clients with static headers use a personal access token', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(hub.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'pat-client', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name === 'demo_echo')).toBe(true);
    await client.close();

    const tokens = await api('/tokens');
    const id = tokens.body[0].id;
    expect(tokens.body[0].tokenPrefix).toMatch(/^ac_pat_/);
    expect((await api(`/tokens/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api('/me')).status).toBe(401);
  });

  it('does not let AI apps manage the hub with their OAuth tokens', async () => {
    const workspace = (await hub.services.db.query.workspaces.findFirst())!;
    const { body } = await api('/me');
    expect(body.workspace.id).toBe(workspace.id);
    // An OAuth access token only carries the "mcp" scope.
    const grantToken = await createOAuthToken(hub);
    expect((await api('/me', { auth: grantToken })).status).toBe(401);
    const mcp = await fetch(hub.mcpUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${grantToken}` },
    });
    expect(mcp.status).not.toBe(401);
  });
});

async function createOAuthToken(hub: TestHub): Promise<string> {
  const { createHash } = await import('node:crypto');
  const registration = (await (
    await fetch(`${hub.baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://app.example/cb'], token_endpoint_auth_method: 'none' }),
    })
  ).json()) as { client_id: string };
  const verifier = 'x'.repeat(50);
  const url = new URL('/oauth/authorize', hub.baseUrl);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: registration.client_id,
    redirect_uri: 'https://app.example/cb',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  const callback = await new TestBrowser(hub.baseUrl).authorize(url);
  const tokens = (await (
    await fetch(`${hub.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: callback.searchParams.get('code')!,
        code_verifier: verifier,
        client_id: registration.client_id,
      }),
    })
  ).json()) as { access_token: string };
  return tokens.access_token;
}
