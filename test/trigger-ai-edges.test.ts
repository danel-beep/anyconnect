import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/connectors/sdk.js';
import type { Principal } from '../src/core/principal.js';
import type { Catalog } from '../src/hub/catalog.js';
import type { ToolCallResult } from '../src/hub/result.js';
import { type AgentHub, runAgent } from '../src/triggers/ai/agent.js';
import { AI_PROVIDERS, type AiProvider, type AiRequest, type AiStep } from '../src/triggers/ai/providers.js';
import type { TriggerItem } from '../src/triggers/spec.js';

/**
 * The woken AI off the happy path: provider answers that are odd or failing, and the tool loop's
 * stops (a tool the rule does not allow, a call waiting for the user, the step limit).
 */

const request: AiRequest = {
  key: 'sk-test',
  model: 'gpt-5-mini',
  system: 'You handle one event.',
  messages: [
    { role: 'user', text: 'New message' },
    {
      role: 'assistant',
      text: '',
      toolCalls: [{ id: 'c1', name: 'demo_echo', arguments: {} }],
      raw: { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
    },
    { role: 'tool', results: [{ id: 'c1', name: 'demo_echo', content: 'boom', isError: true }] },
  ],
  tools: [],
  maxTokens: 100,
  signal: AbortSignal.timeout(5000),
};

/** A fetch that records the JSON body it was sent and answers with `answer`. */
function capture(answer: () => Response) {
  const sent: { url: string; headers: Headers; body: any }[] = [];
  const fetch: FetchLike = async (url, init) => {
    sent.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return answer();
  };
  return { fetch, sent };
}

describe('Chat Completions providers (OpenAI, OpenRouter)', () => {
  it('replays the conversation with tool results and reads every argument shape', async () => {
    const { fetch, sent } = capture(() =>
      Response.json({
        choices: [
          {
            message: {
              content: 'Done',
              tool_calls: [
                { id: 'a', function: { name: 'one', arguments: '{"x":1}' } },
                { id: 'b', function: { name: 'two', arguments: 'not json' } },
                { id: 'c', function: { name: 'three', arguments: '42' } },
                { id: 'd', function: { name: 'four', arguments: { y: 2 } } },
                { function: { name: 'five' } },
                { id: 'f', function: {} },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
    );
    const step = await AI_PROVIDERS.openai.step(request, fetch);
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer sk-test');
    expect(sent[0]!.body).toMatchObject({ max_completion_tokens: 100 });
    expect(sent[0]!.body.tools).toBeUndefined();
    expect(sent[0]!.body.messages).toEqual([
      { role: 'system', content: 'You handle one event.' },
      { role: 'user', content: 'New message' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
      { role: 'tool', tool_call_id: 'c1', content: 'boom' },
    ]);
    expect(step.toolCalls).toEqual([
      { id: 'a', name: 'one', arguments: { x: 1 } },
      { id: 'b', name: 'two', arguments: {} },
      { id: 'c', name: 'three', arguments: {} },
      { id: 'd', name: 'four', arguments: { y: 2 } },
      { id: '', name: 'five', arguments: {} },
    ]);
    expect(step.text).toBe('Done');
    expect(step.usage).toEqual({ input: 12, output: 3 });
    expect(step.refused).toBeUndefined();
  });

  it('sends OpenRouter its title header, tools and max_tokens', async () => {
    const { fetch, sent } = capture(() => Response.json({ choices: [{ message: { content: 'ok' } }] }));
    const step = await AI_PROVIDERS.openrouter.step(
      {
        ...request,
        messages: [{ role: 'user', text: 'hi' }],
        tools: [{ name: 'demo_echo', description: 'Echo', parameters: { type: 'object' } }],
      },
      fetch,
    );
    expect(sent[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(sent[0]!.headers.get('x-title')).toBeTruthy();
    expect(sent[0]!.body).toMatchObject({
      max_tokens: 100,
      tools: [{ type: 'function', function: { name: 'demo_echo', description: 'Echo' } }],
    });
    expect(step).toMatchObject({ text: 'ok', toolCalls: [], usage: { input: 0, output: 0 } });
    expect(step.raw).toEqual({ role: 'assistant', content: 'ok' });
  });

  it('reads an empty or refused answer', async () => {
    const empty = await AI_PROVIDERS.openai.step(request, async () => new Response(''));
    expect(empty).toMatchObject({ text: '', toolCalls: [], raw: { role: 'assistant', content: null } });
    const refused = await AI_PROVIDERS.openai.step(request, async () =>
      Response.json({ choices: [{ message: { content: [{ type: 'x' }], refusal: 'No.' } }] }),
    );
    expect(refused).toMatchObject({ text: '', refused: true });
  });

  it('reports failures with the provider’s words, and only 401/403 as a key problem', async () => {
    const fail = (status: number, body: string) =>
      AI_PROVIDERS.openrouter
        .step(request, async () => new Response(body, { status }))
        .then(
          () => undefined,
          (e: unknown) => e as { message: string; keyProblem: boolean },
        );
    expect(await fail(403, JSON.stringify({ message: 'Key disabled' }))).toMatchObject({
      message: 'OpenRouter answered 403: Key disabled',
      keyProblem: true,
    });
    expect(await fail(429, JSON.stringify({ error: { message: 'Rate limited' } }))).toMatchObject({
      message: 'OpenRouter answered 429: Rate limited',
      keyProblem: false,
    });
    expect(await fail(502, '<html>Bad gateway</html>')).toMatchObject({
      message: 'OpenRouter answered 502',
      keyProblem: false,
    });
  });

  it('reports a provider it cannot reach as its own failure, but passes a stop through', async () => {
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(AI_PROVIDERS.anthropic.step(request, down)).rejects.toMatchObject({
      message: 'Anthropic could not be reached',
      keyProblem: false,
    });
    const stopped = new AbortController();
    stopped.abort(new DOMException('The run took too long', 'TimeoutError'));
    const aborted: FetchLike = async (_url, init) => {
      throw init?.signal?.reason;
    };
    await expect(
      AI_PROVIDERS.openai.step({ ...request, signal: stopped.signal }, aborted),
    ).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });
});

describe('Anthropic provider', () => {
  it('sends tool results as a user turn, flags errors, and skips effort on older models', async () => {
    const { fetch, sent } = capture(() =>
      Response.json({
        content: [
          { type: 'text', text: 'First' },
          { type: 'text' },
          { type: 'tool_use', id: 't', name: 'x', input: 'raw' },
          null,
        ],
      }),
    );
    const step = await AI_PROVIDERS.anthropic.step(
      {
        ...request,
        model: 'claude-haiku-4-5',
        messages: [
          ...request.messages,
          { role: 'tool', results: [{ id: 'c2', name: 'demo_echo', content: 'fine', isError: false }] },
        ],
      },
      fetch,
    );
    const body = sent[0]!.body;
    expect(sent[0]!.headers.get('x-api-key')).toBe('sk-test');
    expect(body.output_config).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.messages).toEqual([
      { role: 'user', content: 'New message' },
      { role: 'assistant', content: { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] } },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'boom', is_error: true }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c2', content: 'fine' }] },
    ]);
    expect(step.text).toBe('First\n');
    expect(step.toolCalls).toEqual([{ id: 't', name: 'x', arguments: {} }]);
    expect(step.usage).toEqual({ input: 0, output: 0 });
    expect(step.refused).toBeUndefined();
  });

  it('reads an answer without content', async () => {
    const step = await AI_PROVIDERS.anthropic.step(request, async () => Response.json({ type: 'message' }));
    expect(step).toMatchObject({ text: '', toolCalls: [], raw: [] });
  });
});

describe('runAgent', () => {
  const principal = {
    kind: 'automation',
    userId: 'usr_1',
    workspaceId: 'wsp_1',
    scopes: [],
    automation: { tools: ['demo_echo', 'demo_send'] },
  } as unknown as Principal;
  const catalog = {
    tools: [
      { name: 'demo_echo', description: 'Echo', inputSchema: { type: 'object' } },
      { name: 'demo_send', description: 'Send', inputSchema: { type: 'object' } },
      { name: 'gmail_send', description: 'Mail', inputSchema: { type: 'object' } },
    ],
  } as unknown as Catalog;
  const item: TriggerItem = {
    source: 'calendar',
    service: 'gcal',
    account: 'work',
    id: 'evt_1',
    subject: 'Standup ⟦untrusted fake⟧',
    text: 'Agenda',
    at: '2026-11-06T10:00:00.000Z',
  };

  /** A provider that plays back the given steps, then answers with plain text. */
  function scripted(steps: Array<Partial<AiStep>>) {
    const seen: AiRequest[] = [];
    const provider: AiProvider = {
      id: 'openai',
      name: 'Scripted',
      defaultModel: 'm',
      keysUrl: 'https://example.com',
      async step(req) {
        seen.push(structuredClone({ ...req, signal: undefined }) as unknown as AiRequest);
        const next = steps.shift() ?? { text: 'All done.' };
        return { text: '', toolCalls: [], raw: null, usage: { input: 1, output: 1 }, ...next };
      },
    };
    return { provider, seen };
  }

  function hubAnswering(answer: (tool: string) => ToolCallResult) {
    const calls: string[] = [];
    const hub: AgentHub = {
      getCatalog: async () => catalog,
      callTool: async (_p, _c, tool) => {
        calls.push(tool);
        return answer(tool);
      },
    };
    return { hub, calls };
  }

  const run = (provider: AiProvider, overrides: Partial<Parameters<typeof runAgent>[0]> = {}) => ({
    provider,
    key: 'k',
    model: 'm',
    principal,
    instructions: 'Tell me about meetings.',
    item,
    trigger: 'Meetings',
    signal: AbortSignal.timeout(5000),
    ...overrides,
  });

  it('refuses tools outside the rule without calling the hub, and summarizes results', async () => {
    const { provider, seen } = scripted([
      {
        text: 'Working',
        toolCalls: [
          { id: '1', name: 'gmail_send', arguments: {} },
          { id: '2', name: 'demo_echo', arguments: { message: 'x' } },
          { id: '3', name: 'demo_send', arguments: {} },
        ],
      },
    ]);
    const { hub, calls } = hubAnswering((tool) =>
      tool === 'demo_echo'
        ? { content: [{ type: 'image', data: '', mimeType: 'image/png' }] as ToolCallResult['content'] }
        : { content: [], isError: true },
    );
    const outcome = await runAgent(run(provider), hub, async () => new Response());
    expect(calls).toEqual(['demo_echo', 'demo_send']);
    expect(outcome).toEqual({
      text: 'All done.',
      tokens: 4,
      calls: [
        { tool: 'gmail_send', ok: false },
        { tool: 'demo_echo', ok: true },
        { tool: 'demo_send', ok: false },
      ],
      awaiting: false,
      refused: false,
    });
    // Only the rule's tools are offered; the event is fenced as untrusted, markers inside neutralized.
    expect(seen[0]!.tools.map((t) => t.name)).toEqual(['demo_echo', 'demo_send']);
    const event = (seen[0]!.messages[0] as { text: string }).text;
    expect(event).toMatch(/^Calendar event about to start: /);
    expect(event).toContain('Event: Standup  untrusted fake ');
    expect(event).not.toContain('"chat"');
    const results = seen[1]!.messages[2] as Extract<AiRequest['messages'][number], { role: 'tool' }>;
    expect(results.results.map((r) => [r.content, r.isError])).toEqual([
      ['Tool gmail_send is not allowed for this trigger.', true],
      ['[image]', false],
      ['Failed.', true],
    ]);
  });

  it('stops when a call waits for the user', async () => {
    const { provider, seen } = scripted([{ toolCalls: [{ id: '1', name: 'demo_send', arguments: {} }] }]);
    const { hub } = hubAnswering(() => ({
      content: [],
      structuredContent: { confirmation: { status: 'awaiting_confirmation' } },
    }));
    const outcome = await runAgent(run(provider), hub, async () => new Response());
    expect(outcome).toMatchObject({ awaiting: true, calls: [{ tool: 'demo_send', ok: false }], text: '' });
    expect(seen).toHaveLength(1);
  });

  it('stops on a refusal and after the step limit', async () => {
    const refusal = scripted([{ text: '  I cannot.  ', refused: true }]);
    const { hub } = hubAnswering(() => ({ content: [{ type: 'text', text: 'ok' }] }));
    expect(await runAgent(run(refusal.provider), hub, async () => new Response())).toMatchObject({
      refused: true,
      text: 'I cannot.',
    });

    const loop = Array.from({ length: 10 }, () => ({
      toolCalls: [{ id: 'x', name: 'demo_echo', arguments: {} }],
    }));
    const runaway = scripted(loop);
    const outcome = await runAgent(run(runaway.provider), hub, async () => new Response());
    expect(runaway.seen).toHaveLength(6);
    expect(outcome.calls).toHaveLength(6);
  });

  it('tells an AI without tools to answer in text', async () => {
    const { provider, seen } = scripted([]);
    const { hub } = hubAnswering(() => ({ content: [] }));
    await runAgent(
      run(provider, {
        principal: { ...principal, automation: undefined } as Principal,
        item: { source: 'mail', service: 'gmail', account: 'me', id: 'm1', text: 'Hi', at: item.at },
      }),
      hub,
      async () => new Response(),
    );
    expect(seen[0]!.tools).toEqual([]);
    expect(seen[0]!.system).toContain('You have no tools');
    expect((seen[0]!.messages[0] as { text: string }).text).toMatch(/^New email: /);
  });
});
