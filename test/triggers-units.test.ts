import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS, AiProviderError, takesEffort } from '../src/triggers/ai/providers.js';
import { alternatives, matchesFilter, renderArgs } from '../src/triggers/match.js';
import { counterpartOf, type TriggerItem, TriggerSpec } from '../src/triggers/spec.js';

const item: TriggerItem = {
  source: 'message',
  service: 'telegram',
  account: 'main',
  id: 'msg_1',
  chat: 'chat_9',
  chatTitle: 'Acme team',
  from: 'Alice Smith',
  text: 'Please pay the INVOICE today',
  at: '2026-11-06T10:00:00.000Z',
};

describe('trigger filters', () => {
  it('splits alternatives by commas and ignores case and spaces', () => {
    expect(alternatives(' Invoice, receipt ,, ')).toEqual(['invoice', 'receipt']);
    expect(alternatives(undefined)).toEqual([]);
  });

  it('matches when every set field matches one of its alternatives', () => {
    expect(matchesFilter({}, item)).toBe(true);
    expect(matchesFilter({ from: 'bob, alice' }, item)).toBe(true);
    expect(matchesFilter({ from: 'alice', text: 'invoice' }, item)).toBe(true);
    expect(matchesFilter({ from: 'alice', text: 'refund' }, item)).toBe(false);
    expect(matchesFilter({ chat: 'acme' }, item)).toBe(true);
    // A mail-only field never matches a message.
    expect(matchesFilter({ subject: 'invoice' }, item)).toBe(false);
  });

  it('groups events by account and chat for loop protection', () => {
    expect(counterpartOf(item)).toBe('telegram:main|chat_9');
  });
});

describe('action templates', () => {
  it('fills placeholders, keeps unknown ones and passes non-strings through', () => {
    expect(
      renderArgs({ text: '{{from}}: {{text}}', chat: '{{ chat }}', n: 3, list: ['{{nope}}'] }, item, 'Bills'),
    ).toEqual({
      text: 'Alice Smith: Please pay the INVOICE today',
      chat: 'chat_9',
      n: 3,
      list: ['{{nope}}'],
    });
  });

  it('defaults a woken AI to asking before risky actions', () => {
    const spec = TriggerSpec.parse({ filter: {}, action: { kind: 'ai', instructions: 'Summarize' } });
    expect(spec.action).toMatchObject({ kind: 'ai', tools: [], confirmRisky: true, notify: true });
  });
});

describe('AI providers', () => {
  const request = {
    key: 'sk-test',
    model: 'claude-haiku-5-5',
    system: 'You handle one event.',
    messages: [{ role: 'user' as const, text: 'hi' }],
    tools: [{ name: 'demo_echo', description: 'Echo', parameters: { type: 'object' } }],
    maxTokens: 100,
    signal: AbortSignal.timeout(1000),
  };

  it('sends Anthropic a cached system prompt and reads tool calls back', async () => {
    let sent: any;
    const step = await AI_PROVIDERS.anthropic.step(request, async (url, init) => {
      expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
      sent = JSON.parse(String(init?.body));
      return Response.json({
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'tool_use', id: 't1', name: 'demo_echo', input: { message: 'x' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
      });
    });
    expect(sent.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(sent.output_config).toEqual({ effort: 'low' });
    expect(step.toolCalls).toEqual([{ id: 't1', name: 'demo_echo', arguments: { message: 'x' } }]);
    expect(step.usage).toEqual({ input: 100, output: 5 });
    // The raw content (with its thinking block) goes back unchanged on the next step.
    expect((step.raw as any[])[0].type).toBe('thinking');
  });

  it('sends effort only to models that take it', () => {
    expect(takesEffort('claude-haiku-5-5')).toBe(true);
    expect(takesEffort('claude-opus-4-5')).toBe(true);
    expect(takesEffort('claude-haiku-4-5')).toBe(false);
  });

  it('reports a refusal and a rejected key', async () => {
    const refused = await AI_PROVIDERS.anthropic.step(request, async () =>
      Response.json({ content: [], stop_reason: 'refusal', usage: {} }),
    );
    expect(refused.refused).toBe(true);
    const failure = AI_PROVIDERS.openai.step({ ...request, model: 'gpt-5-mini' }, async () =>
      Response.json({ error: { message: 'Incorrect API key provided' } }, { status: 401 }),
    );
    await expect(failure).rejects.toBeInstanceOf(AiProviderError);
    await expect(failure).rejects.toMatchObject({ keyProblem: true });
  });
});
