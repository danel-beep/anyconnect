import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { oauthClients, type StoredClientMetadata } from '../db/schema.js';
import { generateToken, hashToken } from '../lib/crypto.js';
import { newId } from '../lib/ids.js';
import { safeFetch } from '../lib/safe-fetch.js';
import type { Logger } from '../logger.js';
import { validateRedirectUri } from './redirect.js';

export type OAuthClient = typeof oauthClients.$inferSelect;

/** OAuth protocol error (RFC 6749 §5.2 / RFC 7591 §3.2.2). */
export class OAuthProtocolError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
    this.name = 'OAuthProtocolError';
  }

  toJSON() {
    return { error: this.error, error_description: this.description };
  }
}

export const SUPPORTED_AUTH_METHODS = ['none', 'client_secret_basic', 'client_secret_post'] as const;

const str = (max: number) => z.string().max(max);
const ClientMetadataInput = z.object({
  redirect_uris: z.array(str(2000)).min(1).max(20),
  client_name: str(200).optional(),
  client_uri: str(2000).optional(),
  logo_uri: str(2000).optional(),
  grant_types: z.array(str(100)).max(10).optional(),
  response_types: z.array(str(100)).max(10).optional(),
  token_endpoint_auth_method: str(100).optional(),
  scope: str(1000).optional(),
  contacts: z.array(str(320)).max(10).optional(),
  software_id: str(200).optional(),
  software_version: str(100).optional(),
});

function parseClientMetadata(body: unknown, defaults: { authMethod: string }): StoredClientMetadata {
  const parsed = ClientMetadataInput.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new OAuthProtocolError(
      'invalid_client_metadata',
      `Invalid client metadata${issue ? `: ${issue.path.join('.')} ${issue.message}` : ''}`,
    );
  }
  const m = parsed.data;
  for (const uri of m.redirect_uris) {
    const problem = validateRedirectUri(uri);
    if (problem) throw new OAuthProtocolError('invalid_redirect_uri', problem);
  }
  const authMethod = m.token_endpoint_auth_method ?? defaults.authMethod;
  if (!(SUPPORTED_AUTH_METHODS as readonly string[]).includes(authMethod)) {
    throw new OAuthProtocolError(
      'invalid_client_metadata',
      `token_endpoint_auth_method must be one of: ${SUPPORTED_AUTH_METHODS.join(', ')}`,
    );
  }
  const grantTypes = m.grant_types ?? ['authorization_code', 'refresh_token'];
  const unsupportedGrant = grantTypes.find((g) => g !== 'authorization_code' && g !== 'refresh_token');
  if (unsupportedGrant) {
    throw new OAuthProtocolError('invalid_client_metadata', `Unsupported grant type: ${unsupportedGrant}`);
  }
  const responseTypes = m.response_types ?? ['code'];
  if (responseTypes.some((r) => r !== 'code')) {
    throw new OAuthProtocolError('invalid_client_metadata', 'Only the "code" response type is supported');
  }
  return {
    redirect_uris: m.redirect_uris,
    client_name: m.client_name?.trim() || undefined,
    client_uri: m.client_uri,
    logo_uri: m.logo_uri,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: authMethod,
    scope: m.scope,
    contacts: m.contacts,
    software_id: m.software_id,
    software_version: m.software_version,
  };
}

/** A client_id that is an https URL with a path identifies a Client ID Metadata Document. */
export function isMetadataDocumentClientId(clientId: string): boolean {
  if (!clientId.startsWith('https://')) return false;
  try {
    const url = new URL(clientId);
    return url.pathname !== '/' && !url.hash && !url.username && !url.password && url.href === clientId;
  } catch {
    return false;
  }
}

function cacheSeconds(cacheControl: string | undefined): number {
  const maxAge = cacheControl?.match(/max-age=(\d+)/i)?.[1];
  const seconds = maxAge ? Number(maxAge) : 3600;
  return Math.min(Math.max(seconds, 300), 86_400);
}

const STALE_GRACE_MS = 7 * 86_400_000;

/**
 * Knows every OAuth client: dynamically registered ones (RFC 7591) and clients identified by a
 * Client ID Metadata Document (the client_id is an https URL that serves its metadata; the
 * preferred mechanism in the current MCP authorization spec).
 */
export class ClientRegistry {
  constructor(
    private readonly db: Db,
    private readonly options: {
      dynamicRegistration: boolean;
      metadataDocuments: boolean;
      /** Allow fetching metadata documents from private networks (tests only). */
      allowPrivateNetwork?: boolean;
      fetchDocument?: typeof safeFetch;
      logger: Logger;
    },
  ) {}

  get dynamicRegistrationEnabled(): boolean {
    return this.options.dynamicRegistration;
  }

  get metadataDocumentsEnabled(): boolean {
    return this.options.metadataDocuments;
  }

  async get(clientId: string): Promise<OAuthClient | undefined> {
    if (!clientId || clientId.length > 2000) return undefined;
    const [row] = await this.db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1);
    if (row && row.registrationType !== 'metadata_document') return row;
    if (!this.options.metadataDocuments || !isMetadataDocumentClientId(clientId)) return undefined;
    if (row?.expiresAt && row.expiresAt.getTime() > Date.now()) return row;
    try {
      return await this.fetchMetadataDocument(clientId);
    } catch (error) {
      if (row && row.updatedAt.getTime() > Date.now() - STALE_GRACE_MS) {
        this.options.logger.warn({ err: error, clientId }, 'using stale client metadata document');
        return row;
      }
      this.options.logger.warn({ err: error, clientId }, 'failed to fetch client metadata document');
      return undefined;
    }
  }

  private async fetchMetadataDocument(clientId: string): Promise<OAuthClient> {
    const fetchDocument = this.options.fetchDocument ?? safeFetch;
    const response = await fetchDocument(clientId, {
      headers: { accept: 'application/json' },
      timeoutMs: 5000,
      maxBytes: 64 * 1024,
      allowPrivateNetwork: this.options.allowPrivateNetwork ?? false,
    });
    if (response.status !== 200) throw new Error(`Metadata document returned HTTP ${response.status}`);
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      throw new Error('Metadata document is not valid JSON');
    }
    if (
      typeof body !== 'object' ||
      body === null ||
      (body as { client_id?: unknown }).client_id !== clientId
    ) {
      throw new Error('Metadata document client_id does not match its URL');
    }
    if ('client_secret' in body) throw new Error('Metadata documents must not contain a client_secret');
    const metadata = parseClientMetadata(body, { authMethod: 'none' });
    if (metadata.token_endpoint_auth_method !== 'none') {
      throw new Error('Clients identified by a metadata document must use token_endpoint_auth_method "none"');
    }
    const expiresAt = new Date(Date.now() + cacheSeconds(response.headers['cache-control']) * 1000);
    const [row] = await this.db
      .insert(oauthClients)
      .values({ id: clientId, registrationType: 'metadata_document', metadata, expiresAt })
      .onConflictDoUpdate({ target: oauthClients.id, set: { metadata, expiresAt, updatedAt: new Date() } })
      .returning();
    return row!;
  }

  /** Dynamic Client Registration (RFC 7591). Returns the registration response body. */
  async register(body: unknown): Promise<Record<string, unknown>> {
    if (!this.options.dynamicRegistration) {
      throw new OAuthProtocolError('invalid_request', 'Dynamic client registration is disabled', 400);
    }
    // RFC 7591 default is client_secret_basic; MCP clients normally ask for "none" (public client).
    const metadata = parseClientMetadata(body, { authMethod: 'client_secret_basic' });
    const id = newId('cli');
    const secret = metadata.token_endpoint_auth_method === 'none' ? undefined : generateToken('ac_cs');
    const [row] = await this.db
      .insert(oauthClients)
      .values({ id, registrationType: 'dynamic', metadata, secretHash: secret ? hashToken(secret) : null })
      .returning();
    return {
      client_id: id,
      client_id_issued_at: Math.floor(row!.createdAt.getTime() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      ...Object.fromEntries(Object.entries(metadata).filter(([, v]) => v !== undefined)),
    };
  }
}
