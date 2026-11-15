import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { oauthClients } from '../src/db/schema.js';
import type { SafeFetchResponse } from '../src/lib/safe-fetch.js';
import { ClientRegistry, OAuthProtocolError } from '../src/oauth/clients.js';
import { validateRedirectUri } from '../src/oauth/redirect.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

/**
 * Client registration and Client ID Metadata Documents off the happy path, and the checks of an
 * authorization request before the user sees a consent page.
 */
describe('OAuth clients', () => {
  let hub: TestHub;
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  const docUrl = 'https://app.example.com/oauth/client.json';
  const doc = (extra: Record<string, unknown> = {}) => ({
    client_id: docUrl,
    client_name: 'Example',
    redirect_uris: ['https://app.example.com/callback'],
    token_endpoint_auth_method: 'none',
    ...extra,
  });
  let answer: () => Promise<SafeFetchResponse>;
  const registry = (options: Partial<ConstructorParameters<typeof ClientRegistry>[1]> = {}) =>
    new ClientRegistry(hub.services.db, {
      dynamicRegistration: true,
      metadataDocuments: true,
      fetchDocument: () => answer(),
      logger,
      ...options,
    });
  const json =
    (body: unknown, headers: Record<string, string> = {}) =>
    async () => ({
      status: 200,
      headers,
      body: JSON.stringify(body),
    });
  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OAuthProtocolError);
    return (error as OAuthProtocolError).description;
  };

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ seed: false });
  });

  beforeEach(async () => {
    await hub.services.db.delete(oauthClients).where(eq(oauthClients.id, docUrl));
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('refuses registrations it cannot serve', async () => {
    expect(await refusal(registry({ dynamicRegistration: false }).register({}))).toContain('disabled');
    expect(await refusal(registry().register({ redirect_uris: [] }))).toMatch(
      /^Invalid client metadata: redirect_uris/,
    );
    expect(await refusal(registry().register({ redirect_uris: ['http://evil.example/cb'] }))).toContain(
      'loopback',
    );
    expect(
      await refusal(
        registry().register({
          redirect_uris: ['https://a.example/cb'],
          token_endpoint_auth_method: 'private_key_jwt',
        }),
      ),
    ).toContain('token_endpoint_auth_method must be one of');
    expect(
      await refusal(
        registry().register({ redirect_uris: ['https://a.example/cb'], response_types: ['token'] }),
      ),
    ).toContain('"code" response type');
  });

  it('gives a confidential client a secret and drops fields it cannot use', async () => {
    const result = await registry().register({
      redirect_uris: ['https://a.example/cb'],
      client_name: '   ',
      logo_uri: `data:image/png;base64,${'A'.repeat(3000)}`,
      contacts: null,
    });
    expect(result).toMatchObject({
      token_endpoint_auth_method: 'client_secret_basic',
      client_secret_expires_at: 0,
    });
    expect(String(result.client_secret)).toMatch(/^ac_cs/);
    expect(result).not.toHaveProperty('client_name');
    expect(result).not.toHaveProperty('logo_uri');
    expect(registry().dynamicRegistrationEnabled).toBe(true);
    expect(registry({ metadataDocuments: false }).metadataDocumentsEnabled).toBe(false);
  });

  it('does not look up ids that cannot be clients', async () => {
    answer = vi.fn(json(doc()));
    expect(await registry().get('')).toBeUndefined();
    expect(await registry().get(`https://a.example/${'x'.repeat(2001)}`)).toBeUndefined();
    expect(await registry().get('cli_unknown')).toBeUndefined();
    expect(await registry({ metadataDocuments: false }).get(docUrl)).toBeUndefined();
    expect(answer).not.toHaveBeenCalled();
  });

  it('loads a metadata document once and keeps it for its cache time, within bounds', async () => {
    answer = vi.fn(json(doc(), { 'cache-control': 'public, max-age=60' }));
    const client = await registry().get(docUrl);
    expect(client).toMatchObject({ id: docUrl, registrationType: 'metadata_document' });
    // max-age below five minutes is raised to five minutes.
    const ttl = client!.expiresAt!.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(290_000);
    expect(ttl).toBeLessThan(310_000);
    await registry().get(docUrl);
    expect(answer).toHaveBeenCalledOnce();
  });

  it('refuses documents that are not this client’s or claim a secret', async () => {
    const bad: Array<() => Promise<SafeFetchResponse>> = [
      async () => ({ status: 404, headers: {}, body: '' }),
      async () => ({ status: 200, headers: {}, body: 'not json' }),
      json(null),
      json(doc({ client_id: 'https://other.example/client.json' })),
      json(doc({ client_secret: 'x' })),
      json(doc({ token_endpoint_auth_method: 'client_secret_post' })),
    ];
    for (const next of bad) {
      answer = next;
      expect(await registry().get(docUrl)).toBeUndefined();
    }
  });

  it('serves a recently loaded document while its host is down, but not an old one', async () => {
    answer = json(doc());
    await registry().get(docUrl);
    await hub.services.db
      .update(oauthClients)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthClients.id, docUrl));
    answer = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect((await registry().get(docUrl))?.id).toBe(docUrl);
    await hub.services.db
      .update(oauthClients)
      .set({ updatedAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(oauthClients.id, docUrl));
    expect(await registry().get(docUrl)).toBeUndefined();
  });

  it('validates redirect URIs', () => {
    expect(validateRedirectUri('https://user:pw@a.example/cb')).toBe(
      'Redirect URIs must not contain credentials',
    );
    expect(validateRedirectUri('http://127.0.0.1:3000/cb')).toBeUndefined();
  });

  describe('authorization requests', () => {
    let clientId: string;
    let single: string;
    const challenge = 'a'.repeat(43);
    const validate = (params: Record<string, string | undefined>) =>
      hub.services.oauth.validateAuthorizationRequest({
        client_id: clientId,
        redirect_uri: 'https://a.example/cb',
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'st',
        ...params,
      } as never);
    const errorOf = async (params: Record<string, string | undefined>) => {
      const result = await validate(params);
      if (result.kind === 'error_redirect')
        return new URL(result.location).searchParams.get('error_description');
      if (result.kind === 'error_page') return result.description;
      return 'ok';
    };

    beforeAll(async () => {
      clientId = String(
        (
          await hub.services.clients.register({
            redirect_uris: ['https://a.example/cb', 'https://a.example/other'],
            token_endpoint_auth_method: 'none',
          })
        ).client_id,
      );
      single = String(
        (
          await hub.services.clients.register({
            redirect_uris: ['https://single.example/cb'],
            token_endpoint_auth_method: 'none',
          })
        ).client_id,
      );
    });

    it('shows an error page when it cannot trust where to send the user', async () => {
      expect(await errorOf({ client_id: undefined })).toBe('client_id is missing.');
      expect(await errorOf({ client_id: 'cli_nope' })).toContain('not registered');
      expect(await errorOf({ redirect_uri: undefined })).toBe('redirect_uri is missing.');
      expect(await errorOf({ redirect_uri: 'https://evil.example/cb' })).toContain('does not match');
    });

    it('takes the only registered redirect when the request names none', async () => {
      const result = await validate({ client_id: single, redirect_uri: undefined, response_type: 'token' });
      expect(result.kind).toBe('error_redirect');
      expect((result as { location: string }).location).toMatch(/^https:\/\/single\.example\/cb\?/);
    });

    it('sends request errors back to the client with its state', async () => {
      const result = await validate({ response_type: 'token' });
      const url = new URL((result as { location: string }).location);
      expect(url.searchParams.get('error')).toBe('unsupported_response_type');
      expect(url.searchParams.get('state')).toBe('st');
      expect(url.searchParams.get('iss')).toBeTruthy();
      expect(await errorOf({ code_challenge: undefined })).toBe('PKCE code_challenge is required.');
      expect(await errorOf({ code_challenge_method: undefined })).toBe('code_challenge_method must be S256.');
      expect(await errorOf({ code_challenge_method: 'plain' })).toBe('code_challenge_method must be S256.');
      expect(await errorOf({ code_challenge: 'short' })).toBe('Malformed code_challenge.');
      expect(await errorOf({ resource: 'https://elsewhere.example/mcp' })).toMatch(/^Unknown resource/);
    });
  });
});
