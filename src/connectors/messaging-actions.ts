/**
 * The standard tools every messenger connector gets. Inputs and outputs follow the hub's shared
 * `messages.*` capability shapes (snake_case, ISO dates), so unified cross-service tools can use
 * them without mapping. Part of the connector SDK: no application imports.
 */
import { z } from 'zod';
import type { ChatView, MessageView, MessagingPort } from './messaging.js';
import { fileNameFromUrl } from './messaging-http.js';
import {
  type ActionDefinition,
  type ActionFactory,
  type ActionLocale,
  ConnectorError,
  type FieldLocale,
  rawResult,
} from './sdk.js';

const limit = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).default(fallback).describe(`How many items to return (max ${max})`);

const isoDate = z
  .string()
  .refine(
    (v) => !Number.isNaN(Date.parse(v)),
    'expected an ISO date, e.g. 2026-11-04 or 2026-11-04T10:00:00Z',
  );

export function chatItem(chat: ChatView) {
  return {
    id: chat.id,
    title: chat.title,
    kind: chat.kind,
    ...(chat.username ? { username: chat.username } : {}),
    unread: chat.unread,
    ...(chat.lastMessageAt ? { last_message_at: chat.lastMessageAt } : {}),
  };
}

export function messageItem(message: MessageView) {
  return {
    id: message.id,
    chat_id: message.chatId,
    chat: message.chatTitle,
    direction: message.direction,
    ...(message.sender?.name
      ? { from: message.sender.name }
      : message.direction === 'out'
        ? { from: 'me' }
        : {}),
    ...(message.sender?.id ? { from_id: message.sender.id } : {}),
    date: message.sentAt,
    ...(message.editedAt ? { edited_at: message.editedAt } : {}),
    text: message.text,
    ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    ...(message.attachments.length
      ? {
          attachments: message.attachments.map((a) => ({
            id: a.id,
            kind: a.kind,
            ...(a.name ? { name: a.name } : {}),
            ...(a.mimeType ? { mime_type: a.mimeType } : {}),
            ...(a.size !== undefined ? { size: a.size } : {}),
          })),
        }
      : {}),
    ...(message.deleted ? { deleted: true } : {}),
  };
}

/**
 * Canonical item shapes of the shared `messages.*` capabilities (see `capabilities.ts`): the
 * unified cross-service tools only keep fields their schema knows, so map what differs.
 */
type ChatOut = ReturnType<typeof chatItem>;
type MessageOut = ReturnType<typeof messageItem>;

const canonicalChat = (chat: ChatOut) => ({ ...chat, kind: chat.kind === 'bot' ? 'direct' : chat.kind });

const canonicalMessage = (message: MessageOut) =>
  message.attachments
    ? { ...message, attachments: message.attachments.map((a) => ({ ...a, name: a.name ?? a.kind })) }
    : message;

/** Hub chat ids look like `cht_…`; anything else passed as `chat` to messages_send is a recipient. */
const isChatId = (value: string) => /^cht_[0-9a-z]+$/i.test(value);

/** Account config field shared by all messenger connectors. */
export const pacingConfig = z
  .object({
    perMinute: z.number().int().min(1).max(60).optional().describe('Messages per minute'),
    perHour: z.number().int().min(1).max(3_000).optional().describe('Messages per hour'),
    perDay: z.number().int().min(1).max(20_000).optional().describe('Messages per day'),
    newContactsPerDay: z
      .number()
      .int()
      .min(0)
      .max(500)
      .optional()
      .describe('First messages to new people per day'),
    minGapMs: z.number().int().min(0).max(600_000).optional().describe('Shortest pause between messages, ms'),
    maxGapMs: z.number().int().min(0).max(600_000).optional().describe('Longest pause between messages, ms'),
    typing: z.boolean().optional().describe('Show "typing…" before sending'),
  })
  .describe('Sending pace (protects the account from bans)');

/** Largest file returned inline to the AI. */
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

/*
 * Every tool here is `openWorld`: even the ones that answer from the hub's copy return what other
 * people wrote, so the hub marks their results as third-party content (prompt injection defense).
 */
export function messengerActions<TConfig, TCredentials>(
  action: ActionFactory<TConfig, TCredentials>,
  port: MessagingPort,
  options: { serviceName: string },
): ActionDefinition<TConfig, TCredentials>[] {
  const { serviceName } = options;
  return [
    action({
      name: 'list_chats',
      title: 'List chats',
      description: `Lists ${serviceName} chats of the account, most recent first, with unread counters. Use it to find a chat id for read_chat or send. Answers from the hub's synced copy, without touching ${serviceName}.`,
      input: z.object({
        query: z.string().max(200).optional().describe('Filter by chat title or @username (word prefixes)'),
        unread_only: z.boolean().default(false).describe('Only chats with unread messages'),
        limit: limit(100, 30),
        cursor: z.string().max(200).optional().describe('next_cursor from the previous call'),
      }),
      hints: { readOnly: true, idempotent: true, openWorld: true },
      capability: {
        id: 'messages.list_chats',
        mapOutput: (result) => {
          const { chats, next_cursor } = result as { chats: ChatOut[]; next_cursor?: string };
          return { items: chats.map(canonicalChat), ...(next_cursor ? { nextCursor: next_cursor } : {}) };
        },
      },
      run: async (input, ctx) => {
        const page = await port.forAccount(ctx.account.id).listChats({
          ...(input.query ? { query: input.query } : {}),
          unreadOnly: input.unread_only,
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        });
        return {
          chats: page.items.map(chatItem),
          ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
        };
      },
    }),
    action({
      name: 'search',
      title: 'Search messages',
      description: `Full-text search over ${serviceName} messages of the account (all chats or one), newest first. Matches word beginnings, so "meet" finds "meeting" and "meets" (Russian word forms too). Filter by sender and dates.`,
      input: z.object({
        query: z.string().max(300).optional().describe('Words to find; all of them must occur'),
        chat: z.string().max(64).optional().describe('Chat id from list_chats to search in'),
        from: z.string().max(100).optional().describe('Sender name or id'),
        since: isoDate.optional().describe('Only messages at or after this date'),
        until: isoDate.optional().describe('Only messages before this date'),
        limit: limit(100, 20),
        cursor: z.string().max(200).optional().describe('next_cursor from the previous call'),
      }),
      hints: { readOnly: true, idempotent: true, openWorld: true },
      capability: {
        id: 'messages.search',
        mapOutput: (result) => {
          const { messages, next_cursor } = result as { messages: MessageOut[]; next_cursor?: string };
          return {
            items: messages.map(canonicalMessage),
            ...(next_cursor ? { nextCursor: next_cursor } : {}),
          };
        },
      },
      run: async (input, ctx) => {
        if (!input.query && !input.chat && !input.from && !input.since && !input.until) {
          throw new ConnectorError(
            'invalid_input',
            'Pass query, chat, from or a date range. For recent messages use whats_new.',
          );
        }
        const page = await port.forAccount(ctx.account.id).search({
          ...(input.query ? { query: input.query } : {}),
          ...(input.chat ? { chatId: input.chat } : {}),
          ...(input.from ? { from: input.from } : {}),
          ...(input.since ? { since: new Date(input.since) } : {}),
          ...(input.until ? { until: new Date(input.until) } : {}),
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        });
        return {
          messages: page.items.map(messageItem),
          ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
        };
      },
    }),
    action({
      name: 'read_chat',
      title: 'Read chat',
      description: `Returns the latest messages of a ${serviceName} chat in chronological order. Pass next_cursor as before to page back in time.`,
      input: z.object({
        chat: z.string().max(64).describe('Chat id from list_chats'),
        before: z
          .string()
          .max(200)
          .optional()
          .describe('next_cursor from the previous call (older messages)'),
        limit: limit(200, 30),
      }),
      hints: { readOnly: true, idempotent: true, openWorld: true },
      capability: {
        id: 'messages.read_chat',
        mapOutput: (result) => {
          const { chat, messages, next_cursor } = result as {
            chat: ChatOut;
            messages: MessageOut[];
            next_cursor?: string;
          };
          return {
            chat: canonicalChat(chat),
            messages: messages.map(canonicalMessage),
            ...(next_cursor ? { nextCursor: next_cursor } : {}),
          };
        },
      },
      run: async (input, ctx) => {
        const result = await port.forAccount(ctx.account.id).readChat({
          chatId: input.chat,
          ...(input.before ? { before: input.before } : {}),
          limit: input.limit,
        });
        return {
          chat: chatItem(result.chat),
          messages: result.messages.map(messageItem),
          ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
        };
      },
    }),
    action({
      name: 'whats_new',
      title: "What's new",
      description: `New ${serviceName} messages since the last check, oldest first. Keep the returned cursor and pass it next time to get only newer messages; without a cursor returns the last since_hours hours.`,
      input: z.object({
        cursor: z.string().max(200).optional().describe('cursor from the previous call'),
        since_hours: z
          .number()
          .min(1)
          .max(24 * 30)
          .default(24)
          .describe('Look-back window when no cursor is given'),
        include_own: z.boolean().default(false).describe('Also include messages sent by this account'),
        limit: limit(200, 50),
      }),
      hints: { readOnly: true, openWorld: true },
      run: async (input, ctx) => {
        const result = await port.forAccount(ctx.account.id).whatsNew({
          ...(input.cursor ? { cursor: input.cursor } : {}),
          sinceHours: input.since_hours,
          includeOwn: input.include_own,
          limit: input.limit,
        });
        return {
          messages: result.messages.map(messageItem),
          cursor: result.cursor,
          has_more: result.hasMore,
        };
      },
    }),
    action({
      name: 'send',
      title: 'Send message',
      description: `Sends a text, or a file by https link, from this ${serviceName} account via a paced queue that protects it. Result: "sent", or "queued" with an eta. An identical request within 10 minutes is not sent twice. A first message to someone who never wrote to this account needs the user's explicit approval.`,
      input: z.object({
        chat: z.string().max(64).optional().describe('Chat id from list_chats (preferred)'),
        to: z
          .string()
          .max(64)
          .optional()
          .describe('For a new conversation: phone number in international format or @username'),
        text: z
          .string()
          .trim()
          .max(4096)
          .default('')
          .describe('Message text (with a file: its caption, max 1024)'),
        reply_to: z.string().max(64).optional().describe('Message id to reply to (same chat)'),
        file_url: z
          .url({ protocol: /^https$/ })
          .max(2048)
          .optional()
          .describe('Public https link of a file to send'),
        file_kind: z
          .enum(['photo', 'video', 'audio', 'document'])
          .optional()
          .describe('Default: by extension'),
        file_name: z.string().trim().min(1).max(200).optional().describe('Shown file name'),
      }),
      hints: { readOnly: false, destructive: false, openWorld: true },
      // Sending is what the user approves by default (same as mail and Slack); see assessRisk below.
      risk: 'dangerous',
      capability: {
        id: 'messages.send',
        mapInput: ({ chat, ...rest }) =>
          typeof chat === 'string' && !isChatId(chat) ? { ...rest, to: chat } : { ...rest, chat },
        mapOutput: (result) => {
          const sent = result as { status: string; [key: string]: unknown };
          // The canonical status knows sent and queued; "uncertain" stays visible through the note.
          return sent.status === 'sent' || sent.status === 'queued' ? sent : { ...sent, status: undefined };
        },
      },
      // First contact is what gets accounts banned and what the user must approve.
      assessRisk: async (input, ctx) => {
        const known = input.chat
          ? await port
              .forAccount(ctx.account.id)
              .isKnownContact(input.chat)
              .catch(() => true)
          : false;
        return known
          ? undefined
          : {
              risk: 'dangerous',
              reason: `First message to someone who never wrote to this ${serviceName} account`,
            };
      },
      run: async (input, ctx) => {
        if (!input.chat && !input.to) throw new ConnectorError('invalid_input', 'Pass chat or to.');
        if (!input.text && !input.file_url)
          throw new ConnectorError('invalid_input', 'Pass text or file_url.');
        const result = await port.forAccount(ctx.account.id).send({
          ...(input.chat ? { chatId: input.chat } : { to: input.to! }),
          text: input.text,
          ...(input.reply_to ? { replyTo: input.reply_to } : {}),
          ...(input.file_url
            ? {
                file: {
                  url: input.file_url,
                  kind: input.file_kind ?? fileKindOf(input.file_url),
                  name: input.file_name ?? fileNameFromUrl(input.file_url),
                },
              }
            : {}),
        });
        if (result.status === 'failed')
          throw new ConnectorError('upstream', `Not sent: ${result.error ?? 'unknown error'}`);
        return {
          id: result.messageId ?? result.jobId,
          status: result.status,
          ...(result.sentAt ? { date: result.sentAt } : {}),
          ...(result.eta ? { eta: result.eta } : {}),
          ...(result.error ? { note: result.error } : {}),
          ...(result.status === 'uncertain'
            ? { note: 'Delivery could not be confirmed. Check the chat with read_chat before sending again.' }
            : {}),
          ...(result.deduplicated ? { deduplicated: true } : {}),
        };
      },
    }),
    action({
      name: 'mark_read',
      title: 'Mark chat as read',
      description: `Marks all messages of a ${serviceName} chat as read (the other side sees read receipts where the messenger shows them).`,
      input: z.object({ chat: z.string().max(64).describe('Chat id from list_chats') }),
      hints: { readOnly: false, idempotent: true, openWorld: true },
      risk: 'write',
      run: async (input, ctx) => port.forAccount(ctx.account.id).markRead(input.chat),
    }),
    action({
      name: 'get_attachment',
      title: 'Get attachment',
      description: `Downloads a file attached to a ${serviceName} message (photos and voice messages are returned so you can see or hear them).`,
      input: z.object({
        message: z.string().max(64).describe('Message id'),
        attachment: z.string().max(16).describe('Attachment id from the message, e.g. a0'),
      }),
      hints: { readOnly: true, idempotent: true, openWorld: true },
      run: async (input, ctx) => {
        const file = await port.forAccount(ctx.account.id).download(input.message, input.attachment);
        const name = file.name ?? input.attachment;
        if (file.data.byteLength > MAX_INLINE_BYTES) {
          return `The file "${name}" is ${(file.data.byteLength / 1_048_576).toFixed(1)} MB (${file.mimeType}), too large to return here.`;
        }
        const base64 = Buffer.from(file.data).toString('base64');
        if (file.mimeType.startsWith('image/')) {
          return rawResult({ content: [{ type: 'image', data: base64, mimeType: file.mimeType }] });
        }
        if (file.mimeType.startsWith('audio/')) {
          return rawResult({ content: [{ type: 'audio', data: base64, mimeType: file.mimeType }] });
        }
        if (file.mimeType.startsWith('text/') || file.mimeType === 'application/json') {
          return rawResult({ content: [{ type: 'text', text: Buffer.from(file.data).toString('utf8') }] });
        }
        return `File "${name}" (${file.mimeType}, ${file.data.byteLength} bytes) cannot be shown as text or image.`;
      },
    }),
  ];
}

/**
 * Website texts of the standard messenger tools and of the `pacing` field, for a connector's
 * `ui.locales` (people only: the AI keeps the English descriptions above).
 */
export function messengerUiTexts(
  serviceName: string,
): Record<'ru' | 'en', { actions: Record<string, ActionLocale>; pacing: FieldLocale }> {
  return {
    ru: {
      actions: {
        list_chats: {
          title: 'Список чатов',
          description: `Чаты ${serviceName}, сначала недавние, со счётчиком непрочитанного.`,
        },
        search: {
          title: 'Поиск сообщений',
          description: 'Поиск по всей переписке или одному чату, по словам, отправителю и датам.',
        },
        read_chat: { title: 'Чтение чата', description: 'Последние сообщения чата, можно листать назад.' },
        whats_new: {
          title: 'Что нового',
          description: 'Новые сообщения с прошлой проверки, без повторов.',
        },
        send: {
          title: 'Отправка сообщения',
          description:
            'Пишет в чат через очередь: пауза и «печатает…», как у человека, без дублей. Можно приложить файл по ссылке. Первое сообщение новому человеку — только с вашего согласия.',
        },
        mark_read: {
          title: 'Отметить прочитанным',
          description: 'Отмечает все сообщения чата прочитанными.',
        },
        get_attachment: {
          title: 'Вложение',
          description: 'Скачивает файл из сообщения: фото и голосовые ИИ может посмотреть и послушать.',
        },
      },
      pacing: {
        label: 'Темп отправки',
        hint: 'Лимиты и паузы между сообщениями. Значения по умолчанию подходят почти всем.',
      },
    },
    en: {
      actions: {
        list_chats: {
          title: 'List chats',
          description: `${serviceName} chats, most recent first, with unread counters.`,
        },
        search: {
          title: 'Search messages',
          description: 'Searches all chats or one chat by words, sender and dates.',
        },
        read_chat: {
          title: 'Read a chat',
          description: 'Latest messages of a chat; page back for older ones.',
        },
        whats_new: {
          title: "What's new",
          description: 'New messages since the last check, without repeats.',
        },
        send: {
          title: 'Send a message',
          description:
            'Writes to a chat through a queue: human-like pauses and typing, never twice. Files can be attached by link. A first message to someone new needs your OK.',
        },
        mark_read: { title: 'Mark as read', description: 'Marks every message of a chat as read.' },
        get_attachment: {
          title: 'Attachment',
          description:
            'Downloads a file from a message; the AI can look at photos and listen to voice messages.',
        },
      },
      pacing: {
        label: 'Sending pace',
        hint: 'Limits and pauses between messages. The defaults suit almost everyone.',
      },
    },
  };
}

/**
 * Guesses how to send a file from its link's extension. Only formats both Telegram and WhatsApp
 * show as photo, video or audio get those kinds; everything else goes as a document.
 */
export function fileKindOf(url: string): 'photo' | 'video' | 'audio' | 'document' {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  if (ext && ['jpg', 'jpeg', 'png'].includes(ext)) return 'photo';
  if (ext && ['mp4', '3gp'].includes(ext)) return 'video';
  if (ext && ['mp3', 'm4a', 'ogg', 'opus', 'aac', 'amr'].includes(ext)) return 'audio';
  return 'document';
}
