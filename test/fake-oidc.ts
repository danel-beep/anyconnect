import { expect } from 'vitest';
import { googleEmailAuthority, OidcLoginProvider } from '../src/core/external-login.js';
import type { TestBrowser } from './helpers.js';

const CLIENT_ID = 'test-client.apps.example';
const ISSUER = 'https://accounts.example';

type Claims = Record<string, unknown>;

/** A fake OpenID provider: the test decides the ID token's claims for every code it hands out. */
export class FakeOidc {
  private readonly tokens = new Map<string, Claims>();
  private counter = 0;
  readonly provider = new OidcLoginProvider(
    {
      id: 'google',
      name: 'Google',
      authorizationUrl: `${ISSUER}/auth`,
      tokenUrl: `${ISSUER}/token`,
      issuers: [ISSUER],
      clientId: CLIENT_ID,
      clientSecret: 'shh',
      scopes: ['openid', 'email', 'profile'],
      emailAuthority: googleEmailAuthority,
    },
    async (_url, init) => {
      const code = new URLSearchParams(String(init?.body)).get('code') ?? '';
      const claims = this.tokens.get(code);
      this.tokens.delete(code);
      if (!claims) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
      return Response.json({ id_token: `${part({ alg: 'RS256' })}.${part(claims)}.sig` });
    },
  );

  /** Walks /auth/google → provider → callback. Returns the callback response. */
  async signIn(
    browser: TestBrowser,
    claims: Claims,
    opts: { next?: string; state?: string; nonce?: string } = {},
  ): Promise<Response> {
    const start = await browser.request(
      `/auth/google${opts.next ? `?next=${encodeURIComponent(opts.next)}` : ''}`,
    );
    expect(start.status).toBe(302);
    const url = new URL(start.headers.get('location')!);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/auth`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const code = `code-${++this.counter}`;
    this.tokens.set(code, {
      iss: ISSUER,
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 600,
      nonce: opts.nonce ?? url.searchParams.get('nonce'),
      email_verified: true,
      ...claims,
    });
    const state = opts.state ?? url.searchParams.get('state')!;
    return browser.request(`/auth/google/callback?state=${encodeURIComponent(state)}&code=${code}`);
  }
}
