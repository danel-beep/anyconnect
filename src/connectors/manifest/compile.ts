import { z } from 'zod';
import { getCapability } from '../capabilities.js';
import { HttpClient, type QueryValue } from '../http/client.js';
import { getPath, pickFields } from '../http/json-path.js';
import { TokenBucketLimiter } from '../http/rate-limit.js';
import { placeholders, render, renderString, type TemplateScope } from '../http/template.js';
import {
  type AccountContext,
  type ActionDefinition,
  type AnyObjectSchema,
  type CapabilityBinding,
  type CapabilityId,
  type ConnectorDefinition,
  ConnectorError,
  type JsonSchema,
  requireOAuth,
} from '../sdk.js';
import {
  HttpManifest,
  type HttpManifestInput,
  type ManifestAction,
  type ManifestCapability,
  type ManifestPagination,
  type ManifestRequest,
} from './schema.js';

/**
 * Turns an HTTP manifest into a regular connector. The hub cannot tell the difference: accounts,
 * credentials, OAuth, catalog modes and auditing work exactly as for code connectors.
 */

export const CURSOR_ARGUMENT = 'cursor';
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export class ManifestError extends Error {
  override name = 'ManifestError';
}

type Ctx = AccountContext<Record<string, unknown>, Record<string, unknown>>;

function objectSchema(json: JsonSchema | undefined, what: string): AnyObjectSchema {
  const schema = z.fromJSONSchema({ type: 'object', properties: {}, ...json } as never);
  if (!(schema instanceof z.ZodObject)) throw new ManifestError(`${what} must be an object schema`);
  // Unknown keys are dropped rather than forwarded to the service.
  return (schema as z.ZodObject).strip();
}

function defaultCredentials(manifest: HttpManifest): JsonSchema | undefined {
  if (manifest.credentials) return manifest.credentials;
  switch (manifest.auth.type) {
    case 'api_key':
      return {
        type: 'object',
        properties: { apiKey: { type: 'string', minLength: 1, description: `${manifest.name} API key` } },
        required: ['apiKey'],
      };
    case 'bearer':
      return {
        type: 'object',
        properties: { token: { type: 'string', minLength: 1, description: `${manifest.name} access token` } },
        required: ['token'],
      };
    case 'oauth2':
      return personalTokenSchema(manifest);
    default:
      return undefined;
  }
}

function personalTokenSchema(manifest: HttpManifest): JsonSchema | undefined {
  if (manifest.auth.type !== 'oauth2' || !manifest.auth.token) return undefined;
  return {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        description: `${manifest.name} personal access token (only if the account is not connected through OAuth)`,
      },
    },
  };
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify({ v: value })).toString('base64url');
}

function decodeCursor(cursor: string): unknown {
  try {
    return (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v: unknown }).v;
  } catch {
    throw new ConnectorError(
      'invalid_input',
      'Invalid cursor: pass nextCursor from the previous result unchanged',
    );
  }
}

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;(.*)/);
    // Sentry always sends a next link and marks the last page with `results="false"`.
    if (
      match &&
      /rel="?([^";]*\s)?next(\s[^";]*)?"?/i.test(match[2]!) &&
      !/results="?false/i.test(match[2]!)
    ) {
      return match[1];
    }
  }
  return undefined;
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}

interface CompiledAction {
  definition: ActionDefinition;
}

class ManifestRuntime {
  readonly limiter = new TokenBucketLimiter();

  constructor(readonly manifest: HttpManifest) {}

  scope(ctx: Ctx, input: Record<string, unknown>): TemplateScope {
    return {
      input,
      config: ctx.config,
      credentials: ctx.credentials,
      account: ctx.account,
      oauth: ctx.oauth ? { extra: ctx.oauth.extra } : undefined,
    };
  }

  client(ctx: Ctx, scope: TemplateScope): HttpClient {
    const { manifest } = this;
    const baseUrl = renderString(manifest.baseUrl, scope);
    if (typeof baseUrl !== 'string' || !baseUrl) {
      throw new ConnectorError(
        'invalid_input',
        `${manifest.name}: the account settings needed for the URL are missing`,
      );
    }
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(
      (render(manifest.headers ?? {}, scope) as Record<string, unknown>) ?? {},
    )) {
      headers[key] = String(value);
    }
    const query: Record<string, QueryValue> = {};
    const auth = manifest.auth;
    const secret = (template: string, what: string): string => {
      const value = renderString(template, scope);
      if (value === undefined || value === '')
        throw new ConnectorError('auth', `${what} is not set for this account`);
      return String(value);
    };
    switch (auth.type) {
      case 'api_key':
        if (auth.in === 'header') headers[auth.name] = secret(auth.value, 'The API key');
        else query[auth.name] = secret(auth.value, 'The API key');
        break;
      case 'bearer':
        headers.authorization = `Bearer ${secret(auth.token, 'The access token')}`;
        break;
      case 'basic': {
        const user = secret(auth.username, 'The username');
        const password = auth.password ? String(renderString(auth.password, scope) ?? '') : '';
        headers.authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
        break;
      }
      case 'oauth2':
        // With ctx.oauth the client adds the bearer token and refreshes it on 401.
        if (!ctx.oauth) {
          if (!auth.token) requireOAuth(ctx);
          else
            headers.authorization = `Bearer ${secret(auth.token, 'Neither an OAuth connection nor a token')}`;
        }
        break;
      case 'none':
        break;
    }
    return new HttpClient(ctx, {
      baseUrl,
      headers,
      query,
      ...(manifest.errorMessagePaths ? { errorMessagePaths: manifest.errorMessagePaths } : {}),
      ...(manifest.rateLimit
        ? { rateLimit: { limiter: this.limiter, key: ctx.account.id, limit: manifest.rateLimit } }
        : {}),
    });
  }

  async execute(
    ctx: Ctx,
    request: ManifestRequest,
    input: Record<string, unknown>,
    declared: Set<string>,
    page?: { pagination: ManifestPagination; cursor: unknown },
  ) {
    const scope = this.scope(ctx, input);
    const client = this.client(ctx, scope);
    const used = new Set<string>([CURSOR_ARGUMENT]);
    let path = request.path.replace(/\{(\w+)\}/g, (_m, name: string) => {
      used.add(name);
      const value = input[name];
      if (value === undefined || value === null || value === '') {
        throw new ConnectorError('invalid_input', `"${name}" is required`);
      }
      return encodeURIComponent(String(value));
    });
    const rest = Object.fromEntries(
      Object.entries(input).filter(
        ([key, value]) => declared.has(key) && !used.has(key) && value !== undefined,
      ),
    );
    const isBodyMethod = BODY_METHODS.has(request.method);
    let query = (request.query ? render(request.query, scope) : isBodyMethod ? {} : rest) as Record<
      string,
      QueryValue
    >;
    let body = request.body !== undefined ? render(request.body, scope) : isBodyMethod ? rest : undefined;

    if (page && page.cursor !== undefined) {
      const { pagination, cursor } = page;
      if (pagination.type === 'link' || pagination.type === 'next_url') {
        // The cursor is a full URL from the service: only follow it on the API's own origin, so a
        // crafted cursor can never send the account's credentials elsewhere.
        // Relative next links (Twilio's `next_page_uri`) resolve against the API's origin.
        const base = new URL(String(renderString(this.manifest.baseUrl, scope)));
        const next = new URL(String(cursor), base);
        if (next.origin !== base.origin) throw new ConnectorError('invalid_input', 'Invalid cursor');
        path = next.toString();
        query = {};
      } else if (pagination.in === 'body') {
        body = { ...(typeof body === 'object' && body !== null ? body : {}), [pagination.param]: cursor };
      } else {
        query = { ...query, [pagination.param]: cursor as QueryValue };
      }
    } else if (page && page.pagination.type === 'page') {
      const { pagination } = page;
      if (pagination.in === 'body') {
        body = {
          ...(typeof body === 'object' && body !== null ? body : {}),
          [pagination.param]: pagination.start,
        };
      } else {
        query = { ...query, [pagination.param]: pagination.start };
      }
    }

    const headers = request.headers
      ? Object.fromEntries(
          Object.entries(render(request.headers, scope) as Record<string, unknown>).map(([k, v]) => [
            k,
            String(v),
          ]),
        )
      : undefined;
    return client.request({
      method: request.method,
      url: path,
      query,
      ...(headers ? { headers } : {}),
      ...(body !== undefined
        ? request.bodyType === 'form'
          ? { form: body as Record<string, QueryValue> }
          : { json: body }
        : {}),
    });
  }
}

function assertScopes(template: unknown, allowed: string[], where: string): void {
  for (const path of placeholders(template)) {
    if (!allowed.some((scope) => path === scope || path.startsWith(`${scope}.`))) {
      throw new ManifestError(`${where}: placeholder {{${path}}} must start with ${allowed.join(' or ')}`);
    }
  }
}

/** Declarative capability mapping: templates instead of `mapInput` / `mapOutput` functions. */
function capabilityBinding(ref: ManifestCapability, where: string): CapabilityBinding {
  if (typeof ref === 'string') return { id: ref as CapabilityId };
  const binding: CapabilityBinding = { id: ref.id as CapabilityId };
  const { input: inputTemplate, output: outputTemplate } = ref;
  if (inputTemplate) {
    assertScopes(inputTemplate, ['input'], `${where} capability "${ref.id}" input`);
    binding.mapInput = (input) => (render(inputTemplate, { input }) ?? {}) as Record<string, unknown>;
  }
  if (outputTemplate) {
    assertScopes(outputTemplate, ['item', 'input'], `${where} capability "${ref.id}" output`);
    const one = (item: unknown, input: Record<string, unknown>) => render(outputTemplate, { item, input });
    const list = getCapability(ref.id)?.kind === 'list';
    binding.mapOutput = (result, input) => {
      if (!list) return one(result, input);
      if (Array.isArray(result)) return result.map((item) => one(item, input));
      const page = result as { items?: unknown };
      if (page && Array.isArray(page.items)) {
        return { ...page, items: page.items.map((item) => one(item, input)) };
      }
      return result;
    };
  }
  return binding;
}

function compileAction(
  runtime: ManifestRuntime,
  action: ManifestAction,
  connectorId: string,
): CompiledAction {
  const { manifest } = runtime;
  const pagination: ManifestPagination | undefined =
    action.pagination === true ? manifest.pagination : action.pagination || undefined;
  if (action.pagination === true && !manifest.pagination) {
    throw new ManifestError(
      `Action "${connectorId}.${action.name}" uses pagination but the manifest defines none`,
    );
  }
  const properties = { ...((action.input.properties ?? {}) as Record<string, unknown>) };
  if (pagination) {
    if (CURSOR_ARGUMENT in properties) {
      throw new ManifestError(
        `Action "${connectorId}.${action.name}" must not define a "${CURSOR_ARGUMENT}" input`,
      );
    }
    properties[CURSOR_ARGUMENT] = {
      type: 'string',
      description: 'Pass nextCursor from the previous result to get the next page. Omit for the first page.',
    };
  }
  const inputSchema: JsonSchema = { ...action.input, type: 'object', properties };
  for (const name of pathParams(action.request.path)) {
    if (!(name in properties)) {
      throw new ManifestError(
        `Action "${connectorId}.${action.name}": path parameter {${name}} is not an input`,
      );
    }
  }
  const declared = new Set(Object.keys(properties));
  const input = objectSchema(inputSchema, `Input of "${connectorId}.${action.name}"`);
  const response = action.response ?? {};

  const definition: ActionDefinition = {
    name: action.name,
    ...(action.title ? { title: action.title } : {}),
    description: action.description,
    ...(action.keywords ? { keywords: action.keywords } : {}),
    input,
    inputSchema,
    ...(action.hints ? { hints: action.hints } : {}),
    ...(action.risk ? { risk: action.risk } : {}),
    ...(action.tags?.length ? { tags: action.tags } : {}),
    ...(action.undo ? { undo: action.undo } : {}),
    ...(action.capability
      ? {
          capability: (Array.isArray(action.capability) ? action.capability : [action.capability]).map(
            (ref) => capabilityBinding(ref, `Action "${connectorId}.${action.name}"`),
          ),
        }
      : {}),
    async run(rawInput, rawCtx) {
      const ctx = rawCtx as Ctx;
      const args = rawInput as Record<string, unknown>;
      const cursor =
        typeof args[CURSOR_ARGUMENT] === 'string' ? decodeCursor(args[CURSOR_ARGUMENT]) : undefined;
      const result = await runtime.execute(
        ctx,
        action.request,
        args,
        declared,
        pagination ? { pagination, cursor } : undefined,
      );
      if (result.data === undefined || result.data === '') return response.empty ?? 'Done.';
      const rooted = getPath(result.data, response.root);
      const shaped = pickFields(rooted, response.fields);
      if (!pagination) return shaped ?? null;

      let next: unknown;
      switch (pagination.type) {
        case 'cursor':
          next = getPath(result.data, pagination.nextPath);
          break;
        case 'next_url':
          next = getPath(result.data, pagination.nextPath);
          break;
        case 'link':
          next = nextLink(result.headers.get('link'));
          break;
        case 'page': {
          const current = typeof cursor === 'number' ? cursor : pagination.start;
          const more = pagination.hasMorePath
            ? Boolean(getPath(result.data, pagination.hasMorePath))
            : Array.isArray(rooted) && rooted.length > 0;
          next = more ? current + 1 : undefined;
          break;
        }
        case 'offset': {
          const current = typeof cursor === 'number' ? cursor : 0;
          const limit = Number(args[pagination.limitParam] ?? pagination.defaultLimit);
          next = Array.isArray(rooted) && rooted.length >= limit ? current + rooted.length : undefined;
          break;
        }
      }
      const hasNext = next !== undefined && next !== null && next !== '' && next !== false;
      return { items: shaped ?? [], ...(hasNext ? { nextCursor: encodeCursor(next) } : {}) };
    },
  };
  return { definition };
}

/**
 * Validates a manifest and compiles it into a connector. Throws `ManifestError` (or a zod error)
 * with a precise message when the manifest is invalid, so problems surface at registration time.
 */
/**
 * Code-only additions to manifest actions, for built-in manifests: capability bindings with
 * mapping functions, undo, runtime risk checks. JSON manifests cannot carry functions.
 */
export type ManifestActionExtension = Pick<
  ActionDefinition,
  'capability' | 'undo' | 'assessRisk' | 'risk' | 'rateLimit' | 'tags'
>;

export interface ManifestExtensions {
  actions?: Record<string, ManifestActionExtension>;
}

export function defineManifestConnector(
  input: HttpManifestInput,
  extensions: ManifestExtensions = {},
): ConnectorDefinition {
  const parsed = HttpManifest.safeParse(input);
  if (!parsed.success) {
    const where =
      typeof (input as { id?: unknown })?.id === 'string' ? ` "${(input as { id: string }).id}"` : '';
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`)
      .join('; ');
    throw new ManifestError(`Invalid manifest${where}: ${issues}`);
  }
  const manifest = parsed.data;
  const runtime = new ManifestRuntime(manifest);
  const extra = extensions.actions ?? {};
  for (const name of Object.keys(extra)) {
    if (!manifest.actions.some((a) => a.name === name)) {
      throw new ManifestError(`Extension for unknown action "${manifest.id}.${name}"`);
    }
  }
  const actions = manifest.actions.map((action) => ({
    ...compileAction(runtime, action, manifest.id).definition,
    ...extra[action.name],
  }));
  const credentialsJson = defaultCredentials(manifest);
  const auth = manifest.auth;

  const connector: ConnectorDefinition = {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    ...(manifest.instructions ? { instructions: manifest.instructions } : {}),
    ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
    config: objectSchema(manifest.config, `Config of "${manifest.id}"`),
    credentials: objectSchema(credentialsJson, `Credentials of "${manifest.id}"`),
    ...(auth.type === 'oauth2'
      ? {
          oauth: {
            provider: auth.provider,
            scopes: auth.scopes,
            ...(auth.authorizeParams ? { authorizeParams: auth.authorizeParams } : {}),
            ...(auth.token ? { optional: true } : {}),
          },
        }
      : {}),
    actions,
  };
  if (manifest.test) {
    const test = manifest.test;
    connector.test = async (rawCtx) => {
      const ctx = rawCtx as Ctx;
      const result = await runtime.execute(ctx, test.request, {}, new Set());
      const identity = test.identity ? renderString(test.identity, { response: result.data }) : undefined;
      return {
        ok: true,
        ...(identity !== undefined && identity !== '' ? { identity: String(identity) } : {}),
      };
    };
  }
  return connector;
}
