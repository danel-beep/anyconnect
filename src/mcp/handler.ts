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
import { principalFromAuthInfo } from '../core/auth.js';
import type { Interaction } from '../hub/executor.js';
import type { Hub, ToolCallResult } from '../hub/hub.js';
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

/**
 * The MCP endpoint. A fresh MCP server is built per HTTP request from the caller's workspace
 * catalog, so the protocol layer is stateless: any instance can serve any request, deploys do not
 * break sessions, and newly connected accounts appear on the next `tools/list`.
 *
 * Serves the current protocol revision (2026-07-28) and falls back to stateless serving for
 * 2025-era clients (today's Claude and ChatGPT).
 */
export function createHubMcpHandler(deps: { hub: Hub; logger: Logger; version: string }): McpHttpHandler {
  return createMcpHandler(
    async ({ authInfo }) => {
      const principal = principalFromAuthInfo(authInfo);
      const catalog = await deps.hub.getCatalog(principal);
      const server = new McpServer(
        {
          name: 'anyconnect',
          title: 'AnyConnect',
          version: deps.version,
          description: 'One hub for all your services and accounts.',
        },
        { instructions: catalog.instructions },
      );
      for (const tool of catalog.tools) {
        server.registerTool(
          tool.name,
          {
            title: tool.title,
            description: tool.description,
            inputSchema: inputValidator(tool.inputSchema),
            annotations: tool.annotations,
          },
          async (args, ctx) =>
            toMcpResult(
              await deps.hub.callTool(principal, catalog, tool.name, args ?? {}, {
                signal: ctx.mcpReq.signal,
                interaction: interactionOf(ctx.mcpReq),
              }),
            ),
        );
      }
      return server;
    },
    {
      legacy: 'stateless',
      onerror: (error) => deps.logger.debug({ err: error }, 'mcp request error'),
    },
  );
}
