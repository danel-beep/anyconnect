import type { McpHttpHandler } from '@modelcontextprotocol/server';
import type { AppConfig } from './config.js';
import { createBuiltinRegistry } from './connectors/index.js';
import type { ConnectorRegistry } from './connectors/registry.js';
import { AccountKeyring } from './core/account-keys.js';
import { AccountService } from './core/accounts.js';
import { ApiTokenService } from './core/api-tokens.js';
import { HubTokenVerifier } from './core/auth.js';
import { createDatabase, type Database, type Db } from './db/client.js';
import type { StageMap } from './hub/executor.js';
import { Hub, type HubDeps } from './hub/hub.js';
import { type IdempotencyStore, MemoryIdempotencyStore } from './hub/idempotency.js';
import { SecretBox } from './lib/crypto.js';
import { createNetworkPolicy, type NetworkPolicy } from './lib/network.js';
import { RateLimiter } from './lib/rate-limit.js';
import type { safeFetch } from './lib/safe-fetch.js';
import { createLogger, type Logger } from './logger.js';
import { createHubMcpHandler } from './mcp/handler.js';
import { ClientRegistry } from './oauth/clients.js';
import { OAuthServer } from './oauth/server.js';
import { AiClientService } from './security/clients.js';
import { PERSONA_SLUG, PersonaService } from './security/personas.js';
import { PolicyService } from './security/policy-service.js';
import { VERSION } from './version.js';
import { SessionService } from './web/sessions.js';

/** Everything the app needs, wired once. Tests build the same graph with overrides. */
export interface Services {
  config: AppConfig;
  version: string;
  logger: Logger;
  database: Database;
  db: Db;
  secrets: SecretBox;
  /** Outbound network for connectors (`ctx.fetch`, `ctx.network`). */
  network: NetworkPolicy;
  connectors: ConnectorRegistry;
  accounts: AccountService;
  apiTokens: ApiTokenService;
  hub: Hub;
  clients: ClientRegistry;
  oauth: OAuthServer;
  verifier: HubTokenVerifier;
  aiClients: AiClientService;
  personas: PersonaService;
  policies: PolicyService;
  sessions: SessionService;
  rateLimiter: RateLimiter;
  idempotency: IdempotencyStore;
  mcp: McpHttpHandler;
  close(): Promise<void>;
}

export function createServices(
  config: AppConfig,
  overrides: {
    logger?: Logger;
    connectors?: ConnectorRegistry;
    /** Tests: fetch Client ID Metadata Documents from localhost. */
    allowPrivateNetwork?: boolean;
    fetchDocument?: typeof safeFetch;
    /** Executor stages to add or replace (security layer: policy, confirm, untrusted). */
    stages?: StageMap;
    catalogFilter?: HubDeps['catalogFilter'];
  } = {},
): Services {
  const logger =
    overrides.logger ??
    createLogger({ level: config.logLevel, pretty: !config.isProduction && process.stdout.isTTY === true });
  const database = createDatabase(config.database.url, { poolMax: config.database.poolMax });
  const db = database.db;
  const secrets = new SecretBox(config.encryption.key, config.encryption.previousKeys);
  const connectors = overrides.connectors ?? createBuiltinRegistry();
  const network = createNetworkPolicy({
    allowPrivateNetwork: overrides.allowPrivateNetwork ?? config.allowPrivateNetwork,
  });
  const accounts = new AccountService(db, connectors, new AccountKeyring(secrets, secrets), network);
  const apiTokens = new ApiTokenService(db);
  const rateLimiter = new RateLimiter();
  const idempotency = new MemoryIdempotencyStore();
  const hub = new Hub({
    db,
    connectors,
    accounts,
    logger,
    rateLimiter,
    idempotency,
    toolTimeoutMs: config.toolTimeoutMs,
    maxResultTokens: config.tools.maxResultTokens,
    idempotencyWindowMs: config.tools.idempotencyWindowMs,
    ...(overrides.stages ? { stages: overrides.stages } : {}),
    ...(overrides.catalogFilter ? { catalogFilter: overrides.catalogFilter } : {}),
  });
  const clients = new ClientRegistry(db, {
    dynamicRegistration: config.oauth.dynamicRegistration,
    metadataDocuments: config.oauth.clientMetadataDocuments,
    allowPrivateNetwork: overrides.allowPrivateNetwork ?? false,
    ...(overrides.fetchDocument ? { fetchDocument: overrides.fetchDocument } : {}),
    logger,
  });
  const oauth = new OAuthServer({
    db,
    clients,
    issuer: config.publicUrl,
    resource: config.mcpUrl,
    subResource: PERSONA_SLUG,
    accessTokenTtlSeconds: config.oauth.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.oauth.refreshTokenTtlSeconds,
    logger,
  });
  const personas = new PersonaService(db, config.mcpUrl);
  const aiClients = new AiClientService(db);
  const policies = new PolicyService(db);
  const verifier = new HubTokenVerifier(oauth, apiTokens, config.mcpUrl, async (workspaceId, personaId) => {
    const persona = await personas.get(workspaceId, personaId).catch(() => undefined);
    return persona && personas.urlFor(persona.slug);
  });
  const sessions = new SessionService(db, config.sessionTtlSeconds);
  const mcp = createHubMcpHandler({ hub, logger, version: VERSION });

  return {
    config,
    version: VERSION,
    logger,
    database,
    db,
    secrets,
    network,
    connectors,
    accounts,
    apiTokens,
    hub,
    clients,
    oauth,
    verifier,
    aiClients,
    personas,
    policies,
    sessions,
    rateLimiter,
    idempotency,
    mcp,
    async close() {
      rateLimiter.close();
      await mcp.close();
      await network.close();
      await database.close();
    },
  };
}
