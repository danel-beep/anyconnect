import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { AdminService } from './admin/service.js';
import { Analytics } from './analytics/index.js';
import { WorkspaceBillingTools } from './billing/assistant.js';
import { EntitlementService } from './billing/entitlements.js';
import { Payers } from './billing/payers.js';
import type { BillingProvider } from './billing/provider.js';
import { createBillingProvider, TestBillingProvider } from './billing/providers/index.js';
import { ReferralService } from './billing/referrals.js';
import { BillingService } from './billing/service.js';
import type { AppConfig } from './config.js';
import { NO_HUB_BOT, type TelegramHubBot } from './connectors/builtin/telegram-bot.js';
import { type BuiltinDeps, createBuiltinRegistry } from './connectors/index.js';
import type { MessagingPort } from './connectors/messaging.js';
import type { ConnectorRegistry } from './connectors/registry.js';
import { actionText, connectorText } from './connectors/sdk.js';
import { AccountAlerts } from './core/account-alerts.js';
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
import { getWorkspace } from './core/identity.js';
import { isMcpSubPath } from './core/mcp-paths.js';
import { OAuthAppService } from './core/oauth-apps.js';
import { TokenManager } from './core/oauth-tokens.js';
import { PasskeyService } from './core/passkeys.js';
import type { Principal } from './core/principal.js';
import { QuickConnects } from './core/quick-connect.js';
import { RecoveryCodeService } from './core/recovery-codes.js';
import { SecondFactorService } from './core/second-factors.js';
import { TeamService } from './core/teams.js';
import { TotpService } from './core/totp.js';
import { activeUserCheck, memberCheck, UserService } from './core/users.js';
import { VaultGrantLinks } from './core/vault-links.js';
import { VaultScopes } from './core/vault-scope.js';
import { VaultService } from './core/vaults.js';
import { WorkspaceAdmin } from './core/workspace-admin.js';
import { createDatabase, type Database, type Db } from './db/client.js';
import { PgListener } from './db/listener.js';
import { TelegramLanding } from './growth/telegram-landing.js';
import type { CatalogTeam } from './hub/catalog-types.js';
import type { StageMap } from './hub/executor.js';
import { Hub, type HubDeps } from './hub/hub.js';
import { type IdempotencyStore, MemoryIdempotencyStore } from './hub/idempotency.js';
import { SETUP_CONNECTOR, teamCatalogFilter } from './hub/setup-tools.js';
import { PgUsageMeter, type UsageMeter } from './hub/usage.js';
import { builtinJobs } from './jobs/builtin.js';
import { JobQueue } from './jobs/queue.js';
import { CircuitBreaker } from './lib/circuit-breaker.js';
import { parseKey, SecretBox } from './lib/crypto.js';
import { createNetworkPolicy, type NetworkPolicy } from './lib/network.js';
import { RateLimiter } from './lib/rate-limit.js';
import { S3Client } from './lib/s3.js';
import type { safeFetch } from './lib/safe-fetch.js';
import { createLogger, type Logger } from './logger.js';
import { createMailer, type Mailer } from './mail/mailer.js';
import { createHubMcpHandler, createVisitorMcpHandler } from './mcp/handler.js';
import { createMessaging, type Messaging } from './messaging/index.js';
import { TelegramAutomation } from './messaging/telegram-automation.js';
import { BillingNotices } from './notices/billing-notices.js';
import { NoticeService } from './notices/notices.js';
import { ClientRegistry } from './oauth/clients.js';
import { OAuthServer } from './oauth/server.js';
import { BackupService, type DumpTools } from './ops/backups.js';
import { createOps, type Ops, watchConnections, watchJobs } from './ops/index.js';
import { AiAppService } from './security/apps.js';
import { UserSecurityTools, WorkspaceAppTools, WorkspaceProfileTools } from './security/assistant.js';
import { AiClientService } from './security/clients.js';
import { ConfirmationCenter, type DescribeCall } from './security/confirmations.js';
import { isTeamAdmin } from './security/members.js';
import { NotificationChannels } from './security/notifications.js';
import { TelegramOwnerNotifier } from './security/owner-notifier.js';
import {
  latestRunAt,
  type PendingCallRow,
  PendingCallService,
  principalOf,
} from './security/pending-calls.js';
import { PersonaService } from './security/personas.js';
import { PolicyService } from './security/policy-service.js';
import { PendingCallRunner } from './security/runner.js';
import {
  approvalsStage,
  confirmStage,
  createCatalogFilter,
  policyStage,
  toStored,
  untrustedStage,
} from './security/stages.js';
import { StandingApprovals } from './security/standing-approvals.js';
import { type BotUpdateHandler, chainUpdateHandlers, TelegramBot } from './security/telegram.js';
import { createTriggers, type Triggers } from './triggers/index.js';
import { VERSION } from './version.js';
import { translator } from './web/i18n.js';
import { PendingLoginService } from './web/pending-logins.js';
import { SessionService } from './web/sessions.js';

/** Everything the app needs, wired once. Tests build the same graph with overrides. */
export interface Services {
  config: AppConfig;
  version: string;
  logger: Logger;
  /** Error tracking, health checks, job run history. */
  ops: Ops;
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
  /** Payments: checkout, portal, webhooks (provider-agnostic; `billing.provider` may be undefined). */
  billing: BillingService;
  /** The hub's own email (undefined = `MAIL_PROVIDER=none`). */
  mailer: Mailer | undefined;
  /** One-off emails to workspace owners (billing notices, invite rewards). */
  notices: NoticeService;
  billingNotices: BillingNotices;
  /** Invite links and the month of Pro for a paying invitee. */
  referrals: ReferralService;
  accounts: AccountService;
  /** User vaults: sealed accounts (docs/VAULTS.md). */
  vaults: VaultService;
  /** The vault open in the current request, if any. */
  vaultScopes: VaultScopes;
  /** AI apps' and tokens' ways into vaults, and their requests to be let in. */
  vaultLinks: VaultGrantLinks;
  /**
   * Keeps the current request's open vault for a held-back call on a sealed account, which the
   * runner executes later (when held back, and again when approved on the web).
   */
  retainVault: (row: PendingCallRow) => Promise<void>;
  /** OAuth apps of service providers (hub-wide from env, or the user's own). */
  oauthApps: OAuthAppService;
  /** OAuth tokens of connected accounts. */
  tokens: TokenManager;
  /** "Connect an account" OAuth flows. */
  connect: ConnectService;
  health: AccountHealthService;
  /** Tells owners about accounts that need a new sign-in. */
  alerts: AccountAlerts;
  /** Database backups; absent when no bucket is configured. */
  backups: BackupService | undefined;
  /** Background jobs; started by `startJobs()` in processes that run them. */
  jobs: JobQueue;
  /**
   * Postgres notifications that wake the background loops (outbox) instead of polling; started with
   * them in `src/index.ts`. Not started in tests, where the loops fall back to polling.
   */
  listener: PgListener;
  apiTokens: ApiTokenService;
  hub: Hub;
  clients: ClientRegistry;
  oauth: OAuthServer;
  verifier: HubTokenVerifier;
  aiClients: AiClientService;
  /** AI apps with their sign-ins and tokens (rename, disconnect). */
  aiApps: AiAppService;
  personas: PersonaService;
  policies: PolicyService;
  /** Calls held back for the user's confirmation or an undo window. */
  pendingCalls: PendingCallService;
  /** Series of calls the user approved once, e.g. a conversation the AI carries on. */
  approvals: StandingApprovals;
  notificationChannels: NotificationChannels;
  confirmations: ConfirmationCenter;
  /** Runs approved calls when their undo window ends (started by the server, not by tests). */
  pendingRunner: PendingCallRunner;
  /** The hub's own Telegram bot, when TELEGRAM_BOT_TOKEN is set. */
  telegramBot: TelegramBot | undefined;
  /** Telegram accounts connected by adding the hub's bot under Chat Automation (needs the bot). */
  telegramAutomation: TelegramAutomation | undefined;
  /** Every update of the hub's bot goes through here (`/telegram/webhook`). */
  telegramUpdates: BotUpdateHandler;
  /** Connecting accounts by confirming in the service's own app (`core/quick-connect.ts`). */
  quickConnects: QuickConnects;
  /** Secret Telegram must send with webhook updates (derived from the master key). */
  telegramWebhookSecret: string;
  sessions: SessionService;
  /** Sign-up through external providers, roles, suspension, deletion. */
  users: UserService;
  /** Teams: members, invitations, sharing accounts, leaving. */
  teams: TeamService;
  /** The hub owner's admin panel: user directory, plans, extra limits, admin log. */
  adminPanel: AdminService;
  /** Counts over the audit log for the dashboard. */
  activity: ActivityService;
  /** First-party analytics: traffic, funnel, product usage (admin panel → Analytics). */
  analytics: Analytics;
  /** "Sign in with Google" and other OpenID Connect providers. */
  externalLogin: ExternalLoginService;
  /** Sign-ins waiting for a second factor. */
  pendingLogins: PendingLoginService;
  /** TOTP, recovery codes and passkeys. */
  secondFactors: SecondFactorService;
  rateLimiter: RateLimiter;
  circuitBreaker: CircuitBreaker;
  idempotency: IdempotencyStore;
  mcp: McpHttpHandler;
  messaging: Messaging;
  /** Triggers: rules on new messages and mail, the event feed, AI keys (docs/TRIGGERS.md). */
  triggers: Triggers;
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
    /**
     * Outbound network for connectors, provider OAuth and "Sign in with Google" (tests: a fake
     * internet that answers for the real service hosts, see `test/e2e/fake-internet.ts`).
     */
    network?: NetworkPolicy;
    fetchDocument?: typeof safeFetch;
    /** Executor stages to add or replace (security layer: policy, confirm, untrusted). */
    stages?: StageMap;
    catalogFilter?: HubDeps['catalogFilter'];
    /** Tests: talk to a fake Telegram Bot API. */
    telegramFetch?: typeof fetch;
    /** A payment provider instead of the configured one (tests). */
    billing?: BillingProvider;
    /** Tests: talk to fake payment provider APIs. */
    billingFetch?: typeof fetch;
    /** A mailer instead of the configured one (tests: `MemoryMailer`). */
    mailer?: Mailer;
    /** Tests: external sign-in providers with fake endpoints. */
    loginProviders?: OidcLoginProvider[];
    /** Tests: a fake Sentry. */
    sentryFetch?: typeof fetch;
    /** Replaces pg_dump / pg_restore (backup tests). */
    backupTools?: DumpTools;
  } = {},
): Services {
  const logger =
    overrides.logger ??
    createLogger({ level: config.logLevel, pretty: !config.isProduction && process.stdout.isTTY === true });
  const database = createDatabase(config.database.url, { poolMax: config.database.poolMax });
  const db = database.db;
  const ops = createOps({
    config,
    version: VERSION,
    logger,
    database,
    ...(overrides.sentryFetch ? { sentryFetch: overrides.sentryFetch } : {}),
  });
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
  // Accounts connected through Telegram Chat Automation reach the Bot API through the hub's own
  // bot, which is wired further down (it needs accounts, teams and messaging).
  let telegramAutomation: TelegramAutomation | undefined;
  const telegramHubBot: TelegramHubBot = {
    call: (...args) => (telegramAutomation ?? NO_HUB_BOT).call(...args),
    file: (...args) => (telegramAutomation ?? NO_HUB_BOT).file(...args),
    connection: (accountId) => (telegramAutomation ?? NO_HUB_BOT).connection(accountId),
  };
  const builtinDeps: BuiltinDeps = { messaging: messagingPort, telegramBot: telegramHubBot };
  const builtin =
    typeof overrides.connectors === 'function'
      ? overrides.connectors(builtinDeps)
      : (overrides.connectors ?? createBuiltinRegistry(builtinDeps));
  const connectors = new WorkspaceConnectorResolver(builtin, customStore);
  const network =
    overrides.network ??
    createNetworkPolicy({
      allowPrivateNetwork: overrides.allowPrivateNetwork ?? config.allowPrivateNetwork,
    });
  const oauthApps = new OAuthAppService(db, secrets, config.oauthApps, (connector) =>
    connectors.builtin.includes(connector),
  );
  const vaults = new VaultService(db);
  const vaultScopes = new VaultScopes(vaults);
  const keyring = new AccountKeyring(secrets, secrets, vaultScopes);
  const tokens = new TokenManager({ db, keys: keyring, apps: oauthApps, fetch: network.fetch, logger });
  const usage = new PgUsageMeter(db);
  const payers = new Payers(db);
  const entitlements = new EntitlementService({
    db,
    usage,
    payers,
    pricingUrl: `${config.publicUrl}/app/billing`,
    teamUrl: (slug) => `${config.publicUrl}/app/team/${encodeURIComponent(slug)}#plan`,
  });
  const billingProvider =
    overrides.billing ??
    createBillingProvider(config.billing, {
      publicUrl: config.publicUrl,
      ...(overrides.billingFetch ? { fetch: overrides.billingFetch } : {}),
    });
  const billing = new BillingService({
    db,
    entitlements,
    config: config.billing,
    provider: billingProvider,
    logger,
  });
  if (billingProvider instanceof TestBillingProvider) {
    billingProvider.connect((body, headers) => billing.handleWebhook(billingProvider.id, body, headers));
  }
  const mailer =
    overrides.mailer ?? createMailer(config.mail, { log: (fields, msg) => logger.info(fields, msg) });
  const notices = new NoticeService({ db, mailer, publicUrl: config.publicUrl, logger });
  const billingNotices = new BillingNotices({ db, notices, entitlements, publicUrl: config.publicUrl });
  const referrals = new ReferralService({ db, entitlements, notices, publicUrl: config.publicUrl });
  entitlements.listen(billingNotices);
  billing.listen(billingNotices);
  billing.listen(referrals);
  const accounts = new AccountService(db, connectors, keyring, network, tokens, entitlements, vaults);
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
  const vaultLinks = new VaultGrantLinks(vaults, vaultScopes, { db, publicUrl: config.publicUrl });
  vaultScopes.setLockedHelp((source) => vaultLinks.explainLocked(source));
  const apiTokens = new ApiTokenService(db, vaultLinks);
  const teams = new TeamService({
    db,
    accounts,
    mcpUrl: config.mcpUrl,
    publicUrl: config.publicUrl,
    membersChanged: (teamId) => payers.forget(teamId),
    // The OAuth server is built further down; these run only when someone leaves a team.
    revokeGrant: (id) => oauth.revokeGrantById(id),
    revokeToken: (workspaceId, id) => apiTokens.revoke(workspaceId, id),
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
    permissions: teams,
    logger,
  });
  const health = new AccountHealthService({ db, connectors, accounts, tokens, logger });
  const backups = config.backups
    ? new BackupService({
        databaseUrl: config.database.url,
        store: new S3Client(config.backups.storage),
        key: config.backups.encryptionKey
          ? parseKey(config.backups.encryptionKey)
          : secrets.deriveKey('backup'),
        prefix: config.backups.prefix,
        retentionDays: config.backups.retentionDays,
        logger,
        ...(overrides.backupTools ? { tools: overrides.backupTools } : {}),
      })
    : undefined;
  const jobs = new JobQueue({
    connectionString: config.database.url,
    logger,
    monitor: ops.jobRuns,
    onError: (error, job) => ops.errors.capture(error, { source: 'job', context: { job } }),
  });
  const listener = new PgListener({
    connectionString: config.database.url,
    logger: logger.child({ component: 'db-listener' }),
  });
  messaging = createMessaging({
    publicUrl: config.publicUrl,
    gatewayConfig: config.gateway,
    listener,
    db,
    secrets,
    keyring,
    accounts,
    connectors,
    builtin,
    logger,
  });
  watchJobs(ops, jobs);
  watchConnections(
    ops,
    db,
    () => new Map(connectors.builtin.all().map((c) => [c.id, connectorText(c, 'en').name] as const)),
  );
  const analytics = new Analytics({
    db,
    config: config.analytics,
    publicHost: new URL(config.publicUrl).hostname,
    onError: (error) => ops.errors.capture(error, { source: 'analytics' }),
  });
  const rateLimiter = new RateLimiter();
  const circuitBreaker = new CircuitBreaker();
  const idempotency = new MemoryIdempotencyStore();

  // Security layer: who may do what, confirmations, undo windows.
  const personas = new PersonaService(db, config.mcpUrl);
  const aiClients = new AiClientService(db);
  const aiApps = new AiAppService({
    db,
    clients: aiClients,
    // The OAuth server is built further down; grants are revoked only after start-up.
    revokeGrant: (workspaceId, grantId) => oauth.revokeGrant(workspaceId, grantId),
    tokens: apiTokens,
  });
  const policies = new PolicyService(db, async (principal) => (await teams.view(principal))?.access);
  const pendingCalls = new PendingCallService(db, secrets, { confirmationTtlMs: config.confirmations.ttlMs });
  const approvals = new StandingApprovals(db, secrets);
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
  // People who open the bot from an ad or a plain link get a short pitch and a tagged site link.
  const telegramLanding = telegramBot
    ? new TelegramLanding({
        bot: telegramBot,
        publicUrl: config.publicUrl,
        t: translator,
        logger,
        // Bot starts per ad campaign, next to the visits and sign-ups the same tag brings.
        onStart: (campaign) => analytics.track('bot.start', campaign ?? 'none'),
      })
    : undefined;
  const confirmations = new ConfirmationCenter({
    pending: pendingCalls,
    channels: notificationChannels,
    bot: telegramBot,
    publicUrl: config.publicUrl,
    describe: describeCall,
    t: translator,
    logger,
    ...(telegramLanding ? { onOtherStart: telegramLanding.handle } : {}),
  });
  // People connect their own Telegram by adding the hub's bot under Chat Automation.
  telegramAutomation = telegramBot
    ? new TelegramAutomation({
        db,
        bot: telegramBot,
        keys: messaging.keys,
        secrets,
        accounts,
        permissions: teams,
        messaging: messaging.service,
        publicUrl: config.publicUrl,
        t: translator,
        logger,
        capture: (error, context) => {
          ops.errors.capture(error, { source: 'telegram', context });
        },
        onConnected: () => analytics.track('connect.quick', 'telegram_bot'),
      })
    : undefined;
  const quickConnects = new QuickConnects(telegramAutomation ? [telegramAutomation] : []);
  // Chat Automation first (its business updates, links and buttons), then confirmations and the rest.
  const telegramUpdates = chainUpdateHandlers([
    ...(telegramAutomation ? [telegramAutomation.handleUpdate] : []),
    async (update) => {
      await confirmations.handleTelegramUpdate(update);
      return true;
    },
  ]);
  // A held-back call on a sealed account runs later, outside the AI app's request: keep its open
  // vault in memory until then (docs/VAULTS.md).
  const retainVault = async (row: PendingCallRow) => {
    if (row.accountId && (await accounts.isSealed(row.accountId)))
      await vaultScopes.hold(row.id, latestRunAt(row));
  };
  const securityStages: StageMap = {
    policy: policyStage(policies),
    confirm: confirmStage({
      policies,
      pending: pendingCalls,
      center: confirmations,
      stateKey: secrets.deriveKey('confirm-state'),
      waitMs: config.confirmations.waitMs,
      retain: retainVault,
      approvals,
    }),
    approvals: approvalsStage(approvals),
    untrusted: untrustedStage,
  };

  const admin = new WorkspaceAdmin({
    db,
    connectors,
    builtin: connectors.builtin,
    accounts,
    customServices,
    apps: oauthApps,
    policies,
    aiClients,
    teams,
    quickConnects,
    availability: messaging.availability,
    publicUrl: config.publicUrl,
    logger,
  });
  const teamOf = async (principal: Principal): Promise<CatalogTeam | undefined> => {
    const view = await teams.view(principal);
    if (!view) return undefined;
    return {
      name: view.team.name,
      ...(view.member ? { member: view.member.name, admin: isTeamAdmin(view.member.role) } : {}),
      owners: view.access.owners,
    };
  };
  const ownerNotifier = new TelegramOwnerNotifier({
    channels: notificationChannels,
    bot: telegramBot,
    t: translator,
    logger,
  });
  const alerts = new AccountAlerts({
    db,
    connectors,
    notifier: ownerNotifier,
    reconnectUrl: (workspaceId, _service, accountId) => admin.reconnectUrl(workspaceId, accountId),
    logger,
  });
  const activity = new ActivityService(db);
  // The hub is built below with the trigger tools in it; triggers reach it only when they run.
  let hubRef: Hub | undefined;
  const triggers = createTriggers({
    db,
    secrets,
    messaging,
    accounts,
    connectors,
    aiClients,
    notifier: ownerNotifier,
    hub: () => {
      if (!hubRef) throw new Error('hub is not initialized');
      return hubRef;
    },
    jobs: () => jobs,
    listener,
    fetch: network.fetch,
    publicUrl: config.publicUrl,
    logger,
    onError: (error, context) => ops.errors.capture(error, { source: 'trigger', context }),
  });
  for (const job of [
    ...builtinJobs({
      health,
      alerts,
      customServices,
      status: ops.status,
      activity,
      retention: entitlements,
      backups,
      billingNotices,
      analytics,
    }),
    ...messaging.jobs,
    ...triggers.jobs,
    {
      name: 'security.prune_approvals',
      description: 'Delete standing approvals (conversations the AI carried on) a day after they ended',
      cron: '43 2 * * *',
      expectEveryMs: 26 * 3_600_000,
      run: () => approvals.prune(),
    },
  ])
    jobs.register(job);
  const hub = new Hub({
    db,
    meter: usage,
    quota: entitlements,
    connectors,
    accounts,
    logger,
    setup: {
      connector: SETUP_CONNECTOR,
      admin,
      billing: new WorkspaceBillingTools({
        entitlements,
        billing,
        referrals,
        publicUrl: config.publicUrl,
      }),
      profiles: new WorkspaceProfileTools(personas),
      apps: new WorkspaceAppTools(aiApps, personas),
      // Users, sessions and second factors are built further down; read only when the tool runs.
      security: new UserSecurityTools({
        secondFactors: (userId) => secondFactors.summary(userId),
        signIn: async (userId) => {
          const [user, identities] = await Promise.all([users.get(userId), users.identities(userId)]);
          return { password: Boolean(user?.passwordHash), providers: identities.map((i) => i.provider) };
        },
        sessions: async (userId) => (await sessions.list(userId)).length,
        telegram: telegramBot ? notificationChannels : undefined,
        requireSecondFactor: config.auth.requireSecondFactor,
        publicUrl: config.publicUrl,
      }),
      triggers: triggers.service,
    },
    rateLimiter,
    circuitBreaker,
    idempotency,
    errors: ops.errors,
    toolTimeoutMs: config.toolTimeoutMs,
    maxResultTokens: config.tools.maxResultTokens,
    idempotencyWindowMs: config.tools.idempotencyWindowMs,
    toolListTokenBudget: config.tools.listTokenBudget,
    clientPolicies: config.directories.clientPolicies,
    stages: { ...securityStages, ...overrides.stages },
    catalogFilter: overrides.catalogFilter ?? teamCatalogFilter(createCatalogFilter(policies), teamOf),
    team: teamOf,
  });
  hubRef = hub;
  const pendingRunner = new PendingCallRunner({
    pending: pendingCalls,
    center: confirmations,
    run: (row, args) =>
      vaultScopes.runHeld(row.id, async () => toStored(await hub.runApproved(principalOf(row), row, args))),
    logger,
    backstopMs: config.confirmations.runnerBackstopMs,
    listener,
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
    subResource: isMcpSubPath,
    accessTokenTtlSeconds: config.oauth.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.oauth.refreshTokenTtlSeconds,
    logger,
    vaultLinks,
  });
  const userActive = activeUserCheck(db);
  const isMember = memberCheck(db);
  const verifier = new HubTokenVerifier(
    oauth,
    apiTokens,
    config.mcpUrl,
    async ({ workspaceId, personaId }) => {
      if (personaId) {
        const persona = await personas.get(workspaceId, personaId).catch(() => undefined);
        return persona && personas.urlFor(persona.slug);
      }
      // A token made in a team works on the team's URL only.
      const workspace = await getWorkspace(db, workspaceId);
      if (!workspace) return undefined;
      return workspace.kind === 'team' && workspace.slug ? teams.teamUrl(workspace.slug) : config.mcpUrl;
    },
    async (principal) =>
      (await userActive(principal.userId)) && (await isMember(principal.userId, principal.workspaceId)),
  );
  const sessions = new SessionService(db, config.sessionTtlSeconds);
  const users = new UserService({
    db,
    accounts,
    oauth,
    apiTokens,
    teams,
    adminEmails: config.site.adminEmails,
    signups: config.site.signups,
  });
  const externalLogin = new ExternalLoginService(
    { db, secrets, publicUrl: config.publicUrl, logger },
    overrides.loginProviders ??
      (config.site.google ? [new OidcLoginProvider(googleLoginSpec(config.site.google), network.fetch)] : []),
  );
  const adminPanel = new AdminService({ db, users, entitlements });
  const pendingLogins = new PendingLoginService(db);
  const secondFactors = new SecondFactorService(
    new TotpService(db, secrets, config.auth.rpName),
    new RecoveryCodeService(db),
    new PasskeyService(db, { id: config.auth.rpId, name: config.auth.rpName, origin: config.auth.origin }),
  );
  const mcp = createHubMcpHandler({ hub, logger, version: VERSION, publicUrl: config.publicUrl });
  const visitorMcp = config.anonymousMcp.enabled
    ? createVisitorMcpHandler({
        admin,
        setup: SETUP_CONNECTOR,
        logger,
        version: VERSION,
        publicUrl: config.publicUrl,
      })
    : undefined;

  return {
    config,
    version: VERSION,
    logger,
    ops,
    database,
    db,
    secrets,
    network,
    connectors,
    customServices,
    admin,
    usage,
    entitlements,
    billing,
    mailer,
    notices,
    billingNotices,
    referrals,
    accounts,
    vaults,
    vaultScopes,
    vaultLinks,
    retainVault,
    oauthApps,
    tokens,
    connect,
    health,
    alerts,
    backups,
    jobs,
    listener,
    apiTokens,
    hub,
    clients,
    oauth,
    verifier,
    aiClients,
    aiApps,
    personas,
    policies,
    pendingCalls,
    approvals,
    notificationChannels,
    confirmations,
    pendingRunner,
    telegramBot,
    telegramAutomation,
    telegramUpdates,
    quickConnects,
    telegramWebhookSecret: secrets.deriveKey('telegram-webhook').toString('base64url'),
    sessions,
    users,
    teams,
    externalLogin,
    adminPanel,
    activity,
    analytics,
    pendingLogins,
    secondFactors,
    rateLimiter,
    circuitBreaker,
    idempotency,
    mcp,
    messaging,
    triggers,
    ...(visitorMcp ? { visitorMcp } : {}),
    async close() {
      await analytics.close();
      triggers.stop();
      await messaging?.stop();
      await listener.stop();
      await pendingRunner.stop();
      rateLimiter.close();
      await jobs.stop();
      await mcp.close();
      await visitorMcp?.close();
      await network.close();
      await ops.close();
      await database.close();
    },
  };
}
