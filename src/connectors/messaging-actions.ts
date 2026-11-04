/**
 * The standard tools every messenger connector gets. Inputs and outputs follow the hub's shared
 * `messages.*` capability shapes (snake_case, ISO dates), so unified cross-service tools can use
 * them without mapping. Part of the connector SDK: no application imports.
 */
import { z } from 'zod';
import type { ChatView, MessageView, MessagingPort } from './messaging.js';
import { type ActionDefinition, type ActionFactory, ConnectorError, rawResult } from './sdk.js';

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

/** Account config field shared by all messenger connectors. */
export const pacingConfig = z
  .object({
    perMinute: z.number().int().min(1).max(60).optional().describe('Сообщений в минуту'),
    perHour: z.number().int().min(1).max(3_000).optional().describe('Сообщений в час'),
    perDay: z.number().int().min(1).max(20_000).optional().describe('Сообщений в сутки'),
    newContactsPerDay: z
      .number()
      .int()
      .min(0)
      .max(500)
      .optional()
      .describe('Первых сообщений новым собеседникам в сутки'),
    minGapMs: z
      .number()
      .int()
      .min(0)
      .max(600_000)
      .optional()
      .describe('Минимальная пауза между сообщениями, мс'),
    maxGapMs: z
      .number()
      .int()
      .min(0)
      .max(600_000)
      .optional()
      .describe('Максимальная пауза между сообщениями, мс'),
    typing: z.boolean().optional().describe('Показывать «печатает…» перед отправкой'),
  })
  .describe('Темп отправки (защита от бана)');

/** Largest file returned inline to the AI. */
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

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
      hints: { readOnly: true, idempotent: true, openWorld: false },
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
      description: `Full-text search over ${serviceName} messages of the account (all chats or one), newest first. Matches word beginnings, so "встреч" finds "встреча" and "встречу". Filter by sender and dates.`,
      input: z.object({
        query: z.string().max(300).optional().describe('Words to find; all of them must occur'),
        chat: z.string().max(64).optional().describe('Chat id from list_chats to search in'),
        from: z.string().max(100).optional().describe('Sender name or id'),
        since: isoDate.optional().describe('Only messages at or after this date'),
        until: isoDate.optional().describe('Only messages before this date'),
        limit: limit(100, 20),
        cursor: z.string().max(200).optional().describe('next_cursor from the previous call'),
      }),
      hints: { readOnly: true, idempotent: true, openWorld: false },
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
      hints: { readOnly: true, idempotent: true, openWorld: false },
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
      hints: { readOnly: true, openWorld: false },
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
      description: `Sends a text message from this ${serviceName} account. Messages go through a queue with human-like pacing (typing, pauses, daily limits) to protect the account; the result is "sent" or "queued" with an eta. A repeated identical request within 10 minutes is not sent twice. Writing to someone who never wrote to this account first needs the user's explicit approval.`,
      input: z.object({
        chat: z.string().max(64).optional().describe('Chat id from list_chats (preferred)'),
        to: z
          .string()
          .max(64)
          .optional()
          .describe('For a new conversation: phone number in international format or @username'),
        text: z.string().trim().min(1).max(4096).describe('Message text'),
        reply_to: z.string().max(64).optional().describe('Message id to reply to (same chat)'),
      }),
      hints: { readOnly: false, destructive: false, openWorld: true },
      run: async (input, ctx) => {
        if (!input.chat && !input.to) throw new ConnectorError('invalid_input', 'Pass chat or to.');
        const result = await port.forAccount(ctx.account.id).send({
          ...(input.chat ? { chatId: input.chat } : { to: input.to! }),
          text: input.text,
          ...(input.reply_to ? { replyTo: input.reply_to } : {}),
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
