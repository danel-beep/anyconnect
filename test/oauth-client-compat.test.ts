import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestHub, type TestHub } from './helpers.js';

/**
 * What popular AI clients send when they connect, so that a quirk of one client (extra grant types,
 * nulls, many redirect URIs, custom URL schemes) never locks it out. Shapes are copied from the
 * clients' published metadata documents and registration requests.
 */
const CLAUDE_DOCUMENTS: Record<string, Record<string, unknown>> = {
  'https://claude.ai/oauth/mcp-oauth-client-metadata': {
    client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    client_name: 'Claude',
    client_uri: 'https://claude.ai',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
  'https://claude.ai/oauth/claude-code-client-metadata': {
    client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
    client_name: 'Claude Code',
    client_uri: 'https://claude.ai',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
};

const REDIRECTS: Record<string, string> = {
  'https://claude.ai/oauth/mcp-oauth-client-metadata': 'https://claude.ai/api/mcp/auth_callback',
  'https://claude.ai/oauth/claude-code-client-metadata': 'http://localhost:54123/callback',
};

/** Dynamic registration requests: [name, body, redirect_uri used at /oauth/authorize]. */
const REGISTRATIONS: [string, Record<string, unknown>, string][] = [
  [
    'ChatGPT',
    {
      client_name: 'ChatGPT',
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    },
    'https://chatgpt.com/connector_platform_oauth_redirect',
  ],
  [
    'VS Code',
    {
      client_name: 'Visual Studio Code',
      client_uri: 'https://code.visualstudio.com',
      grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
      response_types: ['code'],
      redirect_uris: [
        'https://insiders.vscode.dev/redirect',
        'https://vscode.dev/redirect',
        'http://localhost',
        'http://127.0.0.1',
        'http://localhost:33418',
        'http://127.0.0.1:33418',
      ],
      token_endpoint_auth_method: 'none',
    },
    'http://127.0.0.1:33418/',
  ],
  [
    'Cursor',
    {
      client_name: 'Cursor',
      redirect_uris: ['cursor://anysphere.cursor-retrieval/oauth/user-manyplug/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    'cursor://anysphere.cursor-retrieval/oauth/user-manyplug/callback',
  ],
  [
    'Gemini CLI',
    {
      client_name: 'Gemini CLI MCP Client',
      redirect_uris: ['http://localhost:7777/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      code_challenge_method: ['S256'],
    },
    'http://localhost:7777/oauth/callback',
  ],
  [
    'Codex CLI',
    {
      client_name: 'Codex',
      redirect_uris: ['http://127.0.0.1:41234/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    'http://127.0.0.1:50999/callback',
  ],
  [
    'a client with nulls and a data: logo',
    {
      client_name: null,
      client_uri: null,
      logo_uri: `data:image/png;base64,${'A'.repeat(5000)}`,
      contacts: null,
      scope: null,
      redirect_uris: ['https://app.example/callback'],
      grant_types: ['authorization_code', 'refresh_token', 'client_credentials'],
      response_types: ['code', 'token'],
      token_endpoint_auth_method: null,
      jwks: { keys: [] },
    },
    'https://app.example/callback',
  ],
];

describe('AI client compatibility', () => {
  let hub: TestHub;
  beforeAll(async () => {
    hub = await startTestHub({
      fetchDocument: async (url) => {
        const doc = CLAUDE_DOCUMENTS[url];
        return doc
          ? { status: 200, headers: { 'cache-control': 'max-age=600' }, body: JSON.stringify(doc) }
          : { status: 404, headers: {}, body: '' };
      },
    });
  });
  afterAll(async () => {
    await hub.close();
  });

  /** An /oauth/authorize request reaches sign-in (not an error page) for this client. */
  async function expectAuthorizeAccepted(clientId: string, redirectUri: string) {
    const url = new URL('/oauth/authorize', hub.baseUrl);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: createHash('sha256').update('v'.repeat(64)).digest('base64url'),
      code_challenge_method: 'S256',
      state: 'st',
      scope: 'mcp openid profile',
      resource: hub.mcpUrl,
    }).toString();
    const res = await fetch(url, { redirect: 'manual' });
    expect(res.status, await res.clone().text()).toBe(302);
    expect(res.headers.get('location')).toContain('/login');
  }

  it.each(Object.keys(CLAUDE_DOCUMENTS))('accepts the metadata document %s', async (clientId) => {
    await expectAuthorizeAccepted(clientId, REDIRECTS[clientId]!);
  });

  it.each(REGISTRATIONS)('registers %s', async (_name, body, redirectUri) => {
    const res = await fetch(`${hub.baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const registered = (await res.json()) as Record<string, unknown>;
    expect(res.status, JSON.stringify(registered)).toBe(201);
    expect(registered.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(registered.response_types).toEqual(['code']);
    await expectAuthorizeAccepted(registered.client_id as string, redirectUri);
  });
});
