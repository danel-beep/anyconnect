import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../src/core/principal.js';
import { accounts, messengerChats, telegramConnections, telegramLinks } from '../src/db/schema.js';
import { maskEmail } from '../src/messaging/telegram-automation.js';
import { TELEGRAM_SECRET_HEADER } from '../src/routes/confirm.js';
import { ADMIN, resetDatabase, startTestHub, TestBrowser, type TestHub, unwrapUntrusted } from './helpers.js';

/**
 * Telegram Chat Automation end to end: the connect page's QR code, the hub's bot in Telegram
 * (a fake Bot API), Telegram's business connection, then messages in and out of the new account.
 */

const BOT = 'manyplug_test_bot';
const DANA = { id: 7001, first_name: 'Dana', last_name: 'Lee', username: 'dana_lee', language_code: 'en' };
const EVE = { id: 6660, first_name: 'Eve', username: 'eve' };
const MARIA = { id: 4242, first_name: 'Maria', username: 'maria_k' };

/** A fake Bot API for the hub's bot: answers what the hub asks and records it. */
function fakeBotApi(options: { secretary?: boolean } = {}) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let messageId = 1000;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/file/bot')) {
      return new Response('photo-bytes', { headers: { 'content-type': 'image/jpeg' } });
    }
    const method = url.split('/').pop()!;
    const body: Record<string, unknown> = {};
    if (init?.body instanceof FormData) {
      for (const [key, value] of init.body) body[key] = typeof value === 'string' ? value : '[file]';
    } else Object.assign(body, JSON.parse(String(init?.body ?? '{}')));
    calls.push({ method, body });
    const ok = (result: unknown) => Response.json({ ok: true, result });
    switch (method) {
      case 'getMe':
        return ok({
          id: 1,
          is_bot: true,
          username: BOT,
          ...(options.secretary === false ? {} : { can_connect_to_business: true }),
        });
      case 'sendMessage':
        return ok({
          message_id: ++messageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(body.chat_id), type: 'private' },
        });
      case 'getFile':
        return ok({ file_id: body.file_id, file_path: 'photos/file_1.jpg', file_size: 11 });
      default:
        return ok(true);
    }
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

let updateId = 1;
const now = () => Math.floor(Date.now() / 1000);
const start = (user: typeof DANA | typeof EVE, text: string) => ({
  update_id: updateId++,
  message: { message_id: updateId, date: now(), chat: { id: user.id, type: 'private' }, from: user, text },
});
const press = (user: typeof DANA | typeof EVE, data: string, messageId = 50) => ({
  update_id: updateId++,
  callback_query: {
    id: `cb${updateId}`,
    from: user,
    data,
    message: { message_id: messageId, chat: { id: user.id } },
  },
});
const businessConnection = (user: typeof DANA, overrides: Record<string, unknown> = {}) => ({
  update_id: updateId++,
  business_connection: {
    id: 'BC-dana-1',
    user,
    user_chat_id: user.id,
    date: now(),
    rights: { can_reply: true, can_read_messages: true },
    is_enabled: true,
    ...overrides,
  },
});
const businessMessage = (id: number, text: string, connectionId = 'BC-dana-1') => ({
  update_id: updateId++,
  business_message: {
    business_connection_id: connectionId,
    message_id: id,
    date: now(),
    chat: { id: MARIA.id, type: 'private', first_name: MARIA.first_name, username: MARIA.username },
    from: MARIA,
    text,
  },
});

describe('Telegram through the hub bot (Chat Automation)', () => {
  let hub: TestHub;
  let bot: ReturnType<typeof fakeBotApi>;
  let browser: TestBrowser;
  let principal: Principal;

  const startHub = async (options: { secretary?: boolean } = {}) => {
    await hub?.close();
    bot = fakeBotApi(options);
    hub = await startTestHub({
      env: {
        CONFIRMATION_WAIT_SECONDS: '0',
        TELEGRAM_BOT_TOKEN: '123:test',
        TELEGRAM_API_URL: 'http://telegram.invalid',
      },
      telegramFetch: bot.fetch,
      seed: false,
    });
    const workspace = (await hub.services.db.query.workspaces.findFirst())!;
    const user = (await hub.services.db.query.users.findFirst())!;
    principal = { kind: 'session', userId: user.id, workspaceId: workspace.id, scopes: ['mcp', 'api'] };
    hub.services.messaging.start();
    // These tests are about delivery: the user said "do not ask" for Telegram.
    await hub.services.policies.createRule(workspace.id, { connectorId: 'telegram', confirm: 'never' });
    browser = new TestBrowser(hub.baseUrl);
    expect((await browser.login()).status).toBe(303);
  };

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await startHub();
  });

  afterAll(async () => {
    await hub?.close();
  });

  const webhook = (update: unknown) =>
    fetch(`${hub.baseUrl}/telegram/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [TELEGRAM_SECRET_HEADER]: hub.services.telegramWebhookSecret,
      },
      body: JSON.stringify(update),
    });

  const sentTo = (user: { id: number }) =>
    bot.calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === String(user.id));
  const lastTo = (user: { id: number }) => sentTo(user).at(-1)!;
  const buttons = (call: { body: Record<string, unknown> }) =>
    JSON.stringify(
      (call.body.reply_markup as { inline_keyboard?: unknown } | undefined)?.inline_keyboard ?? [],
    );

  /** Opens `/connect/telegram` like the user: a redirect to a new link's page with its QR code. */
  async function openLink(query = '') {
    const response = await browser.request(`/connect/telegram${query}`);
    expect(response.status).toBe(302);
    const path = response.headers.get('location')!;
    expect(path).toMatch(/^\/connect\/telegram\/link\/tgl_[0-9a-z]{26}$/);
    const page = await browser.request(path);
    expect(page.status).toBe(200);
    const html = await page.text();
    const deepLink = new RegExp(`href="(https://t\\.me/${BOT}\\?start=c_[A-Za-z0-9_-]{32})"`).exec(html)?.[1];
    expect(deepLink, 'the page links to the bot').toBeDefined();
    expect(html).toContain('<svg class="qr"');
    return { path, id: path.split('/').pop()!, html, payload: new URL(deepLink!).searchParams.get('start')! };
  }

  const state = async (path: string) =>
    ((await (await browser.request(`${path}/state`)).json()) as any).state;

  const call = async (tool: string, args: Record<string, unknown>) => {
    const catalog = await hub.services.hub.getCatalog(principal);
    const result = await hub.services.hub.callTool(principal, catalog, tool, args);
    const first = result.content[0];
    const text = first?.type === 'text' ? first.text : '';
    if (result.isError) throw new Error(text);
    return JSON.parse(unwrapUntrusted(text));
  };

  const telegramAccounts = () =>
    hub.services.db.select().from(accounts).where(eq(accounts.connectorId, 'telegram'));

  /** The 6-digit code in the bot's last message to `user`. */
  const codeOf = (user: { id: number }) => /<code>(\d{6})<\/code>/.exec(String(lastTo(user).body.text))?.[1];

  /** Types a code on the link's page, as the signed-in user who made the link. */
  async function typeCode(path: string, code: string) {
    const { csrf } = TestBrowser.hiddenInputs(await (await browser.request(path)).text());
    const response = await browser.request(`${path}/confirm`, { form: { csrf: csrf!, code } });
    expect(response.status).toBe(303);
    return response.headers.get('location')!;
  }

  /** Dana connects through a new QR code: opens it, types the bot's code, adds the bot. */
  async function connectDana(query = '') {
    const link = await openLink(query);
    await webhook(start(DANA, `/start ${link.payload}`));
    await typeCode(link.path, codeOf(DANA)!);
    await webhook(businessConnection(DANA));
    return link;
  }

  it('connects with a QR code and the bot’s code typed on the page, then routes messages both ways', async () => {
    const link = await openLink();
    expect(await state(link.path)).toBe('pending');

    // Dana opens the link: the bot names the hub account (masked) and sends a code for the page.
    expect((await webhook(start(DANA, `/start ${link.payload}`))).status).toBe(200);
    const ask = lastTo(DANA);
    expect(String(ask.body.text)).toContain(maskEmail(ADMIN.email));
    expect(String(ask.body.text)).not.toContain(ADMIN.email);
    const code = codeOf(DANA)!;
    expect(code).toMatch(/^\d{6}$/);
    // Nothing in Telegram connects by itself: the bot only offers Cancel.
    expect(buttons(ask)).toContain(`tgl:${link.id}:n`);
    expect(buttons(ask)).not.toContain(`tgl:${link.id}:y`);
    expect(await state(link.path)).toBe('opened');
    const opened = await (await browser.request(link.path)).text();
    expect(opened).toContain('@dana_lee');
    expect(opened).toContain('name="code"');

    // Someone else with the same QR code gets no code: the link is Dana's now.
    await webhook(start(EVE, `/start ${link.payload}`));
    expect(codeOf(EVE)).toBeUndefined();
    await webhook(press(EVE, `tgl:${link.id}:n`));
    expect(await state(link.path)).toBe('opened');

    // A wrong code changes nothing; the right one confirms, and the bot sends the last step.
    expect(await typeCode(link.path, code === '000000' ? '111111' : '000000')).toContain('code=wrong');
    expect(await (await browser.request(`${link.path}?code=wrong`)).text()).toContain('Неверный код');
    expect(await state(link.path)).toBe('opened');
    expect(await typeCode(link.path, `${code.slice(0, 3)} ${code.slice(3)}`)).toBe(link.path);
    expect(await state(link.path)).toBe('confirmed');
    expect(String(lastTo(DANA).body.text)).toContain(`@${BOT}`);
    expect(await telegramAccounts()).toHaveLength(0);

    // Dana adds the bot under Chat Automation: Telegram reports it and the account appears.
    expect((await webhook(businessConnection(DANA))).status).toBe(200);
    const [account] = await telegramAccounts();
    expect(account).toMatchObject({
      label: '@dana_lee',
      config: { mode: 'automation' },
      status: 'active',
      metadata: { identity: '@dana_lee' },
      workspaceId: principal.workspaceId,
    });
    expect(buttons(lastTo(DANA))).toMatch(/tgc:tgc_[0-9a-z]{26}:x/);
    expect(await state(link.path)).toBe('connected');
    const done = await (await browser.request(link.path)).text();
    expect(done).toContain('Аккаунт подключён');
    expect(done).toContain('@dana_lee');

    // Telegram ids are stored as keyed hashes, names and the connection encrypted, codes hashed.
    const [stored] = await hub.services.db.select().from(telegramConnections);
    expect(stored!.accountId).toBe(account!.id);
    expect(JSON.stringify(stored)).not.toMatch(/7001|BC-dana-1|dana_lee/);
    const [linkRow] = await hub.services.db.select().from(telegramLinks).where(eq(telegramLinks.id, link.id));
    expect(JSON.stringify(linkRow)).not.toContain(link.payload);
    expect(JSON.stringify(linkRow)).not.toMatch(new RegExp(`7001|dana_lee|${code}`));

    // A message in a chat Dana shared reaches the account; the AI reads and answers it as Dana.
    expect((await webhook(businessMessage(5, 'Hi Dana, are we still on for Friday?'))).status).toBe(200);
    const [chat] = (await call('telegram_list_chats', {})).chats;
    expect(chat).toMatchObject({ title: 'Maria', username: 'maria_k', kind: 'direct' });
    const read = await call('telegram_read_chat', { chat: chat.id });
    expect(read.messages.map((m: { text: string }) => m.text)).toEqual([
      'Hi Dana, are we still on for Friday?',
    ]);
    const sent = await call('telegram_send', { chat: chat.id, text: 'Yes, see you at 3' });
    expect(sent.status).toBe('sent');
    expect(bot.calls.filter((c) => c.method === 'sendMessage').at(-1)!.body).toMatchObject({
      business_connection_id: 'BC-dana-1',
      chat_id: String(MARIA.id),
      text: 'Yes, see you at 3',
    });

    // Updates of a connection nobody connected are not stored anywhere.
    const texts = async () =>
      (await call('telegram_read_chat', { chat: chat.id })).messages.map((m: { text: string }) => m.text);
    expect(await texts()).toEqual(['Hi Dana, are we still on for Friday?', 'Yes, see you at 3']);
    await webhook(businessMessage(6, 'unrouted', 'BC-unknown'));
    expect(await texts()).toHaveLength(2);

    // Disconnect in the bot: the account stops getting messages and asks to be connected again.
    const disconnect = /tgc:(tgc_[0-9a-z]{26}):x/.exec(buttons(lastTo(DANA)))![0];
    await webhook(press(DANA, disconnect, 51));
    const [after] = await telegramAccounts();
    expect(after!.status).toBe('needs_reauth');
    await webhook(businessMessage(7, 'after disconnect'));
    expect(await texts()).toHaveLength(2);
    await expect(call('telegram_send', { chat: chat.id, text: 'still there?' })).rejects.toThrow();
  });

  it('never moves a connected Telegram account from the bot alone, and fails after wrong codes', async () => {
    await connectDana();
    const [account] = await telegramAccounts();
    const before = (await hub.services.db.select().from(telegramConnections))[0]!;

    // Someone sends Dana a QR code of theirs and she opens it: the bot only shows a code, and
    // without that code typed on the sender's page nothing moves, whatever she taps.
    const foreign = await openLink();
    await webhook(start(DANA, `/start ${foreign.payload}`));
    expect(codeOf(DANA)).toMatch(/^\d{6}$/);
    expect(String(lastTo(DANA).body.text)).toContain('Никому не отправляйте этот код');
    await webhook(press(DANA, `tgl:${foreign.id}:y`));
    expect(await state(foreign.path)).toBe('opened');
    const after = (await hub.services.db.select().from(telegramConnections))[0]!;
    expect(after.accountId).toBe(before.accountId);
    expect(await telegramAccounts()).toEqual([account]);

    // Guessing does not work: a few wrong codes and the link is dead, even for the right code.
    const code = codeOf(DANA)!;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await typeCode(foreign.path, wrong);
    expect(await state(foreign.path)).toBe('failed');
    expect(await (await browser.request(foreign.path)).text()).toContain('Слишком много неверных кодов');
    await typeCode(foreign.path, code);
    expect(await state(foreign.path)).toBe('failed');
  });

  it('finishes when the bot was added before the QR code was scanned', async () => {
    await webhook(businessConnection(DANA));
    // Added without a link: the bot says where to finish, with a button to the site.
    expect(buttons(lastTo(DANA))).toContain(`${hub.baseUrl}/connect/telegram`);
    expect(await telegramAccounts()).toHaveLength(0);

    const link = await openLink();
    await webhook(start(DANA, `/start ${link.payload}`));
    await typeCode(link.path, codeOf(DANA)!);
    // The connection is there already: the right code connects at once.
    const [account] = await telegramAccounts();
    expect(account).toMatchObject({ status: 'active', config: { mode: 'automation' } });
    expect(buttons(lastTo(DANA))).toMatch(/tgc:tgc_[0-9a-z]{26}:x/);
    expect(await state(link.path)).toBe('connected');
  });

  it('connects the same account again, and only with the same Telegram account', async () => {
    await connectDana();
    const [account] = await telegramAccounts();

    // Paused in Telegram: the account waits, and comes back when the bot is on again.
    await webhook(businessConnection(DANA, { is_enabled: false }));
    expect((await telegramAccounts())[0]!.status).toBe('needs_reauth');
    await webhook(businessConnection(DANA, { rights: { can_read_messages: true } }));
    const back = (await telegramAccounts())[0]!;
    expect(back.status).toBe('active');
    expect(back.statusMessage).toBeNull();

    // Paused, then a new QR code confirmed while paused: the link finishes when the bot is back.
    await webhook(businessConnection(DANA, { is_enabled: false }));
    const whilePaused = await openLink();
    await webhook(start(DANA, `/start ${whilePaused.payload}`));
    await typeCode(whilePaused.path, codeOf(DANA)!);
    expect(await state(whilePaused.path)).toBe('confirmed');
    await webhook(businessConnection(DANA));
    expect(await state(whilePaused.path)).toBe('connected');

    // Disconnected in the bot, then a new QR code: the same account comes back, not a second one.
    await webhook(press(DANA, /tgc:(tgc_[0-9a-z]{26}):x/.exec(buttons(lastTo(DANA)))![0]));
    expect((await telegramAccounts())[0]!.status).toBe('needs_reauth');
    const plain = await openLink();
    await webhook(start(DANA, `/start ${plain.payload}`));
    await typeCode(plain.path, codeOf(DANA)!);
    expect(await telegramAccounts()).toHaveLength(1);
    expect((await telegramAccounts())[0]!).toMatchObject({ id: account!.id, status: 'active' });

    // A reconnect link for Dana's account cannot be taken by another Telegram account.
    const again = await openLink(`?account=${account!.id}`);
    expect(again.html).toContain('@dana_lee');
    await webhook(start(EVE, `/start ${again.payload}`));
    expect(codeOf(EVE)).toBeUndefined();
    expect(await state(again.path)).toBe('pending');
    await webhook(start(DANA, `/start ${again.payload}`));
    await typeCode(again.path, codeOf(DANA)!);
    const accountsNow = await telegramAccounts();
    expect(accountsNow).toHaveLength(1);
    expect(accountsNow[0]!).toMatchObject({ id: account!.id, status: 'active' });
  });

  it('expires links, cancels them and keeps codes single-use', async () => {
    const link = await openLink();
    const cancel = TestBrowser.hiddenInputs(link.html);
    const cancelled = await browser.request(`${link.path}/cancel`, { form: { csrf: cancel.csrf! } });
    expect(cancelled.status).toBe(303);
    expect(await state(link.path)).toBe('cancelled');
    await webhook(start(DANA, `/start ${link.payload}`));
    expect(buttons(lastTo(DANA))).not.toContain('tgl:');

    // A new QR code stops an older one that is not confirmed yet.
    const older = await openLink();
    const newer = await openLink();
    expect(await state(older.path)).toBe('cancelled');
    await hub.services.db
      .update(telegramLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(telegramLinks.id, newer.id));
    expect(await state(newer.path)).toBe('expired');
    const page = await (await browser.request(newer.path)).text();
    expect(page).toContain('QR-код устарел');
    expect(page).toContain('href="/connect/telegram"');
    await webhook(start(DANA, `/start ${newer.payload}`));
    expect(buttons(lastTo(DANA))).not.toContain('tgl:');

    // A confirmed link only waits for Telegram: opening the connect page again keeps it.
    const confirmed = await openLink();
    await webhook(start(DANA, `/start ${confirmed.payload}`));
    await typeCode(confirmed.path, codeOf(DANA)!);
    await openLink();
    expect(await state(confirmed.path)).toBe('confirmed');

    // Someone else's link page is not found.
    const stranger = new TestBrowser(hub.baseUrl);
    expect((await stranger.request(newer.path)).status).toBe(302);
  });

  it('keeps the form one link away and never makes a Chat Automation account from it', async () => {
    const form = await browser.request('/connect/telegram?via=form');
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).not.toContain('value="automation"');
    expect(html).toContain('href="/connect/telegram?via=app"');
    const hidden = TestBrowser.hiddenInputs(html);
    const posted = await browser.request('/connect/telegram', {
      form: { ...hidden, 'config.mode': 'automation', label: 'Sneaky' },
    });
    expect(posted.status).toBe(400);
    expect(await telegramAccounts()).toHaveLength(0);

    // The AI's connect link goes to the quick way, and says so.
    const link = await call('manyplug_connect_account', { service: 'telegram' });
    expect(link.method).toBe('app');
    expect(link.instructions).toContain('QR code');
  });

  it('asks Telegram to deliver an update again when it could not be saved, a few times at most', async () => {
    // The connection itself: without it, every later message of the connection would be lost.
    const link = await openLink();
    await webhook(start(DANA, `/start ${link.payload}`));
    await typeCode(link.path, codeOf(DANA)!);
    const automation = hub.services.telegramAutomation as unknown as Record<string, unknown>;
    const lookup = automation.connectionOfUser;
    automation.connectionOfUser = async () => {
      throw new Error('database is away');
    };
    expect((await webhook(businessConnection(DANA))).status).toBe(500);
    automation.connectionOfUser = lookup;
    expect((await webhook(businessConnection(DANA))).status).toBe(200);
    expect(await state(link.path)).toBe('connected');

    // A message: stored once when it comes again.
    const service = hub.services.messaging.service;
    const route = service.route.bind(service);
    service.route = async () => {
      throw new Error('database is away');
    };
    expect((await webhook(businessMessage(9, 'Hello?'))).status).toBe(500);
    // An update that keeps failing stops holding the bot's webhook after a few deliveries.
    const poison = businessMessage(10, 'never stored');
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await webhook(poison)).status);
    expect(statuses).toEqual([500, 500, 500, 200]);
    service.route = route;
    expect((await webhook(businessMessage(9, 'Hello?'))).status).toBe(200);
    const chats = await hub.services.db.select().from(messengerChats);
    expect(chats).toHaveLength(1);
  });

  it('shows the form when the hub bot cannot be added to accounts (Secretary Mode off)', async () => {
    await startHub({ secretary: false });
    const response = await browser.request('/connect/telegram');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('name="config.mode"');
    expect(html).not.toContain('via=app');
    const link = await call('manyplug_connect_account', { service: 'telegram' });
    expect(link.method).toBe('form');
  });
});
