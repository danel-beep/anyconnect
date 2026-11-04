/**
 * Messenger extension of the connector SDK (Telegram, WhatsApp and any future chat service).
 *
 * A messenger connector describes *how to deliver* (a persistent session in the messenger
 * gateway, or direct HTTP calls such as the Telegram Bot API) and gets a standard set of tools
 * for free: list chats, search, read a chat, what's new, send, mark as read, download a file.
 * Reading never touches the messenger: the hub answers from its own encrypted message store,
 * which the gateway (or a webhook) keeps up to date. Sending always goes through a durable
 * outbox with idempotency and human-like pacing.
 *
 * Like `sdk.ts`, this module must not import application code: the hub injects a
 * {@link MessagingPort} when it registers the connector.
 */
import type { AccountContext } from './sdk.js';

// ---------------------------------------------------------------------------
// Data the AI sees
// ---------------------------------------------------------------------------

export type ChatKind = 'direct' | 'group' | 'channel' | 'bot';

export type AttachmentKind =
  | 'photo'
  | 'video'
  | 'audio'
  | 'voice'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'other';

export interface ChatView {
  /** Opaque hub id of the chat (stable, use it in other tools). */
  id: string;
  title: string;
  kind: ChatKind;
  username?: string;
  unread: number;
  lastMessageAt?: string;
}

export interface AttachmentView {
  id: string;
  kind: AttachmentKind;
  name?: string;
  mimeType?: string;
  size?: number;
}

export interface MessageView {
  /** Opaque hub id of the message. */
  id: string;
  chatId: string;
  chatTitle: string;
  direction: 'in' | 'out';
  sender?: { id?: string; name?: string };
  sentAt: string;
  editedAt?: string;
  text: string;
  replyTo?: string;
  attachments: AttachmentView[];
  deleted?: boolean;
}

export interface Page<T> {
  items: T[];
  /** Pass back to get the next page; absent when there is nothing more. */
  nextCursor?: string;
}

// ---------------------------------------------------------------------------
// Data the transports produce (webhooks, gateway drivers)
// ---------------------------------------------------------------------------

export interface InboundChat {
  /** The messenger's own chat id (Telegram peer id, WhatsApp JID...). Stored encrypted. */
  externalId: string;
  kind: ChatKind;
  title?: string;
  username?: string;
  /** Unread counter as reported by the messenger, when it reports one. */
  unread?: number;
}

export interface InboundAttachment {
  externalId: string;
  kind: AttachmentKind;
  name?: string;
  mimeType?: string;
  size?: number;
  /** Transport-specific data needed to download the file later (stored encrypted). */
  locator?: unknown;
}

export interface InboundMessage {
  chat: InboundChat;
  /** The messenger's own message id, unique within the chat. */
  externalId: string;
  direction: 'in' | 'out';
  sentAt: Date;
  editedAt?: Date;
  sender?: { externalId?: string; name?: string };
  text?: string;
  replyToExternalId?: string;
  attachments?: InboundAttachment[];
  deleted?: boolean;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** One unit of work taken from the outbox by a transport. */
export interface OutboundJob {
  /** Hub job id, stable across retries: transports derive their own idempotency ids from it. */
  id: string;
  attempt: number;
  kind: 'message' | 'mark_read';
  chat: { externalId: string; kind: ChatKind };
  text?: string;
  replyToExternalId?: string;
  /** For `mark_read`: read everything up to this message (absent = the whole chat). */
  upToExternalId?: string;
}

export interface SentReceipt {
  /** The messenger's id of the message that was sent. */
  externalId: string;
  sentAt: Date;
}

export type DeliveryErrorKind =
  /** Retry later; `retryAfterSeconds` says when. */
  | 'rate_limited'
  /** The messenger warns about spam (Telegram PEER_FLOOD, WhatsApp temporary ban): pause sending. */
  | 'spam_warning'
  /** Credentials are no longer valid: the user must reconnect the account. */
  | 'auth'
  /** This message can never be delivered as is (unknown chat, closed 24h window, too long...). */
  | 'rejected'
  /** Network or server trouble: retry with backoff. */
  | 'transient';

/** Thrown by transports so the dispatcher knows whether and when to retry. */
export class DeliveryError extends Error {
  constructor(
    readonly kind: DeliveryErrorKind,
    message: string,
    readonly options: { retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'DeliveryError';
  }
}

export interface DownloadedFile {
  data: Uint8Array;
  mimeType: string;
  name?: string;
}

/** A transport that delivers with plain API calls from the hub (Telegram Bot API, WhatsApp Cloud API). */
export interface DirectTransport<TConfig = unknown, TCredentials = unknown> {
  kind: 'direct';
  /**
   * Can a job interrupted mid-flight be sent again without creating a duplicate? Only true when
   * the messenger deduplicates by an id the transport derives from `job.id`.
   */
  idempotentSend: boolean;
  send(job: OutboundJob, ctx: AccountContext<TConfig, TCredentials>): Promise<SentReceipt | undefined>;
  download?(
    attachment: { externalId: string; locator?: unknown },
    ctx: AccountContext<TConfig, TCredentials>,
  ): Promise<DownloadedFile>;
  /**
   * Turns what the AI passed as `to` (phone number, @username) into a chat, for a first message
   * to someone without a chat in the store yet. Without it, only existing chats can be written to.
   */
  resolveRecipient?(to: string, ctx: AccountContext<TConfig, TCredentials>): Promise<InboundChat>;
  webhook?: WebhookHandler<TConfig, TCredentials>;
}

/** A transport served by a persistent session in the messenger gateway (MTProto, WhatsApp Web). */
export interface SessionTransport {
  kind: 'session';
}

export interface WebhookEndpoint {
  /** Public URL the messenger must call. */
  url: string;
  /** Per-account secret derived by the hub; use it as the webhook token or to verify signatures. */
  secret: string;
}

export interface WebhookRequest {
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  /** Raw body, needed to verify HMAC signatures. */
  body: string;
}

export interface WebhookResponse {
  status: number;
  body?: string;
  contentType?: string;
}

export interface WebhookHandler<TConfig = unknown, TCredentials = unknown> {
  handle(
    request: WebhookRequest,
    ctx: AccountContext<TConfig, TCredentials>,
    hook: WebhookEndpoint & {
      /** Stores messages in the hub's message store (deduplicated, encrypted). */
      ingest(messages: InboundMessage[]): Promise<void>;
      /** Records that the user's own messages were delivered/read, or that a chat was read elsewhere. */
      markChatRead(chatExternalId: string): Promise<void>;
    },
  ): Promise<WebhookResponse>;
}

export type MessengerTransport<TConfig = unknown, TCredentials = unknown> =
  | DirectTransport<TConfig, TCredentials>
  | SessionTransport;

/** Attached to a ConnectorDefinition: makes the connector a messenger. */
export interface MessengerSpec<TConfig = unknown, TCredentials = unknown> {
  /** Picks the transport for an account from its config (e.g. `mode: 'user' | 'bot'`). */
  transport(config: TConfig): MessengerTransport<TConfig, TCredentials>;
  /** Default pacing (per account mode); users can override it per account in `config.pacing`. */
  pacing?(config: TConfig): Partial<PacingLimits>;
}

export interface PacingLimits {
  /** Messages per rolling minute. */
  perMinute: number;
  /** Messages per rolling hour. */
  perHour: number;
  /** Messages per rolling 24 hours. */
  perDay: number;
  /** First messages to people who never wrote to this account, per rolling 24 hours. */
  newContactsPerDay: number;
  /** Random pause between two messages, in milliseconds. */
  minGapMs: number;
  maxGapMs: number;
  /** Show "typing..." before sending, for a time that depends on the text length. */
  typing: boolean;
}

// ---------------------------------------------------------------------------
// What the hub gives a messenger connector
// ---------------------------------------------------------------------------

export interface ListChatsQuery {
  query?: string;
  unreadOnly?: boolean;
  limit: number;
  cursor?: string;
}

export interface SearchQuery {
  query?: string;
  chatId?: string;
  /** Sender name or id (substring, case-insensitive). */
  from?: string;
  since?: Date;
  until?: Date;
  limit: number;
  cursor?: string;
}

export interface ReadChatQuery {
  chatId: string;
  before?: string;
  limit: number;
}

export interface WhatsNewQuery {
  /** Cursor from a previous call; without it, messages from the last `sinceHours`. */
  cursor?: string;
  sinceHours: number;
  includeOwn: boolean;
  limit: number;
}

export interface SendRequest {
  chatId?: string;
  /** For a first message to someone without a chat yet: phone number or @username. */
  to?: string;
  text: string;
  replyTo?: string;
  /** How long to wait for delivery before returning `queued`. */
  waitMs?: number;
}

export interface SendResult {
  jobId: string;
  status: 'queued' | 'sent' | 'failed' | 'uncertain';
  messageId?: string;
  sentAt?: string;
  /** For queued messages: when the outbox expects to send it. */
  eta?: string;
  error?: string;
  /** True when an earlier identical request was found and nothing new was queued. */
  deduplicated?: boolean;
}

export interface AccountMessaging {
  listChats(query: ListChatsQuery): Promise<Page<ChatView>>;
  search(query: SearchQuery): Promise<Page<MessageView>>;
  readChat(query: ReadChatQuery): Promise<{ chat: ChatView; messages: MessageView[]; nextCursor?: string }>;
  whatsNew(query: WhatsNewQuery): Promise<{ messages: MessageView[]; cursor: string; hasMore: boolean }>;
  send(request: SendRequest): Promise<SendResult>;
  markRead(chatId: string): Promise<{ status: string }>;
  download(messageId: string, attachmentId: string): Promise<DownloadedFile>;
  /** Whether this chat ever received a message from the other side (first contact detection). */
  isKnownContact(chatId: string): Promise<boolean>;
  /** Connection status for session transports; undefined for direct ones. */
  session(): Promise<SessionStatusView | undefined>;
  webhook(): WebhookEndpoint;
}

export interface SessionStatusView {
  state: string;
  problem?: string;
  message?: string;
  sendPausedUntil?: string;
}

/** Injected by the hub into messenger connector factories. */
export interface MessagingPort {
  forAccount(accountId: string): AccountMessaging;
}
