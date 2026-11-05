import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { OutboundFile, OutboundJob, TemplateMessage } from '../connectors/messaging.js';
import type { Db } from '../db/client.js';
import { messengerChats, messengerOutbox, type OutboxStatus } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import type { CipherSource } from './ciphers.js';
import type { MessengerKeys } from './keys.js';
import type { ChatInfo } from './store.js';

export type OutboxRow = typeof messengerOutbox.$inferSelect;

export interface OutboxPayload {
  text?: string;
  replyToExternalId?: string;
  upToExternalId?: string;
  template?: TemplateMessage;
  file?: OutboundFile;
}

/** Identical requests (same chat, same text) within this window are merged into one job. */
export const DEDUPE_WINDOW_MS = 10 * 60_000;
/** A claimed job not finished within this time is considered interrupted. */
export const CLAIM_TTL_MS = 2 * 60_000;
/** Finished jobs are deleted this many days after they finished (the privacy policy states it). */
export const OUTBOX_RETENTION_DAYS = 30;
const DAY = 86_400_000;

const payloadContext = (id: string) => `messenger:outbox:${id}`;

export interface ClaimedJob {
  row: OutboxRow;
  job: OutboundJob;
}

/**
 * Durable queue of messages and read receipts. Exactly-once is the goal: a job is merged with an
 * identical recent one, claimed by one worker at a time, and a job interrupted while being sent
 * is only retried when the transport can deduplicate it — otherwise it is marked `uncertain`
 * rather than risking a second copy.
 */
export class Outbox {
  constructor(
    private readonly db: Db,
    private readonly ciphers: CipherSource,
    private readonly keys: MessengerKeys,
  ) {}

  async enqueue(input: {
    accountId: string;
    chatId: string;
    kind: 'message' | 'mark_read';
    payload: OutboxPayload;
    newContact?: boolean;
  }): Promise<{ row: OutboxRow; deduplicated: boolean }> {
    const cipher = await this.ciphers.forAccount(input.accountId);
    const contentKey = this.keys.lookupKey(
      input.accountId,
      'outbox',
      JSON.stringify([
        input.kind,
        input.chatId,
        input.payload.text ?? '',
        input.payload.replyToExternalId ?? '',
        ...(input.payload.template ? [input.payload.template] : []),
        ...(input.payload.file ? [input.payload.file] : []),
      ]),
    );
    return this.db.transaction(async (tx) => {
      // Serializes concurrent identical requests (an AI client retrying while the first is in flight).
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`outbox:${input.accountId}:${contentKey}`}))`,
      );
      if (input.kind === 'message') {
        const [existing] = await tx
          .select()
          .from(messengerOutbox)
          .where(
            and(
              eq(messengerOutbox.accountId, input.accountId),
              eq(messengerOutbox.contentKey, contentKey),
              gt(messengerOutbox.createdAt, new Date(Date.now() - DEDUPE_WINDOW_MS)),
              inArray(messengerOutbox.status, ['queued', 'sending', 'sent', 'uncertain']),
            ),
          )
          .limit(1);
        if (existing) return { row: existing, deduplicated: true };
      }
      const id = newId('out');
      const [row] = await tx
        .insert(messengerOutbox)
        .values({
          id,
          accountId: input.accountId,
          chatId: input.chatId,
          kind: input.kind,
          payloadEncrypted: cipher.encryptJson(input.payload, payloadContext(id)),
          contentKey,
          newContact: input.newContact ?? false,
        })
        .returning();
      await tx.execute(sql`select pg_notify('messenger_outbox', ${input.accountId})`);
      return { row: row!, deduplicated: false };
    });
  }

  async get(id: string): Promise<OutboxRow | undefined> {
    const [row] = await this.db.select().from(messengerOutbox).where(eq(messengerOutbox.id, id)).limit(1);
    return row;
  }

  /** Accounts (among `accountIds`) that have jobs due now. */
  async dueAccounts(accountIds: string[]): Promise<string[]> {
    if (accountIds.length === 0) return [];
    const rows = await this.db
      .selectDistinct({ accountId: messengerOutbox.accountId })
      .from(messengerOutbox)
      .where(
        and(
          inArray(messengerOutbox.accountId, accountIds),
          eq(messengerOutbox.status, 'queued'),
          lte(messengerOutbox.notBefore, new Date()),
        ),
      );
    return rows.map((r) => r.accountId);
  }

  /** Takes the oldest due job of an account, if no other job of that account is in flight. */
  async claim(accountId: string, worker: string): Promise<ClaimedJob | undefined> {
    const row = await this.db.transaction(async (tx) => {
      const [inFlight] = await tx
        .select({ id: messengerOutbox.id })
        .from(messengerOutbox)
        .where(and(eq(messengerOutbox.accountId, accountId), eq(messengerOutbox.status, 'sending')))
        .limit(1);
      if (inFlight) return undefined;
      const [next] = await tx
        .select()
        .from(messengerOutbox)
        .where(
          and(
            eq(messengerOutbox.accountId, accountId),
            eq(messengerOutbox.status, 'queued'),
            lte(messengerOutbox.notBefore, new Date()),
          ),
        )
        .orderBy(asc(messengerOutbox.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!next) return undefined;
      const [claimed] = await tx
        .update(messengerOutbox)
        .set({
          status: 'sending',
          claimedBy: worker,
          claimExpiresAt: new Date(Date.now() + CLAIM_TTL_MS),
          attempts: sql`${messengerOutbox.attempts} + 1`,
        })
        .where(eq(messengerOutbox.id, next.id))
        .returning();
      return claimed;
    });
    if (!row) return undefined;
    return { row, job: await this.toJob(row) };
  }

  private async toJob(row: OutboxRow): Promise<OutboundJob> {
    const cipher = await this.ciphers.forAccount(row.accountId);
    const payload = cipher.decryptJson<OutboxPayload>(row.payloadEncrypted, payloadContext(row.id));
    const [chat] = await this.db
      .select()
      .from(messengerChats)
      .where(eq(messengerChats.id, row.chatId))
      .limit(1);
    if (!chat) throw new Error(`chat ${row.chatId} of job ${row.id} is missing`);
    const info = cipher.decryptJson<ChatInfo>(chat.infoEncrypted, `messenger:chat:${chat.id}`);
    return {
      id: row.id,
      attempt: row.attempts,
      kind: row.kind,
      chat: { externalId: info.externalId, kind: chat.kind },
      ...(payload.text !== undefined ? { text: payload.text } : {}),
      ...(payload.replyToExternalId ? { replyToExternalId: payload.replyToExternalId } : {}),
      ...(payload.upToExternalId ? { upToExternalId: payload.upToExternalId } : {}),
      ...(payload.template ? { template: payload.template } : {}),
      ...(payload.file ? { file: payload.file } : {}),
    };
  }

  async markSent(id: string, result: { messageId?: string; sentAt: Date }): Promise<void> {
    await this.finish(id, {
      status: 'sent',
      sentAt: result.sentAt,
      messageId: result.messageId ?? null,
      error: null,
    });
  }

  async markFailed(
    id: string,
    error: string,
    status: Extract<OutboxStatus, 'failed' | 'uncertain'> = 'failed',
  ) {
    await this.finish(id, { status, error: error.slice(0, 500) });
  }

  /** Puts a claimed job back and holds every queued job of the account until `at`, keeping their order. */
  async release(row: OutboxRow, at: Date, error?: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(messengerOutbox)
        .set({
          status: 'queued',
          claimedBy: null,
          claimExpiresAt: null,
          notBefore: at,
          ...(error ? { error: error.slice(0, 500) } : {}),
        })
        .where(and(eq(messengerOutbox.id, row.id), eq(messengerOutbox.status, 'sending')));
      await this.holdAccount(row.accountId, at, tx);
    });
  }

  /** Delays all queued jobs of an account (flood wait, pacing, paused sending). */
  async holdAccount(accountId: string, until: Date, executor: Pick<Db, 'update'> = this.db): Promise<void> {
    await executor
      .update(messengerOutbox)
      .set({ notBefore: sql`greatest(${messengerOutbox.notBefore}, ${until.toISOString()}::timestamptz)` })
      .where(and(eq(messengerOutbox.accountId, accountId), eq(messengerOutbox.status, 'queued')));
  }

  /**
   * Jobs whose worker vanished mid-send. Idempotent transports get them back in the queue;
   * for the others we cannot know whether the message went out, so they become `uncertain`.
   */
  async recoverInterrupted(accountId: string, idempotentSend: boolean): Promise<number> {
    const stale = and(
      eq(messengerOutbox.accountId, accountId),
      eq(messengerOutbox.status, 'sending'),
      lte(messengerOutbox.claimExpiresAt, new Date()),
    );
    const rows = await this.db
      .update(messengerOutbox)
      .set(
        idempotentSend
          ? { status: 'queued', claimedBy: null, claimExpiresAt: null }
          : {
              status: sql`case when ${messengerOutbox.kind} = 'mark_read' then 'queued' else 'uncertain' end`,
              claimedBy: null,
              claimExpiresAt: null,
              error: 'The worker stopped while sending; the message may or may not have been delivered.',
            },
      )
      .where(stale)
      .returning({ id: messengerOutbox.id });
    return rows.length;
  }

  /** Sent messages of the last 24 hours, for pacing. */
  async recentSends(accountId: string): Promise<{ sentAt: Date; newContact: boolean }[]> {
    const rows = await this.db
      .select({ sentAt: messengerOutbox.sentAt, newContact: messengerOutbox.newContact })
      .from(messengerOutbox)
      .where(
        and(
          eq(messengerOutbox.accountId, accountId),
          eq(messengerOutbox.kind, 'message'),
          eq(messengerOutbox.status, 'sent'),
          gt(messengerOutbox.sentAt, new Date(Date.now() - DAY)),
        ),
      );
    return rows.filter((r) => r.sentAt).map((r) => ({ sentAt: r.sentAt!, newContact: r.newContact }));
  }

  /** Waits until the job leaves the queue, or the timeout passes. */
  async waitFor(id: string, timeoutMs: number, signal?: AbortSignal): Promise<OutboxRow | undefined> {
    const deadline = Date.now() + timeoutMs;
    let row = await this.get(id);
    while (row && (row.status === 'queued' || row.status === 'sending') && Date.now() < deadline) {
      // Deferred past the deadline (flood wait, daily limit, paused account): no point in waiting.
      if (row.status === 'queued' && row.notBefore.getTime() > deadline) break;
      if (signal?.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
      row = await this.get(id);
    }
    return row;
  }

  /** Deletes finished jobs after `days` (payloads are encrypted, but there is no reason to keep them). */
  async prune(days = OUTBOX_RETENTION_DAYS): Promise<void> {
    await this.db
      .delete(messengerOutbox)
      .where(
        and(
          inArray(messengerOutbox.status, ['sent', 'failed', 'uncertain', 'cancelled']),
          lte(messengerOutbox.updatedAt, new Date(Date.now() - days * DAY)),
        ),
      );
  }

  private async finish(id: string, patch: Partial<typeof messengerOutbox.$inferInsert>): Promise<void> {
    await this.db
      .update(messengerOutbox)
      .set({ ...patch, claimedBy: null, claimExpiresAt: null })
      .where(eq(messengerOutbox.id, id));
  }
}
