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
    /** Secret credentials, encrypted with the SecretBox (AAD = account id). */
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
