import { type ContentBlock, type ErrorKind, isRawResult } from '../connectors/sdk.js';

/**
 * A question the hub needs the user to answer before the call can continue (e.g. "Send this
 * email?"). Transports that can ask in the chat (MCP elicitation) do so and retry the call with
 * the answer in `Interaction.answers[key]` and `state` echoed back; others show `content`.
 */
export interface HubQuestion {
  key: string;
  message: string;
  /** Flat JSON Schema of the answer form (MCP elicitation restricted schema). */
  schema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required?: string[] };
  /** Opaque, integrity-protected state the transport echoes back with the answer. */
  state: string;
}

/** Result in MCP CallToolResult shape (kept local so the hub core does not depend on the MCP SDK). */
export interface ToolCallResult {
  [key: string]: unknown;
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  /** Set when the call waits for the user's answer in the chat; see {@link HubQuestion}. */
  question?: HubQuestion;
}

export type ExecErrorKind = ErrorKind | 'timeout' | 'cancelled' | 'internal' | 'hub';

/**
 * What executor stages pass around: a tool result plus internal details that never leave the hub
 * (`toTransport` strips them): the JSON value before serialization and the error classification.
 */
export interface ExecResult extends ToolCallResult {
  /** The action's value (JSON-serializable), when it returned one; `shape` works on it. */
  data?: unknown;
  error?: { kind: ExecErrorKind; retryAfterSeconds?: number };
}

export function errorResult(
  message: string,
  kind: ExecErrorKind = 'hub',
  retryAfterSeconds?: number,
): ExecResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
    error: { kind, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
  };
}

/** Compact JSON: pretty-printing costs ~25% more tokens and models read compact JSON just as well. */
export function serialize(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null');
}

/** Turns a JSON value into a result whose text and structured content agree. */
export function dataResult(data: unknown): ExecResult {
  if (data === undefined) return { content: [{ type: 'text', text: 'Done.' }] };
  const structured =
    typeof data === 'object' && data !== null && !Array.isArray(data)
      ? { structuredContent: data as Record<string, unknown> }
      : {};
  return { content: [{ type: 'text', text: serialize(data) }], ...structured, data };
}

export function normalizeResult(value: unknown): ExecResult {
  if (isRawResult(value)) {
    const { content, structuredContent, isError } = value;
    return { content, ...(structuredContent ? { structuredContent } : {}), ...(isError ? { isError } : {}) };
  }
  return dataResult(value);
}

export function resultText(result: ToolCallResult): string {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');
}

/** Strips executor internals before a result leaves the hub. */
export function toTransport(result: ExecResult): ToolCallResult {
  const { data: _data, error: _error, ...rest } = result;
  return rest;
}
