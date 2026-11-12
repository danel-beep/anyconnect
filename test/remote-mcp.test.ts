import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actionNamesFor,
  defineRemoteMcpConnector,
  type RemoteMcpTool,
  riskFromAnnotations,
  visibleText,
  withoutRiskDowngrades,
} from '../src/connectors/mcp-remote/connector.js';
import { validateConnector } from '../src/connectors/registry.js';
import { actionRisk } from '../src/connectors/sdk.js';
import type { Principal } from '../src/core/principal.js';
import { ensureTestDatabase, resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

/**
 * Two real hubs: "upstream" is a remote MCP server with OAuth (its demo accounts provide the
 * tools), "hub" connects it as an external MCP service: discovery, automatic client registration,
 * the connect flow through the upstream consent page, tool listing and calls.
 */
describe('remote MCP servers as services', () => {
  let upstream: TestHub;
  let hub: TestHub;
  let browser: TestBrowser;
  let principal: Principal;
  let pat: string;

  const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${hub.baseUrl}/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${pat}`, 'content-type': 'application/json' },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };

  beforeAll(async () => {
    const upstreamDb = await ensureTestDatabase('upstream');
    await resetDatabase(upstreamDb);
    await resetDatabase();
    upstream = await startTestHub({ databaseUrl: upstreamDb });
    hub = await startTestHub({ seed: false });
    browser = new TestBrowser(hub.baseUrl);
    await browser.login();
    const user = (await hub.services.db.query.users.findFirst())!;
    const workspace = (await hub.services.db.query.workspaces.findFirst())!;
    principal = { kind: 'session', userId: user.id, workspaceId: workspace.id, scopes: ['mcp', 'api'] };
    // Made in the signed-in browser, so the token opens the user's vault like one from the Apps page.
    ({ token: pat } = await browser.inVault(hub.services, () =>
      hub.services.apiTokens.create({
        workspaceId: workspace.id,
        userId: user.id,
        name: 'test',
        scopes: ['api'],
      }),
    ));
  });

  afterAll(async () => {
    await hub?.close();
    await upstream?.close();
  });

  /** A call from the user's own AI app: inside a request that brings their vault. */
  async function call(name: string, args: Record<string, unknown>) {
    return browser.inVault(hub.services, async () => {
      const catalog = await hub.services.hub.getCatalog(principal);
      return hub.services.hub.callTool(principal, catalog, name, args);
    });
  }

  it('discovers OAuth, registers itself as a client, connects an account and proxies tools', async () => {
    const added = await api('/services', {
      method: 'POST',
      body: { kind: 'mcp', url: upstream.mcpUrl, name: 'Upstream', id: 'upstream' },
    });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      connectorId: 'upstream',
      kind: 'mcp',
      auth: 'oauth2',
      tools: 0,
      valid: true,
    });

    // Dynamic client registration happened at the upstream authorization server.
    const apps = (await api('/oauth/apps')).body as { providerId: string; clientId: string }[];
    expect(apps).toEqual([expect.objectContaining({ providerId: 'mcp_upstream', source: 'workspace' })]);
    const registered = await upstream.services.db.query.oauthClients.findFirst();
    expect(registered?.id).toBe(apps[0]!.clientId);

    // Connect: the hub sends the user to the upstream consent page, which redirects back.
    const start = await browser.request('/connect/upstream?label=Upstream%20hub');
    expect(start.status).toBe(302);
    const authorizationUrl = new URL(start.headers.get('location')!);
    expect(authorizationUrl.origin).toBe(upstream.baseUrl);
    expect(authorizationUrl.searchParams.get('resource')).toBe(upstream.mcpUrl);
    const upstreamBrowser = new TestBrowser(upstream.baseUrl);
    const callback = await upstreamBrowser.authorize(authorizationUrl);
    expect(callback.origin + callback.pathname).toBe(`${hub.baseUrl}/connect/callback`);
    const done = await browser.request(callback.pathname + callback.search);
    expect(done.status).toBe(200);

    // The tool list was fetched right after the account connected.
    const services = (await api('/services')).body as { tools: number; toolsRefreshedAt: string | null }[];
    expect(services[0]!.tools).toBeGreaterThan(2);
    const catalog = await hub.services.hub.getCatalog(principal);
    const echo = catalog.tools.find((t) => t.name === 'upstream_demo_echo')!;
    expect(echo).toBeDefined();
    // The upstream `account` argument is renamed so it does not clash with the hub's own.
    const props = Object.keys(echo.inputSchema.properties as object);
    expect(props).toEqual(['account', 'account_arg', 'message']);
    expect(echo.annotations.readOnlyHint).toBe(true);

    const result = await call('upstream_demo_echo', { account_arg: 'second', message: 'через два хаба' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('Привет from account "Demo — second"'),
    });

    const failing = await call('upstream_demo_fail', { account_arg: 'main', kind: 'not_found' });
    expect(failing.isError).toBe(true);
    expect(failing.content[0]).toMatchObject({ text: expect.stringContaining('Simulated not_found') });
  });

  it('refreshes the upstream token when it is rejected', async () => {
    // Revoke every upstream access token: the next call gets 401, refreshes and succeeds.
    await upstream.services.database.pool.query(
      "update oauth_tokens set revoked_at = now() where type = 'access'",
    );
    const result = await call('upstream_demo_echo', { account_arg: 'main', message: 'again' });
    expect(result.isError).toBeUndefined();
  });

  it('accepts servers with static tokens', async () => {
    const upstreamUser = (await upstream.services.db.query.users.findFirst())!;
    const upstreamWorkspace = (await upstream.services.db.query.workspaces.findFirst())!;
    const { token } = await upstream.services.apiTokens.create({
      workspaceId: upstreamWorkspace.id,
      userId: upstreamUser.id,
      name: 'for the hub',
      scopes: ['mcp'],
    });
    const added = await api('/services', {
      method: 'POST',
      body: { kind: 'mcp', url: upstream.mcpUrl, name: 'Upstream token', id: 'upstream_pat', auth: 'bearer' },
    });
    expect(added.body).toMatchObject({ auth: 'bearer', tools: 0 });
    const account = await api('/accounts', {
      method: 'POST',
      body: { connectorId: 'upstream_pat', label: 'PAT', credentials: { token } },
    });
    expect(account.status).toBe(201);
    expect(account.body.test).toMatchObject({ ok: true });
    const result = await call('upstream_pat_demo_account_info', { account_arg: 'main' });
    expect(result.isError).toBeUndefined();

    expect((await api('/services/upstream_pat', { method: 'DELETE' })).status).toBe(409);
  });

  it('adds HTTP manifests without code and validates them', async () => {
    const manifest = {
      id: 'httpbin_like',
      name: 'Upstream REST',
      description: 'The upstream REST API as a manifest',
      baseUrl: `${upstream.baseUrl}/api/v1`,
      auth: { type: 'bearer' },
      actions: [{ name: 'me', description: 'Who am I', request: { method: 'GET', path: '/me' } }],
    };
    expect((await api('/services', { method: 'POST', body: { kind: 'manifest', manifest } })).status).toBe(
      201,
    );
    const connectors = (await api('/connectors')).body as { id: string }[];
    expect(connectors.map((c) => c.id)).toContain('httpbin_like');

    const duplicate = await api('/services', { method: 'POST', body: { kind: 'manifest', manifest } });
    expect(duplicate.status).toBe(409);
    const builtinId = await api('/services', {
      method: 'POST',
      body: { kind: 'manifest', manifest: { ...manifest, id: 'demo' } },
    });
    expect(builtinId.status).toBe(409);
    const invalid = await api('/services', {
      method: 'POST',
      body: {
        kind: 'manifest',
        manifest: {
          ...manifest,
          id: 'broken',
          actions: [{ name: 'x', description: 'x', request: { method: 'GET', path: '/{id}' } }],
        },
      },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.message).toMatch(/path parameter \{id\}/);

    // Editing replaces the manifest; the id is fixed and the result is validated like on add.
    const edited = { ...manifest, actions: [{ ...manifest.actions[0]!, risk: 'read' }] };
    expect(
      (await api('/services/httpbin_like', { method: 'PATCH', body: { manifest: edited } })).status,
    ).toBe(200);
    const renamed = await api('/services/httpbin_like', {
      method: 'PATCH',
      body: { manifest: { ...manifest, id: 'other' } },
    });
    expect(renamed.status).toBe(400);
    const broken = await api('/services/httpbin_like', {
      method: 'PATCH',
      body: { manifest: { ...manifest, actions: [{ ...manifest.actions[0]!, capability: 'tasks.fly' }] } },
    });
    expect(broken.status).toBe(400);

    expect((await api('/services/httpbin_like', { method: 'DELETE' })).status).toBe(204);
  });

  it('publishes its client metadata document', async () => {
    const response = await fetch(`${hub.baseUrl}/connect/client-metadata.json`);
    expect(await response.json()).toMatchObject({
      client_id: `${hub.baseUrl}/connect/client-metadata.json`,
      redirect_uris: [`${hub.baseUrl}/connect/callback`],
      token_endpoint_auth_method: 'none',
    });
  });

  it('maps remote tool names to unique action names', () => {
    const names = actionNamesFor([
      { name: 'searchPages', inputSchema: {} },
      { name: 'search-pages', inputSchema: {} },
      { name: '42 things', inputSchema: {} },
      { name: 'x'.repeat(80), inputSchema: {} },
    ]);
    expect([...names.values()]).toEqual(['search_pages', 'search_pages_2', 't_42_things', 'x'.repeat(40)]);
  });

  it('renames every input the hub reserves', () => {
    const connector = defineRemoteMcpConnector({
      id: 'remote',
      name: 'Remote',
      description: 'A remote server.',
      url: 'https://example.com/mcp',
      auth: { type: 'none' },
      tools: [
        {
          name: 'query',
          inputSchema: {
            type: 'object',
            properties: { account: { type: 'string' }, fields: { type: 'array' }, q: { type: 'string' } },
            required: ['fields'],
          },
        },
      ],
    });
    expect(() => validateConnector(connector)).not.toThrow();
    const schema = connector.actions[0]!.inputSchema!;
    expect(Object.keys(schema.properties as object)).toEqual(['account_arg', 'fields_arg', 'q']);
    expect(schema.required).toEqual(['fields_arg']);
  });

  it('derives risk from annotations with the MCP defaults and lets the workspace override it', () => {
    const connector = defineRemoteMcpConnector({
      id: 'remote',
      name: 'Remote',
      description: 'x',
      url: 'https://remote.example/mcp',
      auth: { type: 'none' },
      tools: [
        { name: 'read', inputSchema: {}, annotations: { readOnlyHint: true } },
        { name: 'create', inputSchema: {}, annotations: { destructiveHint: false } },
        { name: 'unknown', inputSchema: {} },
        { name: 'wipe', inputSchema: {}, annotations: { destructiveHint: true } },
      ],
      toolRisk: { wipe: 'write' },
    });
    expect(connector.actions.map((a) => actionRisk(a))).toEqual(['read', 'write', 'dangerous', 'write']);
  });

  it('edits a remote server: per-tool risk overrides are validated and applied', async () => {
    const toolRisk = async () => {
      const catalog = await hub.services.hub.getCatalog(principal);
      return catalog.tools.find((t) => t.name === 'upstream_demo_echo')!.risk;
    };
    expect(await toolRisk()).toBe('read');
    const patched = await api('/services/upstream', {
      method: 'PATCH',
      body: { toolRisk: { demo_echo: 'dangerous' }, description: 'The other hub' },
    });
    expect(patched.status).toBe(200);
    expect(await toolRisk()).toBe('dangerous');
    expect(
      (await api('/services/upstream', { method: 'PATCH', body: { toolRisk: { demo_echo: null } } })).status,
    ).toBe(200);
    expect(await toolRisk()).toBe('read');

    const unknown = await api('/services/upstream', {
      method: 'PATCH',
      body: { toolRisk: { nope: 'read' } },
    });
    expect(unknown.status).toBe(400);
    const extra = await api('/services/upstream', { method: 'PATCH', body: { url: 'https://evil.example' } });
    expect(extra.status).toBe(400);
  });
});

describe('what a remote server says about its tools', () => {
  const HIDDEN = '\u200B\u202E\u{E0049}\u{E0067}\u0007';

  it('passes on only the text a person can see, capped', () => {
    expect(visibleText(`Reads${HIDDEN} notes\n\tline two `, 100)).toBe('Reads notes\n\tline two');
    expect(visibleText('x'.repeat(5000), 2000)).toHaveLength(2000);

    const connector = defineRemoteMcpConnector({
      id: 'notes',
      name: 'Notes',
      description: 'Remote notes',
      url: 'https://notes.example/mcp',
      auth: { type: 'none' },
      tools: [
        {
          name: 'find',
          title: `Find${HIDDEN} notes`,
          description: `Finds notes.${HIDDEN}${'!'.repeat(5000)}`,
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: `Words${HIDDEN} to look for` },
              filter: {
                type: 'object',
                properties: { tag: { type: 'string', title: `Tag${HIDDEN}`, description: 'y'.repeat(5000) } },
              },
            },
          },
          annotations: { readOnlyHint: true },
        },
        { name: 'blank', description: HIDDEN, inputSchema: { type: 'object' } },
      ],
    });
    const [find, blank] = connector.actions;
    expect(find!.title).toBe('Find notes');
    expect(find!.description).toHaveLength(2000);
    expect(find!.description.startsWith('Finds notes.!')).toBe(true);
    const schema = find!.inputSchema as { properties: Record<string, any> };
    expect(schema.properties.query.description).toBe('Words to look for');
    expect(schema.properties.filter.properties.tag.title).toBe('Tag');
    expect(schema.properties.filter.properties.tag.description).toHaveLength(2000);
    // A description made only of invisible characters is no description.
    expect(blank!.description).toBe('Runs "blank" on Notes.');
  });

  it('does not let a refresh nobody reviews lower the risk of a tool', () => {
    const tool = (name: string, annotations?: RemoteMcpTool['annotations']): RemoteMcpTool => ({
      name,
      description: `${name} v1`,
      inputSchema: { type: 'object' },
      ...(annotations ? { annotations } : {}),
    });
    const before = [
      tool('wipe'),
      tool('post', { destructiveHint: false }),
      tool('list', { readOnlyHint: true }),
      tool('rename', { destructiveHint: false }),
    ];
    const after = withoutRiskDowngrades(before, [
      // "Now harmless": stays as guarded as it was.
      { ...tool('wipe', { readOnlyHint: true }), description: 'wipe v2' },
      { ...tool('post', { readOnlyHint: true }), description: 'post v2' },
      // Stricter or unchanged annotations and new tools are taken as they are.
      tool('list'),
      tool('rename', { destructiveHint: false, idempotentHint: true }),
      tool('extra', { readOnlyHint: true }),
    ]);
    expect(after.map((t) => [t.name, riskFromAnnotations(t)])).toEqual([
      ['wipe', 'dangerous'],
      ['post', 'write'],
      ['list', 'dangerous'],
      ['rename', 'write'],
      ['extra', 'read'],
    ]);
    // Everything but the annotations follows the server.
    expect(after[0]!.description).toBe('wipe v2');
    expect(after[0]!.annotations).toBeUndefined();
    expect(after[3]!.annotations).toEqual({ destructiveHint: false, idempotentHint: true });
  });
});
