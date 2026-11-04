import type { CatalogTool, ToolAnnotations } from './catalog-types.js';

/** The hub's own tools. Their names start with `anyconnect_`, which no connector can use. */
export const BUILTIN_PREFIX = 'anyconnect_';

export type BuiltinToolId = 'list_accounts' | 'search_tools' | 'describe_tool' | 'call_tool' | 'call_tools';

/** Most calls one `call_tools` batch may contain. */
export const MAX_BATCH_CALLS = 10;

const readOnly = (title: string): ToolAnnotations => ({
  title,
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
});

/** Tools that run other tools: their annotations must not promise anything about the inner calls. */
const dispatcher = (title: string): ToolAnnotations => ({
  title,
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
});

export const BUILTIN_TOOLS: Record<BuiltinToolId, CatalogTool> = {
  list_accounts: {
    name: `${BUILTIN_PREFIX}list_accounts`,
    title: 'List connected services and accounts',
    description:
      'Lists every connected service with its accounts (name, label, identity, status) and its tools. Call it to find out what is connected or which account to use.',
    inputSchema: {
      type: 'object',
      properties: { service: { type: 'string', description: 'Only this service (its id, e.g. "gmail")' } },
    },
    annotations: readOnly('List connected services and accounts'),
    target: { kind: 'builtin', id: 'list_accounts' },
    risk: 'read',
  },
  search_tools: {
    name: `${BUILTIN_PREFIX}search_tools`,
    title: 'Find tools',
    description:
      'Finds tools of the connected services for a task, e.g. "send telegram message" or "unpaid invoices stripe". Returns the best matches with their input schemas, so you can usually call one right away with anyconnect_call_tool.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to do, in a few words' },
        service: { type: 'string', description: 'Only tools of this service id' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 5' },
      },
      required: ['query'],
    },
    annotations: readOnly('Find tools'),
    target: { kind: 'builtin', id: 'search_tools' },
    risk: 'read',
  },
  describe_tool: {
    name: `${BUILTIN_PREFIX}describe_tool`,
    title: 'Describe a tool',
    description:
      'Returns the full description and input schema of tools by name (found with anyconnect_search_tools).',
    inputSchema: {
      type: 'object',
      properties: { names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 } },
      required: ['names'],
    },
    annotations: readOnly('Describe a tool'),
    target: { kind: 'builtin', id: 'describe_tool' },
    risk: 'read',
  },
  call_tool: {
    name: `${BUILTIN_PREFIX}call_tool`,
    title: 'Call a tool',
    description:
      'Calls any tool of the connected services by name (found with anyconnect_search_tools) with its arguments.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name' },
        arguments: { type: 'object', description: 'Arguments matching the tool input schema' },
      },
      required: ['name'],
    },
    annotations: dispatcher('Call a tool'),
    target: { kind: 'builtin', id: 'call_tool' },
    risk: 'read',
  },
  call_tools: {
    name: `${BUILTIN_PREFIX}call_tools`,
    title: 'Call several tools at once',
    description: `Runs up to ${MAX_BATCH_CALLS} independent tool calls in parallel and returns all results in order. Use it instead of several separate calls when no call needs another one's result.`,
    inputSchema: {
      type: 'object',
      properties: {
        calls: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_BATCH_CALLS,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Tool name' },
              arguments: { type: 'object' },
            },
            required: ['name'],
          },
        },
      },
      required: ['calls'],
    },
    annotations: dispatcher('Call several tools at once'),
    target: { kind: 'builtin', id: 'call_tools' },
    risk: 'read',
  },
};
