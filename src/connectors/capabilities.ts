/**
 * Shared capability interfaces.
 *
 * A capability is an operation that many services offer in the same shape: "search messages",
 * "send mail", "list calendar events". A connector action declares which capability it implements
 * (`capability: 'mail.search'`); the hub then builds one unified tool per capability
 * (`mail_search`) that works over every service and account implementing it, with one input schema
 * and one result schema. The AI calls `messages_search` once instead of searching Gmail, Telegram
 * and Slack separately.
 *
 * Rules for implementers:
 * - The action receives the capability's canonical input (or `mapInput(canonical)` if declared).
 * - It returns canonical output: for `list` capabilities an array of items or `{ items, nextCursor }`;
 *   for `single` capabilities one object. `mapOutput` can convert the action's native result.
 * - Item fields not in the schema are dropped from unified results, so keep native results rich
 *   and let the unified view stay compact.
 *
 * Like `sdk.ts`, this module must not import app code.
 */
import { z } from 'zod';

const isoDateTime = (what: string) => z.string().describe(`${what} (ISO 8601 date or date-time)`);
const limit = (max: number, fallback: number) => z.number().int().min(1).max(max).default(fallback);
const id = z.string().describe('Item id on its service; pass it back to other tools of the same account');
const url = z.string().optional().describe('Link that opens the item in the service');

export const Attachment = z.object({
  id: z.string(),
  name: z.string(),
  mime_type: z.string().optional(),
  size: z.number().optional(),
  url: z.string().optional(),
});

/** One message in a messenger chat or a mailbox, as returned by `messages.search`. */
export const MessageItem = z.object({
  id,
  chat_id: z
    .string()
    .optional()
    .describe('Chat id; pass it as "chat" to messages_read_chat or messages_send'),
  chat: z.string().optional().describe('Chat, channel or mailbox folder title'),
  from: z.string().optional().describe('Sender name or address'),
  from_id: z.string().optional(),
  direction: z.enum(['in', 'out']).optional(),
  date: z.string().optional(),
  text: z.string().optional().describe('Message text or snippet'),
  reply_to: z.string().optional(),
  attachments: z.array(Attachment).optional(),
  url,
});

export const ChatItem = z.object({
  id,
  title: z.string(),
  kind: z.enum(['direct', 'group', 'channel']).optional(),
  unread: z.number().optional(),
  last_message_at: z.string().optional(),
  url,
});

export const ChatHistory = z.object({
  chat: ChatItem.optional(),
  messages: z.array(MessageItem),
  nextCursor: z.string().optional().describe('Pass back as "before" to read older messages'),
});

export const MailSummary = z.object({
  id,
  thread_id: z.string().optional(),
  from: z.string().optional(),
  to: z.array(z.string()).optional(),
  subject: z.string().optional(),
  date: z.string().optional(),
  snippet: z.string().optional(),
  unread: z.boolean().optional(),
  has_attachments: z.boolean().optional(),
  /** Sent to many by a machine: newsletter, notification, mailing list (when the service tells). */
  bulk: z.boolean().optional(),
  url,
});

export const MailMessage = MailSummary.extend({
  cc: z.array(z.string()).optional(),
  body: z.string().optional().describe('Plain-text body (HTML converted to text)'),
  attachments: z.array(Attachment).optional(),
});

export const EventItem = z.object({
  id,
  title: z.string(),
  start: z.string(),
  end: z.string().optional(),
  all_day: z.boolean().optional(),
  location: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  calendar: z.string().optional(),
  url,
});

export const FileItem = z.object({
  id,
  name: z.string(),
  path: z.string().optional(),
  mime_type: z.string().optional(),
  size: z.number().optional(),
  modified: z.string().optional(),
  url,
});

export const FileContent = FileItem.extend({
  text: z.string().optional().describe('Text content (documents converted to text, possibly truncated)'),
  truncated: z.boolean().optional(),
});

export const TaskItem = z.object({
  id,
  title: z.string(),
  status: z.enum(['open', 'done']).optional(),
  due: z.string().optional(),
  priority: z.number().optional(),
  project: z.string().optional(),
  url,
});

export const ContactItem = z.object({
  id,
  name: z.string(),
  emails: z.array(z.string()).optional(),
  phones: z.array(z.string()).optional(),
  handles: z.array(z.string()).optional().describe('Usernames on messengers, e.g. "@ivan"'),
  company: z.string().optional(),
  url,
});

export const CreatedItem = z.object({ id, url, date: z.string().optional() });

export interface CapabilityDefinition {
  /** `interface.operation`, e.g. `mail.search`. The unified tool is named `interface_operation`. */
  id: string;
  title: string;
  /** Written for the AI. */
  description: string;
  /** Extra words for tool search only, like `ActionDefinition.keywords`. */
  keywords?: string;
  /** `list` capabilities fan out over all accounts by default and merge items; `single` target one. */
  kind: 'list' | 'single';
  risk: 'read' | 'write';
  input: z.ZodObject<any>;
  /** Item schema (`list`) or result schema (`single`). */
  output: z.ZodObject<any>;
  /** Field used to sort merged items. */
  sortBy?: string;
  /** Default `desc` (newest first); `asc` for things that are upcoming (events, due tasks). */
  sortOrder?: 'asc' | 'desc';
}

function capability<const T extends CapabilityDefinition>(definition: T): T {
  return definition;
}

/**
 * The catalog of shared interfaces. Adding a capability is additive: new connectors can implement
 * it right away and the unified tool appears once at least one account implements it.
 */
export const CAPABILITIES = {
  'messages.search': capability({
    id: 'messages.search',
    keywords: 'who wrote find messages',
    title: 'Search messages everywhere',
    description:
      'Searches messages across all connected messengers and mailboxes (Telegram, WhatsApp, Slack, email…) in one call. Results are merged, newest first, each tagged with its service and account.',
    kind: 'list',
    risk: 'read',
    input: z.object({
      query: z.string().min(1).describe('Words to search for'),
      from: z
        .string()
        .optional()
        .describe('Only messages from this person (name, @username, phone or email)'),
      since: isoDateTime('Only messages after this moment').optional(),
      until: isoDateTime('Only messages before this moment').optional(),
      limit: limit(50, 20),
    }),
    output: MessageItem,
    sortBy: 'date',
  }),
  'messages.list_chats': capability({
    id: 'messages.list_chats',
    keywords: 'chats conversations dialogs unread',
    title: 'List chats everywhere',
    description:
      'Lists recent chats across all connected messengers, merged, most recent first, each tagged with its service and account. Use unread_only to see what needs an answer.',
    kind: 'list',
    risk: 'read',
    input: z.object({
      query: z.string().optional().describe('Only chats whose title or participant matches'),
      unread_only: z.boolean().optional(),
      limit: limit(100, 30),
    }),
    output: ChatItem,
    sortBy: 'last_message_at',
  }),
  'messages.read_chat': capability({
    id: 'messages.read_chat',
    title: 'Read a chat',
    description: 'Returns the latest messages of one chat (newest last). Page back with "before".',
    kind: 'single',
    risk: 'read',
    input: z.object({
      chat: z.string().min(1).describe('Chat id from messages_list_chats or messages_search'),
      before: z.string().optional().describe('Cursor or message id: read messages older than this'),
      limit: limit(100, 30),
    }),
    output: ChatHistory,
  }),
  'messages.send': capability({
    id: 'messages.send',
    keywords: 'write text dm reply',
    title: 'Send a message',
    description:
      'Sends a chat message from one messenger account (Telegram, WhatsApp, Slack…). Reply from the account the conversation happened on.',
    kind: 'single',
    risk: 'write',
    input: z.object({
      chat: z
        .string()
        .min(1)
        .describe('Chat id, or for a new conversation the @username / phone / channel the service expects'),
      text: z.string().min(1).describe('Message text'),
      reply_to: z.string().optional().describe('Id of the message to reply to'),
    }),
    output: CreatedItem.extend({ status: z.enum(['sent', 'queued']).optional() }),
  }),
  'mail.search': capability({
    id: 'mail.search',
    keywords: 'find emails inbox unread new letters check mail who wrote',
    title: 'Search mail in all mailboxes',
    description:
      'Searches email in every connected mailbox at once. Results are merged, newest first, each tagged with its service and account; open one with mail_read.',
    kind: 'list',
    risk: 'read',
    input: z.object({
      query: z.string().optional().describe('Words in the subject or body'),
      from: z.string().optional().describe('Sender address or name'),
      to: z.string().optional().describe('Recipient address'),
      since: isoDateTime('Received after').optional(),
      until: isoDateTime('Received before').optional(),
      unread_only: z.boolean().optional(),
      folder: z
        .string()
        .optional()
        .describe(
          'Folder or label (inbox, sent, junk, trash or a name); default: all mail except spam and trash',
        ),
      limit: limit(50, 20),
    }),
    output: MailSummary,
    sortBy: 'date',
  }),
  'mail.read': capability({
    id: 'mail.read',
    title: 'Read an email',
    description: 'Returns one email with its plain-text body and attachment list.',
    kind: 'single',
    risk: 'read',
    input: z.object({ id: z.string().min(1).describe('Email id from mail_search') }),
    output: MailMessage,
  }),
  'mail.send': capability({
    id: 'mail.send',
    keywords: 'write compose email reply',
    title: 'Send an email',
    description: 'Sends an email from one mailbox. To reply, pass reply_to_id so threading is kept.',
    kind: 'single',
    risk: 'write',
    input: z.object({
      to: z.array(z.string()).min(1).describe('Recipient addresses'),
      cc: z.array(z.string()).optional(),
      bcc: z.array(z.string()).optional(),
      subject: z.string().describe('Subject line'),
      body: z.string().describe('Plain-text body'),
      reply_to_id: z.string().optional().describe('Id of the email being replied to'),
    }),
    output: CreatedItem,
  }),
  'calendar.list_events': capability({
    id: 'calendar.list_events',
    keywords: 'agenda meetings appointments schedule upcoming today tomorrow week',
    title: 'List calendar events',
    description: 'Lists events in a time range across all connected calendars, merged and sorted by start.',
    kind: 'list',
    risk: 'read',
    input: z.object({
      from: isoDateTime('Range start'),
      to: isoDateTime('Range end'),
      query: z.string().optional().describe('Only events matching these words'),
      limit: limit(100, 50),
    }),
    output: EventItem,
    sortBy: 'start',
    sortOrder: 'asc',
  }),
  'calendar.create_event': capability({
    id: 'calendar.create_event',
    keywords: 'schedule book meeting appointment invite',
    title: 'Create a calendar event',
    description: 'Creates an event in one calendar account.',
    kind: 'single',
    risk: 'write',
    input: z.object({
      title: z.string().min(1),
      start: isoDateTime('Start'),
      end: isoDateTime('End'),
      description: z.string().optional(),
      location: z.string().optional(),
      attendees: z.array(z.string()).optional().describe('Attendee email addresses'),
    }),
    output: CreatedItem,
  }),
  'files.search': capability({
    id: 'files.search',
    keywords: 'find document file drive folder',
    title: 'Search files everywhere',
    description: 'Searches files and documents across all connected drives and note apps in one call.',
    kind: 'list',
    risk: 'read',
    input: z.object({
      query: z.string().min(1).describe('Words in the name or content'),
      limit: limit(50, 20),
    }),
    output: FileItem,
    sortBy: 'modified',
  }),
  'files.read': capability({
    id: 'files.read',
    title: 'Read a file',
    description: 'Returns the text content of one file or document (converted to plain text).',
    kind: 'single',
    risk: 'read',
    input: z.object({
      id: z.string().min(1).describe('File id from files_search'),
      max_chars: z.number().int().min(100).max(100_000).default(20_000).describe('Cut the text after this'),
    }),
    output: FileContent,
  }),
  'tasks.list': capability({
    id: 'tasks.list',
    keywords: 'todos to-do open tasks due',
    title: 'List tasks everywhere',
    description: 'Lists tasks across all connected task managers, merged and sorted by due date.',
    kind: 'list',
    risk: 'read',
    input: z.object({
      query: z.string().optional().describe('Only tasks matching these words'),
      status: z.enum(['open', 'done', 'all']).default('open'),
      due_before: isoDateTime('Only tasks due before').optional(),
      limit: limit(100, 30),
    }),
    output: TaskItem,
    sortBy: 'due',
    sortOrder: 'asc',
  }),
  'tasks.create': capability({
    id: 'tasks.create',
    keywords: 'add todo new task reminder',
    title: 'Create a task',
    description: 'Creates a task in one task manager account.',
    kind: 'single',
    risk: 'write',
    input: z.object({
      title: z.string().min(1),
      description: z.string().optional(),
      due: isoDateTime('Due date').optional(),
      project: z.string().optional().describe('Project or list name'),
      priority: z.number().int().min(1).max(4).optional().describe('1 (normal) to 4 (urgent)'),
    }),
    output: CreatedItem,
  }),
  'contacts.search': capability({
    id: 'contacts.search',
    keywords: 'find person phone number address',
    title: 'Search contacts everywhere',
    description: 'Finds people across address books, CRMs and messengers by name, email, phone or username.',
    kind: 'list',
    risk: 'read',
    input: z.object({
      query: z.string().min(1).describe('Name, email, phone or username'),
      limit: limit(50, 20),
    }),
    output: ContactItem,
  }),
} as const satisfies Record<string, CapabilityDefinition>;

export type CapabilityId = keyof typeof CAPABILITIES;

/** Interface names (the part before the dot); reserved as connector ids so tool names never clash. */
export const CAPABILITY_INTERFACES: ReadonlySet<string> = new Set(
  Object.keys(CAPABILITIES).map((key) => key.split('.')[0]!),
);

export type CapabilityInput<C extends CapabilityId> = z.output<(typeof CAPABILITIES)[C]['input']>;
export type CapabilityOutput<C extends CapabilityId> = z.output<(typeof CAPABILITIES)[C]['output']>;

export function getCapability(capabilityId: string): CapabilityDefinition | undefined {
  return (CAPABILITIES as Record<string, CapabilityDefinition>)[capabilityId];
}
