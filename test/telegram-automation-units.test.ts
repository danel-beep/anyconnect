import { describe, expect, it } from 'vitest';
import {
  botUpdateToMessages,
  createTelegramConnector,
  NO_HUB_BOT,
  type TelegramHubBot,
} from '../src/connectors/builtin/telegram.js';
import { DeliveryError, type DirectTransport, type MessagingPort } from '../src/connectors/messaging.js';
import type { AccountRow } from '../src/core/accounts.js';
import { connectFormFields, readConnectForm } from '../src/core/connect-form.js';
import { type QuickConnectFlow, QuickConnects } from '../src/core/quick-connect.js';
import { maskEmail } from '../src/messaging/telegram-automation.js';

const port: MessagingPort = {
  forAccount: () => {
    throw new Error('not used');
  },
};

/** The automation transport with a hub bot that answers every call with `response`. */
function automationTransport(hub: TelegramHubBot) {
  const connector = createTelegramConnector(port, hub);
  const config = connector.config.parse({ mode: 'automation' });
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
    const connector = createTelegramConnector(port, {
      ...NO_HUB_BOT,
      connection: async () => ({ identity: '@dana', enabled: true, rights: ['can_read_messages'] }),
    });
    const test = connector.test!({
      ...(ctx as object),
      config: connector.config.parse({ mode: 'automation' }),
    } as never);
    await expect(test).resolves.toMatchObject({ ok: true, identity: '@dana' });
    const paused = createTelegramConnector(port, {
      ...NO_HUB_BOT,
      connection: async () => ({ identity: '@dana', enabled: false, rights: [] }),
    });
    await expect(
      paused.test!({ ...(ctx as object), config: paused.config.parse({ mode: 'automation' }) } as never),
    ).rejects.toMatchObject({ kind: 'auth' });
  });

  it('never offers the hub bot in the connect form', () => {
    const connector = createTelegramConnector(port);
    const fields = connectFormFields(connector, 'en');
    const mode = fields.find((f) => f.key === 'mode')!;
    expect(mode.options!.map((o) => o.value)).toEqual(['bot', 'user']);
    expect(readConnectForm(fields, { 'config.mode': 'automation' }).problems).toEqual({
      'config.mode': 'not one of the choices',
    });
    expect(readConnectForm(fields, { 'config.mode': 'user' }).problems).toEqual({});
  });
});

describe('quick connect flows', () => {
  const account = (config: Record<string, unknown>) =>
    ({ id: 'acc_1', connectorId: 'telegram', config }) as unknown as AccountRow;
  const flow = (available: () => Promise<boolean>): QuickConnectFlow => ({
    connectorId: 'telegram',
    available,
    reconnects: (a) => a.config.mode === 'automation',
    start: async () => '/connect/telegram/link/x',
  });

  it('offers a flow only when it works now and for the account to reconnect', async () => {
    const ready = flow(async () => true);
    const quick = new QuickConnects([ready]);
    expect(await quick.for('telegram')).toBe(ready);
    expect(await quick.for('gmail')).toBeUndefined();
    expect(await quick.for('telegram', account({ mode: 'automation' }))).toBe(ready);
    // An account made with the form goes back to the form.
    expect(await quick.for('telegram', account({ mode: 'bot' }))).toBeUndefined();
    // The service is away or turned it off: the form, not an error page.
    expect(await new QuickConnects([flow(async () => false)]).for('telegram')).toBeUndefined();
    expect(
      await new QuickConnects([flow(() => Promise.reject(new Error('Telegram is down')))]).for('telegram'),
    ).toBeUndefined();
  });

  it('shows a person enough of the address to recognise their own', () => {
    expect(maskEmail('owner@example.com')).toBe('o•••@example.com');
    expect(maskEmail('x@y.io')).toBe('x•••@y.io');
    expect(maskEmail('not-an-email')).toBe('•••');
  });
});
