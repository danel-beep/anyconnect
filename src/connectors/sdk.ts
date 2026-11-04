/**
 * Connector SDK — the only API a connector needs to know.
 *
 * A connector describes one *service* (Gmail, Telegram, a REST API, a remote MCP server, ...).
 * The hub stores any number of *accounts* for it and turns every action into MCP tools.
 * Connectors never deal with MCP, HTTP routing, storage, encryption or multi-account routing;
 * they receive the already-decrypted config and credentials of exactly one account.
 *
 * This module deliberately has no imports from the rest of the app so it can later be published
 * as a standalone package for third-party connectors.
 */
import type { LookupAddress, LookupOptions } from 'node:dns';
import { z } from 'zod';
import type { CapabilityId } from './capabilities.js';
import type { MessengerSpec } from './messaging.js';

export type { CapabilityId } from './capabilities.js';
export * from './shape.js';

export type JsonSchema = Record<string, unknown>;
export type AnyObjectSchema = z.ZodObject<any, any>;
export type EmptySchema = z.ZodObject<Record<string, never>>;

/** Behaviour hints, mapped to MCP tool annotations (clients use them e.g. to ask for confirmation). */
export interface ActionHints {
  /** Does not modify anything on the remote service. */
  readOnly?: boolean;
  /** May delete or overwrite data (only meaningful when not read-only). */
  destructive?: boolean;
  /** Calling repeatedly with the same input has no additional effect. */
  idempotent?: boolean;
  /** Talks to an external system (default true). */
  openWorld?: boolean;
}

/**
 * How much harm an action can do, used by the hub's policy, confirmation and audit:
 * - `read`: only reads data;
 * - `write`: creates or changes something that is easy to notice and fix (send a message, add a task);
 * - `dangerous`: hard or impossible to undo, or moves money/data out (delete, pay, share publicly).
 */
export type RiskLevel = 'read' | 'write' | 'dangerous';

/** How the effect of an action can be undone (shown in the audit log; the panel offers "undo"). */
export type UndoSpec =
  /** Another action of the same connector reverses it, e.g. `delete_message` for `send_message`. */
  | { kind: 'action'; action: string; note?: string }
  /** The hub may hold the call for this many seconds so the user can cancel it (send with undo window). */
  | { kind: 'delay'; seconds: number }
  | { kind: 'none' };

/** A shared interface operation the action implements; see `capabilities.ts`. */
export interface CapabilityBinding {
  id: CapabilityId;
  /** Converts the capability's canonical input to this action's input (default: passed as is). */
  mapInput?(input: Record<string, unknown>): Record<string, unknown>;
  /** Converts this action's result to the capability's canonical output (default: used as is). */
  mapOutput?(result: unknown, input: Record<string, unknown>): unknown;
}

/** Result of a runtime risk check, see `ActionDefinition.assessRisk`. */
export interface RiskAssessment {
  risk: RiskLevel;
  /** Shown to the user when asking for confirmation, e.g. "First message to a new contact". */
  reason: string;
}

/** Fixed-window request limit, e.g. `{ requests: 20, perSeconds: 60 }`. */
export interface RateLimitSpec {
  requests: number;
  perSeconds: number;
}

/** Tells the hub how to keep the action's results compact for the AI. */
export interface ResponseSpec {
  /**
   * Top-level fields of the result (or of each item for list results) the AI may select with the
   * hub-provided `fields` argument. Declaring them adds that argument to the tool.
   */
  fields?: string[];
  /** Upper bound for the result size in tokens (default: the hub's limit, ~2000 tokens). */
  maxTokens?: number;
}

export interface AccountInfo {
  id: string;
  /** Short machine name, e.g. `work`. */
  name: string;
  /** Human label, e.g. "Рабочая почта". */
  label: string;
  description?: string | undefined;
  /** e.g. the email address or username the account is logged in as. */
  identity?: string | undefined;
}

export interface ConnectorLogger {
  debug(obj: object | string, msg?: string): void;
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

/** The WHATWG `fetch` signature. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** `dns.lookup`-compatible function, accepted by `net`, `tls`, `pg`, `imapflow`, `nodemailer`... */
export type LookupFunction = (
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void;

/** Network access that follows the hub's outbound policy (no private addresses in production). */
export interface NetworkAccess {
  /** Pass to socket libraries (`lookup` option) so raw TCP connections obey the same policy as `fetch`. */
  lookup: LookupFunction;
  /**
   * Throws when a host is an IP literal the policy forbids. Socket libraries skip `lookup` for IP
   * literals, so call this with the configured host before connecting.
   */
  assertHostAllowed(host: string): void;
}

/** The account's OAuth access token, kept fresh by the hub (see `ConnectorDefinition.oauth`). */
export interface OAuthAccess {
  accessToken: string;
  /** Usually `Bearer`. */
  tokenType: string;
  /** Scopes actually granted (may be fewer than requested). */
  scopes: string[];
  expiresAt?: Date | undefined;
  /** Non-secret fields of the token response, e.g. Slack `team`, Salesforce `instance_url`. */
  extra: Record<string, unknown>;
  /**
   * Forces a refresh, e.g. after the service answered 401, and returns the new access token.
   * Concurrent calls share one refresh. Throws `ConnectorError('auth')` when the grant is gone.
   */
  refresh(): Promise<string>;
}

export interface AccountContext<TConfig, TCredentials> {
  account: AccountInfo;
  config: TConfig;
  credentials: TCredentials;
  /** Persist new credentials, e.g. after refreshing an OAuth token. They are encrypted by the hub. */
  updateCredentials(next: TCredentials): Promise<void>;
  /** Aborted when the AI client cancels the call or the tool timeout is reached. */
  signal: AbortSignal;
  logger: ConnectorLogger;
  /**
   * HTTP transport to use for every outbound request. The hub injects one that enforces its network
   * policy; tests inject recorded fixtures. Never use the global `fetch` in a connector.
   */
  fetch: FetchLike;
  /** For connectors that open raw sockets (IMAP, SMTP, databases). */
  network: NetworkAccess;
  /** Present for connectors that declare `oauth`, once the account is connected. */
  oauth?: OAuthAccess | undefined;
}

export type ActionContext<TConfig, TCredentials> = AccountContext<TConfig, TCredentials>;

/** Returns the OAuth access of an account or fails with a clear "reconnect" error. */
export function requireOAuth(ctx: { oauth?: OAuthAccess | undefined }): OAuthAccess {
  if (!ctx.oauth) throw new ConnectorError('auth', 'The account is not connected yet');
  return ctx.oauth;
}

const RAW_RESULT = Symbol.for('anyconnect.rawToolResult');

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string; description?: string };

export interface RawToolResult {
  [RAW_RESULT]: true;
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Return exact MCP content (images, links, ...) instead of letting the hub serialize the value. */
export function rawResult(result: Omit<RawToolResult, typeof RAW_RESULT>): RawToolResult {
  return { ...result, [RAW_RESULT]: true };
}

export function isRawResult(value: unknown): value is RawToolResult {
  return (
    typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[RAW_RESULT] === true
  );
}

/**
 * What an action returns: plain text, any JSON-serializable value (sent to the AI as JSON),
 * or a {@link rawResult}.
 */
export type ActionResult = string | number | boolean | null | object | RawToolResult;

export type ErrorKind =
  /** Credentials are invalid or expired — the account is marked as needing re-authorization. */
  | 'auth'
  /** The input is wrong in a way the AI can fix. */
  | 'invalid_input'
  | 'not_found'
  | 'rate_limited'
  | 'permission'
  /** The remote service failed. */
  | 'upstream';

/** Throw this from an action to return a clear, user-safe error message to the AI. */
export class ConnectorError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly options: { retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ConnectorError';
  }
}

export interface ActionDefinition<TConfig = unknown, TCredentials = unknown> {
  /** snake_case, unique within the connector; becomes part of the tool name. */
  name: string;
  title?: string;
  /** Written for the AI: what it does, when to use it, what it returns. */
  description: string;
  /** Input arguments. Use `.describe()` on fields — descriptions are shown to the AI. */
  input: AnyObjectSchema;
  /**
   * JSON Schema shown to the AI instead of the one generated from `input`. For actions whose schema
   * comes from elsewhere verbatim (a remote MCP server, an HTTP manifest); `input` still validates.
   */
  inputSchema?: JsonSchema;
  hints?: ActionHints;
  /** Default: `read` if `hints.readOnly`, `dangerous` if `hints.destructive`, otherwise `write`. */
  risk?: RiskLevel;
  undo?: UndoSpec;
  /** Shared interface operation(s) this action implements, e.g. `'mail.search'`. */
  capability?: CapabilityId | CapabilityBinding | Array<CapabilityId | CapabilityBinding>;
  response?: ResponseSpec;
  /** Per-account limit for this action (in addition to the connector-wide `rateLimit`). */
  rateLimit?: RateLimitSpec;
  /**
   * Optional runtime check that can *raise* the risk of a particular call, e.g. the first message
   * to someone the account never talked to becomes `dangerous` and needs confirmation. Runs after
   * the policy check and before confirmation; it can never lower the declared risk. If it throws,
   * the call is treated as `dangerous`.
   */
  assessRisk?(
    input: unknown,
    ctx: ActionContext<TConfig, TCredentials>,
  ): Promise<RiskAssessment | undefined> | RiskAssessment | undefined;
  run(input: unknown, ctx: ActionContext<TConfig, TCredentials>): Promise<ActionResult> | ActionResult;
}

export interface TestResult {
  ok: boolean;
  message?: string;
  /** e.g. the email address of the mailbox; shown to the user and the AI. */
  identity?: string;
}

/**
 * How an OAuth-connected service authorizes. Endpoints live in a provider (see
 * `connectors/oauth/providers.ts`), so one OAuth app can serve several connectors
 * (Gmail, Calendar and Drive share `google`).
 */
export interface OAuthRequirement {
  /** A built-in provider id (`google`, `microsoft`, ...) or a full provider description. */
  provider: string | OAuthProviderSpec;
  /** Scopes requested when an account is connected. */
  scopes: string[];
  /** Extra query parameters for the authorization request of this connector. */
  authorizeParams?: Record<string, string>;
  /**
   * Accounts may skip OAuth and use credentials instead (a personal access token / API key): handy
   * for personal use, no OAuth app needed. The connector then checks `ctx.oauth ?? ctx.credentials`.
   */
  optional?: boolean;
}

/** Endpoints and quirks of an OAuth 2 authorization server. Plain data, so it can live in JSON too. */
export interface OAuthProviderSpec {
  /** Stable key; OAuth apps (client id/secret) are stored per provider. */
  id: string;
  name: string;
  authorizationUrl: string;
  tokenUrl: string;
  revocationUrl?: string;
  /** Send a PKCE S256 challenge (default true). */
  pkce?: boolean;
  /** How the client authenticates at the token endpoint (default `client_secret_post`). */
  clientAuth?: 'client_secret_basic' | 'client_secret_post';
  /** Encoding of token requests (default `form`). */
  tokenRequestFormat?: 'form' | 'json';
  /** Default ' '. */
  scopeSeparator?: string;
  /** Query parameter that carries scopes (default `scope`; Slack user tokens use `user_scope`). */
  scopeParam?: string;
  /** Scopes always requested, e.g. `offline_access` for refresh tokens. */
  baseScopes?: string[];
  /** Extra query parameters for every authorization request, e.g. Google `access_type=offline`. */
  authorizeParams?: Record<string, string>;
  /** Extra parameters for every token request, e.g. the RFC 8707 `resource` of an MCP server. */
  tokenParams?: Record<string, string>;
  /** Dot path to the object holding `access_token` etc. when it is nested (Slack: `authed_user`). */
  tokenPath?: string;
  /** Where the user creates an OAuth app for this provider (shown in the panel). */
  appSetupUrl?: string;
}

export interface ConnectorDefinition<TConfig = unknown, TCredentials = unknown> {
  /** Stable key: lowercase letters, digits, underscores; becomes the tool name prefix (`gmail_...`). */
  id: string;
  name: string;
  /** Written for both humans and the AI. */
  description: string;
  version: string;
  /** Extra guidance for the AI, added to the hub instructions when the service has accounts. */
  instructions?: string;
  homepage?: string;
  /** Non-secret per-account settings (visible in the UI). */
  config: AnyObjectSchema;
  /** Secret per-account credentials (encrypted at rest, never shown again after saving). */
  credentials: AnyObjectSchema;
  /** Accounts are connected through OAuth: the hub runs the flow and refreshes tokens (`ctx.oauth`). */
  oauth?: OAuthRequirement;
  actions: ActionDefinition<TConfig, TCredentials>[];
  /** Per-account limit across all actions, e.g. the service's documented API quota. */
  rateLimit?: RateLimitSpec;
  /** Verify that an account works (called when it is added and on demand). */
  test?(ctx: AccountContext<TConfig, TCredentials>): Promise<TestResult>;
  /** Present for chat services: how messages are delivered (see `messaging.ts`). */
  messenger?: MessengerSpec<TConfig, TCredentials>;
}

type ActionSpec<TInput extends AnyObjectSchema, TConfig, TCredentials> = Omit<
  ActionDefinition<TConfig, TCredentials>,
  'input' | 'run' | 'assessRisk'
> & {
  input: TInput;
  assessRisk?(
    input: z.output<TInput>,
    ctx: ActionContext<TConfig, TCredentials>,
  ): Promise<RiskAssessment | undefined> | RiskAssessment | undefined;
  run(
    input: z.output<TInput>,
    ctx: ActionContext<TConfig, TCredentials>,
  ): Promise<ActionResult> | ActionResult;
};

export type ActionFactory<TConfig, TCredentials> = <TInput extends AnyObjectSchema>(
  spec: ActionSpec<TInput, TConfig, TCredentials>,
) => ActionDefinition<TConfig, TCredentials>;

export interface ConnectorSpec<TConfig extends AnyObjectSchema, TCredentials extends AnyObjectSchema> {
  id: string;
  name: string;
  description: string;
  version: string;
  instructions?: string;
  homepage?: string;
  config?: TConfig;
  credentials?: TCredentials;
  oauth?: OAuthRequirement;
  rateLimit?: RateLimitSpec;
  actions: (
    action: ActionFactory<z.output<TConfig>, z.output<TCredentials>>,
  ) => ActionDefinition<z.output<TConfig>, z.output<TCredentials>>[];
  test?(ctx: AccountContext<z.output<TConfig>, z.output<TCredentials>>): Promise<TestResult>;
  messenger?: MessengerSpec<z.output<TConfig>, z.output<TCredentials>>;
}

/**
 * Define a connector with fully typed config, credentials and action inputs:
 *
 * ```ts
 * export default defineConnector({
 *   id: 'weather', name: 'Weather', description: '...', version: '1.0.0',
 *   credentials: z.object({ apiKey: z.string() }),
 *   actions: (action) => [
 *     action({
 *       name: 'forecast', description: 'Weather forecast for a city',
 *       input: z.object({ city: z.string() }), hints: { readOnly: true },
 *       run: async ({ city }, ctx) => fetchForecast(city, ctx.credentials.apiKey),
 *     }),
 *   ],
 * });
 * ```
 */
export function defineConnector<
  TConfig extends AnyObjectSchema = EmptySchema,
  TCredentials extends AnyObjectSchema = EmptySchema,
>(spec: ConnectorSpec<TConfig, TCredentials>): ConnectorDefinition {
  const factory: ActionFactory<z.output<TConfig>, z.output<TCredentials>> = (action) => {
    const { assessRisk } = action;
    return {
      ...action,
      run: (input, ctx) => action.run(input as never, ctx),
      ...(assessRisk ? { assessRisk: (input: unknown, ctx) => assessRisk(input as never, ctx) } : {}),
    } as ActionDefinition<z.output<TConfig>, z.output<TCredentials>>;
  };
  const definition: ConnectorDefinition<z.output<TConfig>, z.output<TCredentials>> = {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    version: spec.version,
    instructions: spec.instructions,
    homepage: spec.homepage,
    config: spec.config ?? z.object({}),
    credentials: spec.credentials ?? z.object({}),
    ...(spec.oauth ? { oauth: spec.oauth } : {}),
    actions: spec.actions(factory),
    rateLimit: spec.rateLimit,
    test: spec.test,
    messenger: spec.messenger,
  };
  return definition as unknown as ConnectorDefinition;
}

/** The action's risk level, explicit or derived from its hints. */
export function actionRisk(action: Pick<ActionDefinition, 'risk' | 'hints'>): RiskLevel {
  if (action.risk) return action.risk;
  if (action.hints?.readOnly) return 'read';
  return action.hints?.destructive ? 'dangerous' : 'write';
}

/** Capability bindings of an action in their long form. */
export function actionCapabilities(action: Pick<ActionDefinition, 'capability'>): CapabilityBinding[] {
  if (!action.capability) return [];
  const list = Array.isArray(action.capability) ? action.capability : [action.capability];
  return list.map((entry) => (typeof entry === 'string' ? { id: entry } : entry));
}

/** Whether repeating the call with the same input is harmless (reads are always idempotent). */
export function actionIdempotent(action: Pick<ActionDefinition, 'risk' | 'hints'>): boolean {
  return actionRisk(action) === 'read' || action.hints?.idempotent === true;
}

/** JSON Schema for a zod schema, in the shape MCP clients expect for tool inputs. */
export function toJsonSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  delete json.$schema;
  return json;
}
