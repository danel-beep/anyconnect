import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InboundMessage } from '../src/connectors/messaging.js';
import { accounts, messengerChats, messengerMessages } from '../src/db/schema.js';
import type { MessageStore } from '../src/messaging/store.js';
import { registryWithFakeChat } from './fake-messenger.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

/**
 * The encrypted message store off the main paths that messengers.test.ts drives: chats that
 * change, messages seen again, delivery that only moves forward, empty pages and cursors.
 */
describe('message store edges', () => {
  let hub: TestHub;
  let store: MessageStore;
  let accountId: string;
  let otherAccount: string;
  let seq = 0;
  const t0 = Date.now() - 3_600_000;

  const message = (extra: Partial<InboundMessage> = {}): InboundMessage => ({
    chat: { externalId: 'chat-ann', kind: 'direct', title: 'Ann' },
    externalId: `m${++seq}`,
    direction: 'in',
    sentAt: new Date(t0 + seq * 1000),
    sender: { externalId: 'u-ann', name: 'Ann' },
    text: `hello number ${seq}`,
    ...extra,
  });

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ connectors: (deps) => registryWithFakeChat(deps), seed: false });
    store = hub.services.messaging.store;
    const workspaceId = (await hub.services.db.query.workspaces.findFirst())!.id;
    const create = async (name: string) =>
      (
        await hub.services.accounts.create(workspaceId, {
          connectorId: 'fakechat',
          name,
          label: name,
          credentials: {},
        })
      ).id;
    accountId = await create('main');
    otherAccount = await create('other');
  });

  beforeEach(async () => {
    await hub.services.db.delete(messengerMessages);
    await hub.services.db.delete(messengerChats);
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('updates a chat only when something about it changed', async () => {
    const first = await store.upsertChat(accountId, { externalId: 'c1', kind: 'direct', username: 'ann_s' });
    expect(first).toMatchObject({ title: 'ann_s', username: 'ann_s', unread: 0 });
    const same = await store.upsertChat(accountId, { externalId: 'c1', kind: 'direct' });
    expect(same).toMatchObject({ id: first.id, title: 'ann_s' });
    const renamed = await store.upsertChat(accountId, {
      externalId: 'c1',
      kind: 'group',
      title: '  Ann & Bob  ',
      unread: 4,
    });
    expect(renamed).toMatchObject({
      id: first.id,
      title: 'Ann & Bob',
      kind: 'group',
      unread: 4,
      username: 'ann_s',
    });
    const counted = await store.upsertChat(accountId, { externalId: 'c1', kind: 'group', unread: 0 });
    expect(counted).toMatchObject({ title: 'Ann & Bob', unread: 0 });
    expect((await store.findChatByExternalId(accountId, 'c1'))?.title).toBe('Ann & Bob');
    // Chats of another account are invisible, by id and by external id.
    expect(await store.getChat(otherAccount, first.id)).toBeUndefined();
    expect(await store.findChatByExternalId(otherAccount, 'c1')).toBeUndefined();
    const bare = await store.upsertChat(accountId, { externalId: 'c2', kind: 'direct' });
    expect(bare.title).toBe('c2');
  });

  it('merges a message seen again, keeps delivery through an edit, and empties a deleted one', async () => {
    const out = message({
      direction: 'out',
      text: 'my reply',
      attachments: [{ externalId: 'f1', kind: 'document' }],
    });
    const [stored] = await store.ingest(accountId, [out]);
    expect(stored).toBeDefined();
    expect(await store.ingest(accountId, [out])).toEqual([]);
    const delivery = (state: 'sent' | 'delivered' | 'read' | 'failed', error?: string) =>
      store.recordDelivery(accountId, {
        chatExternalId: 'chat-ann',
        messageExternalId: out.externalId,
        state,
        ...(error ? { error } : {}),
      });
    expect(await delivery('delivered')).toBe(true);
    expect(await delivery('sent')).toBe(false);
    expect(await delivery('read')).toBe(true);
    expect(await delivery('failed', 'too late')).toBe(false);

    const [edited] = await store.ingest(accountId, [
      { ...out, text: 'my reply, edited', editedAt: new Date() },
    ]);
    expect(edited?.body).toMatchObject({ text: 'my reply, edited', delivery: 'read' });
    const [deleted] = await store.ingest(accountId, [{ ...out, deleted: true, editedAt: edited!.editedAt! }]);
    expect(deleted?.body).toMatchObject({ text: '', attachments: [], delivery: 'read' });

    const page = await store.readChat(accountId, { chatId: stored!.chatId, limit: 10 });
    expect(page?.messages[0]).toMatchObject({ deleted: true, delivery: 'read', text: '' });
    expect(page?.messages[0]?.editedAt).toBeDefined();
    // A message that was deleted is not found by search.
    expect((await store.search(accountId, { query: 'reply', limit: 10 })).items).toEqual([]);
  });

  it('keeps the reason a delivery failed, and ignores statuses it cannot place', async () => {
    const out = message({ direction: 'out' });
    await store.ingest(accountId, [out]);
    const fail = { chatExternalId: 'chat-ann', messageExternalId: out.externalId, state: 'failed' as const };
    expect(await store.recordDelivery(accountId, { ...fail, error: 'x'.repeat(400) })).toBe(true);
    const [found] = (await store.search(accountId, { limit: 1 })).items;
    expect(found?.deliveryError).toHaveLength(300);
    expect(await store.recordDelivery(accountId, { ...fail, chatExternalId: 'nowhere' })).toBe(false);
    expect(await store.recordDelivery(accountId, { ...fail, messageExternalId: 'unknown' })).toBe(false);
    const incoming = message();
    await store.ingest(accountId, [incoming]);
    expect(await store.recordDelivery(accountId, { ...fail, messageExternalId: incoming.externalId })).toBe(
      false,
    );
  });

  it('counts unread messages itself unless the messenger reports a counter', async () => {
    await store.ingest(accountId, [message(), message()]);
    const chat = (await store.findChatByExternalId(accountId, 'chat-ann'))!;
    expect(chat.unread).toBe(2);
    await store.ingest(accountId, [message({ direction: 'out' })]);
    expect((await store.getChat(accountId, chat.id))!.unread).toBe(0);
    await store.ingest(accountId, [message({ chat: { externalId: 'chat-ann', kind: 'direct', unread: 7 } })]);
    expect((await store.getChat(accountId, chat.id))!.unread).toBe(7);
    await store.ingest(accountId, [
      message({ direction: 'out', chat: { externalId: 'chat-ann', kind: 'direct', unread: 7 } }),
    ]);
    expect((await store.getChat(accountId, chat.id))!.unread).toBe(7);
    await store.markChatRead(chat.id);
    expect((await store.listChats(accountId, { unreadOnly: true, limit: 5 })).items).toEqual([]);
  });

  it('pages chats, filtered by title words', async () => {
    for (const name of ['Alpha team', 'Beta team', 'Gamma', 'Delta team']) {
      await store.ingest(accountId, [message({ chat: { externalId: name, kind: 'group', title: name } })]);
    }
    const first = await store.listChats(accountId, { query: 'team', limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const second = await store.listChats(accountId, { query: 'team', limit: 2, cursor: first.nextCursor! });
    const titles = [...first.items, ...second.items].map((c) => c.title).sort();
    expect(titles).toEqual(['Alpha team', 'Beta team', 'Delta team']);
    expect(second.items.every((c) => c.lastMessageAt)).toBe(true);
    expect((await store.listChats(accountId, { query: 'zeta', limit: 2 })).items).toEqual([]);
  });

  it('searches by chat, sender and time, with a cursor to older messages', async () => {
    const replied = message({ text: 'invoice for March' });
    await store.ingest(accountId, [replied]);
    await store.ingest(accountId, [
      message({ text: 'invoice for April', replyToExternalId: replied.externalId }),
      message({ text: 'invoice for May', sender: { name: 'Bob' } }),
      message({ text: 'invoice for June', sender: {} }),
      message({ text: 'lunch?', chat: { externalId: 'chat-bob', kind: 'direct', title: 'Bob' } }),
    ]);
    const chat = (await store.findChatByExternalId(accountId, 'chat-ann'))!;
    const page1 = await store.search(accountId, { query: 'invoice', chatId: chat.id, limit: 2 });
    expect(page1.items.map((m) => m.text)).toEqual(['invoice for June', 'invoice for May']);
    expect(page1.items[0]!.sender).toBeUndefined();
    expect(page1.items[1]!.sender).toEqual({ name: 'Bob' });
    const page2 = await store.search(accountId, {
      query: 'invoice',
      chatId: chat.id,
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.map((m) => m.text)).toEqual(['invoice for April', 'invoice for March']);
    expect(page2.items[0]!.replyTo).toBe(page2.items[1]!.id);
    expect((await store.search(accountId, { from: 'Bob', limit: 5 })).items.map((m) => m.text)).toEqual([
      'invoice for May',
    ]);
    const since = new Date(t0 + (seq - 1) * 1000);
    expect((await store.search(accountId, { since, limit: 5 })).items.map((m) => m.text)).toEqual([
      'lunch?',
      'invoice for June',
    ]);
    expect((await store.search(accountId, { until: new Date(t0), limit: 5 })).items).toEqual([]);
  });

  it('reads a chat page by page and knows no chat of another account', async () => {
    await store.ingest(accountId, [message(), message(), message()]);
    const chat = (await store.findChatByExternalId(accountId, 'chat-ann'))!;
    const latest = await store.readChat(accountId, { chatId: chat.id, limit: 2 });
    expect(latest!.messages).toHaveLength(2);
    const older = await store.readChat(accountId, { chatId: chat.id, limit: 2, before: latest!.nextCursor! });
    expect(older!.messages).toHaveLength(1);
    expect(older!.nextCursor).toBeUndefined();
    expect(await store.readChat(otherAccount, { chatId: chat.id, limit: 2 })).toBeUndefined();
    expect(await store.getMessage(otherAccount, latest!.messages[0]!.id)).toBeUndefined();
    expect((await store.getMessage(accountId, latest!.messages[0]!.id))?.id).toBe(latest!.messages[0]!.id);
    expect((await store.latestInbound(chat.id))?.id).toBe(latest!.messages[1]!.id);
  });

  it('follows what is new with cursors, and starts at the end when nothing is', async () => {
    expect(await store.whatsNew([], { cursor: 'x', sinceHours: 1, includeOwn: false, limit: 5 })).toEqual({
      messages: [],
      cursor: 'x',
      hasMore: false,
    });
    const empty = await store.whatsNew([accountId], { sinceHours: 1, includeOwn: false, limit: 5 });
    expect(empty.messages).toEqual([]);
    // Messages become visible a moment after they are stored.
    await store.ingest(accountId, [message(), message({ direction: 'out' }), message()]);
    await hub.services.db.execute(
      sql`update messenger_messages set created_at = created_at - interval '1 minute'`,
    );
    const fresh = await store.whatsNew([accountId], {
      cursor: empty.cursor,
      sinceHours: 1,
      includeOwn: false,
      limit: 1,
    });
    expect(fresh.messages).toHaveLength(1);
    expect(fresh.hasMore).toBe(true);
    const rest = await store.whatsNew([accountId], {
      cursor: fresh.cursor,
      sinceHours: 1,
      includeOwn: true,
      limit: 5,
    });
    expect(rest.messages.map((m) => m.direction)).toEqual(['out', 'in']);
    const none = await store.whatsNew([accountId], {
      cursor: rest.cursor,
      sinceHours: 1,
      includeOwn: true,
      limit: 5,
    });
    expect(none).toEqual({ messages: [], cursor: rest.cursor, hasMore: false });
    const chat = (await store.findChatByExternalId(accountId, 'chat-ann'))!;
    const inChat = await store.whatsNew([accountId], {
      sinceHours: 2,
      includeOwn: false,
      limit: 5,
      chatId: chat.id,
    });
    expect(inChat.messages).toHaveLength(2);

    const since = await store.arrivedSince(undefined);
    expect(since.accountIds).toBeUndefined();
    expect((await store.arrivedSince(0)).accountIds).toEqual([accountId]);
    expect((await store.arrivedSince(since.latest)).accountIds).toEqual([]);
    // Waiting on a reply starts right after the account's own last message in the chat.
    expect(await store.replyCursor(accountId, chat.id)).not.toBe(await store.replyCursor(accountId));
    expect(await store.replyCursor(otherAccount, 'cht_none')).toBe(await store.replyCursor(otherAccount));
  });

  it('skips history older than the account keeps and prunes what passed its date', async () => {
    await hub.services.db
      .update(accounts)
      .set({ settings: sql`jsonb_build_object('keepMessagesDays', 1)` })
      .where(eq(accounts.id, otherAccount));
    await hub.services.db
      .update(accounts)
      .set({ settings: sql`jsonb_build_object('keepMessagesDays', 0)` })
      .where(eq(accounts.id, accountId));
    const old = new Date(Date.now() - 3 * 86_400_000);
    // Nothing was stored for this account yet, so its setting is read now (and then cached).
    const stored = await store.ingest(otherAccount, [message({ sentAt: old }), message()]);
    expect(stored).toHaveLength(1);
    await store.ingest(accountId, [message({ sentAt: old })]);
    await hub.services.db
      .update(messengerMessages)
      .set({ sentAt: old })
      .where(eq(messengerMessages.accountId, otherAccount));
    expect(await store.prune({ batch: 1 })).toBe(1);
    // An account with a zero setting keeps everything.
    expect((await store.search(accountId, { limit: 5 })).items).toHaveLength(1);
    expect(await store.prune({ maxBatches: 0 })).toBe(0);
  });
});
