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
import { type CallDescription, ConfirmationCenter } from './security/confirmations.js';
import { NotificationChannels } from './security/notifications.js';
import { PendingCallService, principalOf } from './security/pending-calls.js';
import { PERSONA_SLUG, PersonaService } from './security/personas.js';
import { PolicyService } from './security/policy-service.js';
import { PendingCallRunner } from './security/runner.js';
import {
  confirmStage,
  createCatalogFilter,
  policyStage,
  toStored,
  untrustedStage,
} from './security/stages.js';
import { TelegramBot } from './security/telegram.js';
import { VERSION } from './version.js';
import { translator } from './web/i18n.js';
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
  /** Calls held back for the user's confirmation or an undo window. */
  pendingCalls: PendingCallService;
  notificationChannels: NotificationChannels;
  confirmations: ConfirmationCenter;
  /** Runs approved calls when their undo window ends (started by the server, not by tests). */
  pendingRunner: PendingCallRunner;
  /** The hub's own Telegram bot, when TELEGRAM_BOT_TOKEN is set. */
  telegramBot: TelegramBot | undefined;
  /** Secret Telegram must send with webhook updates (derived from the master key). */
  telegramWebhookSecret: string;
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
    /** Tests: talk to a fake Telegram Bot API. */
    telegramFetch?: typeof fetch;
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

  // Security layer: who may do what, confirmations, undo windows.
  const personas = new PersonaService(db, config.mcpUrl);
  const aiClients = new AiClientService(db);
  const policies = new PolicyService(db);
  const pendingCalls = new PendingCallService(db, secrets, { confirmationTtlMs: config.confirmations.ttlMs });
  const notificationChannels = new NotificationChannels(db);
  const telegramBot = config.telegram.botToken
    ? new TelegramBot(config.telegram.botToken, {
        apiUrl: config.telegram.apiUrl,
        logger,
        ...(overrides.telegramFetch ? { fetch: overrides.telegramFetch } : {}),
      })
    : undefined;
  const describeCall = async (
    row: Parameters<ConfirmationCenter['describe']>[0],
  ): Promise<CallDescription> => {
    const [connector, account, client] = await Promise.all([
      connectors.get(row.workspaceId, row.connectorId),
      accounts.get(row.workspaceId, row.accountId).catch(() => undefined),
      row.principal.aiClientId
        ? aiClients.get(row.workspaceId, row.principal.aiClientId).catch(() => undefined)
        : undefined,
    ]);
    const action = connector?.actions.find((a) => a.name === row.action);
    return {
      service: connector?.name ?? row.connectorId,
      action: action?.title ?? row.action,
      account: account ? `${account.label} (${account.name})` : row.accountId,
      client: client?.name ?? (row.principal.kind === 'api_token' ? 'API token' : 'AI app'),
      risk: row.risk,
      reason: row.reason ?? undefined,
    };
  };
  const confirmations = new ConfirmationCenter({
    pending: pendingCalls,
    channels: notificationChannels,
    bot: telegramBot,
    publicUrl: config.publicUrl,
    describe: describeCall,
    t: translator('ru'),
    logger,
  });
  const securityStages: StageMap = {
    policy: policyStage(policies),
    confirm: confirmStage({
      policies,
      pending: pendingCalls,
      center: confirmations,
      stateKey: secrets.deriveKey('confirm-state'),
      waitMs: config.confirmations.waitMs,
    }),
    untrusted: untrustedStage,
  };

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
    stages: { ...securityStages, ...overrides.stages },
    catalogFilter: overrides.catalogFilter ?? createCatalogFilter(policies),
  });
  const pendingRunner = new PendingCallRunner({
    pending: pendingCalls,
    center: confirmations,
    run: async (row, args) => toStored(await hub.runApproved(principalOf(row), row, args)),
    logger,
    intervalMs: config.confirmations.runnerIntervalMs,
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
    pendingCalls,
    notificationChannels,
    confirmations,
    pendingRunner,
    telegramBot,
    telegramWebhookSecret: secrets.deriveKey('telegram-webhook').toString('base64url'),
    sessions,
    rateLimiter,
    idempotency,
    mcp,
    async close() {
      await pendingRunner.stop();
      rateLimiter.close();
      await mcp.close();
      await network.close();
      await database.close();
    },
  };
}
