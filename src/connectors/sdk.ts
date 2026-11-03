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
import { z } from 'zod';

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

export interface AccountContext<TConfig, TCredentials> {
  account: AccountInfo;
  config: TConfig;
  credentials: TCredentials;
  /** Persist new credentials, e.g. after refreshing an OAuth token. They are encrypted by the hub. */
  updateCredentials(next: TCredentials): Promise<void>;
  /** Aborted when the AI client cancels the call or the tool timeout is reached. */
  signal: AbortSignal;
  logger: ConnectorLogger;
}

export type ActionContext<TConfig, TCredentials> = AccountContext<TConfig, TCredentials>;

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
  hints?: ActionHints;
  run(input: unknown, ctx: ActionContext<TConfig, TCredentials>): Promise<ActionResult> | ActionResult;
}

export interface TestResult {
  ok: boolean;
  message?: string;
  /** e.g. the email address of the mailbox; shown to the user and the AI. */
  identity?: string;
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
  actions: ActionDefinition<TConfig, TCredentials>[];
  /** Verify that an account works (called when it is added and on demand). */
  test?(ctx: AccountContext<TConfig, TCredentials>): Promise<TestResult>;
}

type ActionSpec<TInput extends AnyObjectSchema, TConfig, TCredentials> = {
  name: string;
  title?: string;
  description: string;
  input: TInput;
  hints?: ActionHints;
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
  actions: (
    action: ActionFactory<z.output<TConfig>, z.output<TCredentials>>,
  ) => ActionDefinition<z.output<TConfig>, z.output<TCredentials>>[];
  test?(ctx: AccountContext<z.output<TConfig>, z.output<TCredentials>>): Promise<TestResult>;
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
  const factory: ActionFactory<z.output<TConfig>, z.output<TCredentials>> = (action) => ({
    ...action,
    run: (input, ctx) => action.run(input as never, ctx),
  });
  const definition: ConnectorDefinition<z.output<TConfig>, z.output<TCredentials>> = {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    version: spec.version,
    instructions: spec.instructions,
    homepage: spec.homepage,
    config: spec.config ?? z.object({}),
    credentials: spec.credentials ?? z.object({}),
    actions: spec.actions(factory),
    test: spec.test,
  };
  return definition as unknown as ConnectorDefinition;
}

/** JSON Schema for a zod schema, in the shape MCP clients expect for tool inputs. */
export function toJsonSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  delete json.$schema;
  return json;
}
