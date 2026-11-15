import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mailSearch } from '../src/connectors/builtin/email/capability.js';
import { ConnectorError, defineConnector } from '../src/connectors/sdk.js';
import type { AccountRow } from '../src/core/accounts.js';
import { messengerChats, messengerMessages } from '../src/db/schema.js';
import { MailSource, MessageSource } from '../src/triggers/sources.js';
import { registryWithFakeChat } from './fake-messenger.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

/** What the mailbox returns, per folder; a folder set to an error throws it. */
const folders: Record<string, Array<Record<string, unknown>> | Error> = {};
const mailbox = defineConnector({
  id: 'oddmail',
  name: 'OddMail',
  description: 'A mailbox with odd answers',
  version: '1.0.0',
  config: z.object({}),
  actions: (action) => [
    action({
      name: 'search',
      description: 'Searches mail.',
      input: z.object({ folder: z.string().default('all'), since: z.string().optional() }),
      hints: { readOnly: true },
      capability: mailSearch((input) => ({
        ...(input.folder ? { folder: input.folder } : {}),
        ...(input.since ? { since: input.since } : {}),
      })),
      run: ({ folder }) => {
        const answer = folders[folder] ?? [];
        if (answer instanceof Error) throw answer;
        return { messages: answer };
      },
    }),
  ],
});

/**
 * The event sources of triggers on odd input: mail without ids or dates, a mailbox without a spam
 * folder or with a broken one, cursors that are not dates; messages with only files, a sender known
 * by id only, deleted messages, and a quiet last hour.
 */
describe('trigger event sources', () => {
  let hub: TestHub;
  let mail: MailSource;
  let messages: MessageSource;
  let mailAccount: AccountRow;
  let chatAccount: AccountRow;
  const signal = () => AbortSignal.timeout(10_000);
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({
      connectors: (deps) => registryWithFakeChat(deps).register(mailbox),
      seed: false,
    });
    const s = hub.services;
    const workspaceId = (await s.db.query.workspaces.findFirst())!.id;
    mailAccount = await s.accounts.create(workspaceId, {
      connectorId: 'oddmail',
      name: 'work',
      label: 'Work',
      credentials: {},
    });
    chatAccount = await s.accounts.create(workspaceId, {
      connectorId: 'fakechat',
      name: 'main',
      label: 'Main',
      credentials: {},
    });
    mail = new MailSource({ accounts: s.accounts, connectors: s.connectors, logger: s.logger });
    messages = new MessageSource({
      accounts: s.accounts,
      connectors: s.connectors,
      store: s.messaging.store,
    });
  });

  beforeEach(async () => {
    for (const key of Object.keys(folders)) delete folders[key];
    await hub.services.db.delete(messengerMessages);
    await hub.services.db.delete(messengerChats);
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('takes mail with an id, dated or not, and flags bulk mail', async () => {
    folders.inbox = [
      {
        id: 'm1',
        from: 'ann@example.com',
        subject: 'Invoice',
        snippet: 'Please pay',
        date: minutesAgo(1),
        bulk: true,
      },
      { id: 'm2', date: minutesAgo(2) },
      { subject: 'No id: skipped', date: minutesAgo(1) },
      { id: 'm3', subject: 'No date' },
    ];
    const { items, cursor } = await mail.read(mailAccount, minutesAgo(5), signal());
    expect(items.map((i) => i.id).sort()).toEqual(['m1', 'm2', 'm3']);
    expect(items.find((i) => i.id === 'm1')).toMatchObject({
      bulk: true,
      from: 'ann@example.com',
      subject: 'Invoice',
    });
    expect(items.find((i) => i.id === 'm2')).toEqual(
      expect.not.objectContaining({ from: expect.anything() }),
    );
    expect(items.find((i) => i.id === 'm2')!.text).toBe('');
    expect(Date.parse(cursor)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('skips what an untouched cursor has seen, and catches late mail within the overlap', async () => {
    folders.inbox = [
      { id: 'old', date: minutesAgo(30) },
      { id: 'late', date: minutesAgo(8) },
      { id: 'new', date: minutesAgo(1) },
    ];
    const strict = await mail.read(mailAccount, `!${minutesAgo(5)}`, signal());
    expect(strict.items.map((i) => i.id)).toEqual(['new']);
    const overlap = await mail.read(mailAccount, minutesAgo(5), signal());
    expect(overlap.items.map((i) => i.id).sort()).toEqual(['late', 'new']);
    // A cursor that is not a date counts from now (with the overlap): the old mail stays out.
    const garbage = await mail.read(mailAccount, 'garbage', signal());
    expect(garbage.items.map((i) => i.id).sort()).toEqual(['late', 'new']);
  });

  it('reads spam when asked, and still delivers the inbox of a mailbox without a spam folder', async () => {
    folders.inbox = [{ id: 'in', date: minutesAgo(1) }];
    folders.junk = [{ id: 'spam', date: minutesAgo(1) }];
    const [plain, withSpam] = await mail.readMany(
      mailAccount,
      [{ cursor: minutesAgo(5) }, { cursor: minutesAgo(5), options: { spam: true } }],
      signal(),
    );
    expect(plain!.items.map((i) => i.id)).toEqual(['in']);
    expect(withSpam!.items.map((i) => i.id).sort()).toEqual(['in', 'spam']);

    folders.junk = new ConnectorError('not_found', 'No such folder');
    const [noSpam] = await mail.readMany(
      mailAccount,
      [{ cursor: minutesAgo(5), options: { spam: true } }],
      signal(),
    );
    expect(noSpam!.items.map((i) => i.id)).toEqual(['in']);

    folders.junk = new ConnectorError('upstream', 'Server error');
    await expect(
      mail.readMany(mailAccount, [{ cursor: minutesAgo(5), options: { spam: true } }], signal()),
    ).rejects.toThrow('Server error');
    expect(await mail.readMany(mailAccount, [], signal())).toEqual([]);
  });

  it('reads nothing from accounts that are not mailboxes', async () => {
    expect(await mail.reads(chatAccount)).toBe(false);
    expect(await mail.reads(mailAccount)).toBe(true);
    expect(await mail.read(chatAccount, 'c', signal())).toEqual({ items: [], cursor: 'c' });
    expect((await mail.start()).startsWith('!')).toBe(true);
    folders.inbox = [
      { id: 'a', date: minutesAgo(60) },
      { id: 'b', date: minutesAgo(10) },
    ];
    expect((await mail.recent(mailAccount, signal())).map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('turns messages into events: files named, senders by id, deleted and own messages left out', async () => {
    const store = hub.services.messaging.store;
    const chat = { externalId: 'chat-1', kind: 'direct' as const, title: 'Ann' };
    const at = (m: number) => new Date(Date.now() - m * 60_000);
    await store.ingest(chatAccount.id, [
      {
        chat,
        externalId: 'f',
        direction: 'in',
        sentAt: at(3),
        sender: { externalId: 'u-1' },
        attachments: [
          { externalId: 'a', kind: 'document', name: 'invoice.pdf' },
          { externalId: 'b', kind: 'photo' },
        ],
      },
      { chat, externalId: 'gone', direction: 'in', sentAt: at(2), text: 'oops', deleted: true },
      { chat, externalId: 'mine', direction: 'out', sentAt: at(1), text: 'my reply' },
    ]);
    // Rows become visible to cursors a moment after they are stored.
    await hub.services.database.pool.query(
      `UPDATE messenger_messages SET created_at = now() - interval '1 minute'`,
    );
    const recent = await messages.recent(chatAccount);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      from: 'u-1',
      text: '[document: invoice.pdf] [photo]',
      chatTitle: 'Ann',
    });
    expect(await messages.reads(chatAccount)).toBe(true);
    expect(await messages.reads(mailAccount)).toBe(false);
    const { mark } = await messages.changes(undefined);
    expect((await messages.changes(mark)).accountIds).toEqual([]);
  });

  it('looks back a day when the last hour was quiet', async () => {
    const store = hub.services.messaging.store;
    await store.ingest(chatAccount.id, [
      {
        chat: { externalId: 'chat-2', kind: 'direct', title: 'Bob' },
        externalId: 'yesterday',
        direction: 'in',
        sentAt: new Date(Date.now() - 5 * 3_600_000),
        text: 'Are we on?',
      },
    ]);
    await hub.services.database.pool.query(
      `UPDATE messenger_messages SET created_at = now() - interval '1 minute'`,
    );
    expect((await messages.recent(chatAccount)).map((i) => i.text)).toEqual(['Are we on?']);
    await hub.services.db.delete(messengerMessages);
    expect(await messages.recent(chatAccount)).toEqual([]);
  });
});
