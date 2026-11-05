/**
 * Telegram as a personal account (MTProto user mode, the protocol Telegram's own apps use), as a
 * session driver of the messenger gateway. The user logs in once on the website (QR code, or a
 * code from Telegram, then the cloud password if set); the session then lives in the gateway,
 * stored encrypted in Postgres, and shows up in Telegram under Settings → Devices as "Manyplug".
 *
 * Built on mtcute. The gateway around it owns leases, the outbox, pacing and reconnects; this
 * file only speaks Telegram. See docs/MESSENGERS.md.
 */

import { createHash } from 'node:crypto';
import { Long, type Message, MtPeerNotFoundError } from '@mtcute/core';
import { TelegramClient } from '@mtcute/core/client.js';
import {
  DeliveryError,
  type InboundChat,
  type OutboundJob,
  type SentReceipt,
} from '../../../connectors/messaging.js';
import { ConnectorError } from '../../../connectors/sdk.js';
import type { LoginStepInput, LoginView, StartLoginInput } from '../../../messaging/gateway-client.js';
import { VERSION } from '../../../version.js';
import type { DriverSession, LiveSession, LoginFlow, SessionDriver } from '../types.js';
import { SessionError } from '../types.js';
import { deliveryFailure, rpcText, sessionProblem, toSessionError } from './errors.js';
import { type TelegramFileLocator, toInboundChat, toInboundMessage } from './mapping.js';
import { DEVICE_MODEL, gatewayPlatform, NodeCryptoProvider, PolicyTcpTransport } from './platform.js';
import { StateStorage } from './storage.js';

/** The Manyplug app registered at my.telegram.org (TELEGRAM_API_ID / TELEGRAM_API_HASH on the gateway). */
export interface TelegramApp {
  apiId: number;
  apiHash: string;
}

/** The part of mtcute's client the driver uses (tests pass a fake). */
export type TelegramClientLike = Pick<
  TelegramClient,
  | 'connect'
  | 'destroy'
  | 'getMe'
  | 'notifyLoggedIn'
  | 'startUpdatesLoop'
  | 'stopUpdatesLoop'
  | 'onNewMessage'
  | 'onEditMessage'
  | 'onError'
  | 'onHistoryRead'
  | 'iterDialogs'
  | 'getHistory'
  | 'getPeerDialogs'
  | 'getMessages'
  | 'sendText'
  | 'sendTyping'
  | 'readHistory'
  | 'getPeer'
  | 'downloadAsBuffer'
  | 'logOut'
  | 'sendCode'
  | 'signIn'
  | 'checkPassword'
  | 'signInQr'
  | 'getPasswordHint'
  | 'call'
>;

export interface TelegramDriverOptions {
  /** Unset when the gateway has no Telegram app configured: accounts then report it instead of connecting. */
  app: TelegramApp | undefined;
  createClient?: (params: {
    app: TelegramApp;
    storage: StateStorage;
    session: DriverSession;
  }) => TelegramClientLike;
  /** How often to check that the login is still valid (and the connection alive). */
  watchdogMs?: number;
  /** First sync after a login: how many recent chats and messages per chat to load. */
  initialSync?: { chats: number; messagesPerChat: number; gapMs: number };
  /** Largest file the AI can download through the gateway. */
  maxDownloadBytes?: number;
}

const DEFAULTS = {
  watchdogMs: 4 * 60_000,
  initialSync: { chats: 40, messagesPerChat: 20, gapMs: 400 },
  maxDownloadBytes: 50 * 1024 * 1024,
};

const SYNCED_KEY = 'tg:synced';

function defaultClient({
  app,
  storage,
  session,
}: {
  app: TelegramApp;
  storage: StateStorage;
  session: DriverSession;
}) {
  return new TelegramClient({
    apiId: app.apiId,
    apiHash: app.apiHash,
    storage,
    storageOptions: { cleanup: false },
    crypto: new NodeCryptoProvider(),
    transport: new PolicyTcpTransport(session.network),
    platform: gatewayPlatform(session.logger),
    logLevel: 2,
    initConnectionOptions: { deviceModel: DEVICE_MODEL, appVersion: VERSION, systemVersion: 'Cloud' },
    // Messages missed while the session was down are fetched on connect (getDifference).
    updates: { catchUp: true },
  });
}

/** Telegram's random_id for a job: the same on every retry, so Telegram drops a second copy. */
export function randomIdFor(jobId: string): Long {
  const digest = createHash('sha256').update(`telegram-send:${jobId}`).digest();
  return Long.fromBytesLE([...digest.subarray(0, 8)]);
}

function peerOf(chatExternalId: string): number {
  const id = Number(chatExternalId);
  if (!Number.isSafeInteger(id)) throw new DeliveryError('rejected', 'Not a Telegram chat id.');
  return id;
}

export function telegramUserDriver(options: TelegramDriverOptions): SessionDriver {
  const createClient = options.createClient ?? defaultClient;
  const watchdogMs = options.watchdogMs ?? DEFAULTS.watchdogMs;
  const initialSync = options.initialSync ?? DEFAULTS.initialSync;
  const maxDownloadBytes = options.maxDownloadBytes ?? DEFAULTS.maxDownloadBytes;

  const requireApp = (): TelegramApp => {
    if (options.app) return options.app;
    throw new SessionError(
      'protocol',
      'The gateway has no Telegram app: set TELEGRAM_API_ID and TELEGRAM_API_HASH (from my.telegram.org).',
    );
  };

  /** Turns a logged-in client into a running session: updates, watchdog, sending. */
  async function goLive(
    client: TelegramClientLike,
    storage: StateStorage,
    session: DriverSession,
    me: { id: number; displayName: string; username: string | null; phoneNumber: string | null },
  ): Promise<LiveSession> {
    const selfId = me.id;
    const logger = session.logger;
    let resolveClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    const closed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    closed.catch(() => {});
    let ended = false;
    let watchdog: NodeJS.Timeout | undefined;

    const end = async (error?: SessionError) => {
      if (ended) return;
      ended = true;
      if (watchdog) clearInterval(watchdog);
      client.onNewMessage.remove(onMessage);
      client.onEditMessage.remove(onMessage);
      client.onError.remove(onError);
      client.onHistoryRead.remove(onRead);
      await storage.flush().catch((err) => logger.warn({ err }, 'could not save the Telegram session'));
      await client.destroy().catch(() => {});
      if (error) rejectClosed(error);
      else resolveClosed();
    };

    // Updates are stored one batch at a time, in arrival order.
    let queue = Promise.resolve();
    const ingest = (messages: Message[]) => {
      const inbound = messages.flatMap((m) => toInboundMessage(m, { selfId }) ?? []);
      if (inbound.length === 0) return;
      queue = queue
        .then(() => session.ingest(inbound))
        .catch((err) => logger.warn({ err }, 'could not store Telegram messages'));
    };
    const onMessage = (message: Message) => ingest([message]);
    const onError = (error: Error) => {
      const problem = sessionProblem(error);
      if (problem) void end(toSessionError(error));
    };
    // Read on the phone or another device: Telegram's own unread counter replaces ours.
    const onRead = (update: { isOutbox: boolean; chatId: number; unreadCount: number }) => {
      if (update.isOutbox) return;
      queue = queue
        .then(async () => {
          const peer = await client.getPeer(update.chatId);
          await session.upsertChats([toInboundChat(peer, { selfId, unread: update.unreadCount })]);
        })
        .catch((err) => logger.debug({ err }, 'could not update a Telegram unread counter'));
    };
    client.onNewMessage.add(onMessage);
    client.onEditMessage.add(onMessage);
    client.onError.add(onError);
    client.onHistoryRead.add(onRead);
    session.signal.addEventListener('abort', () => void end(), { once: true });

    let failures = 0;
    watchdog = setInterval(() => {
      client
        .call({ _: 'updates.getState' })
        .then(() => {
          failures = 0;
        })
        .catch((error) => {
          if (sessionProblem(error)) return void end(toSessionError(error));
          // mtcute reconnects by itself; give up only when it keeps failing.
          if (++failures >= 3) void end(toSessionError(error, 'network'));
        });
    }, watchdogMs);
    watchdog.unref();

    await client.startUpdatesLoop();
    await storage.flush();
    void syncChats(client, session, selfId, initialSync).catch((err) =>
      logger.warn({ err }, 'Telegram chat sync failed'),
    );

    const identity = me.username ? `@${me.username}` : me.phoneNumber ? `+${me.phoneNumber}` : me.displayName;

    const live: LiveSession = {
      closed,
      identity,
      idempotentSend: true,
      async send(job: OutboundJob): Promise<SentReceipt | undefined> {
        const peer = peerOf(job.chat.externalId);
        try {
          if (job.kind === 'mark_read') {
            await client.readHistory(peer, {
              ...(job.upToExternalId ? { maxId: Number(job.upToExternalId) } : {}),
            });
            return undefined;
          }
          if (job.file || job.template) {
            throw new DeliveryError('rejected', 'This Telegram account sends text messages only.');
          }
          const sent = await client.sendText(peer, job.text ?? '', {
            randomId: randomIdFor(job.id),
            ...(job.replyToExternalId ? { replyTo: Number(job.replyToExternalId) } : {}),
          });
          return { externalId: String(sent.id), sentAt: sent.date };
        } catch (error) {
          if (sessionProblem(error)) void end(toSessionError(error));
          deliveryFailure(error);
          // RANDOM_ID_DUPLICATE: an earlier attempt was delivered; the update brings its copy.
          return undefined;
        }
      },
      async typing(chatExternalId: string, durationMs: number) {
        await client.sendTyping(peerOf(chatExternalId), 'typing').catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, durationMs));
      },
      async resolveRecipient(to: string): Promise<InboundChat> {
        const target = to.trim();
        try {
          const peer = await client.getPeer(
            /^-?\d+$/.test(target) ? Number(target) : target.replace(/^@/, ''),
          );
          return toInboundChat(peer, { selfId });
        } catch (error) {
          const code = (error as { code?: number }).code;
          if (error instanceof MtPeerNotFoundError || (rpcText(error) && code === 400)) {
            throw new ConnectorError(
              'not_found',
              `Telegram has no user or chat "${target}" visible to this account.`,
            );
          }
          throw new ConnectorError('upstream', 'Telegram did not answer; try again in a minute.');
        }
      },
      async download({ chatExternalId, attachment }) {
        const locator = attachment.locator as TelegramFileLocator | undefined;
        if (!locator?.messageId)
          throw new ConnectorError('not_found', 'This attachment cannot be downloaded.');
        const [message] = await client.getMessages(peerOf(chatExternalId), [locator.messageId]);
        const media = message?.media as (Message['media'] & { fileSize?: number }) | null | undefined;
        if (!media || !('fileSize' in media) || media.type === 'webpage') {
          throw new ConnectorError('not_found', 'The message or its file is gone from Telegram.');
        }
        if ((media.fileSize ?? 0) > maxDownloadBytes) {
          throw new ConnectorError('invalid_input', 'The file is too large to download here.');
        }
        const data = await client.downloadAsBuffer(
          media as Parameters<TelegramClientLike['downloadAsBuffer']>[0],
        );
        return {
          data,
          mimeType: attachment.mimeType ?? 'application/octet-stream',
          ...(attachment.name ? { name: attachment.name } : {}),
        };
      },
      async backfill(chatExternalId: string, limit: number): Promise<number> {
        const peer = peerOf(chatExternalId);
        const [dialog] = await client.getPeerDialogs(peer).catch(() => [null]);
        const messages = await client.getHistory(peer, { limit: Math.min(100, Math.max(1, limit)) });
        const inbound = historyMessages(messages, selfId, dialog?.unreadCount);
        await session.ingest(inbound);
        return inbound.length;
      },
      async logout() {
        await client.logOut().catch(() => {});
        await end();
      },
      async stop() {
        await end();
      },
    };
    return live;
  }

  async function newClient(session: DriverSession) {
    const app = requireApp();
    const storage = new StateStorage(session.state, session.logger);
    await storage.driver.load();
    const client = createClient({ app, storage, session });
    return { client, storage };
  }

  return {
    connectorId: 'telegram',

    async connect(session) {
      const { client, storage } = await newClient(session);
      if (!storage.hasLogin()) {
        await client.destroy().catch(() => {});
        throw new SessionError('logged_out', 'Not logged in yet: log in on the website.');
      }
      try {
        await client.connect();
        const me = await client.getMe();
        await client.notifyLoggedIn(me.raw);
        return await goLive(client, storage, session, me);
      } catch (error) {
        await client.destroy().catch(() => {});
        throw toSessionError(error);
      }
    },

    async login(session, input) {
      // A new login replaces whatever was saved before.
      await session.state.clear();
      const { client, storage } = await newClient(session);
      try {
        await client.connect();
      } catch (error) {
        await client.destroy().catch(() => {});
        throw toSessionError(error);
      }
      return startLoginFlow(client, storage, session, input, goLive);
    },
  };
}

type GoLive = (
  client: TelegramClientLike,
  storage: StateStorage,
  session: DriverSession,
  me: Awaited<ReturnType<TelegramClientLike['getMe']>>,
) => Promise<LiveSession>;

type Step = LoginView['step'];

/** A waiter for the next value the user types on the login page. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

const LOGIN_ERRORS: Record<string, string> = {
  PHONE_CODE_INVALID: 'Wrong code. Check the latest code from Telegram and try again.',
  PHONE_CODE_EXPIRED: 'The code has expired. Start the login again.',
  PHONE_NUMBER_INVALID: 'Telegram does not know this phone number.',
  PHONE_NUMBER_BANNED: 'Telegram has banned this phone number.',
  PHONE_NUMBER_FLOOD: 'Too many login attempts for this number. Try again later.',
  PASSWORD_HASH_INVALID: 'Wrong password. Try again.',
  AUTH_TOKEN_EXPIRED: 'The QR code has expired. Start the login again.',
};

function loginErrorText(error: unknown): string {
  const text = rpcText(error);
  if (text && LOGIN_ERRORS[text]) return LOGIN_ERRORS[text];
  if (text?.startsWith('FLOOD_WAIT')) return 'Telegram asks to wait before trying again.';
  return text ? `Telegram refused the login (${text}).` : 'The login failed. Try again.';
}

/**
 * The interactive part: QR code (scanned in Telegram under Settings → Devices) or a code Telegram
 * sends to the user's app, then the cloud password when the account has one. Codes and passwords
 * are only typed on the website; they never pass through the AI chat.
 */
async function startLoginFlow(
  client: TelegramClientLike,
  storage: StateStorage,
  session: DriverSession,
  input: StartLoginInput,
  goLive: GoLive,
): Promise<LoginFlow> {
  let step: Step = input.method === 'qr' ? 'scan_qr' : 'enter_code';
  let qr: string | undefined;
  let hint: string | undefined;
  let error: string | undefined;
  const abort = new AbortController();
  const done = deferred<LiveSession>();
  let password = deferred<string>();
  let code = deferred<string>();
  let finished = false;

  const fail = async (reason: unknown) => {
    if (finished) return;
    finished = true;
    step = 'failed';
    error = loginErrorText(reason);
    abort.abort();
    await client.destroy().catch(() => {});
    done.reject(reason);
  };
  const succeed = async (me: Awaited<ReturnType<TelegramClientLike['getMe']>>) => {
    if (finished) return;
    try {
      const live = await goLive(client, storage, session, me);
      finished = true;
      step = 'done';
      done.resolve(live);
    } catch (reason) {
      await fail(reason);
    }
  };
  const askPassword = async (): Promise<string> => {
    hint = (await client.getPasswordHint().catch(() => null)) ?? undefined;
    step = 'enter_password';
    return password.promise;
  };

  async function withPassword(): Promise<Awaited<ReturnType<TelegramClientLike['getMe']>>> {
    for (;;) {
      const value = await askPassword();
      try {
        return await client.checkPassword({ password: value, abortSignal: abort.signal });
      } catch (reason) {
        if (rpcText(reason) !== 'PASSWORD_HASH_INVALID') throw reason;
        error = LOGIN_ERRORS.PASSWORD_HASH_INVALID;
        password = deferred<string>();
      }
    }
  }

  if (input.method === 'qr') {
    void client
      .signInQr({
        onUrlUpdated: (url) => {
          qr = url;
        },
        password: async () => {
          const value = await askPassword();
          password = deferred<string>();
          return value;
        },
        invalidPasswordCallback: () => {
          error = LOGIN_ERRORS.PASSWORD_HASH_INVALID;
        },
        abortSignal: abort.signal,
      })
      .then(succeed, fail);
  } else {
    if (!input.phone)
      throw new ConnectorError('invalid_input', 'Enter the phone number in international format.');
    const phone = input.phone.startsWith('+') ? input.phone : `+${input.phone}`;
    let sent: Awaited<ReturnType<TelegramClientLike['sendCode']>>;
    try {
      sent = await client.sendCode({ phone, abortSignal: abort.signal });
    } catch (reason) {
      await client.destroy().catch(() => {});
      throw new ConnectorError('invalid_input', loginErrorText(reason));
    }
    if (!('phoneCodeHash' in sent)) {
      void succeed(sent);
    } else {
      const phoneCodeHash = sent.phoneCodeHash;
      void (async () => {
        for (;;) {
          const value = await code.promise;
          try {
            return await client.signIn({ phone, phoneCodeHash, phoneCode: value, abortSignal: abort.signal });
          } catch (reason) {
            const text = rpcText(reason);
            if (text === 'SESSION_PASSWORD_NEEDED') return withPassword();
            if (text !== 'PHONE_CODE_INVALID') throw reason;
            error = LOGIN_ERRORS.PHONE_CODE_INVALID;
            code = deferred<string>();
          }
        }
      })().then(succeed, fail);
    }
  }

  const flow: LoginFlow = {
    view: () => ({
      step,
      ...(step === 'scan_qr' && qr ? { qr } : {}),
      ...(step === 'enter_password' && hint ? { hint } : {}),
      ...(error ? { error } : {}),
    }),
    async submit(value: LoginStepInput) {
      if (finished) return;
      error = undefined;
      if (step === 'enter_code' && value.code) code.resolve(value.code.replace(/\D/g, ''));
      else if (step === 'enter_password' && value.password) password.resolve(value.password);
    },
    async cancel() {
      await fail(new Error('cancelled'));
    },
    done: done.promise,
  };
  return flow;
}

/**
 * Older messages for the store. They carry Telegram's unread counter of the chat (when known), so
 * the store keeps it instead of counting old messages as new ones.
 */
function historyMessages(messages: Message[], selfId: number, unread: number | undefined) {
  return messages.flatMap((m) => {
    const inbound = toInboundMessage(m, { selfId });
    if (!inbound) return [];
    return [{ ...inbound, chat: { ...inbound.chat, unread: unread ?? 0 } }];
  });
}

/** Loads recent chats (titles, unread counters) and, after the first login, their latest messages. */
async function syncChats(
  client: TelegramClientLike,
  session: DriverSession,
  selfId: number,
  limits: { chats: number; messagesPerChat: number; gapMs: number },
): Promise<void> {
  const chats: InboundChat[] = [];
  for await (const dialog of client.iterDialogs({ limit: limits.chats })) {
    if (session.signal.aborted) return;
    chats.push(toInboundChat(dialog.peer, { selfId, unread: dialog.unreadCount }));
  }
  await session.upsertChats(chats);
  if (await session.state.get<boolean>(SYNCED_KEY)) return;
  for (const chat of chats) {
    if (session.signal.aborted) return;
    const messages = await client.getHistory(Number(chat.externalId), { limit: limits.messagesPerChat });
    await session.ingest(historyMessages(messages, selfId, chat.unread));
    await new Promise((resolve) => setTimeout(resolve, limits.gapMs));
  }
  await session.state.set(SYNCED_KEY, true);
}
