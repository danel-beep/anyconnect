import { and, desc, eq, isNull } from 'drizzle-orm';
import { BRAND } from '../brand.js';
import type { Db } from '../db/client.js';
import { oauthAuthorizationCodes, oauthGrants, oauthTokens } from '../db/schema.js';
import { generateToken, hashToken, safeEqual, sha256Base64Url } from '../lib/crypto.js';
import { newId } from '../lib/ids.js';
import type { Logger } from '../logger.js';
import {
  type ClientRegistry,
  type OAuthClient,
  OAuthProtocolError,
  SUPPORTED_GRANT_TYPES,
} from './clients.js';
import { isLoopbackRedirect, redirectUriMatches } from './redirect.js';

/**
 * A small, spec-focused OAuth 2.1 authorization server for MCP clients (Claude, ChatGPT, Claude
 * Code, Cursor, ...). Implements what the MCP authorization spec requires and what real clients use:
 *
 * - Authorization code flow with mandatory PKCE (S256)
 * - Client ID Metadata Documents and Dynamic Client Registration
 * - RFC 8707 resource indicators (tokens are bound to the hub's MCP URL)
 * - RFC 9207 `iss` in authorization responses
 * - Opaque tokens (only hashes stored) with refresh token rotation and reuse detection
 *
 * The HTTP layer (routes, login and consent pages) lives in web/; this class is framework-free.
 */

export const SCOPES = ['mcp', 'offline_access'] as const;
export const DEFAULT_SCOPES = ['mcp'];
const CODE_TTL_MS = 5 * 60_000;
/** A rotated refresh token may be reused this long (lost responses, concurrent refreshes). */
const REFRESH_REUSE_GRACE_MS = 60_000;
const LAST_USED_RESOLUTION_MS = 5 * 60_000;
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

export interface AuthorizationRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  scopes: string[];
  resource: string;
}

export type AuthorizeValidation =
  | { kind: 'ok'; request: AuthorizationRequest }
  /** The client or redirect URI cannot be trusted: show an error page, never redirect. */
  | { kind: 'error_page'; error: string; description: string }
  /** A protocol error that is reported back to the client via its redirect URI. */
  | { kind: 'error_redirect'; location: string };

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** What the hub ties to a grant when the user approves: the AI client entity and the persona. */
export interface GrantBinding {
  aiClientId?: string | undefined;
  personaId?: string | undefined;
}

export interface VerifiedAccessToken extends GrantBinding {
  userId: string;
  workspaceId: string;
  clientId: string;
  grantId: string;
  scopes: string[];
  resource: string;
  expiresAt: Date;
}

type Params = Record<string, string | undefined>;

export class OAuthServer {
  readonly issuer: string;
  readonly resource: string;

  constructor(
    private readonly deps: {
      db: Db;
      clients: ClientRegistry;
      issuer: string;
      /** The protected resource (MCP endpoint URL). */
      resource: string;
      /**
       * Path segments below the MCP URL that are protected resources of their own
       * (persona endpoints `<resource>/<segment>`). Each one gets separately bound tokens.
       */
      subResource?: RegExp;
      accessTokenTtlSeconds: number;
      refreshTokenTtlSeconds: number;
      logger: Logger;
    },
  ) {
    this.issuer = deps.issuer;
    this.resource = deps.resource;
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /** RFC 8414 authorization server metadata. */
  metadata(): Record<string, unknown> {
    const authMethods = ['none', 'client_secret_basic', 'client_secret_post'];
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      ...(this.deps.clients.dynamicRegistrationEnabled
        ? { registration_endpoint: `${this.issuer}/oauth/register` }
        : {}),
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      scopes_supported: [...SCOPES],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: [...SUPPORTED_GRANT_TYPES],
      token_endpoint_auth_methods_supported: authMethods,
      revocation_endpoint_auth_methods_supported: authMethods,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: this.deps.clients.metadataDocumentsEnabled,
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${this.issuer}/`,
    };
  }

  /** RFC 9728 protected resource metadata for the MCP endpoint (or one of its sub-resources). */
  protectedResourceMetadata(resource: string = this.resource): Record<string, unknown> {
    return {
      resource,
      authorization_servers: [this.issuer],
      scopes_supported: [...DEFAULT_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: BRAND.name,
      resource_documentation: `${this.issuer}/`,
    };
  }

  /**
   * Maps a requested `resource` to a canonical protected resource. Accepts the MCP URL itself and
   * the hub origin (some clients send the server origin), with or without a trailing slash, and
   * sub-resources such as persona endpoints (`<mcp url>/<slug>`).
   */
  canonicalResource(raw: string | undefined): string | undefined {
    if (raw === undefined || raw === '') return this.resource;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return undefined;
    }
    url.hash = '';
    const normalized = url.href.replace(/\/+$/, '');
    if (normalized === this.resource || normalized === this.issuer) return this.resource;
    const pattern = this.deps.subResource;
    if (pattern && normalized.startsWith(`${this.resource}/`) && !url.search) {
      const segment = normalized.slice(this.resource.length + 1);
      if (pattern.test(segment)) return normalized;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Authorization endpoint
  // -------------------------------------------------------------------------

  redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    url.searchParams.set('iss', this.issuer);
    return url.href;
  }

  async validateAuthorizationRequest(params: Params): Promise<AuthorizeValidation> {
    const clientId = params.client_id;
    if (!clientId)
      return { kind: 'error_page', error: 'invalid_request', description: 'client_id is missing.' };
    const client = await this.deps.clients.get(clientId);
    if (!client) {
      return {
        kind: 'error_page',
        error: 'invalid_client',
        description: 'This application is not registered with the hub (or its metadata could not be loaded).',
      };
    }
    const registered = client.metadata.redirect_uris;
    let redirectUri = params.redirect_uri;
    if (!redirectUri) {
      if (registered.length !== 1 || isLoopbackRedirect(registered[0]!)) {
        return { kind: 'error_page', error: 'invalid_request', description: 'redirect_uri is missing.' };
      }
      redirectUri = registered[0]!;
    }
    if (!redirectUriMatches(registered, redirectUri)) {
      return {
        kind: 'error_page',
        error: 'invalid_request',
        description: 'The redirect_uri does not match any URI registered by this application.',
      };
    }

    const state = params.state;
    const fail = (error: string, description: string): AuthorizeValidation => ({
      kind: 'error_redirect',
      location: this.redirectWith(redirectUri, { error, error_description: description, state }),
    });

    if (params.response_type !== 'code')
      return fail('unsupported_response_type', 'Only response_type=code is supported.');
    if (!params.code_challenge) return fail('invalid_request', 'PKCE code_challenge is required.');
    if ((params.code_challenge_method ?? 'plain') !== 'S256') {
      return fail('invalid_request', 'code_challenge_method must be S256.');
    }
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(params.code_challenge)) {
      return fail('invalid_request', 'Malformed code_challenge.');
    }
    const resource = this.canonicalResource(params.resource);
    if (!resource) return fail('invalid_target', `Unknown resource. This server protects ${this.resource}.`);

    // Unknown scopes (e.g. "openid profile") are ignored rather than rejected (RFC 6749 §3.3).
    const requested = (params.scope ?? '').split(/\s+/).filter(Boolean);
    const scopes = [
      ...new Set(['mcp', ...requested.filter((s) => (SCOPES as readonly string[]).includes(s))]),
    ];

    return {
      kind: 'ok',
      request: { client, redirectUri, state, codeChallenge: params.code_challenge, scopes, resource },
    };
  }

  /** Called after the user approved on the consent screen. Returns the redirect location. */
  async approve(
    request: AuthorizationRequest,
    userId: string,
    workspaceId: string,
    binding: GrantBinding = {},
  ): Promise<string> {
    const code = generateToken('ac_code');
    await this.deps.db.insert(oauthAuthorizationCodes).values({
      codeHash: hashToken(code),
      clientId: request.client.id,
      userId,
      workspaceId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scopes: request.scopes,
      resource: request.resource,
      aiClientId: binding.aiClientId ?? null,
      personaId: binding.personaId ?? null,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    return this.redirectWith(request.redirectUri, { code, state: request.state });
  }

  deny(request: AuthorizationRequest): string {
    return this.redirectWith(request.redirectUri, {
      error: 'access_denied',
      error_description: 'The user denied access.',
      state: request.state,
    });
  }

  // -------------------------------------------------------------------------
  // Token endpoint
  // -------------------------------------------------------------------------

  private async authenticateClient(params: Params, authorization: string | undefined): Promise<OAuthClient> {
    let clientId = params.client_id;
    let secret = params.client_secret;
    if (authorization?.toLowerCase().startsWith('basic ')) {
      const decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator < 0) throw new OAuthProtocolError('invalid_client', 'Malformed Basic authorization', 401);
      const basicId = decodeURIComponent(decoded.slice(0, separator));
      if (clientId && clientId !== basicId) {
        throw new OAuthProtocolError('invalid_request', 'client_id does not match the Authorization header');
      }
      clientId = basicId;
      secret = decodeURIComponent(decoded.slice(separator + 1));
    }
    if (!clientId) throw new OAuthProtocolError('invalid_client', 'client_id is required', 401);
    const client = await this.deps.clients.get(clientId);
    if (!client) throw new OAuthProtocolError('invalid_client', 'Unknown client', 401);
    if (client.secretHash && (!secret || !safeEqual(hashToken(secret), client.secretHash))) {
      throw new OAuthProtocolError('invalid_client', 'Client authentication failed', 401);
    }
    return client;
  }

  async token(params: Params, authorization?: string): Promise<TokenResponse> {
    const grantType = params.grant_type;
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      throw new OAuthProtocolError('unsupported_grant_type', 'Supported: authorization_code, refresh_token');
    }
    const client = await this.authenticateClient(params, authorization);
    return grantType === 'authorization_code'
      ? this.exchangeCode(client, params)
      : this.refresh(client, params);
  }

  private async exchangeCode(client: OAuthClient, params: Params): Promise<TokenResponse> {
    const { code, code_verifier: verifier } = params;
    if (!code) throw new OAuthProtocolError('invalid_request', 'code is required');
    if (!verifier || !CODE_VERIFIER.test(verifier)) {
      throw new OAuthProtocolError('invalid_request', 'A valid PKCE code_verifier is required');
    }
    const codeHash = hashToken(code);
    const db = this.deps.db;

    // Single use, enforced atomically.
    const [row] = await db
      .update(oauthAuthorizationCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(oauthAuthorizationCodes.codeHash, codeHash), isNull(oauthAuthorizationCodes.usedAt)))
      .returning();
    if (!row) {
      const [used] = await db
        .select()
        .from(oauthAuthorizationCodes)
        .where(eq(oauthAuthorizationCodes.codeHash, codeHash))
        .limit(1);
      if (used?.grantId) {
        // Replayed code: revoke everything issued from it (RFC 6749 §4.1.2).
        await this.revokeGrantById(used.grantId);
        this.deps.logger.warn(
          { clientId: client.id, grantId: used.grantId },
          'authorization code replay detected',
        );
      }
      throw new OAuthProtocolError('invalid_grant', 'Invalid or already used authorization code');
    }
    if (row.clientId !== client.id)
      throw new OAuthProtocolError('invalid_grant', 'Code was issued to another client');
    if (row.expiresAt.getTime() < Date.now())
      throw new OAuthProtocolError('invalid_grant', 'Authorization code expired');
    if (params.redirect_uri && params.redirect_uri !== row.redirectUri) {
      throw new OAuthProtocolError('invalid_grant', 'redirect_uri does not match the authorization request');
    }
    if (!safeEqual(sha256Base64Url(verifier), row.codeChallenge)) {
      throw new OAuthProtocolError('invalid_grant', 'PKCE verification failed');
    }
    if (params.resource && this.canonicalResource(params.resource) !== row.resource) {
      throw new OAuthProtocolError('invalid_target', 'resource does not match the authorization request');
    }

    return db.transaction(async (tx) => {
      const grantId = newId('grt');
      await tx.insert(oauthGrants).values({
        id: grantId,
        clientId: client.id,
        userId: row.userId,
        workspaceId: row.workspaceId,
        scopes: row.scopes,
        resource: row.resource,
        clientName: client.metadata.client_name ?? null,
        aiClientId: row.aiClientId,
        personaId: row.personaId,
      });
      await tx
        .update(oauthAuthorizationCodes)
        .set({ grantId })
        .where(eq(oauthAuthorizationCodes.codeHash, codeHash));
      return this.issueTokens(tx, grantId, row.scopes);
    });
  }

  private async refresh(client: OAuthClient, params: Params): Promise<TokenResponse> {
    const presented = params.refresh_token;
    if (!presented) throw new OAuthProtocolError('invalid_request', 'refresh_token is required');
    const tokenHash = hashToken(presented);
    const db = this.deps.db;
    const [row] = await db
      .select({ token: oauthTokens, grant: oauthGrants })
      .from(oauthTokens)
      .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
      .where(and(eq(oauthTokens.tokenHash, tokenHash), eq(oauthTokens.type, 'refresh')))
      .limit(1);
    const invalid = new OAuthProtocolError('invalid_grant', 'Invalid refresh token');
    if (!row || row.grant.revokedAt || row.token.revokedAt) throw invalid;
    if (row.grant.clientId !== client.id) throw invalid;
    if (row.token.expiresAt.getTime() < Date.now()) throw invalid;
    if (row.token.rotatedAt && Date.now() - row.token.rotatedAt.getTime() > REFRESH_REUSE_GRACE_MS) {
      // A refresh token was used again long after rotation: likely stolen. Kill the whole grant.
      await this.revokeGrantById(row.grant.id);
      this.deps.logger.warn({ clientId: client.id, grantId: row.grant.id }, 'refresh token reuse detected');
      throw invalid;
    }
    let scopes = row.grant.scopes;
    if (params.scope) {
      const requested = params.scope.split(/\s+/).filter(Boolean);
      if (requested.some((s) => !row.grant.scopes.includes(s))) {
        throw new OAuthProtocolError('invalid_scope', 'Requested scope exceeds the original grant');
      }
      scopes = requested;
    }
    if (params.resource && this.canonicalResource(params.resource) !== row.grant.resource) {
      throw new OAuthProtocolError('invalid_target', 'resource does not match the grant');
    }
    return db.transaction(async (tx) => {
      if (!row.token.rotatedAt) {
        await tx
          .update(oauthTokens)
          .set({ rotatedAt: new Date() })
          .where(eq(oauthTokens.tokenHash, tokenHash));
      }
      await tx.update(oauthGrants).set({ lastUsedAt: new Date() }).where(eq(oauthGrants.id, row.grant.id));
      return this.issueTokens(tx, row.grant.id, scopes);
    });
  }

  private async issueTokens(
    tx: Pick<Db, 'insert'>,
    grantId: string,
    scopes: string[],
  ): Promise<TokenResponse> {
    const accessToken = generateToken('ac_at');
    const refreshToken = generateToken('ac_rt');
    const now = Date.now();
    await tx.insert(oauthTokens).values([
      {
        tokenHash: hashToken(accessToken),
        grantId,
        type: 'access',
        expiresAt: new Date(now + this.deps.accessTokenTtlSeconds * 1000),
      },
      {
        tokenHash: hashToken(refreshToken),
        grantId,
        type: 'refresh',
        expiresAt: new Date(now + this.deps.refreshTokenTtlSeconds * 1000),
      },
    ]);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.deps.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  // -------------------------------------------------------------------------
  // Revocation (RFC 7009) and grants
  // -------------------------------------------------------------------------

  async revoke(params: Params, authorization?: string): Promise<void> {
    const client = await this.authenticateClient(params, authorization);
    if (!params.token) throw new OAuthProtocolError('invalid_request', 'token is required');
    const [row] = await this.deps.db
      .select({ token: oauthTokens, grant: oauthGrants })
      .from(oauthTokens)
      .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
      .where(eq(oauthTokens.tokenHash, hashToken(params.token)))
      .limit(1);
    // Unknown tokens and tokens of other clients are ignored silently, as RFC 7009 requires.
    if (!row || row.grant.clientId !== client.id) return;
    if (row.token.type === 'refresh') {
      await this.revokeGrantById(row.grant.id);
    } else {
      await this.deps.db
        .update(oauthTokens)
        .set({ revokedAt: new Date() })
        .where(eq(oauthTokens.tokenHash, row.token.tokenHash));
    }
  }

  async revokeGrantById(grantId: string): Promise<void> {
    const now = new Date();
    await this.deps.db.transaction(async (tx) => {
      await tx
        .update(oauthGrants)
        .set({ revokedAt: now })
        .where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)));
      await tx
        .update(oauthTokens)
        .set({ revokedAt: now })
        .where(and(eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt)));
    });
  }

  async listGrants(workspaceId: string) {
    return this.deps.db
      .select()
      .from(oauthGrants)
      .where(and(eq(oauthGrants.workspaceId, workspaceId), isNull(oauthGrants.revokedAt)))
      .orderBy(desc(oauthGrants.createdAt));
  }

  async revokeGrant(workspaceId: string, grantId: string): Promise<boolean> {
    const [grant] = await this.deps.db
      .select({ id: oauthGrants.id })
      .from(oauthGrants)
      .where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.workspaceId, workspaceId)))
      .limit(1);
    if (!grant) return false;
    await this.revokeGrantById(grant.id);
    return true;
  }

  // -------------------------------------------------------------------------
  // Resource server side
  // -------------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<VerifiedAccessToken | undefined> {
    if (!token.startsWith('ac_at_')) return undefined;
    const [row] = await this.deps.db
      .select({ token: oauthTokens, grant: oauthGrants })
      .from(oauthTokens)
      .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
      .where(and(eq(oauthTokens.tokenHash, hashToken(token)), eq(oauthTokens.type, 'access')))
      .limit(1);
    if (!row || row.token.revokedAt || row.grant.revokedAt) return undefined;
    if (row.token.expiresAt.getTime() <= Date.now()) return undefined;
    if (!row.grant.lastUsedAt || Date.now() - row.grant.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
      await this.deps.db
        .update(oauthGrants)
        .set({ lastUsedAt: new Date() })
        .where(eq(oauthGrants.id, row.grant.id))
        .catch(() => {});
    }
    return {
      userId: row.grant.userId,
      workspaceId: row.grant.workspaceId,
      clientId: row.grant.clientId,
      grantId: row.grant.id,
      scopes: row.grant.scopes,
      resource: row.grant.resource,
      expiresAt: row.token.expiresAt,
      ...(row.grant.aiClientId ? { aiClientId: row.grant.aiClientId } : {}),
      ...(row.grant.personaId ? { personaId: row.grant.personaId } : {}),
    };
  }
}
