import {
  createMcpHandler,
  fromJsonSchema,
  type McpHttpHandler,
  McpServer,
} from '@modelcontextprotocol/server';
import { principalFromAuthInfo } from '../core/auth.js';
import type { Hub } from '../hub/hub.js';
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
      for (const tool of catalog.listed) {
        server.registerTool(
          tool.name,
          {
            title: tool.title,
            description: tool.description,
            inputSchema: inputValidator(tool.inputSchema),
            annotations: tool.annotations,
          },
          (args, ctx) =>
            deps.hub.callTool(principal, catalog, tool.name, args ?? {}, { signal: ctx.mcpReq.signal }),
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
