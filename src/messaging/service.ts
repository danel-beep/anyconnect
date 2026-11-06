import { eq } from 'drizzle-orm';
import {
  type AccountMessaging,
  type DirectTransport,
  type InboundChat,
  type InboundSink,
  MAX_CAPTION_LENGTH,
  type MessagingPort,
  type MessengerTransport,
  type PacingLimits,
  type SendResult,
} from '../connectors/messaging.js';
import type { ConnectorResolver } from '../connectors/registry.js';
import { type AccountContext, type ConnectorDefinition, ConnectorError } from '../connectors/sdk.js';
import type { AccountRow, AccountService } from '../core/accounts.js';
import type { Db } from '../db/client.js';
import { accounts } from '../db/schema.js';
import type { Logger } from '../logger.js';
import { MessengerAccounts } from './accounts.js';
import type { GatewayApi } from './gateway-client.js';
import type { InboundSignal } from './inbound-signal.js';
import type { MessengerKeys } from './keys.js';
import type { Outbox, OutboxRow } from './outbox.js';
import { resolvePacing } from './pacing.js';
import { type MessageStore, type StoredChat, toChatView } from './store.js';

/** How long `send` waits for delivery before answering `queued`. */
const DEFAULT_SEND_WAIT_MS = 12_000;
/** Open waits for replies per account in one process (a client looping in parallel gains nothing). */
const MAX_WAITS_PER_ACCOUNT = 5;
/** A woken wait reads after the store's visibility lag (see `MessageStore.whatsNew`). */
const READ_AFTER_WAKE_MS = 1_100;
/** Session states in which messages keep arriving. */
const LIVE_SESSION_STATES = new Set(['online', 'connecting', 'backoff']);

export interface ResolvedMessenger {
  row: AccountRow;
  connector: ConnectorDefinition;
  config: unknown;
  transport: MessengerTransport;
}

/**
 * The hub side of messaging: implements the {@link MessagingPort} that messenger connectors use
 * for their tools, on top of the message store, the outbox and the gateway.
 */
export class MessagingService implements MessagingPort {
  constructor(
    private readonly deps: {
      db: Db;
      store: MessageStore;
      outbox: Outbox;
      keys: MessengerKeys;
      messengerAccounts: MessengerAccounts;
      accounts: AccountService;
      connectors: ConnectorResolver;
      gateway: GatewayApi | undefined;
      publicUrl: string;
      logger: Logger;
      /** Wakes waits for replies when a message arrives. */
      inbound?: InboundSignal;
      /** Wakes the in-process dispatcher for direct transports. */
      onEnqueued?: (accountId: string) => void;
    },
  ) {}

  private readonly openWaits = new Map<string, number>();

  webhookUrl(accountId: string): string {
    return `${this.deps.publicUrl}/hooks/messenger/${accountId}`;
  }

  /** Loads an account with its messenger connector and transport (any workspace). */
  async resolve(accountId: string): Promise<ResolvedMessenger | undefined> {
    const [row] = await this.deps.db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    if (!row) return undefined;
    const connector = await this.deps.connectors.get(row.workspaceId, row.connectorId);
    if (!connector?.messenger) return undefined;
    const parsed = connector.config.safeParse(row.config ?? {});
    if (!parsed.success) return undefined;
    return { row, connector, config: parsed.data, transport: connector.messenger.transport(parsed.data) };
  }

  async context(resolved: ResolvedMessenger, signal: AbortSignal): Promise<AccountContext<unknown, unknown>> {
    return this.deps.accounts.buildContext(resolved.connector, resolved.row, {
      signal,
      logger: this.deps.logger.child({ connector: resolved.connector.id, account: resolved.row.id }),
    });
  }

  /** Where what a messenger reports about an account goes: the message store. */
  inbound(accountId: string): InboundSink {
    const { store } = this.deps;
    return {
      ingest: async (messages) => {
        await store.ingest(accountId, messages);
      },
      markChatRead: async (chatExternalId) => {
        const chat = await store.findChatByExternalId(accountId, chatExternalId);
        if (chat) await store.markChatRead(chat.id);
      },
      delivery: async (updates) => {
        for (const update of updates) await store.recordDelivery(accountId, update);
      },
    };
  }

  /**
   * Hands an event that reached the hub on a channel it owns for many accounts (the hub's Telegram
   * bot) to this account's transport. False when the account cannot take it (deleted, disabled, or
   * its transport has no `routed` handler): the event is then dropped, never stored anywhere else.
   */
  async route(accountId: string, event: unknown): Promise<boolean> {
    const resolved = await this.resolve(accountId);
    const transport = resolved?.transport;
    if (!resolved?.row.enabled || transport?.kind !== 'direct' || !transport.routed) return false;
    const ctx = await this.context(resolved, AbortSignal.timeout(20_000));
    await transport.routed.handle(event, ctx, this.inbound(accountId));
    return true;
  }

  async pacing(resolved: ResolvedMessenger): Promise<PacingLimits> {
    const overrides = (resolved.config as { pacing?: Partial<PacingLimits> }).pacing;
    return resolvePacing(resolved.connector.messenger?.pacing?.(resolved.config), overrides);
  }

  forAccount(accountId: string): AccountMessaging {
    const { store, outbox } = this.deps;
    const requireChat = async (chatId: string): Promise<StoredChat> => {
      const chat = await store.getChat(accountId, chatId);
      if (!chat)
        throw new ConnectorError(
          'not_found',
          `Chat "${chatId}" not found in this account. Use list_chats to find it.`,
        );
      return chat;
    };
    const requireResolved = async (): Promise<ResolvedMessenger> => {
      const resolved = await this.resolve(accountId);
      if (!resolved) throw new ConnectorError('not_found', 'This messenger account is not available.');
      return resolved;
    };
    const gateway = (): GatewayApi => {
      if (!this.deps.gateway) {
        throw new ConnectorError(
          'upstream',
          'The messenger gateway is not configured on this hub (GATEWAY_URL), so this account cannot be used yet.',
        );
      }
      return this.deps.gateway;
    };

    /** Queues "read up to the latest incoming message" for the chat and clears its unread counter. */
    const queueRead = async (chat: StoredChat): Promise<OutboxRow> => {
      const upTo = await store.latestInbound(chat.id);
      const { row } = await outbox.enqueue({
        accountId,
        chatId: chat.id,
        kind: 'mark_read',
        payload: upTo ? { upToExternalId: upTo.body.externalId } : {},
      });
      this.deps.onEnqueued?.(accountId);
      await store.markChatRead(chat.id);
      return row;
    };

    return {
      listChats: (query) => store.listChats(accountId, query),
      search: (query) => store.search(accountId, query),
      readChat: async (query) => {
        const result = await store.readChat(accountId, query);
        if (!result)
          throw new ConnectorError('not_found', `Chat "${query.chatId}" not found in this account.`);
        return {
          chat: toChatView(result.chat),
          messages: result.messages,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
      },
      whatsNew: (query) => store.whatsNew([accountId], query),

      waitForMessages: async (query) => {
        if (query.chatId) await requireChat(query.chatId);
        const open = this.openWaits.get(accountId) ?? 0;
        if (open >= MAX_WAITS_PER_ACCOUNT) {
          throw new ConnectorError(
            'rate_limited',
            'Too many waits for this account at once. Wait in one call at a time.',
          );
        }
        this.openWaits.set(accountId, open + 1);
        try {
          return await this.waitForMessages(accountId, query);
        } finally {
          const left = (this.openWaits.get(accountId) ?? 1) - 1;
          if (left > 0) this.openWaits.set(accountId, left);
          else this.openWaits.delete(accountId);
        }
      },

      send: async (request) => {
        const resolved = await requireResolved();
        if (request.template && (resolved.transport.kind !== 'direct' || !resolved.transport.templates)) {
          throw new ConnectorError('invalid_input', 'This account cannot send message templates.');
        }
        if (request.file && (resolved.transport.kind !== 'direct' || !resolved.transport.files)) {
          throw new ConnectorError('invalid_input', 'This account cannot send files yet.');
        }
        if (request.file && request.template) {
          throw new ConnectorError('invalid_input', 'Send a template or a file, not both.');
        }
        if (
          request.file &&
          request.text &&
          resolved.transport.kind === 'direct' &&
          resolved.transport.captionless?.includes(request.file.kind)
        ) {
          throw new ConnectorError(
            'invalid_input',
            `This messenger sends ${request.file.kind} without text: send the text as a separate message.`,
          );
        }
        if (request.file && request.text.length > MAX_CAPTION_LENGTH) {
          throw new ConnectorError(
            'invalid_input',
            `With a file the text is its caption: at most ${MAX_CAPTION_LENGTH} characters. Send a longer text as a separate message.`,
          );
        }
        let chat: StoredChat;
        if (request.chatId) chat = await requireChat(request.chatId);
        else if (request.to) {
          const transport = resolved.transport;
          let inbound: InboundChat;
          if (transport.kind === 'session') inbound = await gateway().resolveRecipient(accountId, request.to);
          else if (transport.resolveRecipient) {
            inbound = await transport.resolveRecipient(
              request.to,
              await this.context(resolved, AbortSignal.timeout(30_000)),
            );
          } else {
            throw new ConnectorError(
              'invalid_input',
              'This account can only write to existing chats: pass chat (from list_chats), not to.',
            );
          }
          chat = await store.upsertChat(accountId, inbound);
        } else {
          throw new ConnectorError(
            'invalid_input',
            'Pass chat (from list_chats) or to (phone number / @username).',
          );
        }
        // A person reads before answering: unread messages of the chat are marked read first (the
        // outbox keeps the order), so the other side never sees a reply under an unread message.
        if (chat.unread > 0) await queueRead(chat);
        let replyToExternalId: string | undefined;
        if (request.replyTo) {
          const target = await store.getMessage(accountId, request.replyTo);
          if (!target || target.chatId !== chat.id) {
            throw new ConnectorError('invalid_input', `Message "${request.replyTo}" is not in this chat.`);
          }
          replyToExternalId = target.body.externalId;
        }
        const { row, deduplicated } = await outbox.enqueue({
          accountId,
          chatId: chat.id,
          kind: 'message',
          payload: {
            text: request.text,
            ...(replyToExternalId ? { replyToExternalId } : {}),
            ...(request.template ? { template: request.template } : {}),
            ...(request.file ? { file: request.file } : {}),
          },
          newContact: !chat.hasInbound,
        });
        this.deps.onEnqueued?.(accountId);
        const final = (await outbox.waitFor(row.id, request.waitMs ?? DEFAULT_SEND_WAIT_MS)) ?? row;
        return this.toSendResult(final, deduplicated);
      },

      markRead: async (chatId) => {
        const row = await queueRead(await requireChat(chatId));
        return { status: row.status === 'sent' ? 'read' : 'queued' };
      },

      download: async (messageId, attachmentId) => {
        const message = await store.getMessage(accountId, messageId);
        const index = Number(/^a(\d+)$/.exec(attachmentId)?.[1] ?? Number.NaN);
        const attachment = message?.body.attachments[index];
        if (!message || !attachment) throw new ConnectorError('not_found', 'Attachment not found.');
        const sentLink = (attachment.locator as { sentLink?: string } | undefined)?.sentLink;
        if (sentLink) {
          throw new ConnectorError(
            'not_found',
            `This file was sent by link and the hub keeps no copy of it: ${sentLink}`,
          );
        }
        const resolved = await requireResolved();
        if (resolved.transport.kind === 'session') {
          const chat = await requireChat(message.chatId);
          return gateway().download(accountId, {
            chatExternalId: chat.externalId,
            messageExternalId: message.body.externalId,
            attachment,
          });
        }
        const transport = resolved.transport as DirectTransport;
        if (!transport.download)
          throw new ConnectorError('invalid_input', 'This account cannot download files.');
        return transport.download(
          { externalId: attachment.externalId, locator: attachment.locator },
          await this.context(resolved, AbortSignal.timeout(60_000)),
        );
      },

      isKnownContact: async (chatId) => (await requireChat(chatId)).hasInbound,

      session: async () => {
        const resolved = await this.resolve(accountId);
        if (resolved?.transport.kind !== 'session') return undefined;
        const row = await this.deps.messengerAccounts.get(accountId);
        return row ? MessengerAccounts.view(row) : { state: 'needs_login' };
      },

      webhook: () => ({ url: this.webhookUrl(accountId), secret: this.deps.keys.webhookSecret(accountId) }),
    };
  }

  private async waitForMessages(
    accountId: string,
    query: Parameters<AccountMessaging['waitForMessages']>[0],
  ): Promise<Awaited<ReturnType<AccountMessaging['waitForMessages']>>> {
    const { store, inbound } = this.deps;
    const started = Date.now();
    const deadline = started + query.timeoutMs;
    let cursor = query.cursor ?? (await store.replyCursor(accountId, query.chatId));
    const read = () =>
      store.whatsNew([accountId], {
        cursor,
        sinceHours: 1,
        includeOwn: query.includeOwn,
        limit: query.limit,
        ...(query.chatId ? { chatId: query.chatId } : {}),
      });
    for (;;) {
      const page = await read();
      cursor = page.cursor;
      const waitedMs = Date.now() - started;
      if (page.messages.length > 0) return { ...page, waitedMs };
      // A session that is logged out or stopped will not receive anything: say so instead of waiting.
      const session = await this.forAccount(accountId).session();
      if (session && !LIVE_SESSION_STATES.has(session.state)) {
        return { ...page, waitedMs, offline: session };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || query.signal?.aborted) return { ...page, waitedMs };
      if (inbound) await inbound.wait(accountId, remaining, query.signal);
      else await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 2_000)));
      if (query.signal?.aborted) return { ...(await read()), waitedMs: Date.now() - started };
      // Freshly stored messages become visible to the cursor a moment later.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(READ_AFTER_WAKE_MS, Math.max(0, deadline - Date.now()))),
      );
    }
  }

  private async toSendResult(row: OutboxRow, deduplicated: boolean): Promise<SendResult> {
    const status: SendResult['status'] =
      row.status === 'sent'
        ? 'sent'
        : row.status === 'failed' || row.status === 'cancelled'
          ? 'failed'
          : row.status === 'uncertain'
            ? 'uncertain'
            : 'queued';
    const paused = await this.deps.messengerAccounts.get(row.accountId);
    const pausedUntil =
      paused?.sendPausedUntil && paused.sendPausedUntil > new Date() ? paused.sendPausedUntil : undefined;
    return {
      jobId: row.id,
      status,
      ...(row.messageId ? { messageId: row.messageId } : {}),
      ...(row.sentAt ? { sentAt: row.sentAt.toISOString() } : {}),
      ...(status === 'queued'
        ? {
            eta: (pausedUntil && pausedUntil > row.notBefore ? pausedUntil : row.notBefore).toISOString(),
            ...(pausedUntil
              ? { error: `Sending from this account is paused: ${paused?.sendPauseReason ?? ''}`.trim() }
              : row.error
                ? { error: row.error }
                : {}),
          }
        : row.error
          ? { error: row.error }
          : {}),
      ...(deduplicated ? { deduplicated: true } : {}),
    };
  }
}
