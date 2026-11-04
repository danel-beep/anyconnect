import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { ACCOUNT_ARGUMENT } from '../registry.js';
import {
  type AccountContext,
  type ActionDefinition,
  type ActionHints,
  type ConnectorDefinition,
  ConnectorError,
  type ContentBlock,
  type FetchLike,
  type JsonSchema,
  type OAuthProviderSpec,
  rawResult,
} from '../sdk.js';

/**
 * A remote MCP server (Notion, Linear, Zapier, Composio, another AnyConnect hub...) as a regular
 * hub service: each account is one login to the server, every remote tool becomes an action, and
 * calls go through the hub's routing, policies and audit like any other connector.
 *
 * The tool list is fetched by the hub (`listRemoteTools`) and passed in, so building the connector
 * is synchronous and the catalog never waits on the remote server.
 */

export interface RemoteMcpTool {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema: JsonSchema;
  annotations?:
    | {
        title?: string | undefined;
        readOnlyHint?: boolean | undefined;
        destructiveHint?: boolean | undefined;
        idempotentHint?: boolean | undefined;
        openWorldHint?: boolean | undefined;
      }
    | undefined;
}

export type RemoteMcpAuth =
  | { type: 'none' }
  /** `Authorization: Bearer <credentials.token>` (API keys, personal tokens). */
  | { type: 'bearer' }
  /** A custom header carrying `credentials.token`, e.g. `X-API-Key`. */
  | { type: 'header'; name: string }
  /** MCP authorization: OAuth 2.1 with the server's authorization server (discovered). */
  | { type: 'oauth2'; provider: OAuthProviderSpec; scopes: string[] };

export interface RemoteMcpSpec {
  id: string;
  name: string;
  description: string;
  version?: string;
  instructions?: string;
  /** The server's MCP endpoint (Streamable HTTP). */
  url: string;
  auth: RemoteMcpAuth;
  tools: RemoteMcpTool[];
}

/** The hub's own name when it talks to remote servers. */
const CLIENT_INFO = { name: 'AnyConnect', version: '1.0.0' };
/** Remote argument names the hub reserves get this suffix (and are renamed back on the call). */
const RENAMED_SUFFIX = '_arg';
const ACTION_NAME_MAX = 40;

type Ctx = Pick<
  AccountContext<unknown, Record<string, unknown>>,
  'fetch' | 'signal' | 'oauth' | 'credentials'
>;

/** Maps remote tool names (any characters) to unique snake_case action names. */
export function actionNamesFor(tools: RemoteMcpTool[]): Map<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const tool of tools) {
    let base = tool.name
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    if (!/^[a-z]/.test(base)) base = `t_${base}`;
    base = base.slice(0, ACTION_NAME_MAX).replace(/_$/, '') || 'tool';
    let name = base;
    for (let i = 2; used.has(name); i++)
      name = `${base.slice(0, ACTION_NAME_MAX - String(i).length - 1)}_${i}`;
    used.add(name);
    names.set(tool.name, name);
  }
  return names;
}

function hintsFor(tool: RemoteMcpTool): ActionHints {
  const a = tool.annotations ?? {};
  return {
    ...(a.readOnlyHint !== undefined ? { readOnly: a.readOnlyHint } : {}),
    ...(a.destructiveHint !== undefined ? { destructive: a.destructiveHint } : {}),
    ...(a.idempotentHint !== undefined ? { idempotent: a.idempotentHint } : {}),
    ...(a.openWorldHint !== undefined ? { openWorld: a.openWorldHint } : {}),
  };
}

/** Renames properties the hub reserves (the `account` selector) so remote schemas never clash. */
function adaptSchema(schema: JsonSchema): { schema: JsonSchema; renames: Map<string, string> } {
  const renames = new Map<string, string>();
  const properties: Record<string, unknown> = {};
  // Rebuilt key by key so the renamed property keeps its place in the schema.
  for (const [key, value] of Object.entries((schema.properties ?? {}) as Record<string, unknown>)) {
    if (key === ACCOUNT_ARGUMENT) {
      const local = `${ACCOUNT_ARGUMENT}${RENAMED_SUFFIX}`;
      properties[local] = value;
      renames.set(local, ACCOUNT_ARGUMENT);
    } else {
      properties[key] = value;
    }
  }
  const required = Array.isArray(schema.required)
    ? (schema.required as string[]).map((r) =>
        r === ACCOUNT_ARGUMENT ? `${ACCOUNT_ARGUMENT}${RENAMED_SUFFIX}` : r,
      )
    : undefined;
  return { schema: { ...schema, type: 'object', properties, ...(required ? { required } : {}) }, renames };
}

function authHeaders(auth: RemoteMcpAuth, ctx: Ctx): Record<string, string> {
  const token = typeof ctx.credentials?.token === 'string' ? ctx.credentials.token : undefined;
  switch (auth.type) {
    case 'none':
      return {};
    case 'bearer':
      if (!token) throw new ConnectorError('auth', 'No access token is set for this account');
      return { authorization: `Bearer ${token}` };
    case 'header':
      if (!token) throw new ConnectorError('auth', 'No access token is set for this account');
      return { [auth.name]: token };
    case 'oauth2':
      if (!ctx.oauth) throw new ConnectorError('auth', 'The account is not connected yet');
      return { authorization: `Bearer ${ctx.oauth.accessToken}` };
  }
}

function isUnauthorized(error: unknown): boolean {
  const e = error as { name?: string; code?: unknown; status?: number; data?: { status?: number } };
  return (
    e?.name === 'UnauthorizedError' ||
    e?.status === 401 ||
    e?.data?.status === 401 ||
    /\b401\b|unauthori[sz]ed/i.test(String((error as Error)?.message ?? ''))
  );
}

/** Opens a short-lived client session to the server, runs `use`, and closes it. */
async function withClient<T>(
  url: string,
  auth: RemoteMcpAuth,
  ctx: Ctx,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  let refreshed = false;
  for (;;) {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: ctx.fetch as FetchLike as never,
      requestInit: { headers: authHeaders(auth, ctx) },
    });
    const client = new Client(CLIENT_INFO, { versionNegotiation: { mode: 'auto' } } as never);
    try {
      await client.connect(transport, { signal: ctx.signal } as never);
      return await use(client);
    } catch (error) {
      if (ctx.signal.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : error;
      if (error instanceof ConnectorError) throw error;
      if (isUnauthorized(error)) {
        if (auth.type === 'oauth2' && ctx.oauth && !refreshed) {
          refreshed = true;
          await ctx.oauth.refresh();
          continue;
        }
        throw new ConnectorError('auth', 'The MCP server rejected the credentials of this account', {
          cause: error,
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ConnectorError('upstream', `The MCP server failed: ${message.slice(0, 300)}`, {
        cause: error,
      });
    } finally {
      await client.close().catch(() => {});
    }
  }
}

/** Fetches the full tool list of a remote server (all pages). */
export async function listRemoteTools(url: string, auth: RemoteMcpAuth, ctx: Ctx): Promise<RemoteMcpTool[]> {
  return withClient(url, auth, ctx, async (client) => {
    const tools: RemoteMcpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await client.listTools(cursor ? { cursor } : {});
      for (const tool of result.tools) {
        tools.push({
          name: tool.name,
          ...(tool.title ? { title: tool.title } : {}),
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema as JsonSchema,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        });
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  });
}

const SUPPORTED_BLOCKS = new Set(['text', 'image', 'audio', 'resource_link']);

function toContent(blocks: unknown[]): ContentBlock[] {
  return blocks.map((block) => {
    const b = block as { type?: string; resource?: { uri?: string; text?: string; mimeType?: string } };
    if (b.type && SUPPORTED_BLOCKS.has(b.type)) return block as ContentBlock;
    if (b.type === 'resource' && typeof b.resource?.text === 'string')
      return { type: 'text', text: b.resource.text };
    return { type: 'text', text: JSON.stringify(block) };
  });
}

export function defineRemoteMcpConnector(spec: RemoteMcpSpec): ConnectorDefinition {
  const names = actionNamesFor(spec.tools);
  const actions: ActionDefinition[] = spec.tools.map((tool) => {
    const { schema, renames } = adaptSchema(tool.inputSchema ?? { type: 'object' });
    return {
      name: names.get(tool.name)!,
      ...(tool.title || tool.annotations?.title ? { title: tool.title ?? tool.annotations?.title } : {}),
      description: tool.description?.trim() || `Runs "${tool.name}" on ${spec.name}.`,
      // The remote server validates arguments; the hub only shows its schema to the AI.
      input: z.object({}).loose(),
      inputSchema: schema,
      hints: hintsFor(tool),
      async run(input, rawCtx) {
        const ctx = rawCtx as unknown as Ctx;
        const args: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
          args[renames.get(key) ?? key] = value;
        }
        const result = await withClient(spec.url, spec.auth, ctx, (client) =>
          client.callTool({ name: tool.name, arguments: args }, { signal: ctx.signal } as never),
        );
        const content = Array.isArray(result.content) ? toContent(result.content) : [];
        return rawResult({
          content: content.length ? content : [{ type: 'text', text: 'Done.' }],
          ...(result.structuredContent
            ? { structuredContent: result.structuredContent as Record<string, unknown> }
            : {}),
          ...(result.isError ? { isError: true } : {}),
        });
      },
    };
  });

  const usesToken = spec.auth.type === 'bearer' || spec.auth.type === 'header';
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    version: spec.version ?? '1.0.0',
    ...(spec.instructions ? { instructions: spec.instructions } : {}),
    homepage: new URL(spec.url).origin,
    config: z.object({}),
    credentials: usesToken
      ? z.object({ token: z.string().min(1).describe(`${spec.name} access token or API key`) })
      : z.object({}),
    ...(spec.auth.type === 'oauth2'
      ? { oauth: { provider: spec.auth.provider, scopes: spec.auth.scopes } }
      : {}),
    actions,
    async test(rawCtx) {
      const tools = await listRemoteTools(spec.url, spec.auth, rawCtx as unknown as Ctx);
      return { ok: true, message: `${tools.length} tools available` };
    },
  };
}
