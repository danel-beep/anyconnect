import { getPath } from '../connectors/http/json-path.js';
import type { FetchLike, OAuthProviderSpec } from '../connectors/sdk.js';
import { sha256Base64Url } from '../lib/crypto.js';
import type { ResolvedOAuthApp } from './oauth-apps.js';

/**
 * The OAuth 2 client protocol (RFC 6749 + PKCE, RFC 7009 revocation), driven by provider specs.
 * Stateless: storage, locking and account bookkeeping live in `ConnectService` / `TokenManager`.
 */

export interface TokenSet {
  accessToken: string;
  tokenType: string;
  refreshToken?: string | undefined;
  /** Epoch ms; undefined when the token does not expire. */
  expiresAt?: number | undefined;
  scopes: string[];
  /** Non-secret fields of the token response (team ids, instance URLs, ...). */
  extra: Record<string, unknown>;
}

export class OAuthProtocolError extends Error {
  override name = 'OAuthProtocolError';
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }

  /** The grant is gone (revoked, expired refresh token, password changed): the user must reconnect. */
  get grantInvalid(): boolean {
    return (
      this.code === 'invalid_grant' || this.code === 'invalid_refresh_token' || this.code === 'token_revoked'
    );
  }
}

export function scopeString(provider: OAuthProviderSpec, scopes: string[]): string {
  return scopes.join(provider.scopeSeparator ?? ' ');
}

export function pkcePair(verifier: string): { verifier: string; challenge: string } {
  return { verifier, challenge: sha256Base64Url(verifier) };
}

export function buildAuthorizationUrl(input: {
  provider: OAuthProviderSpec;
  app: ResolvedOAuthApp;
  scopes: string[];
  redirectUri: string;
  state: string;
  codeChallenge?: string | undefined;
  extraParams?: Record<string, string> | undefined;
}): string {
  const { provider } = input;
  const url = new URL(provider.authorizationUrl);
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: input.app.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    ...provider.authorizeParams,
    ...input.extraParams,
  };
  if (input.scopes.length) params[provider.scopeParam ?? 'scope'] = scopeString(provider, input.scopes);
  if (input.codeChallenge) {
    params.code_challenge = input.codeChallenge;
    params.code_challenge_method = 'S256';
  }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

const SECRET_KEYS = /token|secret|password|code/i;

function nonSecret(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (SECRET_KEYS.test(key)) continue;
    if (['expires_in', 'scope', 'token_type', 'ok'].includes(key)) continue;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const nested = nonSecret(value as Record<string, unknown>);
      if (Object.keys(nested).length) out[key] = nested;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function parseTokenResponse(
  provider: OAuthProviderSpec,
  raw: Record<string, unknown>,
  fallback: { scopes: string[]; refreshToken?: string | undefined },
  now = Date.now(),
): TokenSet {
  if (raw.ok === false || typeof raw.error === 'string') {
    const code = String(raw.error ?? 'invalid_response');
    throw new OAuthProtocolError(code, String(raw.error_description ?? code));
  }
  const tokenObject = (provider.tokenPath ? getPath(raw, provider.tokenPath) : raw) as
    | Record<string, unknown>
    | undefined;
  const accessToken = tokenObject?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new OAuthProtocolError('invalid_response', 'The provider did not return an access token');
  }
  const expiresIn = Number(tokenObject?.expires_in);
  const scope = tokenObject?.scope ?? raw.scope;
  const tokenType = typeof tokenObject?.token_type === 'string' ? tokenObject.token_type : 'Bearer';
  return {
    accessToken,
    // Some providers (Slack user tokens) say "user": the header scheme is still Bearer.
    tokenType:
      tokenType.toLowerCase() === 'bearer' || tokenType.toLowerCase() === 'user' ? 'Bearer' : tokenType,
    refreshToken:
      typeof tokenObject?.refresh_token === 'string' ? tokenObject.refresh_token : fallback.refreshToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
    scopes:
      typeof scope === 'string'
        ? scope.split(/[ ,]+/).filter(Boolean)
        : Array.isArray(scope)
          ? scope.map(String)
          : fallback.scopes,
    extra: nonSecret(raw),
  };
}

async function tokenRequest(
  provider: OAuthProviderSpec,
  app: ResolvedOAuthApp,
  params: Record<string, string>,
  fetch: FetchLike,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const body: Record<string, string> = { ...params };
  if ((provider.clientAuth ?? 'client_secret_post') === 'client_secret_basic' && app.clientSecret) {
    const encode = (v: string) => encodeURIComponent(v);
    headers.authorization = `Basic ${Buffer.from(`${encode(app.clientId)}:${encode(app.clientSecret)}`).toString('base64')}`;
  } else {
    body.client_id = app.clientId;
    if (app.clientSecret) body.client_secret = app.clientSecret;
  }
  let payload: string;
  if (provider.tokenRequestFormat === 'json') {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  } else {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body).toString();
  }
  let response: Response;
  try {
    response = await fetch(provider.tokenUrl, { method: 'POST', headers, body: payload, signal });
  } catch (error) {
    throw new OAuthProtocolError('network', `Could not reach ${provider.name}: ${(error as Error).message}`);
  }
  const text = await response.text();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // GitHub-style form-encoded responses.
    raw = Object.fromEntries(new URLSearchParams(text));
  }
  if (!response.ok) {
    const code = typeof raw.error === 'string' ? raw.error : `http_${response.status}`;
    throw new OAuthProtocolError(
      code,
      typeof raw.error_description === 'string'
        ? raw.error_description
        : `${provider.name} answered HTTP ${response.status}`,
      response.status,
    );
  }
  return raw;
}

export async function exchangeCode(input: {
  provider: OAuthProviderSpec;
  app: ResolvedOAuthApp;
  code: string;
  redirectUri: string;
  codeVerifier?: string | undefined;
  requestedScopes: string[];
  fetch: FetchLike;
  signal: AbortSignal;
}): Promise<TokenSet> {
  const raw = await tokenRequest(
    input.provider,
    input.app,
    {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
    },
    input.fetch,
    input.signal,
  );
  return parseTokenResponse(input.provider, raw, { scopes: input.requestedScopes });
}

export async function refreshTokenSet(input: {
  provider: OAuthProviderSpec;
  app: ResolvedOAuthApp;
  current: TokenSet;
  fetch: FetchLike;
  signal: AbortSignal;
}): Promise<TokenSet> {
  if (!input.current.refreshToken) {
    throw new OAuthProtocolError(
      'invalid_grant',
      'The access token expired and the service gave no refresh token',
    );
  }
  const raw = await tokenRequest(
    input.provider,
    input.app,
    { grant_type: 'refresh_token', refresh_token: input.current.refreshToken },
    input.fetch,
    input.signal,
  );
  const next = parseTokenResponse(input.provider, raw, {
    scopes: input.current.scopes,
    refreshToken: input.current.refreshToken,
  });
  // Keep fields the refresh response omits (Slack team, instance URLs).
  return { ...next, extra: { ...input.current.extra, ...next.extra } };
}

/** Best-effort RFC 7009 revocation, used when an account is deleted. */
export async function revokeTokenSet(input: {
  provider: OAuthProviderSpec;
  app: ResolvedOAuthApp;
  tokens: TokenSet;
  fetch: FetchLike;
  signal: AbortSignal;
}): Promise<boolean> {
  if (!input.provider.revocationUrl) return false;
  const token = input.tokens.refreshToken ?? input.tokens.accessToken;
  const body = new URLSearchParams({
    token,
    client_id: input.app.clientId,
    ...(input.app.clientSecret ? { client_secret: input.app.clientSecret } : {}),
  });
  try {
    const response = await input.fetch(input.provider.revocationUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Bearer ${input.tokens.accessToken}`,
      },
      body: body.toString(),
      signal: input.signal,
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
