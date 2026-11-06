/**
 * Database schema (Drizzle ORM, PostgreSQL).
 *
 * Ownership model: everything a person connects lives in a *workspace*. Every user has one
 * personal workspace; a *team* is a workspace with several members, where each connected account
 * belongs to one member (or to the whole team) and is shared explicitly (see `docs/TEAMS.md`).
 *
 * Migrations are generated from this file with `npm run db:generate` and committed in /drizzle.
 * Keep this file free of runtime imports from the app (drizzle-kit loads it standalone).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
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
  /** Hub-wide role: `admin` opens the admin panel (always behind a second factor). */
  role: text().$type<UserRole>().notNull().default('user'),
  /** `suspended` users cannot sign in; their AI apps and tokens are revoked when suspended. */
  status: text().$type<UserStatus>().notNull().default('active'),
  /** Why the account is suspended (shown to admins only). */
  statusReason: text(),
  /** Preferred interface language (`ru`, `en`); null = from the browser. */
  locale: text(),
  /** The user's invite code (`/?ref=<code>`), created on first use; see `ReferralService`. */
  referralCode: text().unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  lastLoginAt: timestamp({ withTimezone: true }),
});

export type UserRole = 'user' | 'admin';
export type UserStatus = 'active' | 'suspended';

/** Sign-in identities at external providers ("Sign in with Google"), linked to a hub user. */
export const userIdentities = pgTable(
  'user_identities',
  {
    /** Login provider id, e.g. `google`. */
    provider: text().notNull(),
    /** The provider's stable user id (`sub`). */
    subject: text().notNull(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Email the provider reported at the last sign-in. */
    email: text(),
    createdAt: createdAt(),
    lastUsedAt: timestamp({ withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.provider, t.subject] }), index().on(t.userId)],
);

/** Sign-ins in progress at an external provider (single use, 10 minutes, bound to the browser). */
export const loginStates = pgTable(
  'login_states',
  {
    /** SHA-256 of the `state` parameter; the browser holds the same value in a cookie. */
    stateHash: text().primaryKey(),
    provider: text().notNull(),
    /** Encrypted PKCE verifier and OpenID nonce (AAD = state hash). */
    secretsEncrypted: text().notNull(),
    /** Hub-relative path to return to afterwards. */
    next: text().notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.expiresAt)],
);

export interface WorkspaceSettings {
  /**
   * How accounts are turned into MCP tools:
   * - `grouped`: one tool per service action with an `account` argument (compact, default)
   * - `per_account`: one tool per account and action (most explicit, more tools)
   */
  toolExposure?: 'grouped' | 'per_account';
  /**
   * What `tools/list` shows:
   * - `auto` (default): every tool while they fit the token budget, otherwise discovery
   * - `direct`: every tool
   * - `discovery`: meta tools to search and call the rest, plus the most useful tools
   */
  toolListing?: 'auto' | 'direct' | 'discovery';
  /** Workspace-wide defaults of the access policy (rules override them, see access_rules). */
  security?: SecuritySettings;
}

/** How risky an action is: reads, changes, or destructive / irreversible operations. */
export type RiskLevel = 'read' | 'write' | 'dangerous';
/** The highest risk a client may use: `none` hides the account, `full` allows dangerous actions. */
export type AccessLevel = 'none' | 'read' | 'write' | 'full';
/** From which risk on a call needs the user's confirmation. */
export type ConfirmLevel = 'never' | 'dangerous' | 'write' | 'always';
/**
 * Where the user confirms a call: `link`, outside the AI chat (the Manyplug page or Telegram);
 * `chat`, by answering the AI app in the chat itself (the AI asks and repeats the call).
 */
export type ConfirmIn = 'link' | 'chat';

export interface SecuritySettings {
  /** Default: `full`. */
  defaultAccess?: AccessLevel;
  /** Default: `dangerous`. */
  defaultConfirm?: ConfirmLevel;
  /** Undo window for changing actions (seconds, 0 = run at once). Default: 0. */
  undoWindowSeconds?: number;
  /** Where confirmations are given. Default: `link`. */
  confirmIn?: ConfirmIn;
}

export type WorkspaceKind = 'personal' | 'team';
export type MemberRole = 'owner' | 'admin' | 'member';
/**
 * How a team pays (`docs/TEAMS.md`): `payer`, one person's plan covers everyone; `each`, every member
 * uses their own plan, and the payer's covers only what is the team's (its accounts, its shared key).
 */
export type TeamBillingMode = 'payer' | 'each';

export const workspaces = pgTable('workspaces', {
  id: text().primaryKey(),
  name: text().notNull(),
  /** `personal`: one person's own space; `team`: several members, each with their own accounts. */
  kind: text().$type<WorkspaceKind>().notNull().default('personal'),
  /** Teams: the address part of the team's MCP URL (`/mcp/team/<slug>`); never changes. */
  slug: text().unique(),
  settings: jsonb().$type<WorkspaceSettings>().notNull().default({}),
  /** Teams: the member whose plan pays for the team; null = its owner. */
  billingUserId: text().references(() => users.id, { onDelete: 'set null' }),
  /** Teams: see {@link TeamBillingMode}. */
  billingMode: text().$type<TeamBillingMode>().notNull().default('payer'),
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
    role: text().$type<MemberRole>().notNull().default('owner'),
    /**
     * Teams: the member's short name, unique in the team. Their accounts are named after it
     * (`ann`, `ann_work`), so "Ann's mail" is easy to say and to pick.
     */
    handle: text(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index().on(t.userId),
    uniqueIndex().on(t.workspaceId, t.handle),
  ],
);

/** Invitations to a team, bound to an email address; the link carries a token stored as a hash. */
export const workspaceInvitations = pgTable(
  'workspace_invitations',
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Normalized (lowercase); only a user signed in with this address can accept. */
    email: text().notNull(),
    role: text().$type<Exclude<MemberRole, 'owner'>>().notNull().default('member'),
    tokenHash: text().notNull().unique(),
    invitedBy: text().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedAt: timestamp({ withTimezone: true }),
    acceptedBy: text().references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.workspaceId), index().on(t.email)],
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
    /**
     * Teams: the team's shared connection, not tied to one person. It only sees what the whole
     * team may use (team accounts and accounts shared with everyone) and cannot change the setup.
     */
    shared: boolean().notNull().default(false),
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
    /**
     * The member it belongs to: only they (and whoever they share it with) can use it. Null: the
     * team's own account, which every member can use and the team admins manage.
     */
    ownerUserId: text().references(() => users.id, { onDelete: 'cascade' }),
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
    /** When the owners were told this account needs a new sign-in; cleared once it works again. */
    reauthNotifiedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex().on(t.workspaceId, t.connectorId, t.name),
    index().on(t.workspaceId),
    index().on(t.ownerUserId),
  ],
);

export type ShareLevel = 'read' | 'write' | 'full';

/**
 * Who else in a team may use an account, and how much: one row per member, or `userId` null for the
 * whole team. A member's account without rows is private to them; a team account without a
 * whole-team row is fully usable by every member.
 */
export const accountShares = pgTable(
  'account_shares',
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    accountId: text()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** The member it is shared with; null: everyone in the team. */
    userId: text().references(() => users.id, { onDelete: 'cascade' }),
    access: text().$type<ShareLevel>().notNull(),
    createdBy: text().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.workspaceId),
    uniqueIndex().on(t.accountId, t.userId),
    uniqueIndex('account_shares_team_unique').on(t.accountId).where(sql`${t.userId} is null`),
  ],
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
    /** Hashed end-user id at the AI provider, when the client sends one (see `Principal.aiSubject`). */
    aiSubject: text(),
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
  // The second index serves an account's own log (the account page, the activity filter).
  // The third serves hub-wide windows (status page, retention clean-up).
  (t) => [
    index().on(t.workspaceId, t.createdAt),
    index().on(t.accountId, t.createdAt),
    index().on(t.createdAt),
  ],
);

/**
 * Usage counters for plans and limits: executed calls per workspace, day, caller (AI account when
 * known, else the AI app connection; see `usageCaller`) and action. Only counted for now; plans and
 * limits read them later. Kept apart from `tool_calls`, which is an audit log and may be pruned.
 */
export const usageCounters = pgTable(
  'usage_counters',
  {
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** UTC day. */
    day: date({ mode: 'string' }).notNull(),
    caller: text().notNull(),
    connectorId: text().notNull(),
    action: text().notNull(),
    calls: integer().notNull().default(0),
    errors: integer().notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.day, t.caller, t.connectorId, t.action] }),
    index().on(t.caller, t.day),
    // Hub-wide totals per day (admin panel).
    index().on(t.day),
  ],
);

/**
 * What each person's plan was charged: executed calls per paying workspace (a person's own; see
 * `billing/payers.ts`), day and the workspace they happened in. Written with `usage_counters`, at
 * the time of the call, so a team that changes who pays never moves earlier use. The workspace
 * column is no foreign key on purpose: deleting a team must not give its payer the use back.
 */
export const billingUsage = pgTable(
  'billing_usage',
  {
    payerId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** UTC day. */
    day: date({ mode: 'string' }).notNull(),
    workspaceId: text().notNull(),
    calls: integer().notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.payerId, t.day, t.workspaceId] })],
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
  /** A team's shared connection (see `Principal.shared`). */
  shared?: boolean;
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
    /** Null for a setup tool, which acts on the workspace. */
    accountId: text().references(() => accounts.id, { onDelete: 'cascade' }),
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
    /** Language of the page the chat was linked from; the user's saved language wins over it. */
    locale: text(),
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
  /** In a team: whose the new account is (a member's user id, or null for the team's). */
  owner?: { userId: string | null };
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

// ---------------------------------------------------------------------------
// Messengers (Telegram, WhatsApp, ...): see docs/MESSENGERS.md
// ---------------------------------------------------------------------------

/**
 * Data keys of the hub, stored wrapped (encrypted) by the SecretBox so that rotating
 * ENCRYPTION_KEY only re-wraps them and never invalidates data derived from them
 * (e.g. the blind search index of messages).
 */
export const dataKeys = pgTable('data_keys', {
  purpose: text().primaryKey(),
  keyEncrypted: text().notNull(),
  createdAt: createdAt(),
});

/**
 * User vaults (see `src/lib/vault.ts`, `src/core/vaults.ts`): the public key that sealed accounts
 * are encrypted to. The private key is never stored here, only in `vault_wraps`.
 */
export const userVaults = pgTable('user_vaults', {
  userId: text()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Raw X25519 public key, base64url. */
  publicKey: text().notNull(),
  createdAt: createdAt(),
});

/** What a vault wrap is unlocked with. */
export type VaultWrapKind = 'device' | 'passkey' | 'recovery' | 'oauth' | 'oauth_code' | 'api_token';

/**
 * The vault's private key wrapped under one secret the hub does not keep: a browser's device key
 * (in a cookie only that browser has), a passkey PRF output, the recovery key, or a bearer token
 * (OAuth access or refresh token, personal token) of which only the hash is stored elsewhere. One row per secret; deleting the row (or the secret's own row,
 * through `ref`) revokes that way in.
 */
export const vaultWraps = pgTable(
  'vault_wraps',
  {
    userId: text()
      .notNull()
      .references(() => userVaults.userId, { onDelete: 'cascade' }),
    kind: text().$type<VaultWrapKind>().notNull(),
    /** The secret's own id: device id, passkey credential id, token hash or id; `-` for recovery. */
    ref: text().notNull(),
    wrapped: text().notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp({ withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind, t.ref] }), index().on(t.kind, t.ref)],
);

/** What asks to be let into a vault: a new browser, an AI app (OAuth grant) or a personal token. */
export type VaultRequestKind = 'device' | 'oauth' | 'api_token';

/** One secret a request asks a wrap for: the wrap's `ref` and the public key the secret derives. */
export interface VaultRequestKey {
  ref: string;
  /** X25519 public key whose private half is the secret (a device key or `tokenSecret(token)`). */
  publicKey: string;
}

/**
 * Something of the user's that cannot open their vault yet asks to: a browser signed in after the
 * vault was created, or an AI app / personal token connected before it (or from a browser where
 * the vault was locked). A browser where the vault is open approves it by sealing the vault key to
 * each `keys[].publicKey`, which become wraps of `kind`; the secrets never reach the database and
 * the row is then deleted. One row per thing (`subject`: device id, OAuth grant id, token id).
 */
export const vaultRequests = pgTable(
  'vault_requests',
  {
    userId: text()
      .notNull()
      .references(() => userVaults.userId, { onDelete: 'cascade' }),
    kind: text().$type<VaultRequestKind>().notNull(),
    subject: text().notNull(),
    keys: jsonb().$type<VaultRequestKey[]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind, t.subject] })],
);

export type MessengerSessionState =
  /** No session yet: the user has to log in (QR code, phone code). */
  | 'needs_login'
  /** The gateway is (re)connecting. */
  | 'connecting'
  | 'online'
  /** Waiting before the next reconnect attempt. */
  | 'backoff'
  /** Stopped until the user acts (logged out, banned, too many failures...). */
  | 'stopped';

export type MessengerProblem =
  | 'logged_out'
  | 'needs_password'
  | 'frozen'
  | 'banned'
  | 'phone_offline'
  | 'flood'
  | 'network'
  | 'protocol'
  | 'failing';

/**
 * Runtime state of a messenger account: the gateway lease (exactly one connection per account),
 * connection status and the sending pause. One row per messenger account, created lazily.
 */
export const messengerAccounts = pgTable(
  'messenger_accounts',
  {
    accountId: text()
      .primaryKey()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Gateway instance that holds the session. */
    leaseOwner: text(),
    /** Internal URL of that instance, for requests that must reach the live session. */
    leaseOwnerUrl: text(),
    leaseExpiresAt: timestamp({ withTimezone: true }),
    /** Incremented on every new lease: writes from a stale holder are rejected. */
    fencingToken: bigint({ mode: 'number' }).notNull().default(0),
    state: text().$type<MessengerSessionState>().notNull().default('needs_login'),
    problem: text().$type<MessengerProblem>(),
    problemMessage: text(),
    /** Consecutive failed connection attempts (reset when online). */
    failures: integer().notNull().default(0),
    nextAttemptAt: timestamp({ withTimezone: true }),
    lastOnlineAt: timestamp({ withTimezone: true }),
    /** Sending is paused (spam warning, long flood wait); reading keeps working. */
    sendPausedUntil: timestamp({ withTimezone: true }),
    sendPauseReason: text(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.leaseExpiresAt)],
);

/** Encrypted key-value state of a messenger session (auth keys, update state, peer cache...). */
export const messengerState = pgTable(
  'messenger_state',
  {
    accountId: text()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    /** SecretBox envelope, AAD = account id + key. */
    valueEncrypted: text().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.key] })],
);

export const messengerChats = pgTable(
  'messenger_chats',
  {
    id: text().primaryKey(),
    accountId: text()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Keyed hash of the messenger's chat id: lookups without storing the id in clear. */
    externalKey: text().notNull(),
    /** Encrypted `{ externalId, title, username }`. */
    infoEncrypted: text().notNull(),
    kind: text().$type<'direct' | 'group' | 'channel' | 'bot'>().notNull(),
    /** Blind index of the title words (see messaging/search-index.ts). */
    titleIndex: integer().array().notNull().default(sql`'{}'::int[]`),
    unread: integer().notNull().default(0),
    /** The other side has written at least once (first-contact detection). */
    hasInbound: boolean().notNull().default(false),
    lastMessageAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex().on(t.accountId, t.externalKey),
    index().on(t.accountId, t.lastMessageAt),
    index().using('gin', t.titleIndex),
  ],
);

export const messengerMessages = pgTable(
  'messenger_messages',
  {
    /** Ingestion order: the cursor of "what's new". */
    seq: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    id: text().notNull().unique(),
    accountId: text()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    chatId: text()
      .notNull()
      .references(() => messengerChats.id, { onDelete: 'cascade' }),
    /** Keyed hash of the messenger's message id (dedupe across restarts, webhooks and echoes). */
    externalKey: text().notNull(),
    direction: text().$type<'in' | 'out'>().notNull(),
    sentAt: timestamp({ withTimezone: true }).notNull(),
    editedAt: timestamp({ withTimezone: true }),
    deleted: boolean().notNull().default(false),
    /** Encrypted `{ externalId, text, sender, replyTo, attachments }`. */
    bodyEncrypted: text().notNull(),
    /** Blind index of words and sender name for encrypted full-text search. */
    searchIndex: integer().array().notNull().default(sql`'{}'::int[]`),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex().on(t.chatId, t.externalKey),
    index().on(t.accountId, t.sentAt),
    index().on(t.chatId, t.sentAt),
    index().on(t.accountId, t.seq),
    index().using('gin', t.searchIndex),
  ],
);

export type OutboxStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'cancelled';

/** Durable, idempotent queue of everything the hub sends to messengers. */
export const messengerOutbox = pgTable(
  'messenger_outbox',
  {
    id: text().primaryKey(),
    accountId: text()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    chatId: text()
      .notNull()
      .references(() => messengerChats.id, { onDelete: 'cascade' }),
    kind: text().$type<'message' | 'mark_read'>().notNull(),
    /** Encrypted job payload (text, reply target). */
    payloadEncrypted: text().notNull(),
    /** Keyed hash of chat + content: identical requests within a short window are merged. */
    contentKey: text().notNull(),
    status: text().$type<OutboxStatus>().notNull().default('queued'),
    /** First message to someone who never wrote to this account (stricter limits). */
    newContact: boolean().notNull().default(false),
    attempts: integer().notNull().default(0),
    notBefore: timestamp({ withTimezone: true }).notNull().defaultNow(),
    claimedBy: text(),
    claimExpiresAt: timestamp({ withTimezone: true }),
    /** Hub id of the stored message once sent. */
    messageId: text(),
    error: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    sentAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.status, t.notBefore),
    index().on(t.accountId, t.sentAt),
    index().on(t.accountId, t.contentKey, t.createdAt),
  ],
);

/**
 * Telegram Chat Automation: a person adds the hub's own bot to their Telegram account (Settings →
 * Chat Automation) and it reads and replies in the chats they picked. A one-time link ties that
 * Telegram account to a workspace; see docs/MESSENGERS.md.
 */
export type TelegramLinkState =
  /** Shown as a QR code; nobody has opened it in Telegram yet. */
  | 'pending'
  /** Opened in the bot (`/start`): waiting for the person to tap Connect. */
  | 'opened'
  /** Confirmed in the bot: waiting for Telegram to report the bot in Chat Automation. */
  | 'confirmed'
  /** The account is connected (or being created: `accountId` is set once it exists). */
  | 'connected'
  /** The account could not be created (`error` says why). */
  | 'failed'
  /** Cancelled in the bot or on the page. */
  | 'cancelled';

/** A one-time link (QR code) that connects a Telegram account to a workspace through the hub's bot. */
export const telegramLinks = pgTable(
  'telegram_links',
  {
    id: text().primaryKey(),
    /** SHA-256 of the code in the bot's deep link. */
    codeHash: text().notNull().unique(),
    /** The code itself, encrypted (SecretBox, AAD = link id), so the page can show the QR code again. */
    codeEncrypted: text().notNull(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Who made the link: only they see its page, and the account is theirs (or the team's). */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The account to create: name, label, owner in a team. */
    draft: jsonb().$type<ConnectDraft>().notNull().default({}),
    /** The account this link connects again. */
    reconnectAccountId: text().references(() => accounts.id, { onDelete: 'cascade' }),
    /** Hub-relative path to go to afterwards. */
    returnTo: text(),
    state: text().$type<TelegramLinkState>().notNull().default('pending'),
    /** Keyed hash of the Telegram user who opened the link: only they can finish it. */
    telegramUserKey: text(),
    /**
     * Encrypted `{ chat, label }` of that user (SecretBox, AAD = link id): the private chat the bot
     * writes to and the @username or name the page shows while the link is in progress.
     */
    telegramEncrypted: text(),
    /**
     * SHA-256 of the 6-digit code the bot sent when the link was opened. The signed-in user types it
     * on the link's page: proof that one person holds both the hub session and the Telegram account.
     */
    confirmCodeHash: text(),
    /** Wrong codes typed on the page; the link fails after a few. */
    confirmAttempts: integer().notNull().default(0),
    accountId: text().references(() => accounts.id, { onDelete: 'set null' }),
    error: text(),
    /** Language of the page, for the bot's messages. */
    locale: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.telegramUserKey), index().on(t.userId), index().on(t.expiresAt)],
);

/**
 * A business connection of the hub's bot: a person added it under Settings → Chat Automation. One
 * per Telegram user (Telegram connects one bot to an account), routed to the account it connects.
 * Without an account (added before opening a link, or disconnected) its messages are not stored.
 */
export const telegramConnections = pgTable('telegram_connections', {
  id: text().primaryKey(),
  /** Keyed hash of the Telegram user who connected the bot. */
  telegramUserKey: text().notNull().unique(),
  /** Keyed hash of the current business connection id: how updates are routed. */
  connectionKey: text().notNull().unique(),
  /** Encrypted `{ connectionId, userChatId, username, name }` (SecretBox, AAD = the user key). */
  infoEncrypted: text().notNull(),
  /**
   * What the person allowed the bot: the BusinessBotRights flags that are on (`can_reply`...).
   * Names of permissions only, nothing about the person, so it is not encrypted.
   */
  rights: text().array().notNull().default(sql`'{}'::text[]`),
  /** False while the bot is removed or paused in Telegram. */
  enabled: boolean().notNull().default(true),
  accountId: text()
    .unique()
    .references(() => accounts.id, { onDelete: 'set null' }),
  /** The language the person's Telegram app is set to, for the bot's messages. */
  locale: text(),
  connectedAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Plans, limits and the admin panel
// ---------------------------------------------------------------------------

/**
 * The plan a person is on, kept on their own workspace (a team has none: it runs on its payer's).
 * No row = the free plan. Payment providers write here through `BillingService`
 * (`src/billing/service.ts`); admins can set a plan by hand (`provider = 'manual'`).
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    workspaceId: text()
      .primaryKey()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Plan id from `src/billing/plans.ts`. */
    planId: text().notNull(),
    status: text().$type<SubscriptionStatus>().notNull().default('active'),
    /** Who manages the subscription: `manual` (admin), later `stripe`, `yookassa`... */
    provider: text().notNull().default('manual'),
    /** The subscription id at the payment provider. */
    externalId: text(),
    /** When a paid period (or a manually granted plan) ends; null = open-ended. */
    currentPeriodEnd: timestamp({ withTimezone: true }),
    cancelAtPeriodEnd: boolean().notNull().default(false),
    /** The customer at the payment provider (opens its billing portal, links later checkouts). */
    customerId: text(),
    /** Billing interval of a paid subscription. */
    interval: text().$type<'month' | 'year'>(),
    /** How many of the provider's price were bought (always 1: no plan is sold per unit). */
    quantity: integer().notNull().default(1),
    /**
     * When the provider last changed the subscription (its event time). Webhooks can arrive out of
     * order; an older event never overwrites a newer state.
     */
    providerUpdatedAt: timestamp({ withTimezone: true }),
    note: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.provider, t.externalId)],
);

export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled';

/**
 * Webhook events from payment providers, kept for duplicate protection (providers retry) and for
 * the admin panel. Only the normalized outcome is stored, never card or personal data.
 */
export const billingEvents = pgTable(
  'billing_events',
  {
    provider: text().notNull(),
    /** The provider's event id. */
    eventId: text().notNull(),
    type: text().notNull(),
    workspaceId: text().references(() => workspaces.id, { onDelete: 'set null' }),
    /** The subscription id at the provider. */
    externalId: text(),
    planId: text(),
    status: text(),
    /** `applied`, `ignored` (stale, unknown workspace or price) or `failed`. */
    outcome: text().notNull(),
    detail: text(),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.eventId] }),
    index().on(t.workspaceId),
    index().on(t.createdAt),
  ],
);

/**
 * Emails and other one-off notices already sent to a workspace, so each goes out once per
 * occasion (`key`: the trial end day, the counting period, the subscription and period...).
 */
export const sentNotices = pgTable(
  'sent_notices',
  {
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** `trial_ending`, `limit_reached`, `payment_failed`, `referral_reward`. */
    kind: text().notNull(),
    key: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.kind, t.key] })],
);

export type ReferralStatus = 'signed_up' | 'rewarded' | 'no_reward';

/**
 * Who invited whom (one row per invited user). The inviter gets a month of Pro once the invited
 * user starts paying; see `ReferralService`.
 */
export const referrals = pgTable(
  'referrals',
  {
    referredUserId: text()
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    referrerUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text().$type<ReferralStatus>().notNull().default('signed_up'),
    /** What the inviter got: `pro_plan` (a month of Pro), `pro_limits` (Pro limits on a paid plan) or why not. */
    reward: text(),
    rewardedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.referrerUserId)],
);

/**
 * Extra limits granted to a workspace on top of its plan (by an admin, a promo, support).
 * While active, `amount` is added to the plan's limit of `metric`; null `amount` lifts the limit.
 */
export const limitGrants = pgTable(
  'limit_grants',
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** A metric from `src/billing/plans.ts` (`actions`, `accounts`...). */
    metric: text().notNull(),
    amount: integer(),
    reason: text(),
    grantedBy: text().references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.workspaceId)],
);

/**
 * "I want this plan" from the dashboard while payments are manual (no `BillingProvider`). Admins
 * see open requests in the panel; setting a plan for the workspace closes them.
 */
export const planRequests = pgTable(
  'plan_requests',
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text().references(() => users.id, { onDelete: 'set null' }),
    planId: text().notNull(),
    interval: text().$type<'month' | 'year'>().notNull().default('month'),
    createdAt: createdAt(),
    closedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.workspaceId), index().on(t.closedAt)],
);

/** What admins did in the admin panel. Kept when the admin or the target user is deleted. */
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: text().primaryKey(),
    actorUserId: text().references(() => users.id, { onDelete: 'set null' }),
    actorEmail: text().notNull(),
    /** `user.suspend`, `plan.set`, `limit.grant`... */
    action: text().notNull(),
    targetUserId: text(),
    targetWorkspaceId: text(),
    /** Argument-free summary of the change (plan ids, amounts, reasons). */
    details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ip: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.createdAt), index().on(t.targetUserId)],
);

// ---------------------------------------------------------------------------
// Operations: error tracking, background job runs
// ---------------------------------------------------------------------------

/**
 * Unexpected errors grouped by fingerprint (the hub's own error tracker, see `src/ops/errors.ts`).
 * Only scrubbed text is stored: messages and stacks pass through `scrubSecrets`, and contexts never
 * hold tool arguments, tokens or credentials.
 */
export const errorGroups = pgTable(
  'error_groups',
  {
    id: text().primaryKey(),
    /** Hash of source, error type, normalized message and the first own stack frame. */
    fingerprint: text().notNull().unique(),
    /** Where it happened: `http`, `tool`, `job`, `process`, `maintenance`... */
    source: text().notNull(),
    /** Error class name (`TypeError`). */
    type: text().notNull(),
    message: text().notNull(),
    stack: text(),
    /** The latest occurrence's context: path, method, tool, connector, job (no arguments). */
    context: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    count: integer().notNull().default(1),
    /** Reference of the latest occurrence, as shown to users ("ref …") and in the logs. */
    lastRef: text(),
    lastRequestId: text(),
    release: text(),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Set when an admin marks it fixed; a new occurrence reopens the group. */
    resolvedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.lastSeenAt), index().on(t.resolvedAt)],
);

/** The latest run of each background job, so a job that silently stopped is visible. */
export const jobRuns = pgTable('job_runs', {
  name: text().primaryKey(),
  lastStartedAt: timestamp({ withTimezone: true }),
  lastSucceededAt: timestamp({ withTimezone: true }),
  lastFailedAt: timestamp({ withTimezone: true }),
  /** Scrubbed message of the latest failure. */
  lastError: text(),
  lastDurationMs: integer(),
  /** Failures since the last success. */
  consecutiveFailures: integer().notNull().default(0),
  runs: bigint({ mode: 'number' }).notNull().default(0),
  failures: bigint({ mode: 'number' }).notNull().default(0),
});

// ---------------------------------------------------------------------------
// Status page: component states, daily uptime, incidents
// ---------------------------------------------------------------------------

/** Current state of each public component (see `src/ops/status.ts`), updated every minute. */
export const statusComponents = pgTable('status_components', {
  /** `web`, `mcp`, `database`, `jobs`, `connections`. */
  component: text().primaryKey(),
  status: text().$type<'ok' | 'degraded' | 'down'>().notNull(),
  /** Internal detail for the admin panel (never shown on the public page). */
  detail: text(),
  /** When the component entered its current status. */
  since: timestamp({ withTimezone: true }).notNull().defaultNow(),
  lastSampleAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Minutes per status, per component and UTC day: the 90-day bars and uptime percentages. */
export const statusDays = pgTable(
  'status_days',
  {
    component: text().notNull(),
    day: date({ mode: 'string' }).notNull(),
    okMinutes: integer().notNull().default(0),
    degradedMinutes: integer().notNull().default(0),
    downMinutes: integer().notNull().default(0),
    /** Minutes without a sample: the hub (or its jobs) was not running. */
    missingMinutes: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.component, t.day] })],
);

/** A period when a component was degraded or down (or not sampled at all). */
export const statusIncidents = pgTable(
  'status_incidents',
  {
    id: text().primaryKey(),
    component: text().notNull(),
    /** Worst status during the incident; `missing` = no samples (the hub was not running). */
    status: text().$type<'degraded' | 'down' | 'missing'>().notNull(),
    detail: text(),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    /** Null while ongoing. */
    endedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.startedAt), index().on(t.component, t.endedAt)],
);

// ---------------------------------------------------------------------------
// Product analytics (first party, cookieless; see `docs/ANALYTICS.md`)
// ---------------------------------------------------------------------------

/**
 * The secret of each UTC day that visitor ids are hashed with. Random, shared by every instance,
 * deleted after two days: from then on nobody (us included) can tie a visit back to an address.
 */
export const analyticsSalts = pgTable('analytics_salts', {
  day: date({ mode: 'string' }).primaryKey(),
  salt: text().notNull(),
  createdAt: createdAt(),
});

/**
 * One row per visitor and UTC day on the public site: a daily aggregate, not a click log. The
 * visitor is `hash(day salt, IP, browser)`, so the same person is a new visitor the next day and no
 * IP address or cookie is stored. The traffic source is the first non-direct one seen that day.
 */
export const analyticsVisits = pgTable(
  'analytics_visits',
  {
    day: date({ mode: 'string' }).notNull(),
    /** Daily visitor id (truncated SHA-256, base64url). */
    visitor: text().notNull(),
    /** `direct`, a search engine, a site, or `utm_source` (`telegram`). */
    source: text().notNull(),
    /** `none`, `organic`, `referral`, `social`, `ai`, `paid`, `email`, `invite` or `utm_medium`. */
    medium: text().notNull(),
    campaign: text(),
    term: text(),
    content: text(),
    /** The referring site's host, without `www.`. */
    referrerHost: text(),
    /** The first page of the visit (ids replaced by `:id`). */
    landingPath: text().notNull(),
    /** ISO 3166 country code from the IP (looked up, never stored). */
    country: text(),
    /** The browser's preferred language (`en`, `ru`, `de`). */
    language: text(),
    /** `desktop`, `mobile`, `tablet`. */
    device: text().notNull(),
    browser: text().notNull(),
    os: text().notNull(),
    /** The browser carried a sign-in session: a returning user, kept out of acquisition numbers. */
    known: boolean().notNull().default(false),
    pageviews: integer().notNull().default(0),
    firstAt: timestamp({ withTimezone: true }).notNull(),
    lastAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.visitor] }), index().on(t.source, t.day)],
);

/** Page views per UTC day and page (site and dashboard; ids in paths replaced by `:id`). */
export const analyticsPages = pgTable(
  'analytics_pages',
  {
    day: date({ mode: 'string' }).notNull(),
    path: text().notNull(),
    views: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.path] })],
);

/**
 * Counters of product events per UTC day: `name` says what happened (`signup`, `connect.start`,
 * `checkout.start`, `crawler`, `bot.start`), `key` what it happened to (a service, plan, campaign).
 */
export const analyticsEvents = pgTable(
  'analytics_events',
  {
    day: date({ mode: 'string' }).notNull(),
    name: text().notNull(),
    key: text().notNull().default(''),
    count: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.name, t.key] })],
);

/**
 * Where a user came from, written once at sign-up from that day's (or the day before's) visit by
 * the same visitor. `matched = false`: no visit was seen (an earlier visit, or before analytics).
 */
export const userAttribution = pgTable(
  'user_attribution',
  {
    userId: text()
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    source: text().notNull(),
    medium: text().notNull(),
    campaign: text(),
    term: text(),
    content: text(),
    referrerHost: text(),
    landingPath: text(),
    country: text(),
    language: text(),
    device: text(),
    browser: text(),
    os: text(),
    matched: boolean().notNull(),
    /** When the matched visit started. */
    firstSeenAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.createdAt), index().on(t.source)],
);
