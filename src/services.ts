import type { McpHttpHandler } from '@modelcontextprotocol/server';
import type { AppConfig } from './config.js';
import { createBuiltinRegistry } from './connectors/index.js';
import type { ConnectorRegistry } from './connectors/registry.js';
import { AccountService } from './core/accounts.js';
import { ApiTokenService } from './core/api-tokens.js';
import { HubTokenVerifier } from './core/auth.js';
import { ConnectService } from './core/connect.js';
import { CustomConnectorStore, WorkspaceConnectorResolver } from './core/custom-connectors.js';
import { CustomServiceManager } from './core/custom-services.js';
import { AccountHealthService } from './core/health.js';
import { OAuthAppService } from './core/oauth-apps.js';
import { TokenManager } from './core/oauth-tokens.js';
import { createDatabase, type Database, type Db } from './db/client.js';
import { Hub } from './hub/hub.js';
import { builtinJobs } from './jobs/builtin.js';
import { JobQueue } from './jobs/queue.js';
import { SecretBox } from './lib/crypto.js';
import { createNetworkPolicy, type NetworkPolicy } from './lib/network.js';
import { RateLimiter } from './lib/rate-limit.js';
import type { safeFetch } from './lib/safe-fetch.js';
import { createLogger, type Logger } from './logger.js';
import { createHubMcpHandler } from './mcp/handler.js';
import { ClientRegistry } from './oauth/clients.js';
import { OAuthServer } from './oauth/server.js';
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
  /** Built-in connectors plus the services users defined in their workspaces. */
  connectors: WorkspaceConnectorResolver;
  /** Remote MCP servers and HTTP manifests added without code. */
  customServices: CustomServiceManager;
  accounts: AccountService;
  /** OAuth apps of service providers (hub-wide from env, or the user's own). */
  oauthApps: OAuthAppService;
  /** OAuth tokens of connected accounts. */
  tokens: TokenManager;
  /** "Connect an account" OAuth flows. */
  connect: ConnectService;
  health: AccountHealthService;
  /** Background jobs; started by `startJobs()` in processes that run them. */
  jobs: JobQueue;
  apiTokens: ApiTokenService;
  hub: Hub;
  clients: ClientRegistry;
  oauth: OAuthServer;
  verifier: HubTokenVerifier;
  sessions: SessionService;
  rateLimiter: RateLimiter;
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
  } = {},
): Services {
  const logger =
    overrides.logger ??
    createLogger({ level: config.logLevel, pretty: !config.isProduction && process.stdout.isTTY === true });
  const database = createDatabase(config.database.url, { poolMax: config.database.poolMax });
  const db = database.db;
  const secrets = new SecretBox(config.encryption.key, config.encryption.previousKeys);
  const customStore = new CustomConnectorStore(db, logger);
  const connectors = new WorkspaceConnectorResolver(
    overrides.connectors ?? createBuiltinRegistry(),
    customStore,
  );
  const network = createNetworkPolicy({
    allowPrivateNetwork: overrides.allowPrivateNetwork ?? config.allowPrivateNetwork,
  });
  const oauthApps = new OAuthAppService(db, secrets, config.oauthApps);
  const tokens = new TokenManager({ db, secrets, apps: oauthApps, fetch: network.fetch, logger });
  const accounts = new AccountService(db, connectors, secrets, network, tokens);
  const customServices = new CustomServiceManager({
    db,
    store: customStore,
    builtin: connectors.builtin,
    accounts,
    apps: oauthApps,
    fetch: network.fetch,
    publicUrl: config.publicUrl,
    redirectUri: `${config.publicUrl}/connect/callback`,
    logger,
  });
  const connect = new ConnectService({
    db,
    secrets,
    connectors,
    accounts,
    apps: oauthApps,
    tokens,
    fetch: network.fetch,
    redirectUri: `${config.publicUrl}/connect/callback`,
    onConnected: (account) => customServices.afterAccountConnected(account),
    logger,
  });
  const health = new AccountHealthService({ db, connectors, accounts, tokens, logger });
  const jobs = new JobQueue({ connectionString: config.database.url, logger });
  for (const job of builtinJobs({ health, customServices })) jobs.register(job);
  const apiTokens = new ApiTokenService(db);
  const hub = new Hub({ db, connectors, accounts, logger, toolTimeoutMs: config.toolTimeoutMs });
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
    accessTokenTtlSeconds: config.oauth.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.oauth.refreshTokenTtlSeconds,
    logger,
  });
  const verifier = new HubTokenVerifier(oauth, apiTokens, config.mcpUrl);
  const sessions = new SessionService(db, config.sessionTtlSeconds);
  const rateLimiter = new RateLimiter();
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
    customServices,
    accounts,
    oauthApps,
    tokens,
    connect,
    health,
    jobs,
    apiTokens,
    hub,
    clients,
    oauth,
    verifier,
    sessions,
    rateLimiter,
    mcp,
    async close() {
      rateLimiter.close();
      await jobs.stop();
      await mcp.close();
      await network.close();
      await database.close();
    },
  };
}
