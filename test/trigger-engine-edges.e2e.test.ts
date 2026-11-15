import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../src/core/principal.js';
import { triggerEvents, triggers as triggerTable } from '../src/db/schema.js';
import { RunInterrupted } from '../src/triggers/engine.js';
import type { TriggerItem } from '../src/triggers/spec.js';
import type { Trigger } from '../src/triggers/store.js';
import { FakeInternet } from './e2e/fake-internet.js';
import { registryWithFakeChat } from './fake-messenger.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

/**
 * How a trigger's run ends when something is off: the AI key is gone or refused, the provider is
 * unreachable, a tool fails, the user has no channel for notices, the process stops before the run
 * acted; and how a confirmation the run waited for settles the event.
 */
describe('trigger runs that do not go to plan', () => {
  let hub: TestHub;
  let internet: FakeInternet;
  let workspaceId: string;
  let chatAccount: string;
  let session: Principal;
  let seq = 0;

  const engine = () => hub.services.triggers.engine;
  const store = () => hub.services.triggers.store;
  const item = (): TriggerItem => ({
    source: 'message',
    service: 'fakechat',
    account: 'main',
    id: `m${++seq}`,
    chat: 'chat-1',
    chatTitle: 'Alice',
    from: 'Alice',
    text: 'Hello there',
    at: new Date().toISOString(),
  });

  /** A matched event waiting for its run, as the scan records it. */
  const pending = async (
    trigger: { id: string },
    status: 'running' | 'awaiting_confirmation' = 'running',
  ) => {
    const full = (await store().get(workspaceId, trigger.id)) as Trigger;
    const it = item();
    const event = await store().recordEvent({
      trigger: full,
      accountId: chatAccount,
      item: it,
      eventKey: `fakechat:${it.id}`,
      counterpartKey: 'alice',
      status,
      ...(status === 'awaiting_confirmation'
        ? { result: { calls: [{ tool: 'demo_echo', ok: false }] } }
        : {}),
      aiKeyId: full.aiKeyId,
    });
    return event!.id;
  };
  const event = async (id: string) => (await store().getEvent(id))!;
  const create = (input: Record<string, unknown>) =>
    hub.services.triggers.service.create(session, { name: `T${++seq}`, when: 'message', ...input } as never);

  beforeAll(async () => {
    await resetDatabase();
    internet = new FakeInternet();
    hub = await startTestHub({ connectors: (deps) => registryWithFakeChat(deps), internet, seed: false });
    workspaceId = (await hub.services.db.query.workspaces.findFirst())!.id;
    const userId = (await hub.services.db.query.users.findFirst())!.id;
    session = { kind: 'session', userId, workspaceId, scopes: [] };
    chatAccount = (
      await hub.services.accounts.create(workspaceId, {
        connectorId: 'fakechat',
        name: 'main',
        label: 'Main',
        credentials: {},
      })
    ).id;
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
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('ignores events that are gone or already over', async () => {
    await expect(engine().run('tev_missing')).resolves.toBeUndefined();
    const trigger = await create({ do: 'notify' });
    const id = await pending(trigger);
    await store().setStatus(id, 'done');
    await engine().run(id);
    expect((await event(id)).status).toBe('done');
  });

  it('runs an event only once', async () => {
    const trigger = await create({ do: 'notify' });
    const id = await pending(trigger);
    expect(await store().claim(id)).toBe(true);
    await engine().run(id);
    expect((await event(id)).status).toBe('running');
  });

  it('reports a notice nobody can receive as done without a channel', async () => {
    const trigger = await create({ do: 'notify' });
    const id = await pending(trigger);
    await engine().run(id);
    expect(await event(id)).toMatchObject({ status: 'done', result: { summary: 'no_channel' } });
  });

  it('fails a tool run with the tool’s error', async () => {
    const trigger = await create({
      do: 'tool',
      tool: 'demo_echo',
      args: { account: 'nobody', message: 'x' },
    });
    const id = await pending(trigger);
    await engine().run(id);
    const done = await event(id);
    expect(done.status).toBe('failed');
    expect(done.result.calls).toEqual([{ tool: 'demo_echo', ok: false }]);
    expect(done.result.error).toBeTruthy();
  });

  it('gives a run back untouched when the process stops before it acted', async () => {
    const trigger = await create({ do: 'notify' });
    const id = await pending(trigger);
    const stop = new AbortController();
    stop.abort();
    await expect(engine().run(id, stop.signal)).rejects.toBeInstanceOf(RunInterrupted);
    const back = await event(id);
    expect(back.status).toBe('running');
    const [row] = await hub.services.db.select().from(triggerEvents).where(eq(triggerEvents.id, id));
    expect(row!.startedAt).toBeNull();
  });

  describe('the user’s AI', () => {
    const aiTrigger = async (key: string) => {
      const created = await hub.services.triggers.keys.create(workspaceId, {
        provider: 'openai',
        key,
        dailyRuns: null,
      });
      const trigger = await create({ do: 'ai', instructions: 'Say hi', notify: false });
      return { trigger, keyId: created.id };
    };

    it('fails without a key', async () => {
      const { trigger, keyId } = await aiTrigger('sk-gone-0123456789abcdef');
      await hub.services.triggers.keys.delete(workspaceId, keyId);
      const id = await pending(trigger);
      await engine().run(id);
      expect(await event(id)).toMatchObject({ status: 'failed', result: { skipped: 'no_key' } });
    });

    it('fails with the provider’s words when it refuses the key, and marks the key', async () => {
      internet.serve('api.openai.com', () =>
        Response.json({ error: { message: 'Incorrect API key provided' } }, { status: 401 }),
      );
      const { trigger, keyId } = await aiTrigger('sk-wrong-0123456789abcdef');
      const id = await pending(trigger);
      await engine().run(id);
      expect(await event(id)).toMatchObject({
        status: 'failed',
        result: { error: 'OpenAI answered 401: Incorrect API key provided' },
      });
      expect((await hub.services.triggers.keys.get(workspaceId, keyId)).lastError).toContain('401');
      await hub.services.triggers.keys.delete(workspaceId, keyId);
    });

    it('fails as unreachable when the provider is down, and marks the key', async () => {
      internet.serve('api.openai.com', () => {
        throw new TypeError('fetch failed');
      });
      const { trigger, keyId } = await aiTrigger('sk-down-0123456789abcdef');
      const id = await pending(trigger);
      await engine().run(id);
      expect(await event(id)).toMatchObject({
        status: 'failed',
        result: { error: 'OpenAI could not be reached' },
      });
      expect((await hub.services.triggers.keys.get(workspaceId, keyId)).lastError).toBe(
        'OpenAI could not be reached',
      );
      await hub.services.triggers.keys.delete(workspaceId, keyId);
    });

    it('sends the summary to the user when the rule asks for it', async () => {
      internet.serve('api.openai.com', () =>
        Response.json({ choices: [{ message: { role: 'assistant', content: 'Alice says hello.' } }] }),
      );
      const created = await hub.services.triggers.keys.create(workspaceId, {
        provider: 'openai',
        key: 'sk-good-0123456789abcdef',
        dailyRuns: null,
      });
      const trigger = await create({ do: 'ai', instructions: 'Say hi', notify: true });
      const id = await pending(trigger);
      await engine().run(id);
      expect(await event(id)).toMatchObject({ status: 'done', result: { summary: 'Alice says hello.' } });
      await hub.services.triggers.keys.delete(workspaceId, created.id);
    });
  });

  describe('a confirmation the run waited for', () => {
    it('marks the event done or failed, and the call that waited', async () => {
      const trigger = await create({
        do: 'tool',
        tool: 'demo_echo',
        args: { account: 'main', message: 'x' },
      });
      const approved = await pending(trigger, 'awaiting_confirmation');
      await engine().confirmationSettled(approved, 'demo_echo', 'succeeded');
      expect(await event(approved)).toMatchObject({
        status: 'done',
        result: { calls: [{ tool: 'demo_echo', ok: true }] },
      });
      const denied = await pending(trigger, 'awaiting_confirmation');
      await engine().confirmationSettled(denied, 'demo_echo', 'denied');
      expect(await event(denied)).toMatchObject({
        status: 'failed',
        result: { error: 'You declined the action', calls: [{ tool: 'demo_echo', ok: false }] },
      });
    });

    it('leaves the event alone for outcomes that are not final and events not waiting', async () => {
      const trigger = await create({ do: 'notify' });
      const waiting = await pending(trigger, 'awaiting_confirmation');
      await engine().confirmationSettled(waiting, 'demo_echo', 'approved');
      expect((await event(waiting)).status).toBe('awaiting_confirmation');
      const running = await pending(trigger);
      await engine().confirmationSettled(running, 'demo_echo', 'expired');
      expect((await event(running)).status).toBe('running');
      await expect(engine().confirmationSettled('tev_missing', 'x', 'failed')).resolves.toBeUndefined();
    });
  });
});
