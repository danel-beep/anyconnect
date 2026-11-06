import { Long } from '@mtcute/core';
import { describe, expect, it } from 'vitest';
import { DeliveryError, type InboundChat, type InboundMessage } from '../src/connectors/messaging.js';
import { randomIdFor, telegramUserDriver } from '../src/gateway/drivers/telegram/driver.js';
import { deliveryFailure, toSessionError } from '../src/gateway/drivers/telegram/errors.js';
import { toInboundChat, toInboundMessage } from '../src/gateway/drivers/telegram/mapping.js';
import { PEER_BUCKETS, StateStorage } from '../src/gateway/drivers/telegram/storage.js';
import type { DriverSession, LiveSession, SessionState } from '../src/gateway/drivers/types.js';
import { SessionError } from '../src/gateway/drivers/types.js';
import {
  ANNA_ID,
  createFakeTelegram,
  type FakeTelegramState,
  fakeClientFactory,
  fakeMessage,
  GROUP_ID,
  ME_ID,
  rpc,
} from './fake-telegram.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Session state in memory, with a write counter (values are copied like the real JSON store). */
function memoryState() {
  const data = new Map<string, unknown>();
  let writes = 0;
  const state: SessionState & { data: Map<string, unknown>; writes: () => number } = {
    data,
    writes: () => writes,
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async set(key, value) {
      writes++;
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key) {
      data.delete(key);
    },
    async list<T>(prefix: string) {
      return [...data]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value: value as T }));
    },
    async clear() {
      data.clear();
    },
  };
  return state;
}

function fakeSession(state = memoryState()) {
  const abort = new AbortController();
  const ingested: InboundMessage[] = [];
  const chats: InboundChat[] = [];
  const session: DriverSession = {
    account: { id: 'acc_tg', name: 'personal', config: {}, credentials: {} },
    state,
    ingest: async (messages) => {
      ingested.push(...messages);
    },
    upsertChats: async (list) => {
      chats.push(...list);
    },
    signal: abort.signal,
    logger: silent,
    network: { lookup: (() => {}) as never, assertHostAllowed() {} },
  };
  return { session, state, abort, ingested, chats };
}

const APP = { apiId: 12345, apiHash: '0123456789abcdef0123456789abcdef' };

function driver(fake: FakeTelegramState, overrides: Partial<Parameters<typeof telegramUserDriver>[0]> = {}) {
  return telegramUserDriver({
    app: APP,
    createClient: fakeClientFactory(fake),
    initialSync: { chats: 10, messagesPerChat: 5, gapMs: 0 },
    watchdogMs: 20,
    ...overrides,
  });
}

async function until<T>(probe: () => T | Promise<T>, what: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('Telegram session storage', () => {
  it('keeps auth keys at once, batches the rest and restores everything', async () => {
    const state = memoryState();
    const storage = new StateStorage(state, silent, { flushDelayMs: 5 });
    await storage.driver.load();
    expect(storage.hasLogin()).toBe(false);

    await storage.authKeys.set(2, new Uint8Array([1, 2, 3]));
    expect(state.data.has('tg:auth')).toBe(true);

    storage.kv.set('pts', new Uint8Array([7]));
    for (let id = 1; id <= 3; id++) {
      storage.peers.store({
        id,
        accessHash: String(id * 10),
        isMin: false,
        usernames: [`user${id}`],
        updated: 1,
        complete: new Uint8Array([id]),
      });
    }
    const before = state.writes();
    // mtcute asks to save after every batch of updates: many asks, one write per changed row.
    storage.driver.save?.();
    storage.driver.save?.();
    storage.driver.save?.();
    await until(() => state.data.has('tg:kv'), 'the batched save');
    expect(state.writes() - before).toBe(1 + 3);
    // Peer rows are named by bucket, never by the Telegram id itself.
    expect([...state.data.keys()].filter((k) => k.startsWith('tg:peers:')).length).toBe(3);
    expect([...state.data.keys()].every((k) => !/user\d/.test(k))).toBe(true);

    const restored = new StateStorage(state, silent);
    await restored.driver.load();
    expect(restored.hasLogin()).toBe(true);
    expect(await restored.authKeys.get(2)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await restored.kv.get('pts')).toEqual(new Uint8Array([7]));
    expect((await restored.peers.getByUsername('user2'))?.accessHash).toBe('20');

    await restored.authKeys.deleteAll();
    expect(state.data.has('tg:auth')).toBe(false);
    expect(PEER_BUCKETS).toBeGreaterThan(1);
  });
});

describe('Telegram mapping', () => {
  it('maps chats, messages and media, and skips service messages', () => {
    const incoming = toInboundMessage(fakeMessage(5, 'hi there'), { selfId: ME_ID })!;
    expect(incoming).toMatchObject({
      chat: { externalId: String(ANNA_ID), kind: 'direct', title: 'Anna', username: '@anna' },
      externalId: '5',
      direction: 'in',
      text: 'hi there',
    });
    expect(incoming.sender).toBeUndefined();

    const inGroup = toInboundMessage(fakeMessage(6, 'standup', { group: true }))!;
    expect(inGroup.chat).toMatchObject({ externalId: String(GROUP_ID), kind: 'group', title: 'Team chat' });
    expect(inGroup.sender).toEqual({ externalId: String(ANNA_ID), name: 'Anna' });

    expect(toInboundMessage(fakeMessage(7, 'hey', { out: true }))!.direction).toBe('out');
    expect(toInboundMessage(fakeMessage(8, '', { service: true }))).toBeUndefined();

    const located = toInboundMessage(
      fakeMessage(9, '', {
        media: {
          _: 'messageMediaGeo',
          geo: { _: 'geoPoint', lat: 51.5, long: -0.12, accessHash: Long.ZERO },
        },
      }),
    )!;
    expect(located.text).toBe('[location 51.5, -0.12]');
    expect(located.attachments?.[0]).toMatchObject({ kind: 'location' });
    expect(located.attachments?.[0]?.locator).toBeUndefined();

    const self = toInboundChat(
      { type: 'user', id: ME_ID, isBot: false, displayName: 'Dana', username: null } as never,
      { selfId: ME_ID, unread: 0 },
    );
    expect(self).toMatchObject({ title: 'Saved Messages', kind: 'direct', unread: 0 });
  });
});

describe('Telegram errors', () => {
  it('classifies delivery and session failures', () => {
    const flood = Object.assign(rpc(420, 'FLOOD_WAIT_%d'), { seconds: 33 });
    expect(() => deliveryFailure(flood)).toThrow(DeliveryError);
    try {
      deliveryFailure(flood);
    } catch (error) {
      expect(error).toMatchObject({ kind: 'rate_limited', options: { retryAfterSeconds: 33 } });
    }
    const kindOf = (error: unknown) => {
      try {
        deliveryFailure(error);
        return 'duplicate';
      } catch (thrown) {
        return (thrown as DeliveryError).kind;
      }
    };
    expect(kindOf(rpc(400, 'PEER_FLOOD'))).toBe('spam_warning');
    expect(kindOf(rpc(400, 'USER_IS_BLOCKED'))).toBe('rejected');
    expect(kindOf(rpc(401, 'AUTH_KEY_UNREGISTERED'))).toBe('auth');
    expect(kindOf(rpc(500, 'INTERNAL'))).toBe('transient');
    expect(kindOf(new Error('socket hang up'))).toBe('transient');
    expect(kindOf(rpc(400, 'RANDOM_ID_DUPLICATE'))).toBe('duplicate');

    expect(toSessionError(rpc(401, 'SESSION_REVOKED')).problem).toBe('logged_out');
    expect(toSessionError(rpc(401, 'USER_DEACTIVATED_BAN')).problem).toBe('banned');
    expect(toSessionError(rpc(420, 'FROZEN_METHOD_INVALID')).problem).toBe('frozen');
    expect(toSessionError(new Error('ECONNRESET')).problem).toBe('network');
  });

  it('derives the same random id for every retry of a job', () => {
    expect(randomIdFor('job_1').toString()).toBe(randomIdFor('job_1').toString());
    expect(randomIdFor('job_1').toString()).not.toBe(randomIdFor('job_2').toString());
  });
});

describe('Telegram personal-account driver', () => {
  it('reports a missing app or login instead of connecting', async () => {
    const fake = createFakeTelegram();
    const { session } = fakeSession();
    await expect(driver(fake, { app: undefined }).connect(session)).rejects.toThrow(/TELEGRAM_API_ID/);
    await expect(driver(fake).connect(session)).rejects.toMatchObject({ problem: 'logged_out' });
  });

  it('logs in with a QR code and the cloud password, then syncs, sends and reads', async () => {
    const fake = createFakeTelegram();
    fake.twoFactor = true;
    const { session, state, ingested, chats } = fakeSession();
    await state.set('leftover', { from: 'an old login' });
    const tg = driver(fake);

    const flow = await tg.login!(session, { method: 'qr' });
    expect(state.data.has('leftover')).toBe(false);
    await until(() => flow.view().qr, 'the QR code');
    expect(flow.view()).toMatchObject({ step: 'scan_qr', qr: 'tg://login?token=fake-token-1' });

    fake.scan();
    await until(() => flow.view().step === 'enter_password', 'the password step');
    expect(flow.view().hint).toBe('first pet');
    await flow.submit({ password: 'wrong' });
    await until(() => flow.view().error, 'the wrong-password message');
    expect(flow.view().step).toBe('enter_password');
    await flow.submit({ password: 'secret-pass' });
    const live = await flow.done;
    expect(flow.view().step).toBe('done');
    expect(live.identity).toBe('@dana_test');

    // First sync: chat list with unread counters, then the latest messages of each chat.
    await until(() => state.data.get('tg:synced'), 'the first sync');
    expect(chats.map((c) => c.title)).toEqual(['Anna', 'Team chat']);
    expect(chats[0]?.unread).toBe(2);
    expect(ingested.map((m) => m.text)).toEqual(['hello', 'see you tomorrow?', 'standup at 10']);

    // Live updates are stored as they come.
    fake.last!.onNewMessage.emit(fakeMessage(50, 'new message'));
    await until(() => ingested.some((m) => m.text === 'new message'), 'the live update');

    const receipt = await live.send({
      id: 'job_1',
      attempt: 1,
      kind: 'message',
      chat: { externalId: String(ANNA_ID), kind: 'direct' },
      text: 'On my way',
      replyToExternalId: '5',
    });
    expect(receipt?.externalId).toBe('101');
    expect(fake.sent[0]).toMatchObject({
      peer: ANNA_ID,
      text: 'On my way',
      replyTo: 5,
      randomId: randomIdFor('job_1').toString(),
    });

    await live.send({
      id: 'job_2',
      attempt: 1,
      kind: 'mark_read',
      chat: { externalId: String(ANNA_ID), kind: 'direct' },
      upToExternalId: '50',
    });
    expect(fake.read).toEqual([{ peer: ANNA_ID, maxId: 50 }]);

    fake.sendError = rpc(400, 'RANDOM_ID_DUPLICATE');
    expect(
      await live.send({
        id: 'job_1',
        attempt: 2,
        kind: 'message',
        chat: { externalId: String(ANNA_ID), kind: 'direct' },
        text: 'On my way',
      }),
    ).toBeUndefined();

    await expect(
      live.send({
        id: 'job_3',
        attempt: 1,
        kind: 'message',
        chat: { externalId: String(ANNA_ID), kind: 'direct' },
        text: 'x',
        file: { url: 'https://example.com/a.pdf', kind: 'document' },
      }),
    ).rejects.toMatchObject({ kind: 'rejected' });

    expect(await live.resolveRecipient!('@anna')).toMatchObject({
      externalId: String(ANNA_ID),
      kind: 'direct',
    });
    await expect(live.resolveRecipient!('@nobody')).rejects.toThrow(/no user or chat/);

    const file = await live.download!({
      chatExternalId: String(ANNA_ID),
      messageExternalId: '60',
      attachment: {
        id: 'att',
        externalId: '60:0',
        kind: 'document',
        mimeType: 'application/pdf',
        name: 'invoice.pdf',
        locator: { messageId: 60 },
      } as never,
    });
    expect(file).toMatchObject({ mimeType: 'application/pdf', name: 'invoice.pdf' });
    expect(file.data).toEqual(new Uint8Array([1, 2, 3]));

    expect(await live.backfill!(String(GROUP_ID), 20)).toBe(1);

    // The session survives a restart: a new connect finds the saved login.
    await live.stop();
    await live.closed;
    const again = await tg.connect(fakeSession(state).session);
    expect(again.identity).toBe('@dana_test');
    await again.stop();
  });

  it('logs in with a phone code, retrying a wrong code', async () => {
    const fake = createFakeTelegram();
    const { session } = fakeSession();
    const tg = driver(fake);
    await expect(tg.login!(session, { method: 'phone', phone: '+19990000000' })).rejects.toThrow(
      /does not know this phone/,
    );

    const flow = await tg.login!(session, { method: 'phone', phone: '15550001111' });
    expect(flow.view().step).toBe('enter_code');
    await flow.submit({ code: '11111' });
    await until(() => flow.view().error, 'the wrong-code message');
    expect(flow.view().step).toBe('enter_code');
    await flow.submit({ code: '12-345' });
    const live = await flow.done;
    expect(live.identity).toBe('@dana_test');
    await live.stop();
  });

  it('ends the session when Telegram revokes the login', async () => {
    const fake = createFakeTelegram();
    const { session } = fakeSession();
    const tg = driver(fake);
    const flow = await tg.login!(session, { method: 'qr' });
    await until(() => flow.view().qr, 'the QR code');
    fake.scan();
    const live: LiveSession = await flow.done;
    fake.stateError = rpc(401, 'AUTH_KEY_UNREGISTERED');
    await expect(live.closed).rejects.toBeInstanceOf(SessionError);
    await expect(live.closed).rejects.toMatchObject({ problem: 'logged_out' });
  });

  it('cancels a login', async () => {
    const fake = createFakeTelegram();
    const { session } = fakeSession();
    const flow = await driver(fake).login!(session, { method: 'qr' });
    await flow.cancel();
    await expect(flow.done).rejects.toThrow();
    expect(flow.view().step).toBe('failed');
    expect(fake.destroyed).toBeGreaterThan(0);
  });
});

describe('gateway configuration', () => {
  it('reads the Telegram app and accepts a bare host:port as the gateway address', async () => {
    const { loadGatewayConfig } = await import('../src/gateway/config.js');
    const { loadConfig } = await import('../src/config.js');
    const base = {
      DATABASE_URL: 'postgres://x@localhost/db',
      NODE_ENV: 'test',
      GATEWAY_TOKEN: 't'.repeat(32),
    };
    expect(loadGatewayConfig(base).telegram).toBeUndefined();
    expect(
      loadGatewayConfig({ ...base, TELEGRAM_API_ID: '123', TELEGRAM_API_HASH: 'a'.repeat(32) }).telegram,
    ).toEqual({
      apiId: 123,
      apiHash: 'a'.repeat(32),
    });
    expect(() => loadGatewayConfig({ ...base, TELEGRAM_API_ID: '123' })).toThrow(/together/);
    expect(() => loadGatewayConfig({ ...base, TELEGRAM_API_ID: '123', TELEGRAM_API_HASH: 'short' })).toThrow(
      /32-character/,
    );

    expect(loadConfig({ ...base, GATEWAY_URL: 'anyconnect-gateway:10000' }).gateway?.url).toBe(
      'http://anyconnect-gateway:10000',
    );
    expect(loadConfig({ ...base, GATEWAY_URL: 'http://gw.internal:10000/' }).gateway?.url).toBe(
      'http://gw.internal:10000',
    );
    expect(() => loadConfig({ ...base, GATEWAY_URL: 'ftp://gw' })).toThrow(/GATEWAY_URL/);
  });
});
