import { randomBytes } from 'node:crypto';
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

/** `_meta` key set on results that carry third-party content. */
export const UNTRUSTED_META = 'manyplug/untrusted';

export function isUntrusted(result: ToolCallResult): boolean {
  return (result._meta as Record<string, unknown> | undefined)?.[UNTRUSTED_META] === true;
}

/**
 * Wraps text that came from third parties (anything an open-world action returns: emails,
 * messages, web pages) in markers with a random id, so a prompt injection inside the content cannot
 * fake the end of the block. The hub's instructions tell the model to treat marked text as data.
 * `data` stays untouched: it is the value other hub steps (merging, shaping) work on.
 *
 * `structuredContent` is dropped: clients that support it (Claude among them) show the model the
 * structured value instead of the text, which would bypass the markers. Hub tools declare no
 * `outputSchema`, so the marked text is the complete result (MCP: the JSON goes in a text block).
 */
export function markUntrusted<T extends ToolCallResult>(result: T, source: string): T {
  if (result.isError || result.content.length === 0) return result;
  const id = randomBytes(4).toString('hex');
  const label = source.replace(/[⟦⟧\n]/g, ' ');
  const { structuredContent: _structured, ...rest } = result;
  return {
    ...(rest as T),
    content: result.content.map((block) =>
      block.type === 'text'
        ? {
            type: 'text' as const,
            text: `⟦untrusted ${id} source="${label}"⟧\n${block.text}\n⟦/untrusted ${id}⟧`,
          }
        : block,
    ),
    _meta: { ...((result._meta as Record<string, unknown> | undefined) ?? {}), [UNTRUSTED_META]: true },
  };
}

/** A result built from several unit results stays marked when any of them carried third-party content. */
export function carryUntrusted<T extends ToolCallResult>(
  result: T,
  parts: ToolCallResult[],
  source: string,
): T {
  return parts.some(isUntrusted) ? markUntrusted(result, source) : result;
}
