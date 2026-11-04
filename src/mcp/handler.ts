import {
  CLIENT_CAPABILITIES_META_KEY,
  createMcpHandler,
  type ElicitRequestFormParams,
  fromJsonSchema,
  inputRequired,
  type McpHttpHandler,
  McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { BRAND } from '../brand.js';
import type { ConnectorDefinition } from '../connectors/sdk.js';
import { principalFromAuthInfo } from '../core/auth.js';
import { aiSubjectFromMeta } from '../core/principal.js';
import type { WorkspaceAdmin } from '../core/workspace-admin.js';
import type { CatalogTool } from '../hub/catalog-types.js';
import type { Interaction } from '../hub/executor.js';
import type { Hub, ToolCallResult } from '../hub/hub.js';
import { buildVisitorCatalog, callVisitorTool } from '../hub/visitor.js';
import type { Logger } from '../logger.js';

type InputValidator = ReturnType<typeof fromJsonSchema<Record<string, unknown>>>;

const VALIDATOR_CACHE_LIMIT = 2000;
const validators = new Map<string, InputValidator>();

/**
 * `fromJsonSchema` compiles a JSON Schema validator up front. The MCP server is rebuilt on every
 * request, so compiled validators are cached by schema text (most recently used kept last).
 */
function inputValidator(schema: Record<string, unknown>): InputValidator {
  const key = JSON.stringify(schema);
  let validator = validators.get(key);
  if (validator) {
    validators.delete(key);
  } else {
    validator = fromJsonSchema<Record<string, unknown>>(schema);
    if (validators.size >= VALIDATOR_CACHE_LIMIT) {
      const oldest = validators.keys().next().value;
      if (oldest !== undefined) validators.delete(oldest);
    }
  }
  validators.set(key, validator);
  return validator;
}

/**
 * What the client can be asked during this call and what it answered. Only 2026-07-28 clients that
 * declare elicitation can be asked in the chat (multi round-trip); 2025-era stateless clients
 * cannot, and the hub falls back to Telegram or the web page.
 */
export function interactionOf(mcpReq: ServerContext['mcpReq']): Interaction {
  const envelope = mcpReq.envelope as Record<string, unknown> | undefined;
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] as { elicitation?: unknown } | undefined;
  const state = mcpReq.requestState();
  return {
    answers: mcpReq.inputResponses ?? {},
    ...(typeof state === 'string' ? { state } : {}),
    canAsk: Boolean(capabilities?.elicitation),
  };
}

/** A hub question becomes an MCP input-required result (elicitation); anything else passes through. */
export function toMcpResult(result: ToolCallResult) {
  const { question, ...rest } = result;
  if (!question) return rest;
  return inputRequired({
    inputRequests: {
      [question.key]: inputRequired.elicit({
        message: question.message,
        // The hub builds only flat primitive forms, which is what MCP elicitation allows.
        requestedSchema: question.schema as ElicitRequestFormParams['requestedSchema'],
      }),
    },
    requestState: question.state,
  });
}

type ToolCaller = (
  tool: CatalogTool,
  args: Record<string, unknown>,
  mcpReq: ServerContext['mcpReq'],
) => Promise<ToolCallResult>;

const SERVER_INFO = {
  name: BRAND.slug,
  title: BRAND.name,
  description: 'One hub for all your services and accounts.',
};

/** One MCP server for one request: the given tools, each answered by `call`. */
function buildServer(
  version: string,
  view: { instructions: string; tools: CatalogTool[] },
  call: ToolCaller,
): McpServer {
  const server = new McpServer({ ...SERVER_INFO, version }, { instructions: view.instructions });
  for (const tool of view.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: inputValidator(tool.inputSchema),
        annotations: tool.annotations,
      },
      async (args, ctx) => toMcpResult(await call(tool, args ?? {}, ctx.mcpReq)),
    );
  }
  return server;
}

const handlerOptions = (logger: Logger) => ({
  legacy: 'stateless' as const,
  onerror: (error: unknown) => logger.debug({ err: error }, 'mcp request error'),
});

/**
 * The MCP endpoint. A fresh MCP server is built per HTTP request from the caller's workspace
 * catalog, so the protocol layer is stateless: any instance can serve any request, deploys do not
 * break sessions, and newly connected accounts appear on the next `tools/list`.
 *
 * Serves the current protocol revision (2026-07-28) and falls back to stateless serving for
 * 2025-era clients (today's Claude and ChatGPT).
 */
export function createHubMcpHandler(deps: { hub: Hub; logger: Logger; version: string }): McpHttpHandler {
  return createMcpHandler(async ({ authInfo }) => {
    const principal = principalFromAuthInfo(authInfo);
    const catalog = await deps.hub.getCatalog(principal);
    const view = { instructions: catalog.instructions, tools: catalog.listed };
    return buildServer(deps.version, view, (tool, args, mcpReq) => {
      const aiSubject = aiSubjectFromMeta(mcpReq._meta as Record<string, unknown> | undefined);
      const caller = aiSubject ? { ...principal, aiSubject } : principal;
      return deps.hub.callTool(caller, catalog, tool.name, args, {
        signal: mcpReq.signal,
        interaction: interactionOf(mcpReq),
      });
    });
  }, handlerOptions(deps.logger));
}

/**
 * The MCP endpoint for an app that has not signed in yet (see `hub/visitor.ts`). The route lets
 * only visitor-callable tool calls through; the rest get a 401 that starts the app's sign-in.
 */
export function createVisitorMcpHandler(deps: {
  admin: WorkspaceAdmin;
  setup: ConnectorDefinition;
  logger: Logger;
  version: string;
}): McpHttpHandler {
  const view = buildVisitorCatalog(deps.setup);
  return createMcpHandler(
    async () => buildServer(deps.version, view, (tool, args) => callVisitorTool(deps.admin, tool.name, args)),
    handlerOptions(deps.logger),
  );
}
