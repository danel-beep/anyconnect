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
    ...(message.delivery ? { delivery: message.delivery } : {}),
    ...(message.deliveryError ? { delivery_error: message.deliveryError } : {}),
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

/** wait_for_reply: what fits in most AI apps' tool-call limit (~60 s), and the hub's own cap. */
const DEFAULT_WAIT_SECONDS = 45;
const MAX_WAIT_SECONDS = 100;
/** Messages one wait returns at most (has_more says when there are more). */
const WAIT_LIMIT = 50;

/** How long a conversation may run: with checks scheduled in the AI app (`follow_up`), days are realistic. */
const MAX_CONVERSATION_HOURS = 72;

/**
 * How to keep a conversation going after the AI's reply ends: most AI apps can schedule a task for
 * themselves (Claude and ChatGPT scheduled tasks, hourly; Claude Code /loop or cron, by the minute).
 * The hub cannot know which one the caller has, so it hands over a ready prompt for any of them. A
 * scheduled run comes through the same AI app, so the conversation's approval still covers it.
 */
function followUp(c: {
  serviceName: string;
  account: string;
  chatId: string;
  chatTitle: string;
  goal: string;
  until: string;
}) {
  return {
    when: `If the person may answer after this reply of yours ends and your app can schedule tasks for you (scheduled tasks, reminders, /loop, cron), offer the user to schedule a check with this prompt: every hour or as often as the app allows, until ${c.until}. Set it up only if they agree.`,
    prompt: `Continue the ${c.serviceName} conversation in the chat "${c.chatTitle}" (Manyplug, account "${c.account}", chat id ${c.chatId}) for me. Goal: ${c.goal}. Call the ${c.serviceName} wait_for_reply tool with this chat and timeout_seconds 30. If a reply came, answer it with send, keeping to the goal, and wait again; if nothing came, stop until the next check. Stop for good and tell me what happened when the goal is reached, the person ends the conversation or asks for something only I can decide, a send needs my approval, or after ${c.until}; then call end_conversation for this chat and remove this scheduled check.`,
  };
}

const formatHours = (hours: number) =>
  hours < 1 ? `${Math.round(hours * 60)} min` : `${Number(hours.toFixed(1))} h`;

/**
 * The line every messenger connector adds to its instructions, so any AI app knows it can keep a
 * conversation going when (and only when) the user asks for it.
 */
export function conversationInstructions(prefix: string): string {
  return `If the user asks you to talk with someone for them: ${prefix}_start_conversation, then loop ${prefix}_wait_for_reply.`;
}

/** Largest file returned inline to the AI. */
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

/*
 * Every tool here is `openWorld`: even the ones that answer from the hub's copy return what other
 * people wrote, so the hub marks their results as third-party content (prompt injection defense).
 */
/** How many of the newest chats list_chats offers when its query matches none. */
const RECENT_ON_NO_MATCH = 10;

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
      description: `Lists ${serviceName} chats of the account, most recent first, with unread counters. Use it to find a chat id for read_chat or send. New chats appear as soon as someone writes, so call it again instead of relying on an earlier answer. Answers from the hub's synced copy, without touching ${serviceName}.`,
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
        if (input.query && !input.cursor && page.items.length === 0) {
          // Titles are the names saved in the user's contacts, often a nickname or another script
          // ("Даня" for Danel): hand the AI the newest chats instead of a dead end.
          const recent = await port
            .forAccount(ctx.account.id)
            .listChats({ unreadOnly: input.unread_only, limit: RECENT_ON_NO_MATCH });
          return {
            chats: [],
            note: `No chat title or @username matches "${input.query}". Titles are the names saved in this account's contacts, so a person may be listed under a nickname or in another alphabet. The newest chats are below: pick the likely one or ask the user.`,
            recent_chats: recent.items.map(chatItem),
          };
        }
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
      name: 'wait_for_reply',
      title: 'Wait for a reply',
      description: `Waits for new messages and returns as soon as one arrives (from your last message in the chat on, without a cursor). Only when the user asked you to wait for a reply or carry on a conversation. On no_reply_yet, call again with the cursor while the user's time frame allows. Keep the default timeout unless your app allows tool calls over 60 s.`,
      input: z.object({
        chat: z.string().max(64).optional().describe('Chat id; omit for any chat'),
        cursor: z.string().max(200).optional().describe('cursor from the previous call'),
        timeout_seconds: z
          .number()
          .int()
          .min(5)
          .max(MAX_WAIT_SECONDS)
          .default(DEFAULT_WAIT_SECONDS)
          .describe('Seconds to wait'),
      }),
      hints: { readOnly: true, openWorld: true },
      // Waiting that saw nothing is not usage: following a conversation must not use up the plan.
      countsAsUsage: (output) => (output as { status?: string } | undefined)?.status === 'new_messages',
      run: async (input, ctx) => {
        const result = await port.forAccount(ctx.account.id).waitForMessages({
          ...(input.chat ? { chatId: input.chat } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
          timeoutMs: input.timeout_seconds * 1000,
          includeOwn: false,
          limit: WAIT_LIMIT,
          signal: ctx.signal,
        });
        if (result.messages.length > 0) {
          return {
            status: 'new_messages',
            messages: result.messages.map(messageItem),
            cursor: result.cursor,
            has_more: result.hasMore,
          };
        }
        if (result.offline) {
          return {
            status: 'account_offline',
            state: result.offline.state,
            ...(result.offline.problem ? { problem: result.offline.problem } : {}),
            cursor: result.cursor,
            next: `No messages arrive while this ${serviceName} account is offline. Stop waiting and tell the user to connect it again.`,
          };
        }
        return {
          status: 'no_reply_yet',
          waited_seconds: Math.round(result.waitedMs / 1000),
          cursor: result.cursor,
          next: 'Call wait_for_reply again with this cursor, unless the time the user gave is over. If the answer may take longer than this reply lasts, use follow_up from start_conversation.',
        };
      },
    }),
    action({
      name: 'start_conversation',
      title: 'Carry on a conversation',
      description: `Only when the user asks you to talk with someone for them: wait for replies and answer them. The user approves once; then for \`hours\` your sends in this chat need no approval, up to max_messages. Loop: wait_for_reply, send, repeat. Keep to the goal. Stop and report to the user when it is reached, the person ends the talk or wants what only the user can decide, something looks wrong, or time runs out; then call end_conversation.`,
      input: z.object({
        chat: z.string().max(64).describe('Chat id'),
        goal: z.string().trim().min(3).max(500).describe("The user's goal, in their words"),
        hours: z.number().min(0.25).max(MAX_CONVERSATION_HOURS).default(3),
        max_messages: z.number().int().min(1).max(100).default(20),
      }),
      hints: { readOnly: false, destructive: false, openWorld: true },
      // Lets the AI write for the user: they approve it once, as they would approve a send.
      risk: 'dangerous',
      assessRisk: (input) => ({
        risk: 'dangerous',
        reason: `Lets this AI app answer in this chat without asking, for ${formatHours(input.hours)} and up to ${input.max_messages} messages. Goal: ${input.goal}`,
      }),
      grants: (input) => ({
        actions: ['send'],
        scope: input.chat,
        minutes: Math.round(input.hours * 60),
        maxUses: input.max_messages,
        purpose: input.goal,
      }),
      run: async (input, ctx) => {
        const { chat } = await port.forAccount(ctx.account.id).readChat({ chatId: input.chat, limit: 1 });
        const until = new Date(Date.now() + input.hours * 3_600_000).toISOString();
        return {
          status: 'started',
          chat: chat.title,
          goal: input.goal,
          until,
          max_messages: input.max_messages,
          next: 'Answer with send if needed, then call wait_for_reply.',
          follow_up: followUp({
            serviceName,
            account: ctx.account.name,
            chatId: input.chat,
            chatTitle: chat.title,
            goal: input.goal,
            until,
          }),
        };
      },
    }),
    action({
      name: 'end_conversation',
      title: 'End the conversation',
      description: 'Ends start_conversation: sends in the chat need approval again.',
      input: z.object({ chat: z.string().max(64) }),
      hints: { readOnly: false, idempotent: true, openWorld: false },
      // Only takes permissions away, so it never needs a confirmation.
      risk: 'read',
      revokes: (input) => ({ scope: input.chat }),
      run: async () => ({ status: 'ended' }),
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
      // A conversation the user asked the AI to carry on covers the replies in its chat.
      approvalScope: (input) => input.chat,
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
        wait_for_reply: {
          title: 'Ожидание ответа',
          description:
            'Ждёт новое сообщение в чате и сразу отдаёт его ИИ, чтобы тот мог продолжить переписку.',
        },
        start_conversation: {
          title: 'Ведение переписки',
          description:
            'Только когда вы сами просите ИИ вести переписку: вы один раз разрешаете, и ИИ отвечает в этом чате без вопросов, пока не выйдут срок и лимит сообщений.',
        },
        end_conversation: {
          title: 'Завершить переписку',
          description: 'Заканчивает переписку: дальше каждое сообщение снова с вашего согласия.',
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
        wait_for_reply: {
          title: 'Wait for a reply',
          description:
            'Waits for a new message in a chat and hands it to the AI at once, so it can keep the conversation going.',
        },
        start_conversation: {
          title: 'Carry on a conversation',
          description:
            'Only when you ask the AI to talk with someone for you: you approve once, and it answers in that chat without asking until the time or message limit runs out.',
        },
        end_conversation: {
          title: 'End the conversation',
          description: 'Ends the conversation: from then on each message needs your OK again.',
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
