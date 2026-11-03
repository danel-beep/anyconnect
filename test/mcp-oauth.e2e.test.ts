import {
  Client,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/lib/crypto.js';
import { resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

type Stored = Parameters<NonNullable<OAuthClientProvider['saveClientInformation']>>[0];
type Tokens = Parameters<OAuthClientProvider['saveTokens']>[0];

/** In-memory OAuth client, the way Claude Code or another MCP client would behave. */
class MemoryOAuthProvider implements OAuthClientProvider {
  client?: Stored;
  savedTokens?: Tokens;
  verifier = '';
  authorizationUrl?: URL;
  clientMetadataUrl?: string;

  constructor(
    readonly redirectUrl = 'http://localhost:7777/callback',
    options: { clientMetadataUrl?: string } = {},
  ) {
    if (options.clientMetadataUrl) this.clientMetadataUrl = options.clientMetadataUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Test MCP Client',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.client;
  }
  saveClientInformation(info: Stored) {
    this.client = info;
  }
  tokens() {
    return this.savedTokens;
  }
  saveTokens(tokens: Tokens) {
    this.savedTokens = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
  discovery?: unknown;
  saveDiscoveryState(state: unknown) {
    this.discovery = state;
  }
  discoveryState() {
    return this.discovery as never;
  }
}

async function connectWithOAuth(
  hub: TestHub,
  provider: MemoryOAuthProvider,
  modern = false,
): Promise<Client> {
  const browser = new TestBrowser(hub.baseUrl);
  const first = new StreamableHTTPClientTransport(new URL(hub.mcpUrl), { authProvider: provider });
  const probe = new Client({ name: 'probe', version: '1.0.0' });
  await expect(probe.connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
  expect(provider.authorizationUrl).toBeDefined();

  const callback = await browser.authorize(provider.authorizationUrl!);
  expect(callback.origin + callback.pathname).toBe(provider.redirectUrl);
  expect(callback.searchParams.get('iss')).toBe(hub.baseUrl);
  await first.finishAuth(callback.searchParams);

  const transport = new StreamableHTTPClientTransport(new URL(hub.mcpUrl), { authProvider: provider });
  const client = new Client(
    { name: 'test', version: '1.0.0' },
    modern ? { versionNegotiation: { mode: 'auto' } } : {},
  );
  await client.connect(transport);
  return client;
}

describe('MCP over OAuth (end to end with the official MCP client)', () => {
  let hub: TestHub;

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await hub?.close();
    hub = await startTestHub();
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('discovers the authorization server, signs in, and lists the hub tools (2025 protocol)', async () => {
    const provider = new MemoryOAuthProvider();
    const client = await connectWithOAuth(hub, provider);
    expect(provider.client?.client_id).toMatch(/^cli_/);
    expect(provider.savedTokens?.access_token).toMatch(/^ac_at_/);
    expect(provider.savedTokens?.refresh_token).toMatch(/^ac_rt_/);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['anyconnect_list_accounts', 'demo_account_info', 'demo_echo', 'demo_fail']);

    const echo = tools.find((t) => t.name === 'demo_echo')!;
    const accountProperty = (echo.inputSchema.properties as Record<string, { enum?: string[] }>).account;
    expect(accountProperty?.enum).toEqual(['main', 'second']);
    expect(echo.inputSchema.required).toContain('account');
    expect(echo.annotations?.readOnlyHint).toBe(true);

    const result = await client.callTool({
      name: 'demo_echo',
      arguments: { account: 'second', message: 'hi' },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain('Привет from account \\"Demo — second\\" (second): hi');

    const listed = await client.callTool({ name: 'anyconnect_list_accounts', arguments: {} });
    expect(JSON.stringify(listed.content)).toContain('second');
    await client.close();
  });

  it('serves the 2026-07-28 protocol to clients that negotiate it', async () => {
    const client = await connectWithOAuth(hub, new MemoryOAuthProvider(), true);
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name === 'demo_echo')).toBe(true);
    const result = await client.callTool({ name: 'demo_account_info', arguments: { account: 'main' } });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.structuredContent)).toContain('"name":"main"');
    await client.close();
  });

  it('routes calls per account and reports tool errors without failing the protocol', async () => {
    const client = await connectWithOAuth(hub, new MemoryOAuthProvider());
    // Several accounts are connected, so the account argument is required by the tool schema.
    const missing = await client.callTool({ name: 'demo_echo', arguments: { message: 'x' } });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain('account');

    const failing = await client.callTool({
      name: 'demo_fail',
      arguments: { account: 'main', kind: 'not_found' },
    });
    expect(failing.isError).toBe(true);
    expect(JSON.stringify(failing.content)).toContain('Simulated not_found error');

    const main = await client.callTool({ name: 'demo_account_info', arguments: { account: 'main' } });
    const second = await client.callTool({ name: 'demo_account_info', arguments: { account: 'second' } });
    const fp = (r: typeof main) => (r.structuredContent as { secretFingerprint: string }).secretFingerprint;
    expect(fp(main)).not.toBe(fp(second));
    await client.close();

    // Every call that reached the hub is in the audit log (newest first), with the account it used.
    const workspace = (await hub.services.db.query.workspaces.findFirst())!;
    const calls = await hub.services.hub.recentToolCalls(workspace.id);
    expect(calls.map((c) => `${c.toolName}:${c.status}`)).toEqual([
      'demo_account_info:ok',
      'demo_account_info:ok',
      'demo_fail:error',
    ]);
    expect(calls.every((c) => c.accountId && c.principalType === 'oauth' && c.clientId)).toBe(true);
  });

  it('identifies clients by a Client ID Metadata Document instead of registering them', async () => {
    const clientId = 'https://client.example/oauth/metadata.json';
    const redirectUrl = 'http://localhost:7788/callback';
    await hub.close();
    hub = await startTestHub({
      fetchDocument: async (url) => {
        expect(url).toBe(clientId);
        return {
          status: 200,
          headers: { 'cache-control': 'max-age=600' },
          body: JSON.stringify({
            client_id: clientId,
            client_name: 'Metadata Client',
            redirect_uris: ['http://localhost/callback'],
            grant_types: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_method: 'none',
          }),
        };
      },
    });
    const provider = new MemoryOAuthProvider(redirectUrl, { clientMetadataUrl: clientId });
    const client = await connectWithOAuth(hub, provider);
    expect(provider.client?.client_id).toBe(clientId);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(1);
    await client.close();
  });

  it('rotates refresh tokens and revokes the grant when an old one is replayed', async () => {
    const provider = new MemoryOAuthProvider();
    await (await connectWithOAuth(hub, provider)).close();
    const clientId = provider.client!.client_id;
    const refresh = async (token: string) =>
      fetch(`${hub.baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId }),
      });

    const original = provider.savedTokens!.refresh_token!;
    const first = await refresh(original);
    expect(first.status).toBe(200);
    const rotated = (await first.json()) as { refresh_token: string; access_token: string };
    expect(rotated.refresh_token).not.toBe(original);

    // Within the grace period the old token still works (lost responses, concurrent refreshes)...
    expect((await refresh(original)).status).toBe(200);
    // ...but once the grace period has passed, reuse revokes the whole grant.
    await hub.services.database.pool.query(
      "UPDATE oauth_tokens SET rotated_at = now() - interval '10 minutes' WHERE token_hash = $1",
      [hashToken(original)],
    );
    const replay = await refresh(original);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
    expect((await refresh(rotated.refresh_token)).status).toBe(400);

    const mcp = await fetch(hub.mcpUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${rotated.access_token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(mcp.status).toBe(401);
  });

  it('rejects a wrong PKCE verifier and a replayed authorization code', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    const registration = await fetch(`${hub.baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://app.example/cb'], token_endpoint_auth_method: 'none' }),
    });
    expect(registration.status).toBe(201);
    const { client_id } = (await registration.json()) as { client_id: string };
    const verifier = 'v'.repeat(64);
    const { createHash } = await import('node:crypto');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = new URL('/oauth/authorize', hub.baseUrl);
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: 'https://app.example/cb',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: hub.mcpUrl,
    }).toString();
    const callback = await browser.authorize(authorize);
    expect(callback.searchParams.get('state')).toBe('xyz');
    const code = callback.searchParams.get('code')!;
    const exchange = (codeVerifier: string) =>
      fetch(`${hub.baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: codeVerifier,
          client_id,
          redirect_uri: 'https://app.example/cb',
        }),
      });
    expect((await exchange('w'.repeat(64))).status).toBe(400);
    // The code was consumed by the failed attempt: codes are strictly single-use.
    expect((await exchange(verifier)).status).toBe(400);
  });

  it('sends errors back to the client when the user denies access', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    const provider = new MemoryOAuthProvider();
    const transport = new StreamableHTTPClientTransport(new URL(hub.mcpUrl), { authProvider: provider });
    await expect(new Client({ name: 'x', version: '1' }).connect(transport)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    const callback = await browser.authorize(provider.authorizationUrl!, 'deny');
    expect(callback.searchParams.get('error')).toBe('access_denied');
    expect(callback.searchParams.get('iss')).toBe(hub.baseUrl);
  });
});
