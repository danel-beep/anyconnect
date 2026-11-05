import { and, asc, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import type {
  AttachmentView,
  ChatKind,
  ChatView,
  DeliveryState,
  DeliveryUpdate,
  InboundAttachment,
  InboundChat,
  InboundMessage,
  MessageView,
  Page,
} from '../connectors/messaging.js';
import type { Db } from '../db/client.js';
import { messengerChats, messengerMessages } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import type { CipherSource, JsonCipher } from './ciphers.js';
import type { MessengerKeys } from './keys.js';
import { indexTerms, matchesQuery, queryTerms } from './search-index.js';

type ChatRow = typeof messengerChats.$inferSelect;
type MessageRow = typeof messengerMessages.$inferSelect;

export interface ChatInfo {
  externalId: string;
  title: string;
  username?: string;
}

export interface StoredAttachment {
  externalId: string;
  kind: InboundAttachment['kind'];
  name?: string;
  mimeType?: string;
  size?: number;
  locator?: unknown;
}

export interface MessageBody {
  externalId: string;
  text: string;
  sender?: { externalId?: string; name?: string };
  replyToExternalId?: string;
  attachments: StoredAttachment[];
  delivery?: DeliveryState;
  deliveryError?: string;
}

export interface StoredChat extends ChatInfo {
  id: string;
  accountId: string;
  kind: ChatKind;
  unread: number;
  hasInbound: boolean;
  lastMessageAt: Date | null;
}

export interface StoredMessage {
  id: string;
  seq: number;
  chatId: string;
  accountId: string;
  direction: 'in' | 'out';
  sentAt: Date;
  editedAt: Date | null;
  deleted: boolean;
  body: MessageBody;
}

const chatContext = (id: string) => `messenger:chat:${id}`;
const messageContext = (id: string) => `messenger:message:${id}`;

/** Freshly ingested rows become visible to "what's new" after this delay (see {@link MessageStore.whatsNew}). */
const VISIBILITY_LAG_MS = 1_000;
const MAX_SCAN_ROUNDS = 5;

function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(parts.join('|'), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): string[] | undefined {
  if (!cursor) return undefined;
  try {
    return Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  } catch {
    return undefined;
  }
}

/**
 * The hub's own copy of messenger chats and messages. Everything identifying is encrypted:
 * chat and message ids are stored as keyed hashes for lookups, text and names as envelopes of the
 * account's data key bound to the row id (see {@link AccountCiphers}), and search goes through a
 * blind index.
 */
export class MessageStore {
  constructor(
    private readonly db: Db,
    private readonly ciphers: CipherSource,
    private readonly keys: MessengerKeys,
  ) {}

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /** Finds or creates the chat; updates its title when the messenger reports a new one. */
  async upsertChat(accountId: string, chat: InboundChat): Promise<StoredChat> {
    const cipher = await this.ciphers.forAccount(accountId);
    const externalKey = this.keys.lookupKey(accountId, 'chat', chat.externalId);
    const [existing] = await this.db
      .select()
      .from(messengerChats)
      .where(and(eq(messengerChats.accountId, accountId), eq(messengerChats.externalKey, externalKey)))
      .limit(1);
    if (existing) {
      const info = this.chatInfo(cipher, existing);
      const title = chat.title?.trim() || info.title;
      const username = chat.username ?? info.username;
      const patch: Partial<typeof messengerChats.$inferInsert> = {};
      if (title !== info.title || username !== info.username) {
        patch.infoEncrypted = this.encryptChatInfo(cipher, existing.id, {
          externalId: chat.externalId,
          title,
          username,
        });
        patch.titleIndex = this.titleIndex(accountId, title, username);
      }
      if (chat.unread !== undefined && chat.unread !== existing.unread) patch.unread = chat.unread;
      if (chat.kind !== existing.kind) patch.kind = chat.kind;
      if (Object.keys(patch).length === 0) return this.toStoredChat(existing, info);
      const [row] = await this.db
        .update(messengerChats)
        .set(patch)
        .where(eq(messengerChats.id, existing.id))
        .returning();
      return this.toStoredChat(
        row!,
        patch.infoEncrypted ? { externalId: chat.externalId, title, username } : info,
      );
    }
    const id = newId('cht');
    const info: ChatInfo = {
      externalId: chat.externalId,
      title: chat.title?.trim() || chat.username || chat.externalId,
      ...(chat.username ? { username: chat.username } : {}),
    };
    const [row] = await this.db
      .insert(messengerChats)
      .values({
        id,
        accountId,
        externalKey,
        infoEncrypted: this.encryptChatInfo(cipher, id, info),
        kind: chat.kind,
        titleIndex: this.titleIndex(accountId, info.title, info.username),
        unread: chat.unread ?? 0,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return this.toStoredChat(row, info);
    // Lost a race with a concurrent insert of the same chat.
    return this.upsertChat(accountId, chat);
  }

  /**
   * Stores messages idempotently: a message seen again (webhook retry, echo of our own send,
   * history backfill after a restart) is merged, never duplicated. Edits and deletions update
   * the stored copy; deleted messages lose their text.
   */
  async ingest(accountId: string, messages: InboundMessage[]): Promise<StoredMessage[]> {
    const stored: StoredMessage[] = [];
    for (const message of messages) {
      const result = await this.ingestOne(accountId, message);
      if (result) stored.push(result);
    }
    return stored;
  }

  private async ingestOne(accountId: string, message: InboundMessage): Promise<StoredMessage | undefined> {
    const chat = await this.upsertChat(accountId, message.chat);
    const cipher = await this.ciphers.forAccount(accountId);
    const externalKey = this.keys.lookupKey(accountId, `msg:${chat.id}`, message.externalId);
    const body: MessageBody = {
      externalId: message.externalId,
      text: message.deleted ? '' : (message.text ?? ''),
      ...(message.sender ? { sender: message.sender } : {}),
      ...(message.replyToExternalId ? { replyToExternalId: message.replyToExternalId } : {}),
      attachments: message.deleted ? [] : (message.attachments ?? []),
    };
    const searchIndex = this.messageIndex(accountId, body);
    const [existing] = await this.db
      .select()
      .from(messengerMessages)
      .where(and(eq(messengerMessages.chatId, chat.id), eq(messengerMessages.externalKey, externalKey)))
      .limit(1);

    let row: MessageRow | undefined;
    let isNew = false;
    if (existing) {
      const changed =
        (message.deleted ?? false) !== existing.deleted ||
        (message.editedAt && message.editedAt.getTime() !== existing.editedAt?.getTime());
      if (!changed) return undefined;
      // An edit or deletion keeps what is known about delivery.
      const previous = cipher.decryptJson<MessageBody>(existing.bodyEncrypted, messageContext(existing.id));
      if (previous.delivery) body.delivery = previous.delivery;
      if (previous.deliveryError) body.deliveryError = previous.deliveryError;
      [row] = await this.db
        .update(messengerMessages)
        .set({
          bodyEncrypted: cipher.encryptJson(body, messageContext(existing.id)),
          searchIndex,
          editedAt: message.editedAt ?? existing.editedAt,
          deleted: message.deleted ?? false,
        })
        .where(eq(messengerMessages.seq, existing.seq))
        .returning();
    } else {
      const id = newId('msg');
      [row] = await this.db
        .insert(messengerMessages)
        .values({
          id,
          accountId,
          chatId: chat.id,
          externalKey,
          direction: message.direction,
          sentAt: message.sentAt,
          editedAt: message.editedAt ?? null,
          deleted: message.deleted ?? false,
          bodyEncrypted: cipher.encryptJson(body, messageContext(id)),
          searchIndex,
        })
        .onConflictDoNothing()
        .returning();
      isNew = Boolean(row);
    }
    if (!row) return undefined;

    if (isNew) {
      await this.db
        .update(messengerChats)
        .set({
          lastMessageAt: sql`greatest(${messengerChats.lastMessageAt}, ${message.sentAt.toISOString()}::timestamptz)`,
          ...(message.direction === 'in'
            ? {
                hasInbound: true,
                // A messenger-reported counter (set by upsertChat) wins over our own counting.
                ...(message.chat.unread === undefined ? { unread: sql`${messengerChats.unread} + 1` } : {}),
              }
            : { unread: 0 }),
        })
        .where(eq(messengerChats.id, chat.id));
    }
    return { ...this.toStoredMessage(row), body };
  }

  /**
   * Moves one of the user's own messages forward (sent → delivered → read) or marks it failed.
   * Statuses arrive out of order and concurrently, so the row is locked and never moved back.
   * A status for a message not stored yet (it raced the outbox) is dropped: the next one fixes it.
   */
  async recordDelivery(accountId: string, update: DeliveryUpdate): Promise<boolean> {
    const chat = await this.findChatByExternalId(accountId, update.chatExternalId);
    if (!chat) return false;
    const externalKey = this.keys.lookupKey(accountId, `msg:${chat.id}`, update.messageExternalId);
    const cipher = await this.ciphers.forAccount(accountId);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(messengerMessages)
        .where(and(eq(messengerMessages.chatId, chat.id), eq(messengerMessages.externalKey, externalKey)))
        .limit(1)
        .for('update');
      if (row?.direction !== 'out') return false;
      const body = cipher.decryptJson<MessageBody>(row.bodyEncrypted, messageContext(row.id));
      if (!deliveryAdvances(body.delivery, update.state)) return false;
      body.delivery = update.state;
      if (update.state === 'failed' && update.error) body.deliveryError = update.error.slice(0, 300);
      await tx
        .update(messengerMessages)
        .set({ bodyEncrypted: cipher.encryptJson(body, messageContext(row.id)) })
        .where(eq(messengerMessages.seq, row.seq));
      return true;
    });
  }

  async markChatRead(chatId: string): Promise<void> {
    await this.db.update(messengerChats).set({ unread: 0 }).where(eq(messengerChats.id, chatId));
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async getChat(accountId: string, chatId: string): Promise<StoredChat | undefined> {
    const [row] = await this.db
      .select()
      .from(messengerChats)
      .where(and(eq(messengerChats.accountId, accountId), eq(messengerChats.id, chatId)))
      .limit(1);
    return row ? this.readChatRow(row) : undefined;
  }

  async findChatByExternalId(accountId: string, externalId: string): Promise<StoredChat | undefined> {
    const externalKey = this.keys.lookupKey(accountId, 'chat', externalId);
    const [row] = await this.db
      .select()
      .from(messengerChats)
      .where(and(eq(messengerChats.accountId, accountId), eq(messengerChats.externalKey, externalKey)))
      .limit(1);
    return row ? this.readChatRow(row) : undefined;
  }

  async getMessage(accountId: string, messageId: string): Promise<StoredMessage | undefined> {
    const [row] = await this.db
      .select()
      .from(messengerMessages)
      .where(and(eq(messengerMessages.accountId, accountId), eq(messengerMessages.id, messageId)))
      .limit(1);
    return row ? this.readMessageRow(row) : undefined;
  }

  async findMessageByExternalId(
    accountId: string,
    chatId: string,
    externalId: string,
  ): Promise<StoredMessage | undefined> {
    const externalKey = this.keys.lookupKey(accountId, `msg:${chatId}`, externalId);
    const [row] = await this.db
      .select()
      .from(messengerMessages)
      .where(and(eq(messengerMessages.chatId, chatId), eq(messengerMessages.externalKey, externalKey)))
      .limit(1);
    return row ? this.readMessageRow(row) : undefined;
  }

  /** The newest message the other side sent in a chat (read receipts point at it). */
  async latestInbound(chatId: string): Promise<StoredMessage | undefined> {
    const [row] = await this.db
      .select()
      .from(messengerMessages)
      .where(and(eq(messengerMessages.chatId, chatId), eq(messengerMessages.direction, 'in')))
      .orderBy(desc(messengerMessages.sentAt), desc(messengerMessages.seq))
      .limit(1);
    return row ? this.readMessageRow(row) : undefined;
  }

  async listChats(
    accountId: string,
    query: { query?: string; unreadOnly?: boolean; limit: number; cursor?: string },
  ): Promise<Page<ChatView>> {
    const offset = Number(decodeCursor(query.cursor)?.[0] ?? 0) || 0;
    const terms = query.query ? queryTerms(query.query, 'c') : [];
    const tokens = terms.map((t) => this.keys.indexToken(accountId, t));
    const conditions = [eq(messengerChats.accountId, accountId)];
    if (query.unreadOnly) conditions.push(gt(messengerChats.unread, 0));
    if (tokens.length) conditions.push(sql`${messengerChats.titleIndex} @> ${sqlIntArray(tokens)}`);

    const items: ChatView[] = [];
    let scanned = offset;
    let exhausted = false;
    for (let round = 0; round < MAX_SCAN_ROUNDS && items.length < query.limit; round++) {
      const batch = query.limit * 2;
      const rows = await this.db
        .select()
        .from(messengerChats)
        .where(and(...conditions))
        .orderBy(sql`${messengerChats.lastMessageAt} desc nulls last`, asc(messengerChats.id))
        .limit(batch)
        .offset(scanned);
      let consumed = 0;
      for (const row of rows) {
        consumed++;
        const chat = await this.readChatRow(row);
        if (query.query && !matchesQuery(`${chat.title} ${chat.username ?? ''}`, query.query)) continue;
        items.push(toChatView(chat));
        if (items.length >= query.limit) break;
      }
      scanned += consumed;
      if (rows.length < batch && consumed === rows.length) {
        exhausted = true;
        break;
      }
    }
    return { items, ...(exhausted ? {} : { nextCursor: encodeCursor([scanned]) }) };
  }

  /** Messages, newest first, filtered by the blind index and verified after decryption. */
  async search(
    accountId: string,
    query: {
      query?: string;
      chatId?: string;
      from?: string;
      since?: Date;
      until?: Date;
      limit: number;
      cursor?: string;
    },
  ): Promise<Page<MessageView>> {
    const conditions = [eq(messengerMessages.accountId, accountId), eq(messengerMessages.deleted, false)];
    if (query.chatId) conditions.push(eq(messengerMessages.chatId, query.chatId));
    if (query.since) conditions.push(sql`${messengerMessages.sentAt} >= ${query.since.toISOString()}`);
    if (query.until) conditions.push(sql`${messengerMessages.sentAt} < ${query.until.toISOString()}`);
    const terms = [
      ...(query.query ? queryTerms(query.query, 't') : []),
      ...(query.from ? queryTerms(query.from, 'f') : []),
    ];
    const tokens = terms.map((t) => this.keys.indexToken(accountId, t));
    if (tokens.length) conditions.push(sql`${messengerMessages.searchIndex} @> ${sqlIntArray(tokens)}`);

    let position = decodeCursor(query.cursor);
    const chats = new Map<string, StoredChat | undefined>();
    const items: MessageView[] = [];
    let more = false;
    for (let round = 0; round < MAX_SCAN_ROUNDS; round++) {
      const batch = query.limit * 3;
      const rows = await this.db
        .select()
        .from(messengerMessages)
        .where(and(...conditions, ...(position ? [keysetBefore(position)] : [])))
        .orderBy(desc(messengerMessages.sentAt), desc(messengerMessages.seq))
        .limit(batch);
      for (const row of rows) {
        position = [String(row.sentAt.getTime()), String(row.seq)];
        const message = await this.readMessageRow(row);
        if (query.query && !matchesQuery(message.body.text, query.query)) continue;
        if (query.from && !matchesQuery(senderText(message.body), query.from)) continue;
        items.push(await this.toMessageView(message, chats));
        if (items.length >= query.limit) {
          more = true;
          break;
        }
      }
      if (items.length >= query.limit || rows.length < batch) {
        more = more || rows.length === batch;
        break;
      }
      more = true;
    }
    return { items, ...(more && position ? { nextCursor: encodeCursor(position) } : {}) };
  }

  /** The last messages of a chat in chronological order, with a cursor to older ones. */
  async readChat(
    accountId: string,
    query: { chatId: string; before?: string; limit: number },
  ): Promise<{ chat: StoredChat; messages: MessageView[]; nextCursor?: string } | undefined> {
    const chat = await this.getChat(accountId, query.chatId);
    if (!chat) return undefined;
    const position = decodeCursor(query.before);
    const rows = await this.db
      .select()
      .from(messengerMessages)
      .where(and(eq(messengerMessages.chatId, chat.id), ...(position ? [keysetBefore(position)] : [])))
      .orderBy(desc(messengerMessages.sentAt), desc(messengerMessages.seq))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const chats = new Map<string, StoredChat | undefined>([[chat.id, chat]]);
    const messages: MessageView[] = [];
    for (const row of page.reverse())
      messages.push(await this.toMessageView(await this.readMessageRow(row), chats));
    const oldest = page[0];
    return {
      chat,
      messages,
      ...(rows.length > query.limit && oldest
        ? { nextCursor: encodeCursor([oldest.sentAt.getTime(), oldest.seq]) }
        : {}),
    };
  }

  /**
   * Messages stored after a cursor, in ingestion order. Rows younger than one second are held
   * back so that a concurrent transaction that took a lower sequence number and commits later
   * is not skipped by a cursor that already moved past it.
   */
  async whatsNew(
    accountIds: string[],
    query: { cursor?: string; sinceHours: number; includeOwn: boolean; limit: number },
  ): Promise<{ messages: MessageView[]; cursor: string; hasMore: boolean }> {
    if (accountIds.length === 0) return { messages: [], cursor: query.cursor ?? '', hasMore: false };
    const after = Number(decodeCursor(query.cursor)?.[0] ?? Number.NaN);
    const visibleBefore = new Date(Date.now() - VISIBILITY_LAG_MS);
    const conditions = [
      inArray(messengerMessages.accountId, accountIds),
      lt(messengerMessages.createdAt, visibleBefore),
      eq(messengerMessages.deleted, false),
      Number.isFinite(after)
        ? gt(messengerMessages.seq, after)
        : gt(messengerMessages.sentAt, new Date(Date.now() - query.sinceHours * 3_600_000)),
    ];
    if (!query.includeOwn) conditions.push(eq(messengerMessages.direction, 'in'));
    const rows = await this.db
      .select()
      .from(messengerMessages)
      .where(and(...conditions))
      .orderBy(asc(messengerMessages.seq))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const chats = new Map<string, StoredChat | undefined>();
    const messages: MessageView[] = [];
    for (const row of page) messages.push(await this.toMessageView(await this.readMessageRow(row), chats));
    let lastSeq = page.at(-1)?.seq;
    if (lastSeq === undefined) {
      if (Number.isFinite(after)) lastSeq = after;
      else {
        // No cursor and nothing new: start the cursor at the current end of the visible feed.
        const [latest] = await this.db
          .select({ seq: sql<number>`coalesce(max(${messengerMessages.seq}), 0)` })
          .from(messengerMessages)
          .where(
            and(
              inArray(messengerMessages.accountId, accountIds),
              lt(messengerMessages.createdAt, visibleBefore),
            ),
          );
        lastSeq = Number(latest?.seq ?? 0);
      }
    }
    return { messages, cursor: encodeCursor([lastSeq]), hasMore: rows.length > query.limit };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private encryptChatInfo(cipher: JsonCipher, chatId: string, info: ChatInfo): string {
    return cipher.encryptJson(info, chatContext(chatId));
  }

  private chatInfo(cipher: JsonCipher, row: ChatRow): ChatInfo {
    return cipher.decryptJson<ChatInfo>(row.infoEncrypted, chatContext(row.id));
  }

  private async readChatRow(row: ChatRow): Promise<StoredChat> {
    return this.toStoredChat(row, this.chatInfo(await this.ciphers.forAccount(row.accountId), row));
  }

  private async readMessageRow(row: MessageRow): Promise<StoredMessage> {
    const cipher = await this.ciphers.forAccount(row.accountId);
    return {
      ...this.toStoredMessage(row),
      body: cipher.decryptJson<MessageBody>(row.bodyEncrypted, messageContext(row.id)),
    };
  }

  private titleIndex(accountId: string, title: string, username?: string): number[] {
    return tokensOf(this.keys, accountId, indexTerms(`${title} ${username ?? ''}`, 'c'));
  }

  private messageIndex(accountId: string, body: MessageBody): number[] {
    const terms = [
      ...indexTerms([body.text, ...body.attachments.map((a) => a.name ?? '')].filter(Boolean).join(' '), 't'),
      ...indexTerms(senderText(body), 'f'),
    ];
    return tokensOf(this.keys, accountId, terms);
  }

  private toStoredChat(row: ChatRow, info: ChatInfo): StoredChat {
    return {
      id: row.id,
      accountId: row.accountId,
      kind: row.kind,
      unread: row.unread,
      hasInbound: row.hasInbound,
      lastMessageAt: row.lastMessageAt,
      ...info,
    };
  }

  private toStoredMessage(row: MessageRow): Omit<StoredMessage, 'body'> {
    return {
      id: row.id,
      seq: row.seq,
      chatId: row.chatId,
      accountId: row.accountId,
      direction: row.direction,
      sentAt: row.sentAt,
      editedAt: row.editedAt,
      deleted: row.deleted,
    };
  }

  private async toMessageView(
    message: StoredMessage,
    chats: Map<string, StoredChat | undefined>,
  ): Promise<MessageView> {
    if (!chats.has(message.chatId))
      chats.set(message.chatId, await this.getChat(message.accountId, message.chatId));
    const chat = chats.get(message.chatId);
    let replyTo: string | undefined;
    if (message.body.replyToExternalId) {
      replyTo = (
        await this.findMessageByExternalId(message.accountId, message.chatId, message.body.replyToExternalId)
      )?.id;
    }
    const sender = message.body.sender;
    return {
      id: message.id,
      chatId: message.chatId,
      chatTitle: chat?.title ?? '',
      direction: message.direction,
      ...(sender && (sender.name || sender.externalId)
        ? {
            sender: {
              ...(sender.externalId ? { id: sender.externalId } : {}),
              ...(sender.name ? { name: sender.name } : {}),
            },
          }
        : {}),
      sentAt: message.sentAt.toISOString(),
      ...(message.editedAt ? { editedAt: message.editedAt.toISOString() } : {}),
      text: message.body.text,
      ...(replyTo ? { replyTo } : {}),
      attachments: message.body.attachments.map(toAttachmentView),
      ...(message.deleted ? { deleted: true } : {}),
      ...(message.body.delivery ? { delivery: message.body.delivery } : {}),
      ...(message.body.deliveryError ? { deliveryError: message.body.deliveryError } : {}),
    };
  }
}

const DELIVERY_RANK: Record<DeliveryState, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

/** Delivery only moves forward; a failure is final, and nothing reverts a read message. */
function deliveryAdvances(current: DeliveryState | undefined, next: DeliveryState): boolean {
  if (!current) return true;
  if (current === 'failed' || current === 'read') return false;
  return DELIVERY_RANK[next] > DELIVERY_RANK[current];
}

function senderText(body: MessageBody): string {
  return [body.sender?.name, body.sender?.externalId].filter(Boolean).join(' ');
}

function tokensOf(keys: MessengerKeys, accountId: string, terms: string[]): number[] {
  return [...new Set(terms.map((t) => keys.indexToken(accountId, t)))];
}

function sqlIntArray(values: number[]) {
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::int[]`;
}

function keysetBefore(position: string[]) {
  const sentAt = new Date(Number(position[0]));
  const seq = Number(position[1]);
  return or(
    lt(messengerMessages.sentAt, sentAt),
    and(eq(messengerMessages.sentAt, sentAt), lt(messengerMessages.seq, seq)),
  )!;
}

function toAttachmentView(attachment: StoredAttachment, index: number): AttachmentView {
  return {
    id: `a${index}`,
    kind: attachment.kind,
    ...(attachment.name ? { name: attachment.name } : {}),
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
  };
}

export function toChatView(chat: StoredChat): ChatView {
  return {
    id: chat.id,
    title: chat.title,
    kind: chat.kind,
    ...(chat.username ? { username: chat.username } : {}),
    unread: chat.unread,
    ...(chat.lastMessageAt ? { lastMessageAt: chat.lastMessageAt.toISOString() } : {}),
  };
}
