import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { AdminService } from './admin/service.js';
import { EntitlementService } from './billing/entitlements.js';
import type { BillingProvider } from './billing/provider.js';
import type { AppConfig } from './config.js';
import { type BuiltinDeps, createBuiltinRegistry } from './connectors/index.js';
import type { MessagingPort } from './connectors/messaging.js';
import type { ConnectorRegistry } from './connectors/registry.js';
import { actionText, connectorText } from './connectors/sdk.js';
import { AccountKeyring } from './core/account-keys.js';
import { AccountService } from './core/accounts.js';
import { ActivityService } from './core/activity.js';
import { ApiTokenService } from './core/api-tokens.js';
import { HubTokenVerifier } from './core/auth.js';
import { ConnectService } from './core/connect.js';
import { CustomConnectorStore, WorkspaceConnectorResolver } from './core/custom-connectors.js';
import { CustomServiceManager } from './core/custom-services.js';
import { ExternalLoginService, googleLoginSpec, OidcLoginProvider } from './core/external-login.js';
import { AccountHealthService } from './core/health.js';
import { OAuthAppService } from './core/oauth-apps.js';
import { TokenManager } from './core/oauth-tokens.js';
import { PasskeyService } from './core/passkeys.js';
import { RecoveryCodeService } from './core/recovery-codes.js';
import { SecondFactorService } from './core/second-factors.js';
import { TotpService } from './core/totp.js';
import { activeUserCheck, UserService } from './core/users.js';
import { WorkspaceAdmin } from './core/workspace-admin.js';
import { createDatabase, type Database, type Db } from './db/client.js';
import type { StageMap } from './hub/executor.js';
import { Hub, type HubDeps } from './hub/hub.js';
import { type IdempotencyStore, MemoryIdempotencyStore } from './hub/idempotency.js';
import { SETUP_CONNECTOR } from './hub/setup-tools.js';
import { PgUsageMeter, type UsageMeter } from './hub/usage.js';
import { builtinJobs } from './jobs/builtin.js';
import { JobQueue } from './jobs/queue.js';
import { SecretBox } from './lib/crypto.js';
import { createNetworkPolicy, type NetworkPolicy } from './lib/network.js';
import { RateLimiter } from './lib/rate-limit.js';
import type { safeFetch } from './lib/safe-fetch.js';
import { createLogger, type Logger } from './logger.js';
import { createHubMcpHandler, createVisitorMcpHandler } from './mcp/handler.js';
import { createMessaging, type Messaging } from './messaging/index.js';
import { ClientRegistry } from './oauth/clients.js';
import { OAuthServer } from './oauth/server.js';
import { AiClientService } from './security/clients.js';
import { ConfirmationCenter, type DescribeCall } from './security/confirmations.js';
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
import { PendingLoginService } from './web/pending-logins.js';
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
  /** Workspace administration (what the setup tools and the panel do for the user). */
  admin: WorkspaceAdmin;
  /** Usage counters per workspace, AI account and action. */
  usage: UsageMeter;
  /** Plans, limits and grants (billing layer). */
  entitlements: EntitlementService;
  /** Payment provider; undefined until payments are connected (see `src/billing/provider.ts`). */
  billing: BillingProvider | undefined;
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
  /** Sign-up through external providers, roles, suspension, deletion. */
  users: UserService;
  /** The hub owner's admin panel: user directory, plans, extra limits, admin log. */
  adminPanel: AdminService;
  /** Counts over the audit log for the dashboard. */
  activity: ActivityService;
  /** "Sign in with Google" and other OpenID Connect providers. */
  externalLogin: ExternalLoginService;
  /** Sign-ins waiting for a second factor. */
  pendingLogins: PendingLoginService;
  /** TOTP, recovery codes and passkeys. */
  secondFactors: SecondFactorService;
  rateLimiter: RateLimiter;
  idempotency: IdempotencyStore;
  mcp: McpHttpHandler;
  messaging: Messaging;
  /** /mcp for apps that have not signed in yet; absent when `MCP_ANONYMOUS` is off. */
  visitorMcp?: McpHttpHandler;
  close(): Promise<void>;
}

export function createServices(
  config: AppConfig,
  overrides: {
    logger?: Logger;
    connectors?: ConnectorRegistry | ((deps: BuiltinDeps) => ConnectorRegistry);
    /** Tests: fetch Client ID Metadata Documents from localhost. */
    allowPrivateNetwork?: boolean;
    fetchDocument?: typeof safeFetch;
    /** Executor stages to add or replace (security layer: policy, confirm, untrusted). */
    stages?: StageMap;
    catalogFilter?: HubDeps['catalogFilter'];
    /** Tests: talk to a fake Telegram Bot API. */
    telegramFetch?: typeof fetch;
    /** A payment provider (none is built in yet). */
    billing?: BillingProvider;
    /** Tests: external sign-in providers with fake endpoints. */
    loginProviders?: OidcLoginProvider[];
  } = {},
): Services {
  const logger =
    overrides.logger ??
    createLogger({ level: config.logLevel, pretty: !config.isProduction && process.stdout.isTTY === true });
  const database = createDatabase(config.database.url, { poolMax: config.database.poolMax });
  const db = database.db;
  const secrets = new SecretBox(config.encryption.key, config.encryption.previousKeys);
  const customStore = new CustomConnectorStore(db, logger);
  // Built-in connectors get ports to hub subsystems that are built after them (they need the registry).
  let messaging: Messaging | undefined;
  const messagingPort: MessagingPort = {
    forAccount: (accountId) => {
      if (!messaging) throw new Error('messaging is not initialized');
      return messaging.service.forAccount(accountId);
    },
  };
  const builtinDeps: BuiltinDeps = { messaging: messagingPort };
  const builtin =
    typeof overrides.connectors === 'function'
      ? overrides.connectors(builtinDeps)
      : (overrides.connectors ?? createBuiltinRegistry(builtinDeps));
  const connectors = new WorkspaceConnectorResolver(builtin, customStore);
  const network = createNetworkPolicy({
    allowPrivateNetwork: overrides.allowPrivateNetwork ?? config.allowPrivateNetwork,
  });
  const oauthApps = new OAuthAppService(db, secrets, config.oauthApps);
  const keyring = new AccountKeyring(secrets, secrets);
  const tokens = new TokenManager({ db, keys: keyring, apps: oauthApps, fetch: network.fetch, logger });
  const usage = new PgUsageMeter(db);
  const entitlements = new EntitlementService({ db, usage, pricingUrl: `${config.publicUrl}/app/billing` });
  const accounts = new AccountService(db, connectors, keyring, network, tokens, entitlements);
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
  messaging = createMessaging({
    publicUrl: config.publicUrl,
    gatewayConfig: config.gateway,
    db,
    secrets,
    accounts,
    connectors,
    builtin,
    logger,
  });
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
  const describeCall: DescribeCall = async (row, locale) => {
    const [connector, account, client] = await Promise.all([
      row.connectorId === SETUP_CONNECTOR.id
        ? SETUP_CONNECTOR
        : connectors.get(row.workspaceId, row.connectorId),
      row.accountId ? accounts.get(row.workspaceId, row.accountId).catch(() => undefined) : undefined,
      row.principal.aiClientId
        ? aiClients.get(row.workspaceId, row.principal.aiClientId).catch(() => undefined)
        : undefined,
    ]);
    const action = connector?.actions.find((a) => a.name === row.action);
    return {
      service: connector ? connectorText(connector, locale).name : row.connectorId,
      action: connector && action ? actionText(connector, action, locale).title : row.action,
      account: account ? `${account.label} (${account.name})` : (row.accountId ?? 'settings'),
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
    t: translator,
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

  const admin = new WorkspaceAdmin({
    db,
    connectors,
    builtin: connectors.builtin,
    accounts,
    customServices,
    apps: oauthApps,
    publicUrl: config.publicUrl,
    logger,
  });
  const hub = new Hub({
    db,
    meter: usage,
    quota: entitlements,
    connectors,
    accounts,
    logger,
    setup: { connector: SETUP_CONNECTOR, admin },
    rateLimiter,
    idempotency,
    toolTimeoutMs: config.toolTimeoutMs,
    maxResultTokens: config.tools.maxResultTokens,
    idempotencyWindowMs: config.tools.idempotencyWindowMs,
    toolListTokenBudget: config.tools.listTokenBudget,
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
  const verifier = new HubTokenVerifier(
    oauth,
    apiTokens,
    config.mcpUrl,
    async (workspaceId, personaId) => {
      const persona = await personas.get(workspaceId, personaId).catch(() => undefined);
      return persona && personas.urlFor(persona.slug);
    },
    activeUserCheck(db),
  );
  const sessions = new SessionService(db, config.sessionTtlSeconds);
  const users = new UserService({
    db,
    accounts,
    oauth,
    apiTokens,
    adminEmails: config.site.adminEmails,
    signups: config.site.signups,
  });
  const externalLogin = new ExternalLoginService(
    { db, secrets, publicUrl: config.publicUrl, logger },
    overrides.loginProviders ??
      (config.site.google ? [new OidcLoginProvider(googleLoginSpec(config.site.google), network.fetch)] : []),
  );
  const adminPanel = new AdminService({ db, users, entitlements });
  const activity = new ActivityService(db);
  const pendingLogins = new PendingLoginService(db);
  const secondFactors = new SecondFactorService(
    new TotpService(db, secrets, config.auth.rpName),
    new RecoveryCodeService(db),
    new PasskeyService(db, { id: config.auth.rpId, name: config.auth.rpName, origin: config.auth.origin }),
  );
  const mcp = createHubMcpHandler({ hub, logger, version: VERSION });
  const visitorMcp = config.anonymousMcp.enabled
    ? createVisitorMcpHandler({ admin, setup: SETUP_CONNECTOR, logger, version: VERSION })
    : undefined;

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
    admin,
    usage,
    entitlements,
    billing: overrides.billing,
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
    users,
    externalLogin,
    adminPanel,
    activity,
    pendingLogins,
    secondFactors,
    rateLimiter,
    idempotency,
    mcp,
    messaging,
    ...(visitorMcp ? { visitorMcp } : {}),
    async close() {
      await messaging?.stop();
      await pendingRunner.stop();
      rateLimiter.close();
      await jobs.stop();
      await mcp.close();
      await visitorMcp?.close();
      await network.close();
      await database.close();
    },
  };
}
