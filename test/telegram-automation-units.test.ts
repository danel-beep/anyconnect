import { describe, expect, it } from 'vitest';
import {
  botUpdateToMessages,
  createTelegramBotConnector,
  NO_HUB_BOT,
  type TelegramHubBot,
} from '../src/connectors/builtin/telegram-bot.js';
import { DeliveryError, type DirectTransport, type MessagingPort } from '../src/connectors/messaging.js';
import type { AccountRow } from '../src/core/accounts.js';
import { connectFormFields, readConnectForm } from '../src/core/connect-form.js';
import { type QuickConnectFlow, QuickConnects } from '../src/core/quick-connect.js';
import { maskEmail } from '../src/messaging/telegram-automation.js';
import { RetryBudget } from '../src/security/telegram.js';

const port: MessagingPort = {
  forAccount: () => {
    throw new Error('not used');
  },
};

/** The automation transport with a hub bot that answers every call with `response`. */
function automationTransport(hub: TelegramHubBot) {
  const connector = createTelegramBotConnector(port, hub);
  const config = connector.config.parse({ bot: 'hub' });
  return connector.messenger!.transport(config) as DirectTransport<unknown, unknown>;
}

const ctx = {
  account: { id: 'acc_1', name: 'dana', label: '@dana' },
  config: {},
  credentials: {},
  signal: AbortSignal.timeout(5_000),
  fetch: globalThis.fetch,
} as never;

const job = {
  id: 'out_1',
  attempt: 1,
  kind: 'message' as const,
  chat: { externalId: '4242', kind: 'direct' as const },
  text: 'Hi',
};

const answering = (status: number, body: unknown): TelegramHubBot => ({
  ...NO_HUB_BOT,
  call: async () => Response.json(body, { status }),
});

describe('Telegram accounts on the hub bot', () => {
  it('keeps plain chat ids for the hub bot and connection-scoped ids for an own bot', () => {
    const update = {
      update_id: 1,
      business_message: {
        business_connection_id: 'BC1',
        message_id: 5,
        date: 1_700_000_000,
        chat: { id: 4242, type: 'private' as const, first_name: 'Maria' },
        from: { id: 4242, first_name: 'Maria' },
        text: 'Hello',
      },
    };
    expect(botUpdateToMessages(update, '', { plainChats: true })[0]!.chat.externalId).toBe('4242');
    expect(botUpdateToMessages(update, '1')[0]!.chat.externalId).toBe('4242@BC1');
    // The owner's own messages (from their phone) are outgoing.
    const own = { ...update, business_message: { ...update.business_message, from: { id: 7001 } } };
    expect(botUpdateToMessages(own, '', { plainChats: true })[0]!.direction).toBe('out');
  });

  it('sends on the account’s connection and maps Telegram’s answers', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const transport = automationTransport({
      ...NO_HUB_BOT,
      call: async (_account, method, params) => {
        calls.push({ method, params });
        return Response.json({
          ok: true,
          result: { message_id: 9, date: 1_700_000_000, chat: { id: 4242 } },
        });
      },
    });
    await expect(transport.send(job, ctx)).resolves.toMatchObject({ externalId: '9' });
    // The hub adds the connection: the connector never sees or sends it.
    expect(calls).toEqual([{ method: 'sendMessage', params: { chat_id: '4242', text: 'Hi' } }]);

    const kind = async (hub: TelegramHubBot) =>
      automationTransport(hub)
        .send(job, ctx)
        .then(
          () => 'sent',
          (error: unknown) => (error instanceof DeliveryError ? error.kind : String(error)),
        );
    // The hub's own token failing is the hub's problem: retried, not the account's sign-in.
    expect(await kind(answering(401, { ok: false, error_code: 401, description: 'Unauthorized' }))).toBe(
      'transient',
    );
    expect(await kind(answering(429, { ok: false, error_code: 429, parameters: { retry_after: 3 } }))).toBe(
      'rate_limited',
    );
    expect(await kind(answering(403, { ok: false, error_code: 403, description: 'Forbidden' }))).toBe(
      'rejected',
    );
    expect(await kind(answering(502, { ok: false, error_code: 502 }))).toBe('transient');
    // Not connected through the hub's bot (no bot on this hub, or disconnected): reconnect.
    expect(await kind(NO_HUB_BOT)).toBe('auth');
  });

  it('checks the account through the connection Telegram reported', async () => {
    const connector = createTelegramBotConnector(port, {
      ...NO_HUB_BOT,
      connection: async () => ({ identity: '@dana', enabled: true, rights: ['can_read_messages'] }),
    });
    const test = connector.test!({
      ...(ctx as object),
      config: connector.config.parse({ bot: 'hub' }),
    } as never);
    await expect(test).resolves.toMatchObject({ ok: true, identity: '@dana' });
    const paused = createTelegramBotConnector(port, {
      ...NO_HUB_BOT,
      connection: async () => ({ identity: '@dana', enabled: false, rights: [] }),
    });
    await expect(
      paused.test!({ ...(ctx as object), config: paused.config.parse({ bot: 'hub' }) } as never),
    ).rejects.toMatchObject({ kind: 'auth' });
  });

  it('never offers the hub bot in the connect form', () => {
    const connector = createTelegramBotConnector(port);
    const fields = connectFormFields(connector, 'en');
    // Only "own" is left, so there is nothing to choose: the field is not shown at all.
    expect(fields.map((f) => f.key)).not.toContain('bot');
    expect(fields.find((f) => f.key === 'botToken')).toMatchObject({ advanced: false });
    // A posted value for it is ignored: the default (an own bot) applies.
    expect(readConnectForm(fields, { 'config.bot': 'hub' })).toMatchObject({ config: {}, problems: {} });
  });

  it('asks an own bot for its token', async () => {
    const connector = createTelegramBotConnector(port);
    await expect(
      connector.test!({ ...(ctx as object), config: connector.config.parse({}) } as never),
    ).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('bot token') });
  });
});

describe('quick connect flows', () => {
  const account = (config: Record<string, unknown>) =>
    ({ id: 'acc_1', connectorId: 'telegram_bot', config }) as unknown as AccountRow;
  const flow = (available: () => Promise<boolean>): QuickConnectFlow => ({
    connectorId: 'telegram_bot',
    available,
    reconnects: (a) => a.config.bot === 'hub',
    start: async () => '/connect/telegram/link/x',
  });

  it('offers a flow only when it works now and for the account to reconnect', async () => {
    const ready = flow(async () => true);
    const quick = new QuickConnects([ready]);
    expect(await quick.for('telegram_bot')).toBe(ready);
    expect(await quick.for('gmail')).toBeUndefined();
    expect(await quick.for('telegram_bot', account({ bot: 'hub' }))).toBe(ready);
    // An account made with the form goes back to the form.
    expect(await quick.for('telegram_bot', account({ bot: 'own' }))).toBeUndefined();
    // The service is away or turned it off: the form, not an error page.
    expect(await new QuickConnects([flow(async () => false)]).for('telegram_bot')).toBeUndefined();
    expect(
      await new QuickConnects([flow(() => Promise.reject(new Error('Telegram is down')))]).for(
        'telegram_bot',
      ),
    ).toBeUndefined();
  });

  it('shows a person enough of the address to recognise their own', () => {
    expect(maskEmail('owner@example.com')).toBe('o•••@example.com');
    expect(maskEmail('x@y.io')).toBe('x•••@y.io');
    expect(maskEmail('not-an-email')).toBe('•••');
  });
});

describe('retries of bot updates', () => {
  it('lets an update ask for redelivery a few times, then lets it go', () => {
    const budget = new RetryBudget(3, 2);
    expect([1, 2, 3, 4].map(() => budget.take(10))).toEqual([true, true, true, false]);
    // Each update has its own budget; without an update_id there is nothing to count.
    expect(budget.take(11)).toBe(true);
    expect(budget.take(undefined)).toBe(false);
    // Only the newest updates are remembered: an old one starts again rather than growing a map.
    budget.take(12);
    expect(budget.take(10)).toBe(true);
  });
});
