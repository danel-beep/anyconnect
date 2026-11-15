import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountRow } from '../src/core/accounts.js';
import type { Principal } from '../src/core/principal.js';
import { aiKeys, triggerEvents, triggers as triggerTable } from '../src/db/schema.js';
import { accountsLabel, filterOf, limitsOf, runOf } from '../src/triggers/service.js';
import type { TriggerEvent } from '../src/triggers/store.js';
import { registryWithFakeChat } from './fake-messenger.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

/**
 * TriggerService off the happy path: the errors a chat tool or the dashboard gets back for a
 * trigger that cannot work, changes that keep what they don't mention, and the views of runs.
 */

describe('trigger service views', () => {
  it('keeps only filter words that are set', () => {
    expect(
      filterOf({
        from: ' Ann ',
        chat: '',
        subject: 'Invoice',
        text: '  ',
        not_from: 'bot',
        not_chat: 'Spam',
        not_subject: 'Re:',
        not_text: 'unsubscribe',
        skip_bulk: true,
        spam: true,
        minutes_before: 0,
      }),
    ).toEqual({
      from: 'Ann',
      subject: 'Invoice',
      not_from: 'bot',
      not_chat: 'Spam',
      not_subject: 'Re:',
      not_text: 'unsubscribe',
      skip_bulk: true,
      spam: true,
      minutes_before: 0,
    });
    expect(filterOf(undefined)).toEqual({});
    expect(filterOf({ skip_bulk: false, spam: false })).toEqual({});
  });

  it('names the accounts a trigger watches, including removed ones', () => {
    const accounts = [{ id: 'acc_1', connectorId: 'gmail', name: 'work' }] as AccountRow[];
    expect(
      accountsLabel({ source: 'mail', connectorId: 'gmail', accountIds: ['acc_1', 'gone'] }, accounts),
    ).toBe('gmail:work, removed account');
    expect(accountsLabel({ source: 'mail', connectorId: 'gmail', accountIds: [] }, accounts)).toBe('gmail');
    expect(accountsLabel({ source: 'calendar', connectorId: null, accountIds: [] }, accounts)).toBe(
      'all calendars',
    );
  });

  it('shows a run with its timing, item and result, and leaves out what is empty', () => {
    const createdAt = new Date('2026-11-06T10:00:00Z');
    const full = runOf(
      {
        status: 'done',
        createdAt,
        finishedAt: new Date('2026-11-06T10:00:02.340Z'),
        tokens: 120,
        item: {
          source: 'mail',
          service: 'gmail',
          account: 'work',
          id: 'm1',
          from: 'Ann',
          subject: 'S'.repeat(200),
          text: 'Body',
          at: createdAt.toISOString(),
        },
        result: {
          summary: 'Replied',
          error: 'Partly failed',
          skipped: 'no',
          calls: [{ tool: 'x', ok: true }],
        },
      } as unknown as TriggerEvent,
      'Mail',
    );
    expect(full).toMatchObject({
      trigger: 'Mail',
      seconds: 2.3,
      from: 'Ann',
      summary: 'Replied',
      error: 'Partly failed',
      skipped: 'no',
      calls: [{ tool: 'x', ok: true }],
      tokens: 120,
    });
    expect(full.title!.length).toBeLessThanOrEqual(121);
    const chat = runOf(
      {
        status: 'running',
        createdAt,
        finishedAt: null,
        tokens: 0,
        item: {
          source: 'message',
          service: 'tg',
          account: 'a',
          id: '1',
          chatTitle: 'Team',
          text: '',
          at: '',
        },
        result: { calls: [] },
      } as unknown as TriggerEvent,
      'T',
    );
    expect(chat).toEqual({
      trigger: 'T',
      status: 'running',
      at: createdAt.toISOString(),
      service: 'tg',
      account: 'a',
      id: '1',
      title: 'Team',
    });
    const bare = runOf(
      { status: 'skipped', createdAt, item: null, result: {} } as unknown as TriggerEvent,
      'T',
    );
    expect(Object.keys(bare)).toEqual(['trigger', 'status', 'at']);
  });

  it('checks argument limits against the trigger’s tools', () => {
    expect(limitsOf(null, ['a'])).toBeUndefined();
    expect(() => limitsOf({ a: 'nope' } as never, ['a'])).toThrow('allow:');
    expect(() => limitsOf({ b: { to: ['x'] } }, ['a'])).toThrow('not in the trigger');
    expect(limitsOf({ b: { to: ['x'] }, a: {} }, ['a'], false)).toBeUndefined();
    expect(limitsOf({ a: { to: ['x'] } }, ['a'])).toEqual({ a: { to: ['x'] } });
  });
});

describe('trigger service', () => {
  let hub: TestHub;
  let workspaceId: string;
  let session: Principal;

  const service = () => hub.services.triggers.service;
  const message = (extra: Record<string, unknown> = {}) =>
    service().create(session, { name: 'Watch', when: 'message', do: 'check', ...extra } as never);
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => 'resolved',
      (e: Error) => e.message,
    );

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ connectors: (deps) => registryWithFakeChat(deps), seed: false });
    workspaceId = (await hub.services.db.query.workspaces.findFirst())!.id;
    const userId = (await hub.services.db.query.users.findFirst())!.id;
    session = { kind: 'session', userId, workspaceId, scopes: [] };
    for (const name of ['main', 'second']) {
      await hub.services.accounts.create(workspaceId, {
        connectorId: 'fakechat',
        name,
        label: name,
        credentials: {},
      });
    }
    await hub.services.accounts.create(workspaceId, {
      connectorId: 'demo',
      name: 'main',
      label: 'Main',
      credentials: { secret: 's' },
    });
  });

  beforeEach(async () => {
    await hub.services.db.delete(triggerEvents);
    await hub.services.db.delete(triggerTable);
    await hub.services.db.delete(aiKeys);
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('says what a trigger is missing before creating it', async () => {
    expect(await failure(message({ do: 'tool' }))).toContain('do=tool needs "tool"');
    expect(await failure(message({ do: 'tool', tool: 'no_such_tool' }))).toContain(
      'Unknown tool no_such_tool',
    );
    expect(await failure(message({ do: 'ai' }))).toContain('do=ai needs "instructions"');
    expect(await failure(message({ do: 'ai', instructions: 'Reply' }))).toContain('Add an AI API key first');
    expect(await failure(message({ account: 'fakechat:nobody' }))).toMatch(
      /No messenger account "fakechat:nobody"\. Use one of: fakechat:main, fakechat:second/,
    );
    expect(
      await failure(
        service().create(session, { name: 'Mail', when: 'mail', do: 'notify', account: 'gmail' }),
      ),
    ).toBe('No mailbox "gmail". Connect one first.');
    expect(await service().list(workspaceId)).toEqual([]);
  });

  it('watches one account, a whole service, or everything', async () => {
    expect((await message({ name: 'One', account: 'fakechat:second' })).accounts).toBe('fakechat:second');
    expect((await message({ name: 'Service', account: 'fakechat' })).accounts).toBe('fakechat');
    const all = await message({ name: 'All', account: ' all ' });
    expect(all).toMatchObject({ accounts: 'all messages', everyAccount: true });
  });

  it('keeps what a change does not mention', async () => {
    await message({ task: 'Summarize', filter: { from: 'Ann' } });
    const renamed = await service().update(session, 'Watch', { filter: { text: 'invoice' } });
    expect(renamed).toMatchObject({ do: 'check', task: 'Summarize', filter: { text: 'invoice' } });
    const moved = await service().update(session, 'Watch', { account: 'fakechat:main', dailyLimit: 3 });
    expect(moved).toMatchObject({ accounts: 'fakechat:main', dailyLimit: 3, task: 'Summarize' });
    const notify = await service().update(session, 'Watch', { do: 'notify' });
    expect(notify).toMatchObject({ do: 'notify', action: 'notify' });
    expect(notify.task).toBeUndefined();
    const tool = await service().update(session, 'Watch', {
      do: 'tool',
      tool: 'demo_echo',
      args: { message: '{{text}}' },
    });
    expect(tool.action).toBe('demo_echo');
    // A later change of the arguments keeps the tool.
    expect((await service().update(session, 'Watch', { args: { message: 'hi' } })).action).toBe('demo_echo');
    expect((await service().update(session, 'Watch', { enabled: false })).enabled).toBe(false);
  });

  it('wakes the AI on a chosen key and keeps the key, tools and limits on later changes', async () => {
    const first = await hub.services.triggers.keys.create(workspaceId, {
      provider: 'openai',
      label: 'Personal',
      key: 'sk-personal-0123456789abcdef',
      dailyRuns: null,
    });
    await hub.services.triggers.keys.create(workspaceId, {
      provider: 'anthropic',
      label: 'Work',
      key: 'sk-ant-work-0123456789abcdef',
      dailyRuns: 5,
    });
    expect(await failure(message({ do: 'ai', instructions: 'Reply', aiKey: 'Missing' }))).toBe(
      'Unknown AI key "Missing". Use one of: Personal, Work',
    );
    const ai = await message({
      do: 'ai',
      instructions: 'Reply politely',
      aiKey: 'Work',
      tools: ['demo_echo'],
      allow: { demo_echo: { account: ['main'] } },
      askBeforeRisky: false,
    });
    expect(ai).toMatchObject({
      do: 'ai',
      askBeforeRisky: false,
      allow: { demo_echo: { account: ['main'] } },
    });
    expect(ai.action).toMatch(/^AI \(Work, claude-.*; tools: demo_echo\)$/);
    const later = await service().update(session, 'Watch', { instructions: 'Reply briefly' });
    expect(later.action).toBe(ai.action);
    expect(later.allow).toEqual({ demo_echo: { account: ['main'] } });
    // Dropping the tool drops its limits with it.
    const noTools = await service().update(session, 'Watch', { tools: [] });
    expect(noTools.action).toMatch(/tools: none\)$/);
    expect(noTools.allow).toBeUndefined();

    expect(await service().findAiKey(workspaceId, 'nothing')).toBeUndefined();
    expect((await service().findAiKey(workspaceId, 'Personal'))?.id).toBe(first.id);
    expect(await failure(service().updateAiKey(workspaceId, 'nothing', { label: 'x' }))).toContain(
      'Use one of: Personal, Work',
    );
    expect((await service().deleteAiKey(workspaceId, 'Personal')).label).toBe('Personal');
    expect((await service().aiKeys(workspaceId)).map((k) => k.label)).toEqual(['Work']);
    await service().deleteAiKey(workspaceId, 'Work');
    expect(await failure(service().deleteAiKey(workspaceId, 'Work'))).toContain('No AI key yet');
    // The trigger still exists; its key is gone.
    expect((await service().find(workspaceId, 'Watch')).action).toMatch(/^AI \(no key;/);
  });

  it('explains a test that found nothing, and runs and checks of one trigger', async () => {
    await message();
    const signal = AbortSignal.timeout(10_000);
    const tried = await service().test(session, 'Watch', { run: false, force: false, signal });
    expect(tried).toMatchObject({ looked: 0, matched: false, ran: false });
    expect(tried.note).toBe('Nothing arrived on the accounts this trigger watches in the last day.');
    const named = await service().test(session, 'Watch', { item: 'msg_x', run: true, force: false, signal });
    expect(named.note).toContain('No message or email "msg_x"');
    expect(await service().runs(workspaceId, { trigger: 'Watch', limit: 5 })).toEqual([]);
    expect(await service().check(session, { trigger: 'Watch', limit: 5, signal })).toEqual({
      events: [],
      more: false,
    });
    expect(await failure(service().runs(workspaceId, { trigger: 'Nope', limit: 5 }))).not.toBe('resolved');
  });

  it('lists what each source can watch and the AI providers', async () => {
    const watchable = await service().watchable(workspaceId);
    expect(watchable.message.map((a) => a.name).sort()).toEqual(['main', 'second']);
    expect(watchable.mail).toEqual([]);
    expect(service().aiProviders.map((p) => p.id)).toEqual(['openai', 'anthropic', 'openrouter']);
    expect(service().pageUrl).toMatch(/\/app\/triggers$/);
    expect(service().aiPageUrl).toMatch(/\/app\/ai$/);
    expect(await service().events(workspaceId)).toEqual([]);
  });
});
