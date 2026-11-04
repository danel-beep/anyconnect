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

/** A fake Telegram Bot API and Meta Graph API on one local port. */
async function startFakeApis() {
  const calls: { path: string; body: any; auth?: string | undefined }[] = [];
  let nextMessageId = 500;
  let failNext: { status: number; body: unknown } | undefined;
  const app = new Hono();
  app.post('/:token/:method', async (c) => {
    const body = await c.req.json().catch(() => ({}));
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
        return c.json({ ok: true, result: true });
      case 'sendMessage':
        return c.json({
          ok: true,
          result: { message_id: nextMessageId++, date: Math.floor(Date.now() / 1000) },
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

    it('starts a conversation by phone number as a new contact', async () => {
      await addNumber();
      const sent = json(await call('whatsapp_send', { to: '+7 999 765-43-21', text: 'Здравствуйте' }));
      expect(sent.status).toBe('sent');
      const [job] = await hub.services.db.select().from(messengerOutbox);
      expect(job?.newContact).toBe(true);
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
