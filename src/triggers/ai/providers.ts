import { BRAND } from '../../brand.js';
import type { FetchLike, JsonSchema } from '../../connectors/sdk.js';
import type { AiProviderId } from '../../db/schema.js';

/**
 * The AI APIs a trigger can wake with the user's own key. Each provider turns one step of the
 * conversation (system prompt, messages, tools) into its HTTP request and its answer back into
 * text and tool calls. All traffic goes through the hub's network policy (`fetch`), and the key is
 * only ever sent to the provider's own host. A new provider is one more entry in {@link AI_PROVIDERS}.
 */

export interface AiTool {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface AiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AiMessage =
  | { role: 'user'; text: string }
  /** `raw` is the provider's own content, sent back unchanged (Anthropic thinking blocks must be). */
  | { role: 'assistant'; text: string; toolCalls: AiToolCall[]; raw: unknown }
  | { role: 'tool'; results: Array<{ id: string; name: string; content: string; isError: boolean }> };

export interface AiStep {
  text: string;
  toolCalls: AiToolCall[];
  raw: unknown;
  usage: { input: number; output: number };
  /** The provider declined (safety); nothing more will come. */
  refused?: boolean;
}

export interface AiRequest {
  key: string;
  model: string;
  system: string;
  messages: AiMessage[];
  tools: AiTool[];
  maxTokens: number;
  signal: AbortSignal;
}

export interface AiProvider {
  id: AiProviderId;
  name: string;
  /** A small, fast model: triggers fire often, the user can pick any model of their key. */
  defaultModel: string;
  /** Where the user creates a key. */
  keysUrl: string;
  step(request: AiRequest, fetch: FetchLike): Promise<AiStep>;
}

/** Claude models that accept `output_config.effort` (Opus 4.5 and later, Sonnet 4.6, every 5.x model). */
export const takesEffort = (model: string) =>
  /^claude-(?:(?:opus|sonnet|haiku|fable)-[5-9]|opus-4-[5-9]|sonnet-4-6)/.test(model);

/** A provider's answer that is not a success, with the provider's own words when it gave any. */
export class AiProviderError extends Error {
  constructor(
    message: string,
    /** 401/403: the key is wrong or revoked; the user has to change it. */
    readonly keyProblem = false,
  ) {
    super(message);
  }
}

async function post(
  fetch: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  provider: string,
): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!response.ok) {
    const detail = String(json?.error?.message ?? json?.message ?? '').slice(0, 300);
    throw new AiProviderError(
      `${provider} answered ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status === 401 || response.status === 403,
    );
  }
  return json;
}

const parseArguments = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

/** OpenAI's Chat Completions shape, which OpenRouter speaks too. */
function chatCompletions(options: {
  id: AiProviderId;
  name: string;
  url: string;
  defaultModel: string;
  keysUrl: string;
  headers?: Record<string, string>;
  /** OpenAI's current models take `max_completion_tokens`; OpenRouter maps `max_tokens`. */
  maxTokensField: 'max_completion_tokens' | 'max_tokens';
}): AiProvider {
  return {
    id: options.id,
    name: options.name,
    defaultModel: options.defaultModel,
    keysUrl: options.keysUrl,
    async step(request, fetch) {
      const messages: unknown[] = [{ role: 'system', content: request.system }];
      for (const m of request.messages) {
        if (m.role === 'user') messages.push({ role: 'user', content: m.text });
        else if (m.role === 'assistant') messages.push(m.raw);
        else
          for (const r of m.results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }
      const json = await post(
        fetch,
        options.url,
        { authorization: `Bearer ${request.key}`, ...options.headers },
        {
          model: request.model,
          messages,
          ...(request.tools.length
            ? {
                tools: request.tools.map((t) => ({
                  type: 'function',
                  function: { name: t.name, description: t.description, parameters: t.parameters },
                })),
              }
            : {}),
          [options.maxTokensField]: request.maxTokens,
        },
        request.signal,
        options.name,
      );
      const message = json?.choices?.[0]?.message ?? {};
      const toolCalls: AiToolCall[] = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
        .filter((c: any) => c?.function?.name)
        .map((c: any) => ({
          id: String(c.id ?? ''),
          name: String(c.function.name),
          arguments: parseArguments(c.function.arguments),
        }));
      return {
        text: typeof message.content === 'string' ? message.content : '',
        toolCalls,
        raw: {
          role: 'assistant',
          content: typeof message.content === 'string' ? message.content : null,
          ...(Array.isArray(message.tool_calls) && message.tool_calls.length
            ? { tool_calls: message.tool_calls }
            : {}),
        },
        usage: {
          input: Number(json?.usage?.prompt_tokens ?? 0),
          output: Number(json?.usage?.completion_tokens ?? 0),
        },
        ...(message.refusal ? { refused: true } : {}),
      };
    },
  };
}

const anthropic: AiProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  defaultModel: 'claude-haiku-5-5',
  keysUrl: 'https://console.anthropic.com/settings/keys',
  async step(request, fetch) {
    const messages: unknown[] = [];
    for (const m of request.messages) {
      if (m.role === 'user') messages.push({ role: 'user', content: m.text });
      else if (m.role === 'assistant') messages.push({ role: 'assistant', content: m.raw });
      else
        messages.push({
          role: 'user',
          content: m.results.map((r) => ({
            type: 'tool_result',
            tool_use_id: r.id,
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          })),
        });
    }
    const json = await post(
      fetch,
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': request.key, 'anthropic-version': '2023-06-01' },
      {
        model: request.model,
        max_tokens: request.maxTokens,
        // The rule's prompt and tools are the same on every wake: cached, they cost a tenth.
        system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
        ...(request.tools.length
          ? {
              tools: request.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              })),
            }
          : {}),
        // Reacting to one message is routine work: low effort keeps each wake cheap (older models
        // reject the parameter, so it is sent only to those that take it).
        ...(takesEffort(request.model) ? { output_config: { effort: 'low' } } : {}),
        messages,
      },
      request.signal,
      'Anthropic',
    );
    const content: any[] = Array.isArray(json?.content) ? json.content : [];
    return {
      text: content
        .filter((b) => b?.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join('\n'),
      toolCalls: content
        .filter((b) => b?.type === 'tool_use')
        .map((b) => ({ id: String(b.id), name: String(b.name), arguments: parseArguments(b.input) })),
      raw: content,
      usage: {
        input:
          Number(json?.usage?.input_tokens ?? 0) +
          Number(json?.usage?.cache_read_input_tokens ?? 0) +
          Number(json?.usage?.cache_creation_input_tokens ?? 0),
        output: Number(json?.usage?.output_tokens ?? 0),
      },
      ...(json?.stop_reason === 'refusal' ? { refused: true } : {}),
    };
  },
};

export const AI_PROVIDERS: Record<AiProviderId, AiProvider> = {
  openai: chatCompletions({
    id: 'openai',
    name: 'OpenAI',
    url: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-5-mini',
    keysUrl: 'https://platform.openai.com/api-keys',
    maxTokensField: 'max_completion_tokens',
  }),
  anthropic,
  openrouter: chatCompletions({
    id: 'openrouter',
    name: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'openai/gpt-5-mini',
    keysUrl: 'https://openrouter.ai/keys',
    headers: { 'x-title': BRAND.name },
    maxTokensField: 'max_tokens',
  }),
};

export const AI_PROVIDER_IDS = Object.keys(AI_PROVIDERS) as AiProviderId[];
