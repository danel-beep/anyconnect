import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OAuthClient } from '../src/oauth/clients.js';
import { suggestClientIdentity } from '../src/security/clients.js';
import { AI_CLIENTS, type AiClientProfile } from './e2e/ai-clients.js';
import { startTestHub, type TestHub } from './helpers.js';

/**
 * What popular AI clients send when they connect, so that a quirk of one client (extra grant types,
 * nulls, many redirect URIs, custom URL schemes) never locks it out. The real clients' shapes live
 * in `e2e/ai-clients.ts` (shared with the end-to-end connection tests); odd shapes seen in the wild
 * are added here.
 */
const DOCUMENTS = Object.fromEntries(
  AI_CLIENTS.flatMap((c) => (c.identity.kind === 'metadata_document' ? [[c.identity.url, c]] : [])),
) as Record<string, AiClientProfile & { identity: { kind: 'metadata_document' } }>;

/** Dynamic registration requests: [name, body, redirect_uri used at /oauth/authorize]. */
const REGISTRATIONS: [string, Record<string, unknown>, string][] = [
  ...AI_CLIENTS.flatMap((c): [string, Record<string, unknown>, string][] =>
    c.identity.kind === 'registration' ? [[c.id, c.identity.body, c.redirectUrl]] : [],
  ),
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
        const doc = DOCUMENTS[url]?.identity.document;
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

  it.each(Object.keys(DOCUMENTS))('accepts the metadata document %s', async (clientId) => {
    await expectAuthorizeAccepted(clientId, DOCUMENTS[clientId]!.redirectUrl);
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

describe('which AI client a connection belongs to', () => {
  const clientOf = (profile: AiClientProfile) =>
    (profile.identity.kind === 'metadata_document'
      ? {
          id: profile.identity.url,
          registrationType: 'metadata_document',
          metadata: profile.identity.document,
        }
      : {
          id: 'cli_test',
          registrationType: 'dynamic',
          metadata: profile.identity.body,
        }) as unknown as OAuthClient;

  it.each(AI_CLIENTS.map((c) => [c.id, c] as const))('recognises %s', (_id, profile) => {
    expect(suggestClientIdentity(clientOf(profile), profile.redirectUrl).name).toBe(profile.expectedName);
  });

  it('keeps Claude under the key its rules already use, and Claude Code apart from it', () => {
    const [claude, code] = ['claude', 'claude-code'].map((id) => AI_CLIENTS.find((c) => c.id === id)!);
    const web = suggestClientIdentity(clientOf(claude!), claude!.redirectUrl);
    const cli = suggestClientIdentity(clientOf(code!), code!.redirectUrl);
    expect(web).toEqual({ matchKey: 'app:claude', name: 'Claude', verified: true });
    expect(cli).toEqual({
      matchKey: 'cimd:https://claude.ai/oauth/claude-code-client-metadata',
      name: 'Claude Code',
      verified: true,
    });
  });

  it('does not give a well-known name to a registered client that only claims it', () => {
    const impostor = {
      id: 'cli_x',
      registrationType: 'dynamic',
      metadata: { client_name: 'Claude', redirect_uris: ['https://evil.example/cb'] },
    } as unknown as OAuthClient;
    expect(suggestClientIdentity(impostor, 'https://evil.example/cb')).toEqual({
      matchKey: 'dcr:claude@evil.example',
      name: 'Claude',
      verified: false,
    });
  });
});
