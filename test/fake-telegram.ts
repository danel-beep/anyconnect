import { Emitter } from '@fuman/utils';
import { Chat, Long, Message, MtPeerNotFoundError, PeersIndex, tl, User } from '@mtcute/core';
import type { TelegramClientLike } from '../src/gateway/drivers/telegram/driver.js';
import type { StateStorage } from '../src/gateway/drivers/telegram/storage.js';

export const ME_ID = 1000;
export const ANNA_ID = 111;
export const GROUP_ID = -555;

function rawUser(id: number, firstName: string, username?: string, phone?: string): tl.RawUser {
  return {
    _: 'user',
    id,
    accessHash: Long.fromNumber(id * 7),
    firstName,
    ...(username ? { username } : {}),
    ...(phone ? { phone } : {}),
  } as tl.RawUser;
}

const me = rawUser(ME_ID, 'Dana', 'dana_test', '15550001111');
const anna = rawUser(ANNA_ID, 'Anna', 'anna');
const group: tl.RawChat = {
  _: 'chat',
  id: -GROUP_ID,
  title: 'Team chat',
  participantsCount: 3,
  date: 1_700_000_000,
  version: 1,
} as tl.RawChat;
const peers = PeersIndex.from({ users: [me, anna], chats: [group] });

/** A message from Anna (or to her, `out`), or in the group; dates count from a fixed second. */
export function fakeMessage(
  id: number,
  text: string,
  options: { out?: boolean; group?: boolean; media?: tl.TypeMessageMedia; service?: boolean } = {},
): Message {
  const peerId: tl.TypePeer = options.group
    ? { _: 'peerChat', chatId: -GROUP_ID }
    : { _: 'peerUser', userId: ANNA_ID };
  const fromId: tl.TypePeer = { _: 'peerUser', userId: options.out ? ME_ID : ANNA_ID };
  const raw = options.service
    ? ({
        _: 'messageService',
        id,
        peerId,
        fromId,
        date: 1_700_000_000 + id,
        action: { _: 'messageActionChatJoinedByLink', inviterId: ANNA_ID },
      } as tl.RawMessageService)
    : ({
        _: 'message',
        id,
        peerId,
        fromId,
        out: options.out ?? false,
        date: 1_700_000_000 + id,
        message: text,
        ...(options.media ? { media: options.media } : {}),
      } as tl.RawMessage);
  return new Message(raw, peers);
}

export const rpc = (code: number, text: string) => new tl.RpcError(code, text);

/** What the fake Telegram saw, and switches the test flips. */
export interface FakeTelegramState {
  clients: number;
  destroyed: number;
  sent: { peer: unknown; text: string; randomId?: string; replyTo?: number }[];
  read: { peer: unknown; maxId?: number }[];
  typing: number;
  /** Set to make the login ask for the cloud password ("secret-pass"). */
  twoFactor: boolean;
  /** The next sendText fails with this. */
  sendError?: unknown;
  /** updates.getState (the watchdog) fails with this. */
  stateError?: unknown;
  scan(): void;
  /** The newest client, to emit updates on it. */
  last?: ReturnType<typeof fakeClient>;
}

export function createFakeTelegram(): FakeTelegramState {
  const state: FakeTelegramState = {
    clients: 0,
    destroyed: 0,
    sent: [],
    read: [],
    typing: 0,
    twoFactor: false,
    scan: () => {},
  };
  return state;
}

/** The `createClient` option of the Telegram driver: one fake mtcute client per session. */
export function fakeClientFactory(state: FakeTelegramState) {
  return ({ storage }: { storage: StateStorage }): TelegramClientLike => {
    const client = fakeClient(state, storage);
    state.last = client;
    return client as unknown as TelegramClientLike;
  };
}

function fakeClient(state: FakeTelegramState, storage: StateStorage) {
  state.clients++;
  let counter = 100;
  const loggedIn = async () => {
    // What mtcute stores after a login: a permanent key of the primary DC and some state.
    await storage.authKeys.set(2, new Uint8Array(256).fill(9));
    storage.kv.set('dc', new Uint8Array([2]));
    return new User(me);
  };
  const password = async (value: string) => {
    if (value !== 'secret-pass') throw rpc(400, 'PASSWORD_HASH_INVALID');
    return loggedIn();
  };
  return {
    onNewMessage: new Emitter<Message>(),
    onEditMessage: new Emitter<Message>(),
    onError: new Emitter<Error>(),
    onHistoryRead: new Emitter<{ isOutbox: boolean; chatId: number; unreadCount: number }>(),
    async connect() {},
    async destroy() {
      state.destroyed++;
    },
    async getMe() {
      return new User(me);
    },
    async notifyLoggedIn() {
      return me;
    },
    async startUpdatesLoop() {},
    async stopUpdatesLoop() {},
    async *iterDialogs() {
      yield { peer: new User(anna), unreadCount: 2 };
      yield { peer: new Chat(group), unreadCount: 0 };
    },
    async getHistory(peer: number) {
      if (peer === GROUP_ID) return [fakeMessage(7, 'standup at 10', { group: true })];
      return [fakeMessage(1, 'hello'), fakeMessage(2, 'see you tomorrow?', { out: true })];
    },
    async getPeerDialogs(peer: number) {
      return [{ peer: peer === ANNA_ID ? new User(anna) : new Chat(group), unreadCount: 4 }];
    },
    async getMessages(_peer: number, ids: number[]) {
      return ids.map((id) =>
        fakeMessage(id, '', {
          media: {
            _: 'messageMediaDocument',
            document: {
              _: 'document',
              id: Long.fromNumber(42),
              accessHash: Long.fromNumber(1),
              fileReference: new Uint8Array(),
              date: 0,
              mimeType: 'application/pdf',
              size: 3,
              dcId: 2,
              attributes: [{ _: 'documentAttributeFilename', fileName: 'invoice.pdf' }],
            },
          } as tl.TypeMessageMedia,
        }),
      );
    },
    async sendText(peer: unknown, text: string, params: { randomId?: Long; replyTo?: number }) {
      if (state.sendError) {
        const error = state.sendError;
        state.sendError = undefined;
        throw error;
      }
      state.sent.push({
        peer,
        text,
        ...(params.randomId ? { randomId: params.randomId.toString() } : {}),
        ...(params.replyTo ? { replyTo: params.replyTo } : {}),
      });
      return fakeMessage(++counter, text, { out: true });
    },
    async sendTyping() {
      state.typing++;
    },
    async readHistory(peer: unknown, params: { maxId?: number }) {
      state.read.push({ peer, ...(params.maxId ? { maxId: params.maxId } : {}) });
    },
    async getPeer(query: string | number) {
      if (query === 'anna' || query === ANNA_ID) return new User(anna);
      throw new MtPeerNotFoundError(`peer ${query} not found`);
    },
    async downloadAsBuffer() {
      return new Uint8Array([1, 2, 3]);
    },
    async logOut() {
      await storage.authKeys.deleteAll();
      return true;
    },
    async sendCode({ phone }: { phone: string }) {
      if (phone !== '+15550001111') throw rpc(400, 'PHONE_NUMBER_INVALID');
      return { phoneCodeHash: 'hash-1', type: 'app', length: 5 };
    },
    async signIn({ phoneCode, phoneCodeHash }: { phoneCode: string; phoneCodeHash: string }) {
      if (phoneCodeHash !== 'hash-1' || phoneCode !== '12345') throw rpc(400, 'PHONE_CODE_INVALID');
      if (state.twoFactor) throw rpc(401, 'SESSION_PASSWORD_NEEDED');
      return loggedIn();
    },
    async checkPassword({ password: value }: { password: string }) {
      return password(value);
    },
    async getPasswordHint() {
      return 'first pet';
    },
    async signInQr(params: {
      onUrlUpdated: (url: string, expires: Date) => void;
      password?: () => Promise<string>;
      invalidPasswordCallback?: () => void;
      abortSignal?: AbortSignal;
    }) {
      params.onUrlUpdated('tg://login?token=fake-token-1', new Date(Date.now() + 30_000));
      await new Promise<void>((resolve, reject) => {
        state.scan = resolve;
        params.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
      if (!state.twoFactor) return loggedIn();
      for (;;) {
        try {
          return await password(await params.password!());
        } catch (error) {
          params.invalidPasswordCallback?.();
          if (!tl.RpcError.is(error, 'PASSWORD_HASH_INVALID')) throw error;
        }
      }
    },
    async call(request: { _: string }) {
      if (request._ === 'updates.getState' && state.stateError) throw state.stateError;
      return {};
    },
  };
}
