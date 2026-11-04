import {
  type AuthorizationServerMetadata,
  discoverOAuthServerInfo,
  registerClient,
} from '@modelcontextprotocol/client';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ManifestError } from '../connectors/manifest/compile.js';
import {
  listRemoteTools,
  type RemoteMcpAuth,
  type RemoteMcpTool,
} from '../connectors/mcp-remote/connector.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import { ConnectorError, type FetchLike, type OAuthProviderSpec } from '../connectors/sdk.js';
import type { Db } from '../db/client.js';
import { accounts, customConnectors } from '../db/schema.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { Logger } from '../logger.js';
import type { AccountRow, AccountService } from './accounts.js';
import {
  type CustomConnectorRow,
  type CustomConnectorStore,
  compileCustomConnector,
  type RemoteMcpDefinition,
} from './custom-connectors.js';
import type { OAuthAppService } from './oauth-apps.js';

/**
 * Adding services without code: remote MCP servers and HTTP manifests.
 *
 * For an MCP server the hub works out authorization by itself, as an MCP client would: it tries the
 * server anonymously, and on 401 discovers the authorization server (RFC 9728 → RFC 8414) and
 * registers itself as an OAuth client (Client ID Metadata Document when the hub is on https and the
 * server supports it, otherwise Dynamic Client Registration). Accounts are then connected with the
 * usual `/connect/<service>` flow. Servers without OAuth take a token.
 */

const CONNECTOR_ID = /^[a-z][a-z0-9_]{1,23}$/;

interface OAuthDiscovery {
  spec: OAuthProviderSpec;
  scopes: string[];
  metadata: AuthorizationServerMetadata;
  authorizationServerUrl: string;
}

export const AddMcpServerInput = z.object({
  kind: z.literal('mcp'),
  url: z.url(),
  name: z.string().trim().min(1).max(60),
  /** Tool-name prefix; derived from the name when omitted. */
  id: z.string().regex(CONNECTOR_ID, 'use 2-24 lowercase letters, digits or underscores').optional(),
  description: z.string().trim().max(500).optional(),
  instructions: z.string().trim().max(2000).optional(),
  /** `auto` (default): anonymous, else OAuth if the server advertises it, else a token. */
  auth: z.enum(['auto', 'none', 'bearer', 'header', 'oauth2']).default('auto'),
  /** Header name for `auth: header`. */
  headerName: z.string().min(1).max(100).optional(),
});

export const AddManifestServiceInput = z.object({
  kind: z.literal('manifest'),
  manifest: z.record(z.string(), z.unknown()),
});

export const AddServiceInput = z.discriminatedUnion('kind', [AddMcpServerInput, AddManifestServiceInput]);
export type AddServiceInput = z.input<typeof AddServiceInput>;

export interface ServiceView {
  id: string;
  connectorId: string;
  kind: 'mcp' | 'manifest';
  name: string;
  url: string | null;
  auth: string;
  tools: number;
  toolsRefreshedAt: string | null;
  lastError: string | null;
  valid: boolean;
  createdAt: string;
}

/** Client metadata the hub publishes for MCP servers that accept Client ID Metadata Documents. */
export function hubClientMetadata(publicUrl: string, redirectUri: string) {
  return {
    client_id: `${publicUrl}/connect/client-metadata.json`,
    client_name: 'AnyConnect',
    client_uri: publicUrl,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

function idFromName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return /^[a-z][a-z0-9_]{1,23}$/.test(base) ? base : `mcp_${base}`.slice(0, 24).replace(/_$/, '');
}

export class CustomServiceManager {
  constructor(
    private readonly deps: {
      db: Db;
      store: CustomConnectorStore;
      builtin: ConnectorRegistry;
      accounts: AccountService;
      apps: OAuthAppService;
      fetch: FetchLike;
      publicUrl: string;
      redirectUri: string;
      logger: Logger;
    },
  ) {}

  async list(workspaceId: string): Promise<ServiceView[]> {
    return (await this.deps.store.rows(workspaceId)).map((row) => this.view(row));
  }

  private view(row: CustomConnectorRow): ServiceView {
    const definition = row.definition as Record<string, unknown>;
    const connector = this.deps.store.compiled(row);
    return {
      id: row.id,
      connectorId: row.connectorId,
      kind: row.kind,
      name: String(definition.name ?? row.connectorId),
      url: row.kind === 'mcp' ? String(definition.url) : String(definition.baseUrl ?? '') || null,
      auth: String((definition.auth as { type?: string } | undefined)?.type ?? 'none'),
      tools: connector?.actions.length ?? 0,
      toolsRefreshedAt: row.toolsRefreshedAt?.toISOString() ?? null,
      lastError: row.lastError,
      valid: Boolean(connector),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async add(workspaceId: string, raw: AddServiceInput): Promise<ServiceView> {
    const parsed = AddServiceInput.safeParse(raw);
    if (!parsed.success) {
      throw badRequest(
        'Invalid service',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    const input = parsed.data;
    return input.kind === 'mcp'
      ? this.addMcpServer(workspaceId, input)
      : this.addManifest(workspaceId, input.manifest);
  }

  private async assertFreeId(workspaceId: string, connectorId: string): Promise<void> {
    if (!CONNECTOR_ID.test(connectorId)) {
      throw badRequest(
        `Invalid service id "${connectorId}": use 2-24 lowercase letters, digits or underscores`,
      );
    }
    if (
      this.deps.builtin.all().some((c) => c.id === connectorId) ||
      (await this.deps.store.row(workspaceId, connectorId))
    ) {
      throw conflict(`A service with the id "${connectorId}" already exists; choose another id`);
    }
  }

  private async insert(
    workspaceId: string,
    values: Pick<CustomConnectorRow, 'connectorId' | 'kind' | 'definition'> & { tools?: RemoteMcpTool[] },
  ): Promise<CustomConnectorRow> {
    const now = new Date();
    const candidate: CustomConnectorRow = {
      id: newId('svc'),
      workspaceId,
      connectorId: values.connectorId,
      kind: values.kind,
      definition: values.definition,
      tools: values.tools ?? null,
      toolsRefreshedAt: values.tools ? now : null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      compileCustomConnector(candidate); // validates exactly what the resolver will build
    } catch (error) {
      if (error instanceof ManifestError || error instanceof Error) throw badRequest(error.message);
      throw error;
    }
    const [row] = await this.deps.db.insert(customConnectors).values(candidate).returning();
    return row!;
  }

  async addManifest(workspaceId: string, manifest: Record<string, unknown>): Promise<ServiceView> {
    const connectorId = typeof manifest.id === 'string' ? manifest.id : '';
    await this.assertFreeId(workspaceId, connectorId);
    const row = await this.insert(workspaceId, { connectorId, kind: 'manifest', definition: manifest });
    return this.view(row);
  }

  async addMcpServer(workspaceId: string, input: z.output<typeof AddMcpServerInput>): Promise<ServiceView> {
    const connectorId = input.id ?? idFromName(input.name);
    await this.assertFreeId(workspaceId, connectorId);
    const url = new URL(input.url);
    url.hash = '';
    const base = {
      name: input.name,
      description: input.description ?? `${input.name} (remote MCP server)`,
      ...(input.instructions ? { instructions: input.instructions } : {}),
      url: url.toString(),
    };

    let auth: RemoteMcpAuth | undefined;
    let tools: RemoteMcpTool[] | undefined;
    const anonymous = { fetch: this.deps.fetch, signal: AbortSignal.timeout(20_000), credentials: {} };
    if (input.auth === 'none' || input.auth === 'auto') {
      try {
        tools = await listRemoteTools(base.url, { type: 'none' }, anonymous);
        auth = { type: 'none' };
      } catch (error) {
        if (!(error instanceof ConnectorError && error.kind === 'auth') || input.auth === 'none') {
          throw badRequest(`Could not connect to the MCP server: ${(error as Error).message}`);
        }
      }
    }
    if (input.auth === 'bearer') auth = { type: 'bearer' };
    if (input.auth === 'header') {
      if (!input.headerName) throw badRequest('headerName is required for header authentication');
      auth = { type: 'header', name: input.headerName };
    }
    let discovery: OAuthDiscovery | undefined;
    if (!auth) {
      discovery = await this.discoverOAuth(base.url, connectorId, input.name);
      if (discovery) auth = { type: 'oauth2', provider: discovery.spec, scopes: discovery.scopes };
      else if (input.auth === 'oauth2')
        throw badRequest('The MCP server does not advertise OAuth authorization');
      else auth = { type: 'bearer' };
    }

    const row = await this.insert(workspaceId, {
      connectorId,
      kind: 'mcp',
      definition: { ...base, auth } satisfies RemoteMcpDefinition as unknown as Record<string, unknown>,
      ...(tools ? { tools } : {}),
    });
    if (discovery) await this.ensureOAuthClient(workspaceId, discovery, row);
    return this.view((await this.deps.store.row(workspaceId, connectorId))!);
  }

  /** RFC 9728 + RFC 8414 discovery; undefined when the server has no OAuth authorization server. */
  private async discoverOAuth(
    serverUrl: string,
    connectorId: string,
    name: string,
  ): Promise<OAuthDiscovery | undefined> {
    let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
    try {
      info = await discoverOAuthServerInfo(serverUrl, { fetchFn: this.deps.fetch as never });
    } catch (error) {
      this.deps.logger.info({ err: error }, 'MCP OAuth discovery failed');
      return undefined;
    }
    const metadata = info.authorizationServerMetadata;
    if (!metadata?.authorization_endpoint || !metadata.token_endpoint) return undefined;
    const resource = info.resourceMetadata?.resource ?? serverUrl;
    const scopes = (info.resourceMetadata?.scopes_supported as string[] | undefined) ?? [];
    return {
      spec: {
        id: `mcp_${connectorId}`.slice(0, 40),
        name,
        authorizationUrl: metadata.authorization_endpoint,
        tokenUrl: metadata.token_endpoint,
        ...(typeof (metadata as { revocation_endpoint?: unknown }).revocation_endpoint === 'string'
          ? { revocationUrl: (metadata as { revocation_endpoint: string }).revocation_endpoint }
          : {}),
        pkce: true,
        clientAuth: 'client_secret_post',
        // RFC 8707: tokens are bound to this MCP server.
        authorizeParams: { resource },
        tokenParams: { resource },
      },
      scopes,
      metadata,
      authorizationServerUrl: info.authorizationServerUrl,
    };
  }

  /**
   * Registers the hub as an OAuth client of the server's authorization server, unless the
   * workspace already has an app for this provider. Without CIMD or DCR the user adds an app.
   */
  private async ensureOAuthClient(workspaceId: string, discovery: OAuthDiscovery, row: CustomConnectorRow) {
    const { spec: provider, metadata } = discovery;
    if (await this.deps.apps.pick(workspaceId, provider.id)) return;
    const methods = (metadata.token_endpoint_auth_methods_supported as string[] | undefined) ?? [
      'client_secret_basic',
    ];
    const label = `${provider.name} (registered automatically)`;
    if (
      this.deps.publicUrl.startsWith('https://') &&
      (metadata as { client_id_metadata_document_supported?: boolean })
        .client_id_metadata_document_supported &&
      methods.includes('none')
    ) {
      const document = hubClientMetadata(this.deps.publicUrl, this.deps.redirectUri);
      await this.deps.apps.create(
        workspaceId,
        { providerId: provider.id, label, clientId: document.client_id },
        new Set([provider.id]),
      );
      return;
    }
    if (!metadata.registration_endpoint) {
      await this.setError(
        row.id,
        `Add an OAuth app for ${provider.name}: the server does not support automatic registration`,
      );
      return;
    }
    const authMethod = methods.includes('client_secret_post')
      ? 'client_secret_post'
      : methods.includes('none')
        ? 'none'
        : 'client_secret_basic';
    try {
      const client = await registerClient(discovery.authorizationServerUrl, {
        metadata,
        clientMetadata: {
          client_name: 'AnyConnect',
          client_uri: this.deps.publicUrl,
          redirect_uris: [this.deps.redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: authMethod,
        },
        fetchFn: this.deps.fetch as never,
      });
      await this.deps.apps.create(
        workspaceId,
        {
          providerId: provider.id,
          label,
          clientId: client.client_id,
          ...(client.client_secret ? { clientSecret: client.client_secret } : {}),
        },
        new Set([provider.id]),
      );
    } catch (error) {
      await this.setError(
        row.id,
        `Automatic OAuth registration failed: ${(error as Error).message}`.slice(0, 500),
      );
    }
  }

  private async setError(rowId: string, message: string | null) {
    await this.deps.db
      .update(customConnectors)
      .set({ lastError: message })
      .where(eq(customConnectors.id, rowId));
  }

  /**
   * Re-reads the tool list of a remote MCP server through one of its connected accounts (or
   * anonymously). Called after an account connects, on demand, and by a daily job.
   */
  async refreshTools(workspaceId: string, connectorId: string, via?: AccountRow): Promise<ServiceView> {
    const row = await this.deps.store.row(workspaceId, connectorId);
    if (!row) throw notFound('Service');
    if (row.kind !== 'mcp') return this.view(row);
    const definition = row.definition as unknown as RemoteMcpDefinition;
    let ctx: { fetch: FetchLike; signal: AbortSignal; credentials: Record<string, unknown>; oauth?: never };
    if (definition.auth.type === 'none') {
      ctx = { fetch: this.deps.fetch, signal: AbortSignal.timeout(20_000), credentials: {} };
    } else {
      const account =
        via ??
        (
          await this.deps.db
            .select()
            .from(accounts)
            .where(
              and(
                eq(accounts.workspaceId, workspaceId),
                eq(accounts.connectorId, connectorId),
                eq(accounts.enabled, true),
              ),
            )
        ).find((a) => a.status !== 'needs_reauth');
      if (!account)
        throw new AppError(
          409,
          'no_account',
          'Connect an account first: the server only lists tools to signed-in users',
        );
      const connector = this.deps.store.compiled(row);
      if (!connector) throw badRequest('The stored service definition is invalid');
      ctx = (await this.deps.accounts.buildContext(connector, account, {
        signal: AbortSignal.timeout(20_000),
        logger: this.deps.logger,
      })) as never;
    }
    try {
      const tools = await listRemoteTools(definition.url, definition.auth, ctx);
      await this.deps.db
        .update(customConnectors)
        .set({ tools, toolsRefreshedAt: new Date(), lastError: null })
        .where(eq(customConnectors.id, row.id));
    } catch (error) {
      await this.setError(row.id, `Could not list tools: ${(error as Error).message}`.slice(0, 500));
      throw error instanceof ConnectorError ? badRequest(error.message) : error;
    }
    return this.view((await this.deps.store.row(workspaceId, connectorId))!);
  }

  /** Hook after an account of any service was connected or created. */
  async afterAccountConnected(account: AccountRow): Promise<void> {
    const row = await this.deps.store.row(account.workspaceId, account.connectorId);
    if (row?.kind !== 'mcp') return;
    await this.refreshTools(account.workspaceId, account.connectorId, account).catch((error) =>
      this.deps.logger.warn(
        { err: error, service: account.connectorId },
        'tool refresh after connect failed',
      ),
    );
  }

  /** Refreshes every remote MCP server (daily job). */
  async refreshAll(): Promise<void> {
    const rows = await this.deps.db.select().from(customConnectors).where(eq(customConnectors.kind, 'mcp'));
    for (const row of rows) {
      await this.refreshTools(row.workspaceId, row.connectorId).catch(() => {});
    }
  }

  async remove(workspaceId: string, connectorId: string): Promise<void> {
    const row = await this.deps.store.row(workspaceId, connectorId);
    if (!row) throw notFound('Service');
    const [used] = await this.deps.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.connectorId, connectorId)))
      .limit(1);
    if (used) throw conflict('Delete the accounts of this service first');
    await this.deps.db.delete(customConnectors).where(eq(customConnectors.id, row.id));
  }
}
