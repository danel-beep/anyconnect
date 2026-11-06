import { z } from 'zod';
import {
  type AttachmentKind,
  DeliveryError,
  type DirectTransport,
  type InboundAttachment,
  type InboundMessage,
  type MessagingPort,
  type OutboundFile,
  type OutboundJob,
  type SentReceipt,
} from '../messaging.js';
import {
  conversationInstructions,
  messengerActions,
  messengerUiTexts,
  pacingConfig,
} from '../messaging-actions.js';
import {
  deliveryAttempt,
  deliveryFetch,
  downloadForUpload,
  fileNameFromUrl,
  readJson,
  secretsEqual,
} from '../messaging-http.js';
import { type AccountContext, ConnectorError, defineConnector } from '../sdk.js';

/**
 * Telegram Bot: a bot through the official Bot API (webhook in, HTTPS out), plus the owner's own
 * chats when they hand the bot to Chat Automation (Telegram Business). Either the account's own bot
 * (`bot: own`, a token from @BotFather) or the hub's bot (`bot: hub`, made on the quick connect page,
 * see `src/messaging/telegram-automation.ts`). The personal account is a separate connector
 * (`telegram.ts`, MTProto session in the gateway).
 */
const config = z.object({
  bot: z
    .enum(['own', 'hub'])
    .default('own')
    .describe(
      'Whose bot: own = your bot with its token from @BotFather, hub = the hub bot added in Telegram Chat Automation (made on the quick connect page)',
    ),
  botApiUrl: z
    .url({ protocol: /^https?$/ })
    .default('https://api.telegram.org')
    .describe('Bot API server (your own one is only needed for files over 20 MB)'),
  pacing: pacingConfig.optional(),
});

const credentials = z.object({
  botToken: z
    .string()
    .trim()
    .regex(/^\d{5,}:[A-Za-z0-9_-]{30,}$/, 'expected a token from @BotFather, e.g. 123456:ABC-...')
    .optional()
    .describe('Bot token from @BotFather (your own bot)'),
});

type Config = z.output<typeof config>;
type Credentials = z.output<typeof credentials>;
type Ctx = AccountContext<Config, Credentials>;

// ---------------------------------------------------------------------------
// The hub's own bot (Telegram Chat Automation)
// ---------------------------------------------------------------------------

/**
 * The hub's own bot, for accounts connected through Telegram Chat Automation (`bot: hub`):
 * the person added it under Settings → Chat Automation and picked the chats it may see. The hub
 * keeps the bot token and the account's business connection; this connector only names Bot API
 * methods and reads Telegram's answers, exactly as for an account's own bot.
 */
export interface TelegramHubBot {
  /**
   * Calls a Bot API method on the account's business connection (the hub adds
   * `business_connection_id`) and returns Telegram's raw response. Only methods that read files or
   * send and read messages are allowed. Throws a {@link DeliveryError} (`auth`) when the account is
   * not connected now.
   */
  call(
    accountId: string,
    method: string,
    params: Record<string, unknown> | FormData,
    signal?: AbortSignal,
  ): Promise<Response>;
  /** Downloads a file by the `file_path` getFile returned. */
  file(accountId: string, path: string, signal?: AbortSignal): Promise<Response>;
  /** The connection as Telegram last reported it; undefined when the account is not connected. */
  connection(accountId: string): Promise<TelegramBotConnection | undefined>;
}

export interface TelegramBotConnection {
  /** Who connected the bot: their @username, else their name. */
  identity: string;
  /** False while the bot is removed or paused in the person's Telegram settings. */
  enabled: boolean;
  /** What the person allowed: Telegram's BusinessBotRights flags that are on, e.g. `can_reply`. */
  rights: string[];
}

/** For hubs without a bot of their own (TELEGRAM_BOT_TOKEN is not set). */
export const NO_HUB_BOT: TelegramHubBot = {
  call: () => Promise.reject(new DeliveryError('auth', 'This hub has no Telegram bot of its own.')),
  file: () => Promise.reject(new ConnectorError('upstream', 'This hub has no Telegram bot of its own.')),
  connection: () => Promise.resolve(undefined),
};

// ---------------------------------------------------------------------------
// Bot API
// ---------------------------------------------------------------------------

/**
 * How an account reaches the Bot API: its own bot (a token from @BotFather) or the hub's bot on the
 * account's business connection.
 */
interface BotApi {
  /** Chats are the person's own chats on one business connection that the hub adds to requests. */
  hub: boolean;
  /** Sends a request and returns Telegram's raw answer. */
  send(method: string, params: Record<string, unknown> | FormData): Promise<Response>;
  /** Downloads a file by the `file_path` getFile returned. */
  file(path: string): Promise<Response>;
}

function botToken(ctx: Ctx): string {
  if (!ctx.credentials.botToken)
    throw new ConnectorError('auth', 'The bot token is not set for this account.');
  return ctx.credentials.botToken;
}

function ownBot(ctx: Ctx): BotApi {
  const base = ctx.config.botApiUrl.replace(/\/+$/, '');
  return {
    hub: false,
    send: (method, params) =>
      deliveryFetch(ctx.fetch, `${base}/bot${botToken(ctx)}/${method}`, {
        method: 'POST',
        ...(params instanceof FormData
          ? { body: params }
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }),
        signal: ctx.signal,
      }),
    file: (path) => ctx.fetch(`${base}/file/bot${botToken(ctx)}/${path}`, { signal: ctx.signal }),
  };
}

function hubBot(port: TelegramHubBot, ctx: Ctx): BotApi {
  return {
    hub: true,
    send: (method, params) => deliveryAttempt(() => port.call(ctx.account.id, method, params, ctx.signal)),
    file: (path) => port.file(ctx.account.id, path, ctx.signal),
  };
}

interface BotApiResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

/** Calls a Bot API method; failures become {@link DeliveryError}s the dispatcher understands. */
async function callBot<T>(
  api: BotApi,
  method: string,
  params: Record<string, unknown> | FormData,
): Promise<T> {
  const response = await api.send(method, params);
  const body = (await readJson(response)) as BotApiResult<T>;
  if (response.ok && body.ok) return body.result as T;
  const description = body.description ?? `HTTP ${response.status}`;
  const code = body.error_code ?? response.status;
  if (code === 429) {
    throw new DeliveryError('rate_limited', description, {
      retryAfterSeconds: body.parameters?.retry_after ?? 30,
    });
  }
  if (code === 401 || code === 404) {
    // The hub's bot token is the hub's problem, never the account's: retry, the owner was told.
    if (api.hub) throw new DeliveryError('transient', `Telegram did not accept the hub bot: ${description}`);
    throw new DeliveryError('auth', `Telegram rejected the bot token: ${description}`);
  }
  if (code >= 500) throw new DeliveryError('transient', description);
  // 400 (chat not found, message too long...), 403 (blocked by the user, kicked from the group).
  throw new DeliveryError(
    'rejected',
    api.hub
      ? `${description}. With Chat Automation the bot replies only where the person wrote within the last 24 hours, and only while "Reply to messages" is allowed in Telegram (Settings → Chat Automation).`
      : description,
  );
}

/** The same call for actions (not the outbox): errors become ConnectorErrors for the AI. */
async function callBotForAction<T>(api: BotApi, method: string, params: Record<string, unknown>): Promise<T> {
  try {
    return await callBot<T>(api, method, params);
  } catch (error) {
    if (!(error instanceof DeliveryError)) throw error;
    const kind = error.kind === 'auth' ? 'auth' : error.kind === 'rejected' ? 'invalid_input' : 'upstream';
    throw new ConnectorError(kind, error.message, { cause: error });
  }
}

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}
interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}
interface TgFile {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
}
interface TgMessage {
  message_id: number;
  date: number;
  edit_date?: number;
  /** Set on messages of a Telegram Business account the bot is connected to. */
  business_connection_id?: string;
  /** The bot that sent this business message on the owner's behalf. */
  sender_business_bot?: TgUser;
  chat: TgChat;
  from?: TgUser;
  sender_chat?: TgChat;
  text?: string;
  caption?: string;
  reply_to_message?: { message_id: number };
  photo?: TgFile[];
  document?: TgFile;
  video?: TgFile;
  audio?: TgFile;
  voice?: TgFile;
  video_note?: TgFile;
  sticker?: TgFile & { emoji?: string };
  animation?: TgFile;
  location?: { latitude: number; longitude: number };
  contact?: { phone_number: string; first_name: string; last_name?: string };
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  edited_channel_post?: TgMessage;
  business_message?: TgMessage;
  edited_business_message?: TgMessage;
  deleted_business_messages?: { business_connection_id: string; chat: TgChat; message_ids: number[] };
}

/** Updates the hub asks Telegram for (setWebhook `allowed_updates`). */
export const BOT_UPDATES = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
];

/**
 * Chats of a person who connected an account's own bot to their Telegram (Settings → Chat
 * Automation) are addressed through the connection, so their external id carries it:
 * `<chat id>@<connection id>`. Reconnecting the bot gives a new connection id, and with it new chats
 * in the hub's copy; the old ones stay readable. Accounts made with the hub's bot keep plain chat
 * ids instead: they have one connection, which the hub tracks and adds to every request.
 */
export function businessChatId(chatId: number | string, connectionId: string): string {
  return `${chatId}@${connectionId}`;
}

export function parseChatId(externalId: string): { chatId: string; businessConnectionId?: string } {
  const at = externalId.indexOf('@');
  return at > 0
    ? { chatId: externalId.slice(0, at), businessConnectionId: externalId.slice(at + 1) }
    : { chatId: externalId };
}

const fullName = (u: { first_name?: string; last_name?: string } | undefined) =>
  [u?.first_name, u?.last_name].filter(Boolean).join(' ') || undefined;

function attachments(message: TgMessage): InboundAttachment[] {
  const out: InboundAttachment[] = [];
  const add = (kind: AttachmentKind, file: TgFile | undefined, fallbackMime?: string) => {
    if (!file) return;
    out.push({
      externalId: file.file_unique_id ?? file.file_id,
      kind,
      ...(file.file_name ? { name: file.file_name } : {}),
      ...(file.mime_type || fallbackMime ? { mimeType: file.mime_type ?? fallbackMime } : {}),
      ...(file.file_size !== undefined ? { size: file.file_size } : {}),
      locator: { fileId: file.file_id },
    });
  };
  // Telegram sends every size of a photo; the last one is the largest.
  add('photo', message.photo?.at(-1), 'image/jpeg');
  add('document', message.document);
  add('video', message.video ?? message.animation ?? message.video_note, 'video/mp4');
  add('audio', message.audio);
  add('voice', message.voice, 'audio/ogg');
  add('sticker', message.sticker, 'image/webp');
  return out;
}

function messageText(message: TgMessage): string {
  const parts = [message.text ?? message.caption ?? ''];
  if (message.sticker?.emoji) parts.push(message.sticker.emoji);
  if (message.location) parts.push(`[location ${message.location.latitude}, ${message.location.longitude}]`);
  if (message.contact) {
    parts.push(
      `[contact ${fullName(message.contact) ?? ''} ${message.contact.phone_number}]`.replace(/\s+/g, ' '),
    );
  }
  return parts.filter(Boolean).join(' ');
}

function chatOf(chat: TgChat, businessConnectionId: string | undefined): InboundMessage['chat'] {
  const kind = chat.type === 'private' ? 'direct' : chat.type === 'channel' ? 'channel' : 'group';
  return {
    externalId: businessConnectionId ? businessChatId(chat.id, businessConnectionId) : String(chat.id),
    kind,
    ...(chat.type === 'private'
      ? { title: fullName(chat) ?? chat.username }
      : chat.title
        ? { title: chat.title }
        : {}),
    ...(chat.username ? { username: chat.username } : {}),
  };
}

/**
 * Turns a webhook update into the messages it carries (none for updates the hub ignores). With
 * `plainChats` (accounts of the hub's bot) business chats keep their plain Telegram ids.
 */
export function botUpdateToMessages(
  update: TgUpdate,
  botId: string,
  options: { plainChats?: boolean } = {},
): InboundMessage[] {
  const connection = (id: string | undefined) => (options.plainChats ? undefined : id);
  const deleted = update.deleted_business_messages;
  if (deleted) {
    return deleted.message_ids.map((id) => ({
      chat: chatOf(deleted.chat, connection(deleted.business_connection_id)),
      externalId: String(id),
      direction: 'in',
      sentAt: new Date(),
      deleted: true,
    }));
  }
  const message =
    update.message ??
    update.edited_message ??
    update.channel_post ??
    update.edited_channel_post ??
    update.business_message ??
    update.edited_business_message;
  if (!message) return [];
  const chat = message.chat;
  const author = message.from;
  const business = message.business_connection_id;
  // In a business chat the other side is the chat itself; anything else was written by the owner
  // (from their phone) or by the bot on their behalf.
  const outgoing = business
    ? Boolean(message.sender_business_bot) || (author !== undefined && author.id !== chat.id)
    : author !== undefined && String(author.id) === botId;
  return [
    {
      chat: chatOf(chat, connection(business)),
      externalId: String(message.message_id),
      direction: outgoing ? 'out' : 'in',
      sentAt: new Date(message.date * 1000),
      ...(message.edit_date ? { editedAt: new Date(message.edit_date * 1000) } : {}),
      ...(author
        ? {
            sender: {
              externalId: String(author.id),
              name: fullName(author) ?? author.username ?? String(author.id),
            },
          }
        : message.sender_chat
          ? { sender: { externalId: String(message.sender_chat.id), name: message.sender_chat.title ?? '' } }
          : {}),
      text: messageText(message),
      ...(message.reply_to_message ? { replyToExternalId: String(message.reply_to_message.message_id) } : {}),
      attachments: attachments(message),
    },
  ];
}

/** The biggest file the hub downloads to upload it to Telegram itself. */
const MAX_UPLOAD_BYTES = 20 * 1_048_576;

/**
 * How a file goes to Telegram. Telegram fetches links itself only for some formats (documents:
 * PDF, ZIP, GIF; audio: MP3, M4A; video: MP4); anything else, or a file that should get its own
 * name, is downloaded by the hub and uploaded.
 */
export function telegramFileRoute(file: OutboundFile): { method: string; field: string; byLink: boolean } {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(safePath(file.url))?.[1]?.toLowerCase() ?? '';
  const renamed = file.name !== undefined && file.name !== fileNameFromUrl(file.url);
  const route = (method: string, field: string, linkable: string[] | true) => ({
    method,
    field,
    byLink: !renamed && (linkable === true || linkable.includes(ext)),
  });
  switch (file.kind) {
    case 'photo':
      return route('sendPhoto', 'photo', true);
    case 'video':
      return route('sendVideo', 'video', ['mp4']);
    case 'audio':
      return ext === 'ogg' || ext === 'opus'
        ? route('sendVoice', 'voice', true)
        : route('sendAudio', 'audio', ['mp3', 'm4a']);
    default:
      return route('sendDocument', 'document', ['pdf', 'zip', 'gif']);
  }
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Sends a file message, by link or as an upload (see {@link telegramFileRoute}). */
async function sendFile(
  api: BotApi,
  ctx: Ctx,
  file: OutboundFile,
  params: Record<string, unknown>,
): Promise<TgMessage> {
  const route = telegramFileRoute(file);
  if (route.byLink) return callBot<TgMessage>(api, route.method, { ...params, [route.field]: file.url });
  const downloaded = await downloadForUpload(ctx.fetch, file.url, {
    maxBytes: MAX_UPLOAD_BYTES,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) {
    form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  form.append(
    route.field,
    new Blob([downloaded.data as Uint8Array<ArrayBuffer>], { type: downloaded.mimeType }),
    file.name ?? downloaded.name,
  );
  return callBot<TgMessage>(api, route.method, form);
}

/** Delivers an outbox job through the Bot API (both kinds of bot). */
async function deliver(api: BotApi, job: OutboundJob, ctx: Ctx): Promise<SentReceipt | undefined> {
  // The hub adds its own connection; an own bot's business chats carry theirs in the chat id.
  const { chatId, businessConnectionId } = api.hub
    ? { chatId: job.chat.externalId, businessConnectionId: undefined }
    : parseChatId(job.chat.externalId);
  if (job.kind === 'mark_read') {
    // Only business chats have read receipts for bots, and only with the "read messages" right.
    if ((!api.hub && !businessConnectionId) || !job.upToExternalId) return undefined;
    await callBot(api, 'readBusinessMessage', {
      ...(businessConnectionId ? { business_connection_id: businessConnectionId } : {}),
      chat_id: Number(chatId),
      message_id: Number(job.upToExternalId),
    }).catch((error: unknown) => {
      if (!(error instanceof DeliveryError) || error.kind !== 'rejected') throw error;
    });
    return undefined;
  }
  const params = {
    chat_id: chatId,
    ...(businessConnectionId ? { business_connection_id: businessConnectionId } : {}),
    ...(job.replyToExternalId
      ? {
          reply_parameters: {
            message_id: Number(job.replyToExternalId),
            allow_sending_without_reply: true,
          },
        }
      : {}),
  };
  const result = job.file
    ? await sendFile(api, ctx, job.file, { ...params, ...(job.text ? { caption: job.text } : {}) })
    : await callBot<TgMessage>(api, 'sendMessage', { ...params, text: job.text });
  return {
    externalId: String(result.message_id),
    sentAt: new Date(result.date * 1000),
    // Telegram returns the stored file: the hub's copy can then download it like a received one.
    ...(job.file ? { attachments: attachments(result) } : {}),
  };
}

/** Downloads a received (or sent) file through the Bot API (both kinds of bot). */
async function download(api: BotApi, attachment: { locator?: unknown }) {
  const fileId = (attachment.locator as { fileId?: string } | undefined)?.fileId;
  if (!fileId) throw new ConnectorError('not_found', 'This file can no longer be downloaded.');
  const file = await callBotForAction<{ file_path?: string; file_size?: number }>(api, 'getFile', {
    file_id: fileId,
  });
  if (!file.file_path) {
    throw new ConnectorError('invalid_input', 'Telegram does not let bots download files larger than 20 MB.');
  }
  const response = await api.file(file.file_path);
  if (!response.ok)
    throw new ConnectorError('upstream', `Telegram file download failed (${response.status})`);
  return {
    data: new Uint8Array(await response.arrayBuffer()),
    mimeType: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
    name: file.file_path.split('/').at(-1) ?? 'file',
  };
}

/** An account's own bot: its token, its webhook (`/hooks/messenger/<account>`). */
const ownBotTransport: DirectTransport<Config, Credentials> = {
  kind: 'direct',
  // The Bot API has no idempotency key: an interrupted send is reported as uncertain, never repeated.
  idempotentSend: false,
  files: true,
  send: (job, ctx) => deliver(ownBot(ctx), job, ctx),
  download: (attachment, ctx) => download(ownBot(ctx), attachment),

  webhook: {
    async handle(request, ctx, hook) {
      if (request.method !== 'POST') return { status: 405 };
      if (!secretsEqual(request.headers['x-telegram-bot-api-secret-token'], hook.secret))
        return { status: 401 };
      let update: TgUpdate;
      try {
        update = JSON.parse(request.body) as TgUpdate;
      } catch {
        return { status: 400 };
      }
      const botId = botToken(ctx).split(':')[0]!;
      const messages = botUpdateToMessages(update, botId);
      if (messages.length) await hook.ingest(messages);
      return { status: 200, body: 'ok' };
    },
  },
};

/**
 * The hub's bot added in the person's Chat Automation: the hub routes the updates of the account's
 * business connection here (`routed`) and adds the connection to every request.
 */
function hubBotTransport(port: TelegramHubBot): DirectTransport<Config, Credentials> {
  return {
    kind: 'direct',
    idempotentSend: false,
    files: true,
    send: (job, ctx) => deliver(hubBot(port, ctx), job, ctx),
    download: (attachment, ctx) => download(hubBot(port, ctx), attachment),
    routed: {
      async handle(event, _ctx, sink) {
        // Business updates only: the hub's bot gets nothing else for this account.
        const messages = botUpdateToMessages(event as TgUpdate, '', { plainChats: true });
        if (messages.length) await sink.ingest(messages);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export function createTelegramBotConnector(port: MessagingPort, hub: TelegramHubBot = NO_HUB_BOT) {
  const hubTransport = hubBotTransport(hub);
  return defineConnector({
    id: 'telegram_bot',
    name: 'Telegram Bot',
    description:
      'Telegram bots through the official Bot API: your own bot, or your private chats through the Manyplug bot (Chat Automation, connect by QR code). Read and search chats, see what is new, reply.',
    version: '2.0.0',
    homepage: 'https://core.telegram.org/bots',
    instructions:
      "Telegram Bot tools read the hub's synced copy of the chats: fast and free. " +
      'Find chats with telegram_bot_list_chats, then read or send by chat id. ' +
      'A bot sees only chats where people wrote to it and cannot write first. ' +
      "Via Chat Automation (Telegram Business) the user's picked private chats appear from connection on; " +
      "replies go out as the user, within 24 hours of the person's last message. " +
      conversationInstructions('telegram_bot'),
    config,
    credentials,
    messenger: {
      transport: (cfg) => (cfg.bot === 'hub' ? hubTransport : ownBotTransport),
      // Bots are official API clients: Telegram limits them (about 1 message/s per chat, 20/min per
      // group), but there is no reason to imitate a person. The hub's bot is shared by everyone who
      // connected it (about 30 messages/s in total), so each such account gets a smaller share.
      pacing: (cfg) =>
        cfg.bot === 'hub'
          ? { perMinute: 20, perHour: 300, perDay: 2_000, minGapMs: 300, maxGapMs: 900, typing: false }
          : { perMinute: 20, perHour: 1_000, perDay: 20_000, minGapMs: 100, maxGapMs: 400, typing: false },
    },
    async test(ctx) {
      if (ctx.config.bot === 'hub') {
        const connection = await hub.connection(ctx.account.id);
        if (!connection)
          throw new ConnectorError(
            'auth',
            'This Telegram account is no longer connected through Chat Automation: connect it again.',
          );
        if (!connection.enabled)
          throw new ConnectorError(
            'auth',
            'The bot is removed or paused in Telegram (Settings → Chat Automation): add it again there or connect again.',
          );
        return {
          ok: true,
          identity: connection.identity,
          ...(connection.rights.includes('can_reply')
            ? {}
            : {
                message:
                  'The bot can read but not reply: allow it to reply to messages in Telegram (Settings → Chat Automation).',
              }),
        };
      }
      const api = ownBot(ctx);
      const me = await callBotForAction<TgUser>(api, 'getMe', {});
      const hook = port.forAccount(ctx.account.id).webhook();
      await callBotForAction<boolean>(api, 'setWebhook', {
        url: hook.url,
        secret_token: hook.secret,
        allowed_updates: BOT_UPDATES,
      });
      return { ok: true, identity: me.username ? `@${me.username}` : String(me.id) };
    },
    ui: {
      primaryFields: ['botToken'],
      // Accounts of the hub's bot are made on the quick connect page, never with the form.
      formHiddenOptions: { bot: ['hub'] },
      locales: {
        ru: {
          description:
            'Боты Telegram через официальный Bot API: ваш бот или ваши личные чаты через бота Manyplug («Автоматизация чатов», подключение по QR-коду). Чаты, поиск, ответы.',
          setup: {
            app: {
              summary:
                'Вы сканируете QR-код телефоном, вводите на этой странице код из бота Manyplug и добавляете бота в Telegram в разделе «Автоматизация чатов».',
              minutes: 1,
              needs: ['Telegram на телефоне, обновлённый после мая 2026 года'],
              notice:
                'Бот видит только выбранные вами личные чаты и только с момента подключения. Для групп, каналов и старой переписки подключите личный аккаунт с полным доступом.',
              steps: [
                {
                  text: 'Наведите камеру телефона на QR-код на этой странице. Если страница открыта на телефоне, нажмите **Открыть Telegram**.',
                },
                {
                  text: 'В боте Manyplug нажмите **Запустить** (Start) и проверьте, что показан ваш аккаунт Manyplug. Введите код из бота на этой странице и нажмите **Подключить**.',
                },
                { text: 'В Telegram откройте **Настройки → Автоматизация чатов** и добавьте бота Manyplug.' },
                {
                  text: 'Выберите чаты, которые бот может видеть, разрешите ему отвечать на сообщения и сохраните.',
                },
                { text: 'Подождите несколько секунд: эта страница сама покажет **Подключено**.' },
              ],
              tips: [
                'Telegram сам показывает, что может бот. Изменить чаты или убрать бота можно в любой момент: **Настройки → Автоматизация чатов**.',
                'ИИ видит новые сообщения с момента подключения, в том числе те, что вы пишете с телефона.',
                'Ответы уходят от вашего имени и только в чаты, где собеседник писал за последние 24 часа.',
              ],
              problems: [
                {
                  problem: 'В настройках нет раздела **Автоматизация чатов**',
                  fix: 'Обновите Telegram в App Store или Google Play: раздел появился в мае 2026 года. На некоторых телефонах он находится в **Настройки → Изменить**.',
                },
                {
                  problem: 'Бот пишет, что ссылка устарела или уже использована',
                  fix: 'Обновите эту страницу, чтобы получить новый QR-код, и отсканируйте его в течение 15 минут.',
                },
                {
                  problem: 'Страница всё ждёт, хотя бот добавлен',
                  fix: 'Проверьте, что вы ввели код из бота на этой странице. Затем проверьте в **Настройки → Автоматизация чатов**, что бот Manyplug в списке и включён.',
                },
                {
                  problem: 'ИИ не может ответить в чате',
                  fix: 'Разрешите боту отвечать на сообщения в **Настройки → Автоматизация чатов**. Бот отвечает только там, где собеседник писал за последние 24 часа.',
                },
                {
                  problem: 'Камера телефона не открывает Telegram',
                  fix: 'Откройте эту страницу на телефоне, где установлен Telegram, и нажмите **Открыть Telegram**.',
                },
              ],
            },
            form: {
              summary: 'Вы создаёте бота через @BotFather и вставляете его токен.',
              minutes: 3,
              needs: ['Telegram на телефоне или компьютере'],
              steps: [
                {
                  text: 'Откройте @BotFather в Telegram и отправьте **/newbot** (или **/mybots**, чтобы выбрать уже созданного бота).',
                  link: { label: 'Открыть @BotFather', url: 'https://t.me/BotFather' },
                },
                {
                  text: 'Отправьте имя бота, затем адрес, который заканчивается на bot, например acme_support_bot.',
                },
                {
                  text: 'Скопируйте токен из ответа BotFather: он выглядит как 123456789:AA…',
                  fills: ['botToken'],
                },
                {
                  text: 'Вставьте его в форму и нажмите **Подключить**. Manyplug проверит токен и начнёт принимать сообщения.',
                },
              ],
              tips: [
                'Нужны все ваши чаты и группы? Подключите сервис **Telegram**: это вход в личный аккаунт по QR-коду.',
                'Бот видит только чаты, где ему написали, и не может начать разговор первым.',
                'Ваш бот может вести и ваши личные чаты: включите ему Secretary Mode в @BotFather и добавьте его в **Настройки → Автоматизация чатов**.',
              ],
              problems: [
                {
                  problem: 'Проверка пишет, что токен бота неверный (Unauthorized)',
                  fix: 'Скопируйте токен заново: отправьте @BotFather **/mybots**, выберите бота и нажмите **API Token**. Если вы нажимали **Revoke current token**, возьмите новый токен.',
                },
                {
                  problem: 'Бот не получает сообщения из группы',
                  fix: 'Отправьте @BotFather **/setprivacy**, выберите бота и нажмите **Disable**. Затем удалите бота из группы и добавьте снова.',
                },
                {
                  problem: 'Бот не видит сообщения человека',
                  fix: 'Человек должен сначала открыть бота и нажать **Start**: бот не может написать тому, кто ему ни разу не писал.',
                },
              ],
            },
          },
          prompts: [
            'Что нового написали моему боту за сегодня?',
            'Найди обращения клиентов про доставку за эту неделю.',
            'Ответь Анне в чате бота, что счёт будет вечером.',
          ],
          fields: {
            bot: {
              label: 'Чей бот',
              options: { own: 'Ваш бот (токен от @BotFather)', hub: 'Бот Manyplug («Автоматизация чатов»)' },
            },
            botApiUrl: { label: 'Сервер Bot API', hint: 'Свой сервер нужен только для файлов больше 20 МБ.' },
            botToken: { label: 'Токен бота', placeholder: '123456789:AA…' },
            pacing: texts.ru.pacing,
          },
          actions: texts.ru.actions,
        },
        en: {
          description:
            'Telegram bots through the official Bot API: your own bot, or your private chats through the Manyplug bot (Chat Automation, connect by QR code). Chats, search, replies.',
          setup: {
            app: {
              summary:
                'You scan a QR code with your phone, type the code from the Manyplug bot on this page and add the bot to your Telegram under Settings → Chat Automation.',
              minutes: 1,
              needs: ['Telegram on your phone, updated since May 2026'],
              notice:
                'The bot sees only the private chats you pick, from the moment you connect. For groups, channels and older messages, connect a personal account with full access instead.',
              steps: [
                {
                  text: 'Point your phone camera at the QR code on this page. If this page is open on your phone, tap **Open Telegram**.',
                },
                {
                  text: 'In the Manyplug bot tap **Start** and check that it shows your Manyplug account. Type the code from the bot on this page and click **Connect**.',
                },
                { text: 'In Telegram open **Settings → Chat Automation** and add the Manyplug bot.' },
                { text: 'Choose the chats the bot may see, allow it to reply to messages and save.' },
                { text: 'Wait a few seconds: this page shows **Connected** by itself.' },
              ],
              tips: [
                'Telegram shows what the bot may do. Change the chats or remove the bot any time under **Settings → Chat Automation**.',
                'The AI sees new messages from the moment you connect, including the ones you send from your phone.',
                'Replies go out as you, and only in chats where the person wrote within the last 24 hours.',
              ],
              problems: [
                {
                  problem: 'There is no **Chat Automation** in Settings',
                  fix: 'Update Telegram in the App Store or Google Play: the section appeared in May 2026. On some phones it is under **Settings → Edit**.',
                },
                {
                  problem: 'The bot says the link has expired or was already used',
                  fix: 'Reload this page to get a new QR code and scan it within 15 minutes.',
                },
                {
                  problem: 'The page keeps waiting after you added the bot',
                  fix: 'Check that you typed the code from the bot on this page. Then check under **Settings → Chat Automation** that the Manyplug bot is listed and turned on.',
                },
                {
                  problem: 'The AI cannot reply in a chat',
                  fix: 'Allow the bot to reply to messages under **Settings → Chat Automation**. The bot can only answer where the person wrote within the last 24 hours.',
                },
                {
                  problem: 'The phone camera does not open Telegram',
                  fix: 'Open this page on the phone that has Telegram and tap **Open Telegram**.',
                },
              ],
            },
            form: {
              summary: 'You create a bot with @BotFather and paste its token.',
              minutes: 3,
              needs: ['Telegram on your phone or computer'],
              steps: [
                {
                  text: 'Open @BotFather in Telegram and send **/newbot** (or **/mybots** to pick a bot you already have).',
                  link: { label: 'Open @BotFather', url: 'https://t.me/BotFather' },
                },
                {
                  text: 'Send a name for the bot, then a username that ends in bot, for example acme_support_bot.',
                },
                {
                  text: 'Copy the token from BotFather’s reply: it looks like 123456789:AA…',
                  fills: ['botToken'],
                },
                {
                  text: 'Paste it into the form and click **Connect**. Manyplug checks the token and starts receiving messages.',
                },
              ],
              tips: [
                'Want all your chats and groups? Connect the **Telegram** service instead: it logs in to your personal account with a QR code.',
                'A bot only sees chats where people wrote to it and cannot start a conversation.',
                'Your bot can also handle your personal chats: turn on Secretary Mode for it in @BotFather and add it under **Settings → Chat Automation**.',
              ],
              problems: [
                {
                  problem: 'The check says the bot token is wrong (Unauthorized)',
                  fix: 'Copy the token again: send **/mybots** to @BotFather, pick the bot and tap **API Token**. If you tapped **Revoke current token**, use the new token.',
                },
                {
                  problem: 'The bot gets no messages from a group',
                  fix: 'Send **/setprivacy** to @BotFather, pick the bot and choose **Disable**. Then remove the bot from the group and add it again.',
                },
                {
                  problem: 'The bot does not see a person’s messages',
                  fix: 'The person has to open the bot and tap **Start** first: a bot cannot write to someone who never wrote to it.',
                },
              ],
            },
          },
          prompts: [
            'What did people write to my bot today?',
            'Find customer questions about delivery from this week.',
            'Tell Anna in the bot chat that the invoice comes tonight.',
          ],
          fields: {
            bot: {
              label: 'Whose bot',
              options: { own: 'Your bot (token from @BotFather)', hub: 'Manyplug bot (Chat Automation)' },
            },
            botApiUrl: {
              label: 'Bot API server',
              hint: 'Your own server is only needed for files over 20 MB.',
            },
            botToken: { label: 'Bot token', placeholder: '123456789:AA…' },
            pacing: texts.en.pacing,
          },
          actions: texts.en.actions,
        },
      },
    },
    actions: (action) => messengerActions(action, port, { serviceName: 'Telegram' }),
  });
}

const texts = messengerUiTexts('Telegram');
