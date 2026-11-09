import { z } from 'zod';
import { ACTION_TAGS } from '../sdk.js';

/**
 * The declarative HTTP connector format. A manifest is plain JSON-compatible data, so the same
 * format is used for built-in manifests (TypeScript/JSON files in the repo), services a user adds
 * without code (stored in the database), connectors generated from OpenAPI specs, and later
 * composite tools.
 *
 * Templates (`{{input.x}}`, `{{config.x}}`, `{{credentials.x}}`, `{{account.name}}`) are described in
 * `../http/template.ts`. Schemas (`input`, `config`, `credentials`) are JSON Schema objects.
 */

const JsonSchemaObject = z
  .object({ type: z.literal('object').optional(), properties: z.record(z.string(), z.unknown()).optional() })
  .loose();

const Template = z.unknown();
const DotPath = z.string().regex(/^[\w-]+(\.[\w-]+)*$/, 'use a dot path like "data.items"');
const NAME = /^[a-z][a-z0-9_]{0,39}$/;

const ProviderSpec = z.object({
  id: z.string(),
  name: z.string(),
  authorizationUrl: z.url(),
  tokenUrl: z.url(),
  revocationUrl: z.url().optional(),
  pkce: z.boolean().optional(),
  clientAuth: z.enum(['client_secret_basic', 'client_secret_post']).optional(),
  tokenRequestFormat: z.enum(['form', 'json']).optional(),
  scopeSeparator: z.string().optional(),
  scopeParam: z.string().optional(),
  baseScopes: z.array(z.string()).optional(),
  authorizeParams: z.record(z.string(), z.string()).optional(),
  tokenParams: z.record(z.string(), z.string()).optional(),
  tokenPath: z.string().optional(),
  appSetupUrl: z.url().optional(),
});

export const ManifestAuth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('api_key'),
    in: z.enum(['header', 'query']).default('header'),
    /** Header or query parameter name, e.g. `X-API-Key` or `api_key`. */
    name: z.string().min(1),
    /** Default `{{credentials.apiKey}}`. */
    value: z.string().default('{{credentials.apiKey}}'),
  }),
  z.object({
    type: z.literal('bearer'),
    /** Default `{{credentials.token}}`. */
    token: z.string().default('{{credentials.token}}'),
  }),
  z.object({
    type: z.literal('basic'),
    username: z.string(),
    password: z.string().default(''),
  }),
  z.object({
    type: z.literal('oauth2'),
    provider: z.union([z.string(), ProviderSpec]),
    scopes: z.array(z.string()).default([]),
    authorizeParams: z.record(z.string(), z.string()).optional(),
    /**
     * Alternative to OAuth: a personal token sent as `Bearer` when the account has no OAuth
     * connection, e.g. `{{credentials.token}}`. Makes OAuth optional for the connector.
     */
    token: z.string().optional(),
  }),
]);
export type ManifestAuth = z.output<typeof ManifestAuth>;

export const ManifestPagination = z.discriminatedUnion('type', [
  /** The response carries an opaque cursor for the next page. */
  z.object({
    type: z.literal('cursor'),
    /** Request parameter that receives the cursor. */
    param: z.string(),
    in: z.enum(['query', 'body']).default('query'),
    /** Where the next cursor is in the response, e.g. `response_metadata.next_cursor`. */
    nextPath: DotPath,
  }),
  /** Numbered pages. There is a next page while the current one is not empty. */
  z.object({
    type: z.literal('page'),
    param: z.string(),
    in: z.enum(['query', 'body']).default('query'),
    start: z.number().int().default(1),
    /** Optional boolean in the response that says whether more pages exist. */
    hasMorePath: DotPath.optional(),
  }),
  /** Offset/limit. */
  z.object({
    type: z.literal('offset'),
    param: z.string(),
    in: z.enum(['query', 'body']).default('query'),
    /** Input field holding the page size, used to compute the next offset. */
    limitParam: z.string(),
    defaultLimit: z.number().int().positive().default(50),
  }),
  /** RFC 8288 `Link: <...>; rel="next"` header (GitHub, many REST APIs). */
  z.object({ type: z.literal('link') }),
  /** The response carries the full URL of the next page. */
  z.object({ type: z.literal('next_url'), nextPath: DotPath }),
]);
export type ManifestPagination = z.output<typeof ManifestPagination>;

export const ManifestRequest = z.object({
  method: z
    .string()
    .transform((m) => m.toUpperCase())
    .pipe(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])),
  /** Relative to `baseUrl`; `{field}` segments are filled from the input (URL-encoded). */
  path: z.string(),
  /**
   * Query parameters (templates). When omitted, GET/DELETE/HEAD send every input field that is not
   * used in the path as a query parameter.
   */
  query: z.record(z.string(), Template).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /**
   * Body (template). When omitted, POST/PUT/PATCH send every input field not used in the path as
   * the body.
   */
  body: Template.optional(),
  bodyType: z.enum(['json', 'form']).default('json'),
});
export type ManifestRequest = z.output<typeof ManifestRequest>;

export const ManifestResponse = z.object({
  /** Part of the response to return, e.g. `data` or `items`. */
  root: DotPath.optional(),
  /** Keep only these fields (dot paths) of the object or of every array item: saves AI tokens. */
  fields: z.array(DotPath).optional(),
  /** Text returned when the service answers with an empty body (204). */
  empty: z.string().optional(),
});

/**
 * A shared capability the action implements (see `capabilities.ts`). `input` maps the capability's
 * canonical input to the action's input (`{{input.x}}`); `output` maps each result item (`list`
 * capabilities) or the result (`single`) to the canonical shape (`{{item.x}}`, `{{input.x}}`).
 * Without a template the value is passed as is.
 */
export const ManifestCapability = z.union([
  z.string(),
  z.object({
    id: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
    output: z.record(z.string(), z.unknown()).optional(),
  }),
]);
export type ManifestCapability = z.output<typeof ManifestCapability>;

export const ManifestUndo = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('action'), action: z.string(), note: z.string().optional() }),
  z.object({ kind: z.literal('delay'), seconds: z.number().int().min(1).max(600) }),
  z.object({ kind: z.literal('none') }),
]);

export const ManifestAction = z.object({
  name: z.string().regex(NAME, 'use lowercase snake_case'),
  title: z.string().optional(),
  description: z.string().min(1),
  /** Extra words for the hub's tool search only (see `ActionDefinition.keywords`). */
  keywords: z.string().max(300).optional(),
  input: JsonSchemaObject.default({ type: 'object', properties: {} }),
  hints: z
    .object({
      readOnly: z.boolean().optional(),
      destructive: z.boolean().optional(),
      idempotent: z.boolean().optional(),
      openWorld: z.boolean().optional(),
    })
    .optional(),
  /** `read`, `write` or `dangerous`; derived from `hints` when omitted (see `actionRisk`). */
  risk: z.enum(['read', 'write', 'dangerous']).optional(),
  /** Kinds of effect AI app directories care about, e.g. `["moves_money"]` (see `ActionTag`). */
  tags: z.array(z.enum(ACTION_TAGS)).optional(),
  undo: ManifestUndo.optional(),
  capability: z.union([ManifestCapability, z.array(ManifestCapability)]).optional(),
  request: ManifestRequest,
  response: ManifestResponse.optional(),
  /**
   * Makes this a paginated list action: `true` uses the manifest-level `pagination`. The engine adds
   * a `cursor` input and returns `{ items, nextCursor }`, so the AI fetches pages only when needed.
   */
  pagination: z.union([ManifestPagination, z.literal(true)]).optional(),
});
export type ManifestAction = z.output<typeof ManifestAction>;

export const HttpManifest = z.object({
  /** Format version of the manifest itself. */
  manifest: z.literal(1).default(1),
  id: z.string(),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().default('1.0.0'),
  homepage: z.url().optional(),
  instructions: z.string().optional(),
  /** Template; may use `{{config.x}}` (e.g. `https://{{config.subdomain}}.zendesk.com/api/v2`). */
  baseUrl: z.string().min(1),
  auth: ManifestAuth.default({ type: 'none' }),
  /** JSON Schema of non-secret per-account settings. */
  config: JsonSchemaObject.optional(),
  /** JSON Schema of secret per-account credentials (API keys, tokens). */
  credentials: JsonSchemaObject.optional(),
  /** Headers sent with every request (templates), e.g. `{ "Notion-Version": "2022-06-28" }`. */
  headers: z.record(z.string(), z.string()).optional(),
  /** Per-account client-side rate limit. */
  rateLimit: z
    .object({ requests: z.number().int().positive(), perSeconds: z.number().positive() })
    .optional(),
  /** Where the service puts error messages (dot paths), tried in order. */
  errorMessagePaths: z.array(DotPath).optional(),
  /** Pagination used by actions that set `pagination: true`. */
  pagination: ManifestPagination.optional(),
  /** Connection test: a cheap request plus, optionally, where the account identity is. */
  test: z
    .object({
      request: ManifestRequest,
      /** Template over `{{response...}}`, e.g. `{{response.email}}`. */
      identity: z.string().optional(),
    })
    .optional(),
  actions: z.array(ManifestAction).min(1),
});
export type HttpManifestInput = z.input<typeof HttpManifest>;
export type HttpManifest = z.output<typeof HttpManifest>;
