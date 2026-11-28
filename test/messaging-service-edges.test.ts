import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountMessaging, InboundMessage } from '../src/connectors/messaging.js';
import { messengerAccounts, messengerChats, messengerMessages, messengerOutbox } from '../src/db/schema.js';
import { registryWithFakeChat } from './fake-messenger.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

/**
 * What a messenger tool gets back when a request cannot be served: unknown chats and messages,
 * features the account's transport does not have, a hub without a gateway, a logged-out session,
 * too many waits at once; and how a queued send reports a paused account.
 */
describe('messaging service edges', () => {
  let hub: TestHub;
  let accountId: string;
  let messaging: AccountMessaging;
  let seq = 0;

  const ingest = (extra: Partial<InboundMessage> = {}) =>
    hub.services.messaging.store.ingest(accountId, [
      {
        chat: { externalId: 'chat-ann', kind: 'direct', title: 'Ann' },
        externalId: `m${++seq}`,
        direction: 'in',
        sentAt: new Date(),
        sender: { externalId: 'u-ann', name: 'Ann' },
        text: 'hi',
        ...extra,
      },
    ]);
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => 'resolved',
      (e: Error) => e.message,
    );

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ connectors: (deps) => registryWithFakeChat(deps), seed: false });
    const workspaceId = (await hub.services.db.query.workspaces.findFirst())!.id;
    accountId = (
      await hub.services.accounts.create(workspaceId, {
        connectorId: 'fakechat',
        name: 'main',
        label: 'Main',
        credentials: {},
      })
    ).id;
    messaging = hub.services.messaging.service.forAccount(accountId);
  });

  beforeEach(async () => {
    await hub.services.db.delete(messengerOutbox);
    await hub.services.db.delete(messengerMessages);
    await hub.services.db.delete(messengerChats);
    await hub.services.db.delete(messengerAccounts);
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('knows no account that is gone or is not a messenger', async () => {
    const service = hub.services.messaging.service;
    expect(await service.resolve('acc_missing')).toBeUndefined();
    expect(await service.route('acc_missing', {})).toBe(false);
    // A session messenger takes no routed events.
    expect(await service.route(accountId, {})).toBe(false);
    expect(service.webhookUrl(accountId)).toMatch(new RegExp(`/hooks/messenger/${accountId}$`));
    expect(messaging.webhook()).toMatchObject({ url: service.webhookUrl(accountId) });
    expect(
      await failure(
        hub.services.messaging.service.forAccount('acc_missing').send({ chatId: 'c', text: 'x' }),
      ),
    ).toBe('This messenger account is not available.');
  });

  it('refuses sends the request or the account cannot do', async () => {
    const [stored] = await ingest();
    const chatId = stored!.chatId;
    expect(await failure(messaging.send({ text: 'x' }))).toContain('Pass chat');
    expect(await failure(messaging.send({ chatId: 'cht_nope', text: 'x' }))).toContain(
      'not found in this account',
    );
    expect(
      await failure(messaging.send({ chatId, text: 'x', template: { name: 'hello', language: 'en_US' } })),
    ).toBe('This account cannot send message templates.');
    expect(
      await failure(
        messaging.send({ chatId, text: 'x', file: { url: 'https://example.com/a.pdf', kind: 'document' } }),
      ),
    ).toBe('This account cannot send files yet.');
    expect(await failure(messaging.send({ chatId, text: 'x', replyTo: 'msg_elsewhere' }))).toContain(
      'is not in this chat',
    );
    // Writing to someone new needs the gateway, which this hub does not have.
    expect(await failure(messaging.send({ to: '@bob', text: 'x' }))).toContain('gateway is not configured');
  });

  it('marks unread messages read before a reply, and reports a paused account', async () => {
    const [first] = await ingest();
    await ingest();
    const chatId = first!.chatId;
    await hub.services.messaging.accounts.pauseSending(
      accountId,
      new Date(Date.now() + 3_600_000),
      'Flood wait',
    );
    const result = await messaging.send({ chatId, text: 'reply', replyTo: first!.id, waitMs: 0 });
    expect(result).toMatchObject({
      status: 'queued',
      error: 'Sending from this account is paused: Flood wait',
    });
    expect(new Date(result.eta!).getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    const jobs = await hub.services.db.select().from(messengerOutbox);
    expect(jobs.map((j) => j.kind)).toEqual(['mark_read', 'message']);
    expect((await hub.services.messaging.store.getChat(accountId, chatId))!.unread).toBe(0);
    expect(await messaging.markRead(chatId)).toEqual({ status: 'queued' });
    expect(await messaging.isKnownContact(chatId)).toBe(true);
    await hub.services.messaging.accounts.resumeSending(accountId);
  });

  it('reads chats and attachments only where they exist', async () => {
    const [plain] = await ingest();
    const [linked] = await ingest({
      direction: 'out',
      attachments: [
        {
          externalId: 'f1',
          kind: 'document',
          name: 'a.pdf',
          locator: { sentLink: 'https://x.example/a.pdf' },
        },
      ],
    });
    expect(await failure(messaging.readChat({ chatId: 'cht_nope', limit: 5 }))).toContain('not found');
    const page = await messaging.readChat({ chatId: plain!.chatId, limit: 1 });
    expect(page.messages).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    expect(await failure(messaging.download(plain!.id, 'a0'))).toBe('Attachment not found.');
    expect(await failure(messaging.download(linked!.id, 'x'))).toBe('Attachment not found.');
    expect(await failure(messaging.download(linked!.id, 'a0'))).toContain('sent by link');
    await ingest({ attachments: [{ externalId: 'f2', kind: 'photo' }] });
    const [withFile] = (await messaging.search({ limit: 1 })).items;
    expect(await failure(messaging.download(withFile!.id, 'a0'))).toContain('gateway is not configured');
  });

  it('says at once that a logged-out session will not receive anything', async () => {
    expect(await messaging.session()).toEqual({ state: 'needs_login' });
    const answer = await messaging.waitForMessages({ timeoutMs: 10_000, includeOwn: false, limit: 5 });
    expect(answer).toMatchObject({ messages: [], offline: { state: 'needs_login' } });
    expect(answer.waitedMs).toBeLessThan(5_000);
    expect(
      await failure(
        messaging.waitForMessages({ chatId: 'cht_nope', timeoutMs: 10, includeOwn: false, limit: 5 }),
      ),
    ).toContain('not found');
  });

  it('returns early when the wait is cancelled, and limits waits per account', async () => {
    await hub.services.messaging.accounts.setState(accountId, { state: 'online' });
    // Online counts only while a gateway holds the session's lease.
    expect(await messaging.session()).toMatchObject({ state: 'connecting' });
    await hub.services.db
      .update(messengerAccounts)
      .set({ leaseOwner: 'gw', leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(messengerAccounts.accountId, accountId));
    expect(await messaging.session()).toMatchObject({ state: 'online' });
    const stop = new AbortController();
    const waits = Array.from({ length: 5 }, () =>
      messaging.waitForMessages({ timeoutMs: 20_000, includeOwn: false, limit: 5, signal: stop.signal }),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(
      await failure(messaging.waitForMessages({ timeoutMs: 10, includeOwn: false, limit: 5 })),
    ).toContain('Too many waits');
    stop.abort();
    const answers = await Promise.all(waits);
    expect(answers.every((a) => a.messages.length === 0)).toBe(true);
    // The slots are free again.
    const quick = await messaging.waitForMessages({ timeoutMs: 1, includeOwn: false, limit: 5 });
    expect(quick.messages).toEqual([]);
  });

  it('feeds read markers and delivery from the messenger into the store', async () => {
    const [own] = await ingest({ direction: 'out' });
    await ingest();
    const sink = hub.services.messaging.service.inbound(accountId);
    await sink.markChatRead('chat-unknown');
    await sink.markChatRead('chat-ann');
    expect((await hub.services.messaging.store.getChat(accountId, own!.chatId))!.unread).toBe(0);
    await sink.delivery([
      { chatExternalId: 'chat-ann', messageExternalId: own!.body.externalId, state: 'read' },
    ]);
    const [view] = (await messaging.search({ limit: 5 })).items.filter((m) => m.id === own!.id);
    expect(view!.delivery).toBe('read');
  });
});
