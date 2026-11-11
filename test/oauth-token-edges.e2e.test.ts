import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/lib/crypto.js';
import { resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

/**
 * Edge cases of the token and revocation endpoints (`src/oauth/server.ts`) that the happy-path
 * tests in mcp-oauth.e2e.test.ts do not reach: codes and refresh tokens used by the wrong client,
 * after expiry or for another resource, a replayed code, confidential clients and RFC 7009 revocation.
 */
describe('OAuth token endpoint edge cases', () => {
  let hub: TestHub;
  // One signed-in browser for the whole file: sign-in is rate-limited per IP.
  let browser: TestBrowser;
  const redirectUri = 'https://app.example/cb';
  const verifier = 'v'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  interface Client {
    client_id: string;
    client_secret?: string;
  }
  interface Tokens {
    access_token: string;
    refresh_token: string;
    scope: string;
  }

  const register = async (authMethod: 'none' | 'client_secret_basic' = 'none'): Promise<Client> => {
    const response = await fetch(`${hub.baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: authMethod }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as Client;
  };

  const authorize = async (client: Client): Promise<string> => {
    const url = new URL('/oauth/authorize', hub.baseUrl);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's',
      resource: hub.mcpUrl,
    }).toString();
    const callback = await browser.authorize(url);
    return callback.searchParams.get('code')!;
  };

  const post = async (path: string, params: Record<string, string>, authorization?: string) => {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (authorization) headers.authorization = authorization;
    const response = await fetch(`${hub.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(params),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };

  const exchange = (client: Client, code: string, extra: Record<string, string> = {}) =>
    post('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      ...extra,
    });

  const refresh = (client: Client, token: string, extra: Record<string, string> = {}) =>
    post('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: client.client_id,
      ...extra,
    });

  const mcpStatus = async (accessToken: string) =>
    (
      await fetch(hub.mcpUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: '{}',
      })
    ).status;

  const tokensFor = async (client: Client): Promise<Tokens> => {
    const result = await exchange(client, await authorize(client));
    expect(result.status).toBe(200);
    return result.body as Tokens;
  };

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub();
    browser = new TestBrowser(hub.baseUrl);
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('refuses unknown grant types and requests without a client', async () => {
    expect((await post('/oauth/token', { grant_type: 'client_credentials' })).body.error).toBe(
      'unsupported_grant_type',
    );
    const anonymous = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: 'x' });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error).toBe('invalid_client');
    const unknown = await post('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: 'x',
      client_id: 'nope',
    });
    expect(unknown.status).toBe(401);
  });

  it('refuses a code without a verifier, for another client, another redirect or another resource', async () => {
    const client = await register();
    const other = await register();
    const code = await authorize(client);

    expect((await exchange(client, code, { code_verifier: 'short' })).body.error).toBe('invalid_request');
    expect(
      (await post('/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id })).body
        .error,
    ).toBe('invalid_request');
    // Each failure below consumes a fresh code: codes are single-use even when the exchange fails.
    const stolen = await exchange(other, code);
    expect(stolen.body).toMatchObject({
      error: 'invalid_grant',
      error_description: expect.stringContaining('another client'),
    });

    const wrongRedirect = await exchange(client, await authorize(client), {
      redirect_uri: 'https://app.example/other',
    });
    expect(wrongRedirect.body.error_description).toContain('redirect_uri');

    const wrongResource = await exchange(client, await authorize(client), {
      resource: 'https://elsewhere.example/mcp',
    });
    expect(wrongResource.body.error).toBe('invalid_target');
  });

  it('refuses an expired code', async () => {
    const client = await register();
    const code = await authorize(client);
    await hub.services.database.pool.query(
      "UPDATE oauth_authorization_codes SET expires_at = now() - interval '1 minute' WHERE code_hash = $1",
      [hashToken(code)],
    );
    const result = await exchange(client, code);
    expect(result.body).toMatchObject({
      error: 'invalid_grant',
      error_description: expect.stringContaining('expired'),
    });
  });

  it('revokes everything issued from a code when the code is replayed', async () => {
    const client = await register();
    const code = await authorize(client);
    const first = await exchange(client, code);
    expect(first.status).toBe(200);
    expect(await mcpStatus(first.body.access_token)).not.toBe(401);

    const replay = await exchange(client, code);
    expect(replay.body.error).toBe('invalid_grant');
    // RFC 6749 §4.1.2: the tokens from the first exchange stop working.
    expect(await mcpStatus(first.body.access_token)).toBe(401);
    expect((await refresh(client, first.body.refresh_token)).status).toBe(400);
  });

  it('keeps refresh tokens to their client, their lifetime, their scopes and their resource', async () => {
    const client = await register();
    const other = await register();
    const tokens = await tokensFor(client);

    expect((await refresh(other, tokens.refresh_token)).body.error).toBe('invalid_grant');
    expect((await refresh(client, tokens.refresh_token, { scope: `${tokens.scope} admin` })).body.error).toBe(
      'invalid_scope',
    );
    expect(
      (await refresh(client, tokens.refresh_token, { resource: 'https://elsewhere.example/mcp' })).body.error,
    ).toBe('invalid_target');
    expect(
      (await post('/oauth/token', { grant_type: 'refresh_token', client_id: client.client_id })).body.error,
    ).toBe('invalid_request');

    // Asking for the same (or a narrower) set of scopes works.
    const narrowed = await refresh(client, tokens.refresh_token, {
      scope: tokens.scope,
      resource: hub.mcpUrl,
    });
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.scope).toBe(tokens.scope);

    await hub.services.database.pool.query(
      "UPDATE oauth_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1",
      [hashToken(narrowed.body.refresh_token)],
    );
    expect((await refresh(client, narrowed.body.refresh_token)).body.error).toBe('invalid_grant');
  });

  it('authenticates confidential clients with HTTP Basic or the form secret', async () => {
    const client = await register('client_secret_basic');
    expect(client.client_secret).toBeTruthy();
    const basic = (id: string, secret: string) =>
      `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
    const code = await authorize(client);
    const params = {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    };

    expect((await post('/oauth/token', params, basic(client.client_id, 'wrong'))).status).toBe(401);
    expect(
      (await post('/oauth/token', params, `Basic ${Buffer.from('no-colon').toString('base64')}`)).status,
    ).toBe(401);
    // client_id in the form must agree with the Authorization header.
    expect(
      (
        await post(
          '/oauth/token',
          { ...params, client_id: 'someone-else' },
          basic(client.client_id, client.client_secret!),
        )
      ).body.error,
    ).toBe('invalid_request');
    expect((await post('/oauth/token', { ...params, client_id: client.client_id })).status).toBe(401);

    const ok = await post('/oauth/token', params, basic(client.client_id, client.client_secret!));
    expect(ok.status).toBe(200);
    const viaForm = await post('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: ok.body.refresh_token,
      client_id: client.client_id,
      client_secret: client.client_secret!,
    });
    expect(viaForm.status).toBe(200);
  });

  it('revokes access tokens alone and refresh tokens with their grant, ignoring other clients', async () => {
    const client = await register();
    const other = await register();
    const tokens = await tokensFor(client);

    expect((await post('/oauth/revoke', { client_id: client.client_id })).body.error).toBe('invalid_request');
    // Unknown tokens and tokens of another client are ignored without an error (RFC 7009).
    expect((await post('/oauth/revoke', { client_id: client.client_id, token: 'unknown' })).status).toBe(200);
    expect(
      (await post('/oauth/revoke', { client_id: other.client_id, token: tokens.access_token })).status,
    ).toBe(200);
    expect(await mcpStatus(tokens.access_token)).not.toBe(401);

    expect(
      (await post('/oauth/revoke', { client_id: client.client_id, token: tokens.access_token })).status,
    ).toBe(200);
    expect(await mcpStatus(tokens.access_token)).toBe(401);
    // Revoking only the access token leaves the grant: the app can refresh.
    const refreshed = await refresh(client, tokens.refresh_token);
    expect(refreshed.status).toBe(200);

    expect(
      (await post('/oauth/revoke', { client_id: client.client_id, token: refreshed.body.refresh_token }))
        .status,
    ).toBe(200);
    expect(await mcpStatus(refreshed.body.access_token)).toBe(401);
    expect((await refresh(client, refreshed.body.refresh_token)).status).toBe(400);
  });
});
