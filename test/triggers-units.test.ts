import { describe, expect, it } from 'vitest';
import { outsideLimits } from '../src/hub/stages/automation.js';
import { narrows } from '../src/hub/trigger-tools.js';
import { AI_PROVIDERS, AiProviderError, takesEffort } from '../src/triggers/ai/providers.js';
import { alternatives, matchesFilter, renderArgs } from '../src/triggers/match.js';
import { limitsOf } from '../src/triggers/service.js';
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

describe('argument limits', () => {
  const call = (input: Record<string, unknown>, account = 'uliana') =>
    ({ input, account: { name: account }, connector: { id: 'telegram' } }) as any;
  const limits = { chat: ['123', '456'] };

  it('lets through only the allowed values, every item of a list, and needs the argument', () => {
    expect(outsideLimits(undefined, call({ chat: '999' }))).toBeUndefined();
    expect(outsideLimits(limits, call({ chat: '123' }))).toBeUndefined();
    expect(outsideLimits(limits, call({ chat: 456 }))).toBeUndefined();
    expect(outsideLimits(limits, call({ chat: ['123', '456'] }))).toBeUndefined();
    expect(outsideLimits(limits, call({ chat: ['123', '999'] }))?.argument).toBe('chat');
    expect(outsideLimits(limits, call({ to: '@someone' }))?.argument).toBe('chat');
    expect(outsideLimits(limits, call({ chat: { id: '123' } }))?.argument).toBe('chat');
  });

  it('limits the account by name or service:name', () => {
    expect(outsideLimits({ account: ['uliana'] }, call({}))).toBeUndefined();
    expect(outsideLimits({ account: ['telegram:uliana'] }, call({}))).toBeUndefined();
    expect(outsideLimits({ account: ['uliana'] }, call({}, 'work'))?.argument).toBe('account');
  });

  it('tells a narrowing change from one that allows more', () => {
    const before = { telegram_send: { chat: ['1', '2'] } };
    expect(narrows(undefined, { telegram_send: { chat: ['1'] } })).toBe(true);
    expect(narrows(before, { telegram_send: { chat: ['1'] } })).toBe(true);
    expect(narrows(before, { telegram_send: { chat: [1], account: ['a'] } })).toBe(true);
    expect(narrows(before, { telegram_send: { chat: ['1', '3'] } })).toBe(false);
    expect(narrows(before, { gmail_send: { to: ['a@b.com'] } })).toBe(false);
    expect(narrows(before, null)).toBe(false);
  });

  it('keeps limits to the trigger’s tools and reads numbers as text', () => {
    expect(limitsOf({ telegram_send: { chat: [123] } }, ['telegram_send'])).toEqual({
      telegram_send: { chat: ['123'] },
    });
    expect(() => limitsOf({ gmail_send: { to: ['a@b.com'] } }, ['telegram_send'])).toThrow(/not in/);
    expect(limitsOf({ gmail_send: { to: ['a@b.com'] } }, ['telegram_send'], false)).toBeUndefined();
    expect(limitsOf(null, ['telegram_send'])).toBeUndefined();
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
