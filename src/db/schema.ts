/**
 * Database schema (Drizzle ORM, PostgreSQL).
 *
 * Ownership model: everything a person connects lives in a *workspace*. Today every user has one
 * personal workspace; teams/commercial plans can later add members to the same workspace without
 * changing the data model.
 *
 * Migrations are generated from this file with `npm run db:generate` and committed in /drizzle.
 * Keep this file free of runtime imports from the app (drizzle-kit loads it standalone).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: text().primaryKey(),
  /** Stored lower-cased. */
  email: text().notNull().unique(),
  name: text(),
  passwordHash: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  lastLoginAt: timestamp({ withTimezone: true }),
});

export interface WorkspaceSettings {
  /**
   * How accounts are turned into MCP tools:
   * - `grouped`: one tool per service action with an `account` argument (compact, default)
   * - `per_account`: one tool per account and action (most explicit, more tools)
   */
  toolExposure?: 'grouped' | 'per_account';
  /** Workspace-wide defaults of the access policy (rules override them, see access_rules). */
  security?: SecuritySettings;
}

/** How risky an action is: reads, changes, or destructive / irreversible operations. */
export type RiskLevel = 'read' | 'write' | 'dangerous';
/** The highest risk a client may use: `none` hides the account, `full` allows dangerous actions. */
export type AccessLevel = 'none' | 'read' | 'write' | 'full';
/** From which risk on a call needs the user's confirmation. */
export type ConfirmLevel = 'never' | 'dangerous' | 'write' | 'always';

export interface SecuritySettings {
  /** Default: `full`. */
  defaultAccess?: AccessLevel;
  /** Default: `dangerous`. */
  defaultConfirm?: ConfirmLevel;
  /** Undo window for changing actions (seconds, 0 = run at once). Default: 0. */
  undoWindowSeconds?: number;
}

export const workspaces = pgTable('workspaces', {
  id: text().primaryKey(),
  name: text().notNull(),
  settings: jsonb().$type<WorkspaceSettings>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text().$type<'owner' | 'admin' | 'member'>().notNull().default('owner'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index().on(t.userId)],
);

/** Browser sessions for the hub's own pages (login, consent, panel). */
export const webSessions = pgTable(
  'web_sessions',
  {
    /** SHA-256 of the session cookie value. */
    tokenHash: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    ip: text(),
    userAgent: text(),
    /**
     * How the user proved who they are, RFC 8176 values: `pwd`, `otp`, `hwk` (passkey) plus
     * `rec` for a recovery code. Lets features require a second factor or a passkey.
     */
    amr: text().array().notNull().default(sql`'{}'::text[]`),
    /** When the user last signed in or re-confirmed (step-up). Null for sessions older than the column. */
    authenticatedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.userId), index().on(t.expiresAt)],
);

// ---------------------------------------------------------------------------
// OAuth 2.1 authorization server (AI clients such as Claude and ChatGPT)
// ---------------------------------------------------------------------------

export interface StoredClientMetadata {
  redirect_uris: string[];
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
  software_id?: string;
  software_version?: string;
  contacts?: string[];
}

export const oauthClients = pgTable('oauth_clients', {
  /** client_id. For Client ID Metadata Documents this is the https URL of the document. */
  id: text().primaryKey(),
  registrationType: text().$type<'dynamic' | 'metadata_document' | 'static'>().notNull(),
  metadata: jsonb().$type<StoredClientMetadata>().notNull(),
  /** SHA-256 of client_secret for confidential clients. */
  secretHash: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  /** For metadata documents: when the cached copy must be re-fetched. */
  expiresAt: timestamp({ withTimezone: true }),
});

/** A grant = one AI client connected to one workspace by one user. Revoking it revokes all its tokens. */
export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: text().primaryKey(),
    clientId: text()
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    scopes: text().array().notNull().default(sql`'{}'::text[]`),
    resource: text().notNull(),
    /** Snapshot of the client's display name at consent time. */
    clientName: text(),
    /** The AI client this grant belongs to (stable across re-registrations of the same app). */
    aiClientId: text().references(() => aiClients.id, { onDelete: 'set null' }),
    /** Set when the grant is for a persona's MCP URL. Deleting the persona disconnects the grant. */
    personaId: text().references(() => personas.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.workspaceId), index().on(t.clientId)],
);

export const oauthAuthorizationCodes = pgTable('oauth_authorization_codes', {
  codeHash: text().primaryKey(),
  clientId: text()
    .notNull()
    .references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: text()
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  redirectUri: text().notNull(),
  codeChallenge: text().notNull(),
  scopes: text().array().notNull().default(sql`'{}'::text[]`),
  resource: text().notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  usedAt: timestamp({ withTimezone: true }),
  /** Grant created when the code was exchanged (revoked if the code is replayed). */
  grantId: text(),
  /** Copied to the grant: see oauth_grants. */
  aiClientId: text(),
  personaId: text(),
});

export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    tokenHash: text().primaryKey(),
    grantId: text()
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    type: text().$type<'access' | 'refresh'>().notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    /** Refresh tokens only: set when exchanged for a new pair (rotation). */
    rotatedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.grantId), index().on(t.expiresAt)],
);

/** Personal access tokens: static bearer tokens for CLIs, scripts and MCP clients without OAuth. */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    tokenHash: text().notNull().unique(),
    /** First characters of the token, safe to display. */
    tokenPrefix: text().notNull(),
    scopes: text().array().notNull().default(sql`'{}'::text[]`),
    /** The AI client (script, CLI) this token acts as; policies apply to it. */
    aiClientId: text().references(() => aiClients.id, { onDelete: 'set null' }),
    /** Restricts the token to one persona's MCP URL. */
    personaId: text().references(() => personas.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    lastUsedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.workspaceId)],
);

// ---------------------------------------------------------------------------
// Connected services
// ---------------------------------------------------------------------------

export interface AccountSettings {
  /** Actions of the connector that are hidden from AI clients for this account. */
  disabledActions?: string[];
}

export interface AccountMetadata {
  /** Who this account is on the remote service, e.g. an email address or @username. */
  identity?: string;
  [key: string]: unknown;
}

/**
 * A connected account of a service, e.g. Gmail "work", Gmail "personal", Telegram "shop".
 * Many accounts per service per workspace; each is addressed by its short `name`.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Connector type, e.g. `gmail`, `telegram`, `demo`. */
    connectorId: text().notNull(),
    /** Short machine name shown to the AI, unique per connector in a workspace (e.g. `work`). */
    name: text().notNull(),
    /** Human label, e.g. "Рабочая почта". */
    label: text().notNull(),
    /** Optional hint for the AI about when to use this account. */
    description: text(),
    /** Non-secret configuration (validated by the connector's config schema). */
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /**
     * The account's own data key (DEK), wrapped by the master key. It encrypts the account's
     * secrets (envelope encryption); rotating the master key only re-wraps this value.
     */
    dataKeyEncrypted: text(),
    /** Secret credentials, encrypted with the account's data key (AAD = account id). */
    credentialsEncrypted: text(),
    enabled: boolean().notNull().default(true),
    status: text().$type<'active' | 'error' | 'needs_reauth'>().notNull().default('active'),
    statusMessage: text(),
    settings: jsonb().$type<AccountSettings>().notNull().default({}),
    metadata: jsonb().$type<AccountMetadata>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastUsedAt: timestamp({ withTimezone: true }),
    /** Last connection test (on creation, on demand, by the periodic health check). */
    checkedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.connectorId, t.name), index().on(t.workspaceId)],
);

/** Audit trail of every tool call made by an AI client. Arguments are not stored. */
export const toolCalls = pgTable(
  'tool_calls',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    accountId: text().references(() => accounts.id, { onDelete: 'set null' }),
    connectorId: text(),
    action: text(),
    toolName: text().notNull(),
    principalType: text().$type<'oauth' | 'api_token' | 'session'>().notNull(),
    principalId: text(),
    clientId: text(),
    status: text().$type<'ok' | 'error'>().notNull(),
    /**
     * Why the call ended the way it did when that is more than ok/error: `denied` (policy),
     * `declined` (user), `deduplicated`, `rate_limited`, `timeout`, or the connector error kind.
     */
    outcome: text(),
    /** Risk level of the action at call time (`read`, `write`, `dangerous`). */
    risk: text().$type<'read' | 'write' | 'dangerous'>(),
    errorMessage: text(),
    durationMs: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.workspaceId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Data protection: AI clients, personas, access policy, confirmations
// ---------------------------------------------------------------------------

/**
 * An AI client as the user thinks of it: "Claude", "ChatGPT", "Claude Code", "backup script".
 * OAuth grants and personal tokens point to one, so a policy like "ChatGPT may only read" keeps
 * applying when the app reconnects or re-registers itself.
 */
export const aiClients = pgTable(
  'ai_clients',
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    kind: text().$type<'oauth' | 'api_token'>().notNull(),
    /** Stable identity used to recognise the same app again, e.g. `cimd:<url>` or `app:claude`. */
    matchKey: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastUsedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.matchKey)],
);

/**
 * A persona is a named slice of the workspace ("Работа", "Личное") with its own MCP URL
 * (`/mcp/<slug>`). An AI app connected to that URL only sees the persona's accounts.
 */
export const personas = pgTable(
  'personas',
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** URL segment, immutable (it is part of the OAuth resource the grants are bound to). */
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    /** Accounts visible through this persona. */
    accountIds: text().array().notNull().default(sql`'{}'::text[]`),
    /** Upper bound for every client using the persona. */
    maxAccess: text().$type<AccessLevel>().notNull().default('full'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.slug)],
);

/**
 * Access policy: who (AI client and/or persona, empty = anyone) may do what (access level by risk,
 * confirmation, undo window) on which accounts (an account, a whole service, or everything).
 * For every field the most specific matching rule that sets it wins.
 */
export const accessRules = pgTable(
  'access_rules',
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    aiClientId: text().references(() => aiClients.id, { onDelete: 'cascade' }),
    personaId: text().references(() => personas.id, { onDelete: 'cascade' }),
    connectorId: text(),
    accountId: text().references(() => accounts.id, { onDelete: 'cascade' }),
    access: text().$type<AccessLevel>(),
    confirm: text().$type<ConfirmLevel>(),
    undoWindowSeconds: integer(),
    note: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.workspaceId)],
);

export type PendingCallStatus =
  | 'awaiting_confirmation'
  | 'scheduled'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'cancelled'
  | 'expired';

/** Who made a pending call, so it can be executed later exactly as that caller. */
export interface PendingCallPrincipal {
  kind: 'oauth' | 'api_token' | 'session';
  userId: string;
  scopes: string[];
  clientId?: string;
  credentialId?: string;
  aiClientId?: string;
  personaId?: string;
}

/**
 * A tool call the hub holds back: waiting for the user's confirmation (in the chat, Telegram or the
 * web page) or for its undo window. Arguments and results are encrypted; rows are short-lived.
 */
export const pendingCalls = pgTable(
  'pending_calls',
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    principal: jsonb().$type<PendingCallPrincipal>().notNull(),
    toolName: text().notNull(),
    connectorId: text().notNull(),
    action: text().notNull(),
    accountId: text()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    risk: text().$type<RiskLevel>().notNull(),
    /** Why the call is risky, when the action explained it (e.g. "first message to a new contact"). */
    reason: text(),
    /** SecretBox, AAD = `pending:<id>:args`. */
    argsEncrypted: text().notNull(),
    /** SHA-256 of the canonical arguments: a retried call must match what was approved. */
    argsHash: text().notNull(),
    status: text().$type<PendingCallStatus>().notNull(),
    /** Channels the confirmation was offered on, e.g. {elicitation} or {telegram,web}. */
    channels: text().array().notNull().default(sql`'{}'::text[]`),
    decidedVia: text(),
    decidedAt: timestamp({ withTimezone: true }),
    /** Undo window applied after approval (seconds). */
    undoWindowSeconds: integer().notNull().default(0),
    /** When an approved call runs (end of its undo window). */
    executeAt: timestamp({ withTimezone: true }),
    /** Unanswered confirmations expire. */
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    /** SecretBox, AAD = `pending:<id>:result`. */
    resultEncrypted: text(),
    /** When the caller received the final result (a repeated identical call then starts anew). */
    consumedAt: timestamp({ withTimezone: true }),
    /** Telegram message to update once the call is decided. */
    telegramMessage: jsonb().$type<{ chatId: string; messageId: number }>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.status, t.executeAt),
    index().on(t.workspaceId, t.createdAt),
    index().on(t.workspaceId, t.argsHash),
  ],
);

/** Where the hub reaches its owner: today the Telegram chat used for confirmations and alerts. */
export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text().$type<'telegram'>().notNull(),
    /** Telegram chat id once linked. */
    address: text(),
    /** e.g. the Telegram @username, for display. */
    label: text(),
    /** SHA-256 of the one-time code of a link in progress. */
    linkCodeHash: text(),
    linkExpiresAt: timestamp({ withTimezone: true }),
    verifiedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.userId, t.kind), index().on(t.linkCodeHash)],
);

// ---------------------------------------------------------------------------
// Second factors (TOTP, recovery codes, passkeys) and the sign-in steps around them
// ---------------------------------------------------------------------------

/** Authenticator-app secret. One per user; unconfirmed until the user enters a valid code. */
export const userTotp = pgTable('user_totp', {
  userId: text()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Base32 secret encrypted with the SecretBox (AAD = `user:<id>:totp`). */
  secretEncrypted: text().notNull(),
  /** Null while enrollment is pending: the factor is not used for sign-in until confirmed. */
  confirmedAt: timestamp({ withTimezone: true }),
  /** Last accepted time step; codes from this or an earlier step are rejected (no replay). */
  lastUsedStep: bigint({ mode: 'number' }),
  createdAt: createdAt(),
});

/** Single-use recovery codes (SHA-256 of `<user id>:<normalized code>`; the codes are shown once). */
export const userRecoveryCodes = pgTable(
  'user_recovery_codes',
  {
    codeHash: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    usedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.userId)],
);

/** WebAuthn credentials (passkeys and security keys). */
export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Credential ID from the authenticator, base64url. */
    credentialId: text().notNull().unique(),
    /** COSE public key, base64url. */
    publicKey: text().notNull(),
    counter: bigint({ mode: 'number' }).notNull().default(0),
    transports: text().array().notNull().default(sql`'{}'::text[]`),
    deviceType: text().$type<'singleDevice' | 'multiDevice'>().notNull(),
    backedUp: boolean().notNull().default(false),
    /** Name the user gave it, e.g. "iPhone". */
    name: text().notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.userId)],
);

/** Outstanding WebAuthn challenges: short-lived and deleted when used. */
export const webauthnChallenges = pgTable(
  'webauthn_challenges',
  {
    /** SHA-256 of the challenge (base64url). */
    challengeHash: text().primaryKey(),
    challenge: text().notNull(),
    purpose: text().$type<'registration' | 'authentication'>().notNull(),
    /** The user the ceremony is for; null for sign-in with a discoverable passkey. */
    userId: text().references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of a browser-bound value (the CSRF cookie), so a challenge only works where it was issued. */
    bindingHash: text().notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.expiresAt)],
);

/** Password accepted, second factor still due. The cookie holds a random token, the database its hash. */
export const pendingLogins = pgTable(
  'pending_logins',
  {
    tokenHash: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Methods already passed (`pwd`). */
    amr: text().array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.expiresAt)],
);

// ---------------------------------------------------------------------------
// The hub as an OAuth client of connected services
// ---------------------------------------------------------------------------

/**
 * An OAuth app (client id + secret) registered by the user at a provider ("bring your own app").
 * Hub-wide default apps come from env vars (`OAUTH_APP_<PROVIDER>_CLIENT_ID/_SECRET`) and are not
 * stored here.
 */
export const oauthApps = pgTable(
  'oauth_apps',
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** OAuth provider id, e.g. `google`. */
    providerId: text().notNull(),
    label: text().notNull(),
    clientId: text().notNull(),
    /** Encrypted with the SecretBox (AAD = app id). Null for public clients. */
    clientSecretEncrypted: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.workspaceId, t.providerId)],
);

/** OAuth tokens of a connected account. Kept apart from connector credentials: the hub owns them. */
export const accountOauth = pgTable(
  'account_oauth',
  {
    accountId: text()
      .primaryKey()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    providerId: text().notNull(),
    /** Which app issued the tokens: `env:<provider>` or an `oauth_apps` id. Refreshes must use it. */
    appRef: text().notNull(),
    /** Encrypted token set (AAD = account id). */
    tokensEncrypted: text().notNull(),
    /** Access token expiry; null when the token does not expire. */
    expiresAt: timestamp({ withTimezone: true }),
    scopes: text().array().notNull().default(sql`'{}'::text[]`),
    refreshedAt: timestamp({ withTimezone: true }),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.expiresAt)],
);

export interface ConnectDraft {
  name?: string;
  label?: string;
  description?: string;
  config?: Record<string, unknown>;
}

/** A pending "connect account" OAuth flow, single use, short-lived. */
export const oauthConnectStates = pgTable(
  'oauth_connect_states',
  {
    /** SHA-256 of the `state` parameter. */
    stateHash: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectorId: text().notNull(),
    /** Set when re-connecting an existing account. */
    accountId: text().references(() => accounts.id, { onDelete: 'cascade' }),
    /** Fields of the account to create once the flow succeeds. */
    draft: jsonb().$type<ConnectDraft>().notNull().default({}),
    appRef: text().notNull(),
    /** Encrypted PKCE verifier (AAD = state hash). */
    codeVerifierEncrypted: text(),
    redirectUri: text().notNull(),
    /** Hub-relative path to return to afterwards. */
    returnTo: text(),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.expiresAt)],
);

// ---------------------------------------------------------------------------
// Services defined by the user, without code
// ---------------------------------------------------------------------------

/**
 * A service a user added to their workspace without code: a remote MCP server or an HTTP
 * manifest. Resolved next to the built-in connectors (`WorkspaceConnectorResolver`).
 */
export const customConnectors = pgTable(
  'custom_connectors',
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Connector id (tool name prefix), unique in the workspace and never equal to a built-in one. */
    connectorId: text().notNull(),
    kind: text().$type<'mcp' | 'manifest'>().notNull(),
    /** `RemoteMcpDefinition` or an HTTP manifest. */
    definition: jsonb().$type<Record<string, unknown>>().notNull(),
    /** Remote MCP servers: the cached tool list. */
    tools: jsonb().$type<unknown[]>(),
    toolsRefreshedAt: timestamp({ withTimezone: true }),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.connectorId)],
);
