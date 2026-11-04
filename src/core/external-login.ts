import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FetchLike } from '../connectors/sdk.js';
import type { Db } from '../db/client.js';
import { loginStates } from '../db/schema.js';
import { hashToken, type SecretBox, safeEqual } from '../lib/crypto.js';
import { AppError, badRequest } from '../lib/errors.js';
import type { Logger } from '../logger.js';
import { pkcePair } from './oauth-client.js';
import type { ExternalProfile } from './users.js';

/**
 * "Sign in with …": the hub as an OpenID Connect relying party. One `OidcLoginProvider` per
 * provider (Google today; Yandex ID, Microsoft, Apple are the same class with other endpoints).
 *
 * start → a single-use `state` (stored hashed, 10 minutes, also kept in a browser cookie so the
 * callback cannot be replayed in another browser), a PKCE challenge and an OpenID `nonce` →
 * the provider → `/auth/<provider>/callback` → the code is exchanged at the token endpoint over TLS
 * and the ID token's claims are checked (issuer, audience, expiry, nonce, verified email).
 */

export interface OidcProviderSpec {
  id: string;
  name: string;
  authorizationUrl: string;
  tokenUrl: string;
  /** Accepted `iss` values of ID tokens. */
  issuers: string[];
  clientId: string;
  clientSecret?: string | undefined;
  scopes: string[];
  /** Extra authorization parameters (e.g. `prompt=select_account`). */
  authorizeParams?: Record<string, string>;
  /** Whether the provider is the authority for the address in these claims (see `ExternalProfile`). */
  emailAuthority?: (claims: { email: string; hd?: string | undefined }) => boolean;
}

/** Google vouches for its own mailboxes and for Google Workspace domains (the `hd` claim). */
export const googleEmailAuthority = ({ email, hd }: { email: string; hd?: string | undefined }) => {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return (
    domain === 'gmail.com' || domain === 'googlemail.com' || (hd !== undefined && hd.toLowerCase() === domain)
  );
};

export const googleLoginSpec = (client: {
  clientId: string;
  clientSecret?: string | undefined;
}): OidcProviderSpec => ({
  id: 'google',
  name: 'Google',
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
  clientId: client.clientId,
  clientSecret: client.clientSecret,
  scopes: ['openid', 'email', 'profile'],
  authorizeParams: { prompt: 'select_account' },
  emailAuthority: googleEmailAuthority,
});

const STATE_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_S = 120;

const IdTokenClaims = z.object({
  iss: z.string(),
  sub: z.string().min(1).max(255),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number().optional(),
  nonce: z.string().optional(),
  azp: z.string().optional(),
  email: z.string().email().max(320).optional(),
  email_verified: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  name: z.string().max(200).optional(),
  hd: z.string().max(255).optional(),
});

export class ExternalLoginError extends AppError {
  constructor(message: string) {
    super(400, 'external_login_failed', message);
  }
}

function decodeJwtPayload(jwt: string): unknown {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new ExternalLoginError('The provider returned a malformed ID token');
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    throw new ExternalLoginError('The provider returned a malformed ID token');
  }
}

export class OidcLoginProvider {
  constructor(
    readonly spec: OidcProviderSpec,
    private readonly fetch: FetchLike,
  ) {}

  get id(): string {
    return this.spec.id;
  }

  get name(): string {
    return this.spec.name;
  }

  authorizationUrl(input: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
    nonce: string;
  }): string {
    const url = new URL(this.spec.authorizationUrl);
    const params: Record<string, string> = {
      response_type: 'code',
      client_id: this.spec.clientId,
      redirect_uri: input.redirectUri,
      scope: this.spec.scopes.join(' '),
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      ...this.spec.authorizeParams,
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  /** Exchanges the code and returns the verified profile. */
  async complete(input: {
    code: string;
    codeVerifier: string;
    nonce: string;
    redirectUri: string;
    signal: AbortSignal;
  }): Promise<ExternalProfile> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
      client_id: this.spec.clientId,
      ...(this.spec.clientSecret ? { client_secret: this.spec.clientSecret } : {}),
    });
    const response = await this.fetch(this.spec.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: input.signal,
    });
    const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || typeof raw.id_token !== 'string') {
      const reason = typeof raw.error === 'string' ? raw.error : `HTTP ${response.status}`;
      throw new ExternalLoginError(`${this.spec.name} did not complete the sign-in (${reason})`);
    }
    // The ID token came straight from the token endpoint over TLS, authenticated with our client
    // credentials, so its signature need not be checked (OpenID Connect Core 3.1.3.7); the claims are.
    const parsed = IdTokenClaims.safeParse(decodeJwtPayload(raw.id_token));
    if (!parsed.success) throw new ExternalLoginError(`${this.spec.name} returned an unexpected ID token`);
    const claims = parsed.data;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Math.floor(Date.now() / 1000);
    if (!this.spec.issuers.includes(claims.iss))
      throw new ExternalLoginError('ID token from an unexpected issuer');
    if (!audiences.includes(this.spec.clientId))
      throw new ExternalLoginError('ID token for another application');
    if (audiences.length > 1 && claims.azp !== this.spec.clientId)
      throw new ExternalLoginError('ID token for another application');
    if (claims.exp + CLOCK_SKEW_S < now) throw new ExternalLoginError('The ID token has expired');
    if (!claims.nonce || !safeEqual(claims.nonce, input.nonce))
      throw new ExternalLoginError('The sign-in response does not match this browser');
    if (!claims.email) throw new ExternalLoginError(`${this.spec.name} did not share an email address`);
    const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
    return {
      provider: this.spec.id,
      subject: claims.sub,
      email: claims.email,
      emailVerified,
      emailAuthoritative:
        emailVerified && (this.spec.emailAuthority?.({ email: claims.email, hd: claims.hd }) ?? false),
      name: claims.name,
    };
  }
}

/** Runs external sign-ins: state, PKCE and nonce bookkeeping around the providers. */
export class ExternalLoginService {
  private readonly providers = new Map<string, OidcLoginProvider>();

  constructor(
    private readonly deps: {
      db: Db;
      secrets: SecretBox;
      /** `https://<hub>` — callbacks are `<publicUrl>/auth/<provider>/callback`. */
      publicUrl: string;
      logger: Logger;
    },
    providers: OidcLoginProvider[] = [],
  ) {
    for (const provider of providers) this.providers.set(provider.id, provider);
  }

  /** Configured providers, in display order. */
  list(): OidcLoginProvider[] {
    return [...this.providers.values()];
  }

  get(id: string): OidcLoginProvider | undefined {
    return this.providers.get(id);
  }

  redirectUri(providerId: string): string {
    return `${this.deps.publicUrl}/auth/${providerId}/callback`;
  }

  /** Returns the provider URL and the state the caller must also keep in a browser cookie. */
  async start(providerId: string, next: string): Promise<{ url: string; state: string }> {
    const provider = this.providers.get(providerId);
    if (!provider) throw badRequest(`Sign-in with "${providerId}" is not configured on this hub`);
    const state = randomBytes(32).toString('base64url');
    const stateHash = hashToken(state);
    const nonce = randomBytes(24).toString('base64url');
    const pkce = pkcePair(randomBytes(32).toString('base64url'));
    await this.deps.db.insert(loginStates).values({
      stateHash,
      provider: provider.id,
      secretsEncrypted: this.deps.secrets.encryptJson(
        { verifier: pkce.verifier, nonce },
        `login_state:${stateHash}`,
      ),
      next,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });
    const url = provider.authorizationUrl({
      redirectUri: this.redirectUri(provider.id),
      state,
      codeChallenge: pkce.challenge,
      nonce,
    });
    return { url, state };
  }

  /**
   * Handles the provider's redirect. `browserState` is the state from the cookie set at `start`:
   * it must equal the one in the URL, so a link started in another browser does not sign this one in.
   */
  async complete(
    providerId: string,
    params: { state?: string | undefined; code?: string | undefined; error?: string | undefined },
    browserState: string | undefined,
  ): Promise<{ profile: ExternalProfile; next: string }> {
    const provider = this.providers.get(providerId);
    if (!provider) throw badRequest(`Sign-in with "${providerId}" is not configured on this hub`);
    if (!params.state || !browserState || !safeEqual(params.state, browserState))
      throw new ExternalLoginError(
        'This sign-in link was started in another browser or has expired. Try again.',
      );
    const stateHash = hashToken(params.state);
    const [row] = await this.deps.db
      .delete(loginStates)
      .where(eq(loginStates.stateHash, stateHash))
      .returning();
    if (!row || row.provider !== provider.id || row.expiresAt.getTime() < Date.now())
      throw new ExternalLoginError('This sign-in link has expired or was already used. Try again.');
    if (params.error) throw new ExternalLoginError(`${provider.name} sign-in was cancelled`);
    if (!params.code) throw new ExternalLoginError(`${provider.name} did not return an authorization code`);
    const secrets = this.deps.secrets.decryptJson<{ verifier: string; nonce: string }>(
      row.secretsEncrypted,
      `login_state:${stateHash}`,
    );
    const profile = await provider.complete({
      code: params.code,
      codeVerifier: secrets.verifier,
      nonce: secrets.nonce,
      redirectUri: this.redirectUri(provider.id),
      signal: AbortSignal.timeout(15_000),
    });
    return { profile, next: row.next };
  }
}
