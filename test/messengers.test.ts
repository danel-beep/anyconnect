import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../src/core/principal.js';
import { messengerChats, messengerMessages, messengerOutbox } from '../src/db/schema.js';
import { resetDatabase, startTestHub, type TestHub, unwrapUntrusted } from './helpers.js';

const BOT_TOKEN = '123456789:AAEhBP0av18aaaaaaaaaaaaaaaaaaaaaaaa';
const APP_SECRET = '0123456789abcdef0123456789abcdef';

const TEMPLATES = [
  {
    name: 'order_ready',
    language: 'en_US',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Your order' },
      { type: 'BODY', text: 'Hi {{1}}, order {{2}} is ready. Thank you, {{1}}!' },
    ],
  },
  {
    name: 'order_ready',
    language: 'ru',
    status: 'APPROVED',
    category: 'UTILITY',
    parameter_format: 'NAMED',
    components: [{ type: 'BODY', text: 'Здравствуйте, {{name}}! Заказ {{order}} готов.' }],
  },
  {
    name: 'promo_photo',
    language: 'en_US',
    status: 'APPROVED',
    components: [
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'New arrivals' },
    ],
  },
  { name: 'draft_one', language: 'en_US', status: 'PENDING', components: [{ type: 'BODY', text: 'x' }] },
];

/** A fake Telegram Bot API and Meta Graph API on one local port. */
async function startFakeApis() {
  const calls: { path: string; body: any; auth?: string | undefined }[] = [];
  let nextMessageId = 500;
  let failNext: { status: number; body: unknown } | undefined;
  const app = new Hono();
  // Files the hub downloads to upload them to Telegram itself.
  app.get('/files/:name', (c) =>
    c.body(new TextEncoder().encode(`contents of ${c.req.param('name')}`), 200, {
      'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
  );
  app.get('/huge', (c) => c.body(new Uint8Array(21 * 1_048_576), 200));
  app.post('/:token/:method', async (c) => {
    let body: any;
    if (c.req.header('content-type')?.startsWith('multipart/form-data')) {
      body = {};
      for (const [key, value] of (await c.req.formData()).entries()) {
        body[key] = typeof value === 'string' ? value : { filename: value.name, text: await value.text() };
      }
    } else body = await c.req.json().catch(() => ({}));
    calls.push({ path: `${c.req.param('method')}`, body });
    if (c.req.param('token') !== `bot${BOT_TOKEN}`) {
      return c.json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
    }
    if (failNext) {
      const f = failNext;
      failNext = undefined;
      return c.json(f.body as object, f.status as 429);
    }
    switch (c.req.param('method')) {
      case 'getMe':
        return c.json({ ok: true, result: { id: 123456789, is_bot: true, username: 'shop_bot' } });
      case 'setWebhook':
      case 'readBusinessMessage':
        return c.json({ ok: true, result: true });
      case 'sendMessage':
      case 'sendPhoto':
      case 'sendVoice':
      case 'sendDocument':
        return c.json({
          ok: true,
          result: {
            message_id: nextMessageId++,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 42, type: 'private' },
            // Uploaded documents come back as Telegram stores them.
            ...(typeof body.document === 'object'
              ? {
                  document: {
                    file_id: 'DOC-FILE-ID',
                    file_unique_id: 'DOC-U',
                    file_name: body.document.filename,
                  },
                }
              : {}),
          },
        });
      default:
        return c.json({ ok: false, error_code: 404, description: 'Not Found' }, 404);
    }
  });
  app.on(['GET', 'POST'], '/v23.0/*', async (c) => {
    const body = c.req.method === 'POST' ? await c.req.json().catch(() => ({})) : undefined;
    calls.push({ path: c.req.path, body, auth: c.req.header('authorization') });
    if (c.req.path === '/v23.0/1111111111/messages') {
      if (body?.status === 'read') return c.json({ success: true });
      return c.json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.${nextMessageId++}` }] });
    }
    if (c.req.path === '/v23.0/1111111111')
      return c.json({ display_phone_number: '+1 555 0100', id: '1111111111' });
    if (c.req.path === '/v23.0/2222222222/subscribed_apps') return c.json({ success: true });
    if (c.req.path === '/v23.0/2222222222/message_templates') {
      const name = c.req.query('name');
      return c.json({ data: TEMPLATES.filter((t) => !name || t.name === name) });
    }
    return c.json({ error: { message: 'unknown path', code: 100 } }, 400);
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    calls,
    failNextWith(status: number, body: unknown) {
      failNext = { status, body };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('messengers over official APIs (Telegram Bot API, WhatsApp Cloud API)', () => {
  let hub: TestHub;
  let apis: Awaited<ReturnType<typeof startFakeApis>>;
  let principal: Principal;

  const call = async (tool: string, args: Record<string, unknown>) => {
    const catalog = await hub.services.hub.getCatalog(principal);
    return hub.services.hub.callTool(principal, catalog, tool, args);
  };
  const json = (result: { content: { type: string; text?: string }[]; isError?: boolean }) => {
    const text = result.content[0]?.text ?? '';
    if (result.isError) throw new Error(text);
    return JSON.parse(unwrapUntrusted(text));
  };

  beforeAll(async () => {
    await resetDatabase();
    apis = await startFakeApis();
  });

  beforeEach(async () => {
    await hub?.close();
    apis.calls.length = 0;
    // Out-of-band confirmations answer at once instead of waiting for the user.
    hub = await startTestHub({
      env: { ALLOW_PRIVATE_NETWORK: 'true', CONFIRMATION_WAIT_SECONDS: '0' },
      seed: false,
    });
    const workspace = (await hub.services.db.query.workspaces.findFirst())!;
    const user = (await hub.services.db.query.users.findFirst())!;
    principal = { kind: 'session', userId: user.id, workspaceId: workspace.id, scopes: ['mcp', 'api'] };
    hub.services.messaging.start();
    // Sending asks the user first by default; these tests are about delivery, so the user said
    // "do not ask" for both services (the default is checked in its own test).
    for (const connectorId of ['telegram', 'whatsapp']) {
      await hub.services.policies.createRule(workspace.id, { connectorId, confirm: 'never' });
    }
  });

  afterAll(async () => {
    await hub?.close();
    await apis.close();
  });

  async function addBot() {
    const account = await hub.services.accounts.create(principal.workspaceId, {
      connectorId: 'telegram',
      name: 'shop',
      label: 'Магазин',
      config: { mode: 'bot', botApiUrl: apis.url },
      credentials: { botToken: BOT_TOKEN },
    });
    const test = await hub.services.accounts.test(principal.workspaceId, account.id, hub.services.logger);
    expect(test).toMatchObject({ ok: true, identity: '@shop_bot' });
    return account;
  }

  const botUpdate = (
    id: number,
    text: string,
    from = { id: 42, first_name: 'Анна', last_name: 'Петрова' },
  ) => ({
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000) - 60,
      chat: { id: 42, type: 'private', first_name: from.first_name, last_name: from.last_name },
      from,
      text,
    },
  });

  async function postTelegram(accountId: string, update: unknown, secret?: string) {
    const hook = hub.services.messaging.service.forAccount(accountId).webhook();
    return fetch(`${hub.baseUrl}/hooks/messenger/${accountId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': secret ?? hook.secret,
      },
      body: JSON.stringify(update),
    });
  }

  it('registers the webhook, stores incoming messages encrypted and answers from the store', async () => {
    const account = await addBot();
    const setWebhook = apis.calls.find((c) => c.path === 'setWebhook');
    expect(setWebhook?.body.url).toBe(`${hub.baseUrl}/hooks/messenger/${account.id}`);
    expect(setWebhook?.body.secret_token).toHaveLength(43);

    expect((await postTelegram(account.id, botUpdate(1, 'Привет'), 'wrong')).status).toBe(401);
    expect(
      (await postTelegram(account.id, botUpdate(1, 'Здравствуйте! Когда будет готов счёт за ноябрь?')))
        .status,
    ).toBe(200);
    // Telegram retries webhooks: the same update must not create a second message.
    expect(
      (await postTelegram(account.id, botUpdate(1, 'Здравствуйте! Когда будет готов счёт за ноябрь?')))
        .status,
    ).toBe(200);
    await postTelegram(account.id, botUpdate(2, 'И ещё вопрос про доставку'));

    const chats = json(await call('telegram_list_chats', {}));
    expect(chats.chats).toEqual([
      expect.objectContaining({
        title: 'Анна Петрова',
        kind: 'direct',
        unread: 2,
        id: expect.stringMatching(/^cht_/),
      }),
    ]);
    // What other people wrote reaches the AI marked as third-party data.
    const marked = await call('telegram_search', { query: 'счета ноябрь' });
    expect((marked.content[0] as { text: string }).text).toMatch(/^⟦untrusted \w+ source="Telegram · shop"⟧/);
    const found = json(await call('telegram_search', { query: 'счета ноябрь' }));
    expect(found.messages).toHaveLength(1);
    expect(found.messages[0]).toMatchObject({
      from: 'Анна Петрова',
      from_id: '42',
      direction: 'in',
      chat: 'Анна Петрова',
    });
    // Empty lists are left out of results (hub-wide compaction).
    expect(json(await call('telegram_search', { query: 'декабрь' })).messages).toBeUndefined();
    expect(json(await call('telegram_search', { from: 'анна' })).messages).toHaveLength(2);
    expect(json(await call('telegram_list_chats', { query: 'петров' })).chats).toHaveLength(1);

    const read = json(await call('telegram_read_chat', { chat: chats.chats[0].id }));
    expect(read.messages.map((m: { text: string }) => m.text)).toEqual([
      'Здравствуйте! Когда будет готов счёт за ноябрь?',
      'И ещё вопрос про доставку',
    ]);

    // Nothing readable is stored in clear.
    const raw = JSON.stringify([
      ...(await hub.services.db.select().from(messengerMessages)),
      ...(await hub.services.db.select().from(messengerChats)),
    ]);
    for (const secret of ['счёт', 'Анна', 'Петрова', 'доставку', '"42"']) expect(raw).not.toContain(secret);
  });

  it("encrypts stored messages with the account's own data key", async () => {
    const account = await addBot();
    await postTelegram(account.id, botUpdate(3, 'Секретный номер заказа 7781'));
    const [row] = await hub.services.db
      .select()
      .from(messengerMessages)
      .where(eq(messengerMessages.accountId, account.id));
    const [chat] = await hub.services.db
      .select()
      .from(messengerChats)
      .where(eq(messengerChats.accountId, account.id));
    const context = `messenger:message:${row!.id}`;
    // A data-key envelope, which the master key alone cannot open.
    expect(row!.bodyEncrypted).toMatch(/^d1\./);
    expect(chat!.infoEncrypted).toMatch(/^d1\./);
    expect(() => hub.services.secrets.decryptJson(row!.bodyEncrypted, context)).toThrow();

    // Another account's key cannot open it either, even with the right context.
    const other = await hub.services.accounts.create(principal.workspaceId, {
      connectorId: 'telegram',
      name: 'other',
      label: 'Другой',
      config: { mode: 'bot', botApiUrl: apis.url },
      credentials: { botToken: BOT_TOKEN },
    });
    const foreign = await hub.services.messaging.ciphers.forAccount(other.id);
    expect(() => foreign.decryptJson(row!.bodyEncrypted, context)).toThrow();

    // Rows written with the master key before per-account keys stay readable.
    const body = { externalId: '3', text: 'Старая запись', attachments: [] };
    await hub.services.db
      .update(messengerMessages)
      .set({ bodyEncrypted: hub.services.secrets.encryptJson(body, context) })
      .where(eq(messengerMessages.id, row!.id));
    const read = json(await call('telegram_read_chat', { account: 'shop', chat: chat!.id }));
    expect(read.messages.map((m: { text: string }) => m.text)).toEqual(['Старая запись']);
  });

  it("handles the user's own chats through Telegram Business", async () => {
    const account = await addBot();
    expect(apis.calls.find((c) => c.path === 'setWebhook')?.body.allowed_updates).toContain(
      'business_message',
    );
    const client = { id: 77, first_name: 'Maria', username: 'maria_k' };
    const owner = { id: 900, first_name: 'Danel' };
    const business = (
      id: number,
      from: { id: number; first_name: string },
      text: string,
      edited = false,
    ) => ({
      update_id: 1000 + id,
      [edited ? 'edited_business_message' : 'business_message']: {
        message_id: id,
        business_connection_id: 'BC1',
        date: Math.floor(Date.now() / 1000) - 30,
        ...(edited ? { edit_date: Math.floor(Date.now() / 1000) } : {}),
        chat: { id: 77, type: 'private', first_name: 'Maria', username: 'maria_k' },
        from,
        text,
      },
    });
    await postTelegram(account.id, business(10, client, 'Can we move the call to Friday?'));
    await postTelegram(account.id, business(11, owner, 'Let me check'));
    await postTelegram(account.id, business(12, client, 'Thanks! Also, the contract draft'));
    await postTelegram(
      account.id,
      business(12, client, 'Thanks! Also, the contract draft is attached', true),
    );

    const [chat] = json(await call('telegram_list_chats', {})).chats;
    expect(chat).toMatchObject({ title: 'Maria', username: 'maria_k', kind: 'direct' });
    const read = json(await call('telegram_read_chat', { chat: chat.id }));
    expect(read.messages.map((m: { direction: string; text: string }) => [m.direction, m.text])).toEqual([
      ['in', 'Can we move the call to Friday?'],
      ['out', 'Let me check'],
      ['in', 'Thanks! Also, the contract draft is attached'],
    ]);

    // Replies go through the business connection, as the user.
    const sent = json(
      await call('telegram_send', { chat: chat.id, text: 'Friday works', reply_to: read.messages[2].id }),
    );
    expect(sent.status).toBe('sent');
    const request = apis.calls.filter((c) => c.path === 'sendMessage').at(-1);
    expect(request?.body).toMatchObject({
      chat_id: '77',
      business_connection_id: 'BC1',
      text: 'Friday works',
      reply_parameters: { message_id: 12 },
    });

    // Read receipts work in business chats.
    await call('telegram_mark_read', { chat: chat.id });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await hub.services.messaging.dispatcher.tick();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(apis.calls.find((c) => c.path === 'readBusinessMessage')?.body).toEqual({
      business_connection_id: 'BC1',
      chat_id: 77,
      message_id: 12,
    });

    // A message deleted on the phone loses its text in the hub's copy.
    await postTelegram(account.id, {
      update_id: 2000,
      deleted_business_messages: {
        business_connection_id: 'BC1',
        chat: { id: 77, type: 'private', first_name: 'Maria' },
        message_ids: [10],
      },
    });
    const after = json(await call('telegram_read_chat', { chat: chat.id }));
    expect(after.messages[0]).toMatchObject({ deleted: true });
    expect(after.messages[0].text ?? '').toBe('');
    expect(json(await call('telegram_search', { query: 'friday call' })).messages).toBeUndefined();
  });

  it('asks the user before sending, by default', async () => {
    const account = await addBot();
    await postTelegram(account.id, botUpdate(9, 'Пришлите счёт'));
    for (const rule of await hub.services.policies.listRules(principal.workspaceId)) {
      await hub.services.policies.deleteRule(principal.workspaceId, rule.id);
    }
    const [chat] = json(await call('telegram_list_chats', {})).chats;
    const held = await call('telegram_send', { chat: chat.id, text: 'Отправил' });
    expect(JSON.stringify(held.content)).toContain('/confirm/');
    expect(apis.calls.filter((c) => c.path === 'sendMessage')).toHaveLength(0);
  });

  it('follows new messages with a cursor', async () => {
    const account = await addBot();
    await postTelegram(account.id, botUpdate(1, 'первое'));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const first = json(await call('telegram_whats_new', {}));
    expect(first.messages.map((m: { text: string }) => m.text)).toEqual(['первое']);
    await postTelegram(account.id, botUpdate(2, 'второе'));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = json(await call('telegram_whats_new', { cursor: first.cursor }));
    expect(second.messages.map((m: { text: string }) => m.text)).toEqual(['второе']);
    const none = json(await call('telegram_whats_new', { cursor: second.cursor }));
    expect(none.messages).toBeUndefined();
    expect(none.cursor).toBe(second.cursor);
  });

  it('sends through the outbox once, records the message and reports Telegram errors', async () => {
    const account = await addBot();
    await postTelegram(account.id, botUpdate(7, 'Можно счёт?'));
    const [chat] = json(await call('telegram_list_chats', {})).chats;
    const [incoming] = json(await call('telegram_read_chat', { chat: chat.id })).messages;

    const sent = json(
      await call('telegram_send', { chat: chat.id, text: 'Да, отправлю сегодня', reply_to: incoming.id }),
    );
    expect(sent).toMatchObject({ status: 'sent', id: expect.stringMatching(/^msg_/) });
    const request = apis.calls.find((c) => c.path === 'sendMessage');
    expect(request?.body).toMatchObject({
      chat_id: '42',
      text: 'Да, отправлю сегодня',
      reply_parameters: { message_id: 7 },
    });

    // A retry of the same request by the AI client is caught by the hub's duplicate protection...
    const again = await call('telegram_send', {
      chat: chat.id,
      text: 'Да, отправлю сегодня',
      reply_to: incoming.id,
    });
    expect(again.content[0]).toMatchObject({ text: expect.stringContaining('Not repeated') });
    // ...and by the outbox itself, which also covers requests that bypass the hub's window.
    const direct = await hub.services.messaging.service
      .forAccount(account.id)
      .send({ chatId: chat.id, text: 'Да, отправлю сегодня', replyTo: incoming.id });
    expect(direct).toMatchObject({ status: 'sent', deduplicated: true, messageId: sent.id });
    expect(apis.calls.filter((c) => c.path === 'sendMessage')).toHaveLength(1);

    const history = json(await call('telegram_read_chat', { chat: chat.id }));
    expect(history.messages.at(-1)).toMatchObject({
      direction: 'out',
      from: 'me',
      text: 'Да, отправлю сегодня',
      reply_to: incoming.id,
    });
    expect(history.chat.unread).toBe(0);

    apis.failNextWith(403, {
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    const blocked = await call('telegram_send', { chat: chat.id, text: 'Ещё одно сообщение' });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]).toMatchObject({ text: expect.stringContaining('bot was blocked') });
  });

  it('sends files by link, with the text as caption', async () => {
    const account = await addBot();
    await postTelegram(account.id, botUpdate(7, 'Пришлите фото товара'));
    const [chat] = json(await call('telegram_list_chats', {})).chats;

    const photo = json(
      await call('telegram_send', {
        chat: chat.id,
        text: 'Вот он',
        file_url: 'https://cdn.example.com/items/lamp.JPG?v=2',
      }),
    );
    expect(photo.status).toBe('sent');
    expect(apis.calls.find((c) => c.path === 'sendPhoto')?.body).toMatchObject({
      chat_id: '42',
      photo: 'https://cdn.example.com/items/lamp.JPG?v=2',
      caption: 'Вот он',
    });
    json(
      await call('telegram_send', {
        chat: chat.id,
        file_url: 'https://cdn.example.com/docs/price%20list.pdf',
      }),
    );
    const doc = apis.calls.find((c) => c.path === 'sendDocument')?.body;
    expect(doc).toEqual({ chat_id: '42', document: 'https://cdn.example.com/docs/price%20list.pdf' });

    // The hub's copy shows what was sent.
    const read = json(await call('telegram_read_chat', { chat: chat.id }));
    expect(read.messages.at(-1).attachments).toEqual([
      expect.objectContaining({ kind: 'document', name: 'price list.pdf' }),
    ]);

    // Only https links, captions within the messenger's limit, and something to send.
    expect(
      (await call('telegram_send', { chat: chat.id, file_url: 'http://example.com/a.pdf' })).isError,
    ).toBe(true);
    const long = await call('telegram_send', {
      chat: chat.id,
      text: 'x'.repeat(1100),
      file_url: 'https://example.com/a.pdf',
    });
    expect((long.content[0] as { text: string }).text).toContain('at most 1024');
    expect((await call('telegram_send', { chat: chat.id })).isError).toBe(true);

    // A file sent by link has no copy in the hub: get_attachment says where it came from.
    const pdf = read.messages.at(-1);
    const missing = await call('telegram_get_attachment', { message: pdf.id, attachment: 'a0' });
    expect((missing.content[0] as { text: string }).text).toContain('price%20list.pdf');
  });

  it('uploads files Telegram cannot fetch by link, with their own name', async () => {
    const account = await addBot();
    await postTelegram(account.id, botUpdate(8, 'Send the contract'));
    const [chat] = json(await call('telegram_list_chats', {})).chats;
    const port = hub.services.messaging.service.forAccount(account.id);
    const sent = await port.send({
      chatId: chat.id,
      text: 'Here it is',
      file: { url: `${apis.url}/files/contract.docx`, kind: 'document', name: 'Contract v2.docx' },
    });
    expect(sent.status).toBe('sent');
    const upload = apis.calls.filter((c) => c.path === 'sendDocument').at(-1)?.body;
    expect(upload).toMatchObject({
      chat_id: '42',
      caption: 'Here it is',
      document: { filename: 'Contract v2.docx', text: 'contents of contract.docx' },
    });
    // The stored copy points at Telegram's file, like a received one.
    const [message] = await hub.services.db
      .select()
      .from(messengerMessages)
      .where(eq(messengerMessages.direction, 'out'));
    const stored = await hub.services.messaging.store.getMessage(account.id, message!.id);
    expect(stored?.body.attachments[0]).toMatchObject({
      kind: 'document',
      locator: { fileId: 'DOC-FILE-ID' },
    });

    // Voice notes go as voice; oversized downloads fail cleanly instead of filling memory.
    await port.send({
      chatId: chat.id,
      text: '',
      file: { url: 'https://cdn.example.com/a.ogg', kind: 'audio' },
    });
    expect(apis.calls.find((c) => c.path === 'sendVoice')?.body.voice).toBe('https://cdn.example.com/a.ogg');
    const huge = await port.send({
      chatId: chat.id,
      text: '',
      file: { url: `${apis.url}/huge`, kind: 'document', name: 'big.bin' },
    });
    expect(huge).toMatchObject({ status: 'failed', error: expect.stringContaining('larger than 20 MB') });
  });

  it('waits out Telegram flood limits instead of failing', async () => {
    const account = await addBot();
    await postTelegram(account.id, botUpdate(3, 'Привет'));
    const [chat] = json(await call('telegram_list_chats', {})).chats;
    const started = Date.now();
    apis.failNextWith(429, {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 600',
      parameters: { retry_after: 600 },
    });
    const queued = json(await call('telegram_send', { chat: chat.id, text: 'Ответ' }));
    expect(queued.status).toBe('queued');
    expect(new Date(queued.eta).getTime()).toBeGreaterThan(Date.now() + 590_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    const state = await hub.services.messaging.accounts.get(account.id);
    expect(state?.sendPausedUntil?.getTime()).toBeGreaterThan(Date.now() + 590_000);
    const [job] = await hub.services.db.select().from(messengerOutbox);
    expect(job?.status).toBe('queued');
  });

  it('does not let a bot start conversations by phone number', async () => {
    await addBot();
    const result = await call('telegram_send', { to: '+79991234567', text: 'Привет' });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('existing chats') });
  });

  describe('WhatsApp Cloud API', () => {
    async function addNumber() {
      const account = await hub.services.accounts.create(principal.workspaceId, {
        connectorId: 'whatsapp',
        name: 'business',
        label: 'Бизнес-номер',
        config: { mode: 'cloud', phoneNumberId: '1111111111', wabaId: '2222222222', graphApiUrl: apis.url },
        credentials: { accessToken: 'EAAG-test-token-xxxxxxxxxxxxxxxx', appSecret: APP_SECRET },
      });
      const test = await hub.services.accounts.test(principal.workspaceId, account.id, hub.services.logger);
      expect(test).toMatchObject({ ok: true, identity: '+1 555 0100' });
      return account;
    }

    const inbound = (id: string, text: string) => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '1111111111' },
                contacts: [{ wa_id: '79991234567', profile: { name: 'Иван' } }],
                messages: [
                  {
                    from: '79991234567',
                    id,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    async function postWhatsApp(accountId: string, payload: unknown, secret = APP_SECRET) {
      const body = JSON.stringify(payload);
      return fetch(`${hub.baseUrl}/hooks/messenger/${accountId}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
        },
        body,
      });
    }

    it('verifies the subscription and signatures, stores messages, replies and marks read', async () => {
      const account = await addNumber();
      const hook = hub.services.messaging.service.forAccount(account.id).webhook();
      const subscribe = apis.calls.find((c) => c.path.endsWith('/subscribed_apps'));
      expect(subscribe?.body).toEqual({ override_callback_uri: hook.url, verify_token: hook.secret });

      const verify = await fetch(
        `${hook.url}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(hook.secret)}&hub.challenge=12345`,
      );
      expect(await verify.text()).toBe('12345');
      expect(
        (await fetch(`${hook.url}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status,
      ).toBe(403);

      expect((await postWhatsApp(account.id, inbound('wamid.A', 'Добрый день'), 'f'.repeat(32))).status).toBe(
        401,
      );
      expect((await postWhatsApp(account.id, inbound('wamid.A', 'Добрый день, есть доставка?'))).status).toBe(
        200,
      );

      const [chat] = json(await call('whatsapp_list_chats', {})).chats;
      expect(chat).toMatchObject({ title: 'Иван', unread: 1 });
      const sent = json(await call('whatsapp_send', { chat: chat.id, text: 'Да, есть' }));
      expect(sent.status).toBe('sent');
      const send = apis.calls.find((c) => c.path === '/v23.0/1111111111/messages' && c.body?.type === 'text');
      expect(send).toMatchObject({
        auth: 'Bearer EAAG-test-token-xxxxxxxxxxxxxxxx',
        body: { to: '79991234567', text: { body: 'Да, есть' } },
      });

      expect(json(await call('whatsapp_mark_read', { chat: chat.id }))).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await hub.services.messaging.dispatcher.tick();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const read = apis.calls.find((c) => c.body?.status === 'read');
      expect(read?.body.message_id).toBe('wamid.A');
    });

    it('sends documents with a file name', async () => {
      await addNumber();
      const sent = json(
        await call('whatsapp_send', {
          to: '+15550123',
          text: 'Your invoice',
          file_url: 'https://files.example.com/inv/123',
          file_kind: 'document',
          file_name: 'Invoice 123.pdf',
        }),
      );
      expect(sent.status).toBe('sent');
      expect(apis.calls.find((c) => c.body?.type === 'document')?.body).toMatchObject({
        to: '15550123',
        document: {
          link: 'https://files.example.com/inv/123',
          caption: 'Your invoice',
          filename: 'Invoice 123.pdf',
        },
      });
    });

    it('tracks delivery of sent messages from status webhooks', async () => {
      const account = await addNumber();
      await postWhatsApp(account.id, inbound('wamid.Q', 'Is the order ready?'));
      const [chat] = json(await call('whatsapp_list_chats', {})).chats;
      const first = json(await call('whatsapp_send', { chat: chat.id, text: 'Yes, ready' }));
      const second = json(await call('whatsapp_send', { chat: chat.id, text: 'Pick it up today' }));
      const sends = apis.calls.filter(
        (c) => c.path === '/v23.0/1111111111/messages' && c.body?.type === 'text',
      );
      expect(sends).toHaveLength(2);
      expect([first.status, second.status]).toEqual(['sent', 'sent']);
      const status = (id: string, state: string, errors?: unknown[]) => ({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: '1111111111' },
                  statuses: [
                    { id, status: state, recipient_id: '79991234567', ...(errors ? { errors } : {}) },
                  ],
                },
              },
            ],
          },
        ],
      });
      // Status webhooks name messages by WhatsApp's id (wamid), as stored for the sent messages.
      const external = async (messageId: string) =>
        (await hub.services.messaging.store.getMessage(account.id, messageId))!.body.externalId;
      const a = await external(first.id);
      const b = await external(second.id);
      // Out of order: read arrives before delivered and must not be undone.
      await postWhatsApp(account.id, status(a, 'read'));
      await postWhatsApp(account.id, status(a, 'delivered'));
      await postWhatsApp(account.id, status(b, 'failed', [{ code: 131026, title: 'Message undeliverable' }]));
      // Statuses from another number of the business account are ignored.
      const other = status(b, 'read');
      other.entry[0]!.changes[0]!.value.metadata.phone_number_id = '999';
      await postWhatsApp(account.id, other);

      const read = json(await call('whatsapp_read_chat', { chat: chat.id }));
      const mine = read.messages.filter((m: { direction: string }) => m.direction === 'out');
      expect(
        mine.map((m: { delivery?: string; delivery_error?: string }) => [m.delivery, m.delivery_error]),
      ).toEqual([
        ['read', undefined],
        ['failed', 'Message undeliverable'],
      ]);
    });

    it('refuses audio with text before queueing it', async () => {
      await addNumber();
      const result = await call('whatsapp_send', {
        to: '+15550123',
        text: 'listen',
        file_url: 'https://files.example.com/a.mp3',
      });
      expect((result.content[0] as { text: string }).text).toContain('without text');
      expect(await hub.services.db.select().from(messengerOutbox)).toHaveLength(0);
    });

    it('starts a conversation by phone number as a new contact', async () => {
      await addNumber();
      const sent = json(await call('whatsapp_send', { to: '+7 999 765-43-21', text: 'Здравствуйте' }));
      expect(sent.status).toBe('sent');
      const [job] = await hub.services.db.select().from(messengerOutbox);
      expect(job?.newContact).toBe(true);
    });

    it('lists approved templates and sends one to a new number through the outbox', async () => {
      await addNumber();
      const listed = json(await call('whatsapp_list_templates', {}));
      expect(listed.templates).toEqual([
        {
          name: 'order_ready',
          language: 'en_US',
          category: 'utility',
          text: 'Your order\n\nHi , order  is ready. Thank you, !',
          variables: ['1', '2'],
        },
        expect.objectContaining({ name: 'order_ready', language: 'ru', variables: ['name', 'order'] }),
        expect.objectContaining({ name: 'promo_photo', note: expect.stringContaining('image header') }),
      ]);

      // Ambiguous language, wrong variable count and unsupported templates are explained.
      await expect(
        call('whatsapp_send_template', {
          to: '+15550199',
          template: 'order_ready',
          variables: ['Ann', '42'],
        }),
      ).resolves.toMatchObject({ isError: true });
      const wrongCount = await call('whatsapp_send_template', {
        to: '+15550199',
        template: 'order_ready',
        language: 'en_US',
        variables: ['Ann'],
      });
      expect((wrongCount.content[0] as { text: string }).text).toContain('takes 2 variable(s)');
      const photo = await call('whatsapp_send_template', { to: '+15550199', template: 'promo_photo' });
      expect((photo.content[0] as { text: string }).text).toContain('image header');

      const sent = json(
        await call('whatsapp_send_template', {
          to: '+1 555 0199',
          template: 'order_ready',
          language: 'en_US',
          variables: ['Ann', 'A-42'],
        }),
      );
      expect(sent.status).toBe('sent');
      const request = apis.calls.find((c) => c.body?.type === 'template');
      expect(request?.body).toMatchObject({
        to: '15550199',
        template: {
          name: 'order_ready',
          language: { code: 'en_US' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: 'Ann' },
                { type: 'text', text: 'A-42' },
              ],
            },
          ],
        },
      });
      // The hub's copy holds the rendered text, so the chat reads naturally.
      const [chat] = json(await call('whatsapp_list_chats', {})).chats;
      const read = json(await call('whatsapp_read_chat', { chat: chat.id }));
      expect(read.messages.at(-1).text).toBe('Your order\n\nHi Ann, order A-42 is ready. Thank you, Ann!');

      // Named variables carry their names.
      json(
        await call('whatsapp_send_template', {
          chat: chat.id,
          template: 'order_ready',
          language: 'ru',
          variables: ['Анна', 'A-42'],
        }),
      );
      const named = apis.calls.filter((c) => c.body?.type === 'template').at(-1);
      expect(named?.body.template.components[0].parameters[0]).toEqual({
        type: 'text',
        text: 'Анна',
        parameter_name: 'name',
      });

      // Telegram has no templates: the shared send path refuses them.
      const bot = await addBot();
      await postTelegram(bot.id, botUpdate(5, 'hi'));
      const [tgChat] = json(await call('telegram_list_chats', {})).chats;
      await expect(
        hub.services.messaging.service
          .forAccount(bot.id)
          .send({ chatId: tgChat.id, text: 'x', template: { name: 'a', language: 'en' } }),
      ).rejects.toThrow(/cannot send message templates/);
    });

    it('serves the shared messages_* tools across Telegram and WhatsApp', async () => {
      const bot = await addBot();
      const number = await addNumber();
      await postTelegram(bot.id, botUpdate(1, 'Когда будет доставка заказа?'));
      await postWhatsApp(number.id, inbound('wamid.B', 'Доставка сегодня возможна?'));

      const found = json(await call('messages_search', { query: 'доставка' }));
      expect(found.items).toEqual([
        expect.objectContaining({ service: 'whatsapp', text: 'Доставка сегодня возможна?', from: 'Иван' }),
        expect.objectContaining({ service: 'telegram', text: 'Когда будет доставка заказа?' }),
      ]);

      const chats = JSON.stringify(json(await call('messages_list_chats', {})));
      expect(chats).toContain('Анна Петрова');
      expect(chats).toContain('Иван');

      // A first message to a new contact is flagged as dangerous for the confirmation layer.
      const [row] = await hub.services.db
        .select()
        .from(messengerChats)
        .where(eq(messengerChats.accountId, bot.id));
      const send = (await hub.services.connectors.get(principal.workspaceId, 'telegram'))!.actions.find(
        (a) => a.name === 'send',
      )!;
      const ctx = { account: { id: bot.id } } as never;
      expect(await send.assessRisk!({ chat: row!.id, text: 'Привет' }, ctx)).toBeUndefined();
      expect(await send.assessRisk!({ to: '@someone', text: 'Привет' }, ctx)).toMatchObject({
        risk: 'dangerous',
      });
    });
  });
});
