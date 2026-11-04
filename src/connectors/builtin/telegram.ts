import { z } from 'zod';
import {
  type AttachmentKind,
  DeliveryError,
  type DirectTransport,
  type InboundAttachment,
  type InboundMessage,
  type MessagingPort,
  type OutboundFile,
} from '../messaging.js';
import { messengerActions, messengerUiTexts, pacingConfig } from '../messaging-actions.js';
import {
  deliveryFetch,
  downloadForUpload,
  fileNameFromUrl,
  readJson,
  secretsEqual,
} from '../messaging-http.js';
import { type AccountContext, ConnectorError, defineConnector } from '../sdk.js';

const config = z.object({
  mode: z
    .enum(['bot'])
    .default('bot')
    .describe('How the account is connected: bot = your own bot through the official Bot API'),
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
    .describe('Bot token from @BotFather (bot mode)'),
});

type Config = z.output<typeof config>;
type Credentials = z.output<typeof credentials>;
type Ctx = AccountContext<Config, Credentials>;

// ---------------------------------------------------------------------------
// Bot API
// ---------------------------------------------------------------------------

function botToken(ctx: Ctx): string {
  if (!ctx.credentials.botToken)
    throw new ConnectorError('auth', 'The bot token is not set for this account.');
  return ctx.credentials.botToken;
}

function botUrl(ctx: Ctx, method: string): string {
  return `${ctx.config.botApiUrl.replace(/\/+$/, '')}/bot${botToken(ctx)}/${method}`;
}

interface BotApiResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

/** Calls a Bot API method; failures become {@link DeliveryError}s the dispatcher understands. */
async function callBot<T>(ctx: Ctx, method: string, params: Record<string, unknown> | FormData): Promise<T> {
  const response = await deliveryFetch(ctx.fetch, botUrl(ctx, method), {
    method: 'POST',
    ...(params instanceof FormData
      ? { body: params }
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }),
    signal: ctx.signal,
  });
  const body = (await readJson(response)) as BotApiResult<T>;
  if (response.ok && body.ok) return body.result as T;
  const description = body.description ?? `HTTP ${response.status}`;
  const code = body.error_code ?? response.status;
  if (code === 429) {
    throw new DeliveryError('rate_limited', description, {
      retryAfterSeconds: body.parameters?.retry_after ?? 30,
    });
  }
  if (code === 401 || code === 404)
    throw new DeliveryError('auth', `Telegram rejected the bot token: ${description}`);
  if (code >= 500) throw new DeliveryError('transient', description);
  // 400 (chat not found, message too long...), 403 (blocked by the user, kicked from the group).
  throw new DeliveryError('rejected', description);
}

/** The same call for actions (not the outbox): errors become ConnectorErrors for the AI. */
async function callBotForAction<T>(ctx: Ctx, method: string, params: Record<string, unknown>): Promise<T> {
  try {
    return await callBot<T>(ctx, method, params);
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
 * Chats of a Telegram Business account (a Premium user who connected the bot in Settings →
 * Telegram Business → Chatbots) are addressed through the connection, so their external id carries
 * it: `<chat id>@<connection id>`. Reconnecting the bot gives a new connection id, and with it new
 * chats in the hub's copy; the old ones stay readable.
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

/** Turns a webhook update into the messages it carries (none for updates the hub ignores). */
export function botUpdateToMessages(update: TgUpdate, botId: string): InboundMessage[] {
  const deleted = update.deleted_business_messages;
  if (deleted) {
    return deleted.message_ids.map((id) => ({
      chat: chatOf(deleted.chat, deleted.business_connection_id),
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
      chat: chatOf(chat, business),
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
async function sendFile(ctx: Ctx, file: OutboundFile, params: Record<string, unknown>): Promise<TgMessage> {
  const route = telegramFileRoute(file);
  if (route.byLink) return callBot<TgMessage>(ctx, route.method, { ...params, [route.field]: file.url });
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
  return callBot<TgMessage>(ctx, route.method, form);
}

const botTransport: DirectTransport<Config, Credentials> = {
  kind: 'direct',
  // The Bot API has no idempotency key: an interrupted send is reported as uncertain, never repeated.
  idempotentSend: false,
  files: true,

  async send(job, ctx) {
    const { chatId, businessConnectionId } = parseChatId(job.chat.externalId);
    if (job.kind === 'mark_read') {
      // Only business chats have read receipts for bots, and only with the "read messages" right.
      if (!businessConnectionId || !job.upToExternalId) return undefined;
      await callBot(ctx, 'readBusinessMessage', {
        business_connection_id: businessConnectionId,
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
      ? await sendFile(ctx, job.file, { ...params, ...(job.text ? { caption: job.text } : {}) })
      : await callBot<TgMessage>(ctx, 'sendMessage', { ...params, text: job.text });
    return {
      externalId: String(result.message_id),
      sentAt: new Date(result.date * 1000),
      // Telegram returns the stored file: the hub's copy can then download it like a received one.
      ...(job.file ? { attachments: attachments(result) } : {}),
    };
  },

  async download(attachment, ctx) {
    const fileId = (attachment.locator as { fileId?: string } | undefined)?.fileId;
    if (!fileId) throw new ConnectorError('not_found', 'This file can no longer be downloaded.');
    const file = await callBotForAction<{ file_path?: string; file_size?: number }>(ctx, 'getFile', {
      file_id: fileId,
    });
    if (!file.file_path) {
      throw new ConnectorError(
        'invalid_input',
        'Telegram does not let bots download files larger than 20 MB.',
      );
    }
    const url = `${ctx.config.botApiUrl.replace(/\/+$/, '')}/file/bot${botToken(ctx)}/${file.file_path}`;
    const response = await ctx.fetch(url, { signal: ctx.signal });
    if (!response.ok)
      throw new ConnectorError('upstream', `Telegram file download failed (${response.status})`);
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
      name: file.file_path.split('/').at(-1) ?? 'file',
    };
  },

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

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export function createTelegramConnector(port: MessagingPort) {
  return defineConnector({
    id: 'telegram',
    name: 'Telegram',
    description:
      'Telegram messages: read and search chats, see what is new, reply and write. Any number of accounts and bots.',
    version: '1.0.0',
    homepage: 'https://telegram.org',
    instructions:
      "Telegram tools read from the hub's synced copy of the chats, so reading and searching are fast and free. " +
      'Find chats with telegram_list_chats, then read or send by chat id. Use telegram_whats_new with the returned cursor to follow new messages. ' +
      'Before writing to someone who has not written to this account first, ask the user. Bots only see chats where people wrote to the bot. ' +
      "With Telegram Business the user's own chats appear too; replies there are sent as the user.",
    config,
    credentials,
    messenger: {
      transport: () => botTransport,
      // Bots are official API clients: Telegram limits them (about 1 message/s per chat, 20/min per
      // group), but there is no reason to imitate a person.
      pacing: () => ({
        perMinute: 20,
        perHour: 1_000,
        perDay: 20_000,
        minGapMs: 100,
        maxGapMs: 400,
        typing: false,
      }),
    },
    async test(ctx) {
      const me = await callBotForAction<TgUser>(ctx, 'getMe', {});
      const hook = port.forAccount(ctx.account.id).webhook();
      await callBotForAction<boolean>(ctx, 'setWebhook', {
        url: hook.url,
        secret_token: hook.secret,
        allowed_updates: BOT_UPDATES,
      });
      return { ok: true, identity: me.username ? `@${me.username}` : String(me.id) };
    },
    ui: {
      primaryFields: ['botToken'],
      locales: {
        ru: {
          description:
            'Ваш бот Telegram: чаты, поиск по переписке, ответы. Официальный Bot API, без риска для личного аккаунта.',
          setup: {
            form: {
              summary: 'Токен бота от @BotFather. Около двух минут.',
              steps: [
                {
                  text: 'Откройте @BotFather в Telegram и отправьте /newbot (или /mybots, если бот уже есть).',
                  link: { label: 'Открыть @BotFather', url: 'https://t.me/BotFather' },
                },
                { text: 'Придумайте имя и адрес бота. BotFather пришлёт токен вида 123456:ABC-…' },
                { text: 'Вставьте токен в форму. Хаб сам проверит его и подключит приём сообщений.' },
              ],
              tips: [
                'Бот видит только чаты, где ему написали, и не может первым написать человеку.',
                'Чтобы бот читал сообщения в группе, выключите у него Group Privacy в @BotFather.',
                'С Telegram Premium бот может вести и ваши личные чаты: Настройки → Telegram для бизнеса → Чат-боты, укажите бота и дайте право отвечать. Ответы уйдут от вашего имени.',
              ],
            },
          },
          prompts: [
            'Что нового написали боту за сегодня?',
            'Найди сообщения про доставку за эту неделю.',
            'Ответь Анне, что счёт будет вечером.',
          ],
          fields: {
            mode: { label: 'Как подключить', options: { bot: 'Бот (Bot API)' } },
            botApiUrl: { label: 'Сервер Bot API', hint: 'Свой сервер нужен только для файлов больше 20 МБ.' },
            botToken: { label: 'Токен бота', placeholder: '123456789:AA…' },
            pacing: texts.ru.pacing,
          },
          actions: texts.ru.actions,
        },
        en: {
          description: 'Your Telegram bot: chats, message search, replies. The official Bot API.',
          setup: {
            form: {
              summary: 'A bot token from @BotFather. Takes about two minutes.',
              steps: [
                {
                  text: 'Open @BotFather in Telegram and send /newbot (or /mybots if you already have a bot).',
                  link: { label: 'Open @BotFather', url: 'https://t.me/BotFather' },
                },
                { text: 'Pick a name and a username. BotFather replies with a token like 123456:ABC-…' },
                { text: 'Paste the token into the form. The hub checks it and starts receiving messages.' },
              ],
              tips: [
                'A bot only sees chats where people wrote to it and cannot start a conversation.',
                'To let the bot read group messages, turn off Group Privacy for it in @BotFather.',
                'With Telegram Premium the bot can also handle your personal chats: Settings → Telegram Business → Chatbots, pick the bot and allow it to reply. Replies are sent as you.',
              ],
            },
          },
          prompts: [
            'What did people write to the bot today?',
            'Find messages about delivery from this week.',
            'Tell Anna the invoice comes tonight.',
          ],
          fields: {
            mode: { label: 'How to connect', options: { bot: 'Bot (Bot API)' } },
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
