import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  type TriggerEventStatus,
  type TriggerPause,
  type TriggerSource,
  triggerCursors,
  triggerEvents,
  triggers,
} from '../db/schema.js';
import { Semaphore } from '../lib/concurrency.js';
import { hmac, type SecretBox } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { CipherSource } from '../messaging/ciphers.js';
import { utcDayStart } from './match.js';
import { type TriggerItem, type TriggerSpec, TriggerSpec as TriggerSpecSchema } from './spec.js';

export type TriggerRow = typeof triggers.$inferSelect;

export interface Trigger {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  enabled: boolean;
  source: TriggerSource;
  connectorId: string | null;
  accountIds: string[];
  aiKeyId: string | null;
  spec: TriggerSpec;
  dailyRuns: number | null;
  pausedReason: TriggerPause | null;
  pausedAt: Date | null;
  lastEventAt: Date | null;
  createdAt: Date;
}

export interface TriggerInput {
  name: string;
  source: TriggerSource;
  connectorId: string | null;
  accountIds: string[];
  spec: TriggerSpec;
  dailyRuns: number | null;
  aiKeyId: string | null;
}

/** What came of an event, shown to the user (never the content of tool results). */
export interface EventResult {
  summary?: string;
  calls?: Array<{ tool: string; ok: boolean }>;
  error?: string;
  /** Why it was skipped: the daily limit, the AI key's limit, or loop protection. */
  skipped?: 'limit' | 'ai_limit' | 'loop' | 'paused' | 'no_key';
}

export interface TriggerEvent {
  id: string;
  seq: number;
  triggerId: string;
  workspaceId: string;
  accountId: string;
  status: TriggerEventStatus;
  /** Undefined when the account's key cannot be opened here (a sealed account outside its vault). */
  item?: TriggerItem;
  result: EventResult;
  tokens: number | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/** Statuses of events that ran (or were handed over): what the daily limit counts. */
const COUNTED: TriggerEventStatus[] = [
  'new',
  'delivered',
  'running',
  'done',
  'awaiting_confirmation',
  'failed',
];
const MAX_TRIGGERS = 50;
const RETENTION_DAYS = 30;
const specContext = (id: string) => `trigger:${id}`;
const eventContext = (id: string) => `trigger:event:${id}`;

/**
 * Triggers and their event feed in the database. Definitions are encrypted with the master key
 * (the engine reads them in the background); event content with the account's own data key, so
 * deleting the account crypto-shreds it. Item ids and the other side are stored only as keyed
 * hashes, enough to never handle one item twice and to notice a loop.
 */
export class TriggerStore {
  private readonly hashKey: Buffer;

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
    private readonly ciphers: CipherSource,
    /**
     * How many scans may hold their lock at once (see {@link exclusive}): each keeps a database
     * connection for the lock while its queries use others, so it must stay well below the pool.
     */
    private readonly scanSlots = new Semaphore(2),
  ) {
    this.hashKey = secrets.deriveKey('trigger-keys');
  }

  /** Keyed hash of a source item or a counterpart (never the value itself). */
  hash(value: string): string {
    return hmac(this.hashKey, value);
  }

  // --- Triggers ----------------------------------------------------------------

  async list(workspaceId: string): Promise<Trigger[]> {
    const rows = await this.db
      .select()
      .from(triggers)
      .where(eq(triggers.workspaceId, workspaceId))
      .orderBy(asc(triggers.createdAt));
    return rows.map((r) => this.toTrigger(r));
  }

  async get(workspaceId: string, id: string): Promise<Trigger> {
    const [row] = await this.db
      .select()
      .from(triggers)
      .where(and(eq(triggers.workspaceId, workspaceId), eq(triggers.id, id)))
      .limit(1);
    if (!row) throw notFound('Trigger');
    return this.toTrigger(row);
  }

  /** By id or name (any case), for the chat tools. */
  async find(workspaceId: string, ref: string): Promise<Trigger> {
    const needle = ref.trim().toLowerCase();
    const all = await this.list(workspaceId);
    const found = all.find((t) => t.id === ref.trim()) ?? all.find((t) => t.name.toLowerCase() === needle);
    if (!found) throw notFound(`Trigger "${ref}"`);
    return found;
  }

  async create(workspaceId: string, userId: string, input: TriggerInput): Promise<Trigger> {
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(triggers)
      .where(eq(triggers.workspaceId, workspaceId));
    if (n >= MAX_TRIGGERS) throw badRequest(`At most ${MAX_TRIGGERS} triggers`);
    const spec = TriggerSpecSchema.parse(input.spec);
    const id = newId('trg');
    const [row] = await this.db
      .insert(triggers)
      .values({
        id,
        workspaceId,
        userId,
        name: input.name.trim().slice(0, 80),
        source: input.source,
        connectorId: input.connectorId,
        accountIds: input.accountIds,
        actionKind: spec.action.kind,
        aiKeyId: spec.action.kind === 'ai' ? input.aiKeyId : null,
        specEncrypted: this.secrets.encryptJson(spec, specContext(id)),
        dailyRuns: input.dailyRuns,
      })
      .returning();
    return this.toTrigger(row!);
  }

  async update(
    workspaceId: string,
    id: string,
    patch: Partial<
      Pick<TriggerInput, 'name' | 'spec' | 'dailyRuns' | 'aiKeyId' | 'accountIds' | 'connectorId'>
    > & {
      enabled?: boolean;
    },
  ): Promise<Trigger> {
    const current = await this.get(workspaceId, id);
    const spec = patch.spec ? TriggerSpecSchema.parse(patch.spec) : current.spec;
    const [row] = await this.db
      .update(triggers)
      .set({
        ...(patch.name?.trim() ? { name: patch.name.trim().slice(0, 80) } : {}),
        ...(patch.spec
          ? { specEncrypted: this.secrets.encryptJson(spec, specContext(id)), actionKind: spec.action.kind }
          : {}),
        ...(patch.dailyRuns !== undefined ? { dailyRuns: patch.dailyRuns } : {}),
        ...(patch.accountIds ? { accountIds: patch.accountIds } : {}),
        ...(patch.connectorId !== undefined ? { connectorId: patch.connectorId } : {}),
        ...(patch.aiKeyId !== undefined || patch.spec
          ? { aiKeyId: spec.action.kind === 'ai' ? (patch.aiKeyId ?? current.aiKeyId) : null }
          : {}),
        // Turning a trigger on (or raising its limit) lifts a pause it put itself in.
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.enabled || patch.dailyRuns !== undefined ? { pausedReason: null, pausedAt: null } : {}),
      })
      .where(and(eq(triggers.workspaceId, workspaceId), eq(triggers.id, id)))
      .returning();
    return this.toTrigger(row!);
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    const rows = await this.db
      .delete(triggers)
      .where(and(eq(triggers.workspaceId, workspaceId), eq(triggers.id, id)))
      .returning({ id: triggers.id });
    if (!rows.length) throw notFound('Trigger');
  }

  /** Stops a trigger on its own (daily limit reached). True when it was running until now. */
  async pause(id: string, reason: TriggerPause): Promise<boolean> {
    const rows = await this.db
      .update(triggers)
      .set({ pausedReason: reason, pausedAt: new Date() })
      .where(and(eq(triggers.id, id), isNull(triggers.pausedReason)))
      .returning({ id: triggers.id });
    return rows.length > 0;
  }

  /** Enabled, not paused triggers of a source; optionally of one workspace. */
  async active(source: TriggerSource, workspaceId?: string): Promise<Trigger[]> {
    const rows = await this.db
      .select()
      .from(triggers)
      .where(
        and(
          eq(triggers.source, source),
          eq(triggers.enabled, true),
          isNull(triggers.pausedReason),
          ...(workspaceId ? [eq(triggers.workspaceId, workspaceId)] : []),
        ),
      );
    return rows.map((r) => this.toTrigger(r));
  }

  // --- Cursors -----------------------------------------------------------------

  async cursor(triggerId: string, accountId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ cursor: triggerCursors.cursor })
      .from(triggerCursors)
      .where(and(eq(triggerCursors.triggerId, triggerId), eq(triggerCursors.accountId, accountId)))
      .limit(1);
    return row?.cursor;
  }

  async setCursor(triggerId: string, accountId: string, cursor: string): Promise<void> {
    await this.db
      .insert(triggerCursors)
      .values({ triggerId, accountId, cursor })
      .onConflictDoUpdate({ target: [triggerCursors.triggerId, triggerCursors.accountId], set: { cursor } });
  }

  /**
   * Runs `fn` while holding a lock on one trigger × account, so two processes woken by the same
   * message never scan it at the same time (the unique event key also makes a second scan harmless).
   * False when another process holds it.
   */
  async exclusive(triggerId: string, accountId: string, fn: () => Promise<void>): Promise<boolean> {
    // The lock lives in a transaction, which keeps one connection while `fn` runs its queries on
    // others. Many accounts getting a message in the same moment would otherwise take every
    // connection for their locks and wait for one more that never frees up.
    return this.scanSlots.run(() =>
      this.db.transaction(async (tx) => {
        const lock = await tx.execute<{ ok: boolean }>(
          sql`select pg_try_advisory_xact_lock(hashtext(${`trigger:${triggerId}:${accountId}`})) as ok`,
        );
        if (!lock.rows[0]?.ok) return false;
        await fn();
        return true;
      }),
    );
  }

  // --- Events ------------------------------------------------------------------

  /** Records a matched event; undefined when this item was already recorded for the trigger. */
  async recordEvent(input: {
    trigger: Trigger;
    accountId: string;
    item: TriggerItem;
    eventKey: string;
    counterpartKey: string;
    status: TriggerEventStatus;
    result?: EventResult;
    aiKeyId?: string | null;
  }): Promise<TriggerEvent | undefined> {
    const id = newId('tev');
    const cipher = await this.ciphers.forAccount(input.accountId);
    const result = input.result ?? {};
    const [row] = await this.db
      .insert(triggerEvents)
      .values({
        id,
        triggerId: input.trigger.id,
        workspaceId: input.trigger.workspaceId,
        accountId: input.accountId,
        eventKey: input.eventKey,
        counterpartKey: input.counterpartKey,
        status: input.status,
        bodyEncrypted: cipher.encryptJson({ item: input.item, result }, eventContext(id)),
        aiKeyId: input.aiKeyId ?? null,
        ...(input.status === 'skipped' ? { finishedAt: new Date() } : {}),
      })
      .onConflictDoNothing({ target: [triggerEvents.triggerId, triggerEvents.eventKey] })
      .returning();
    if (!row) return undefined;
    await this.db.update(triggers).set({ lastEventAt: new Date() }).where(eq(triggers.id, input.trigger.id));
    return { ...this.eventMeta(row), item: input.item, result };
  }

  async getEvent(id: string): Promise<TriggerEvent | undefined> {
    const [row] = await this.db.select().from(triggerEvents).where(eq(triggerEvents.id, id)).limit(1);
    return row ? this.readEvent(row) : undefined;
  }

  /** Moves an event on; `from` guards against two runners taking the same one. */
  async setStatus(
    id: string,
    status: TriggerEventStatus,
    extra: { from?: TriggerEventStatus; result?: EventResult; tokens?: number } = {},
  ): Promise<boolean> {
    const [current] = await this.db.select().from(triggerEvents).where(eq(triggerEvents.id, id)).limit(1);
    if (!current) return false;
    let bodyEncrypted: string | undefined;
    if (extra.result) {
      const cipher = await this.ciphers.forAccount(current.accountId);
      const body = cipher.decryptJson<{ item: TriggerItem; result: EventResult }>(
        current.bodyEncrypted,
        eventContext(id),
      );
      bodyEncrypted = cipher.encryptJson({ item: body.item, result: extra.result }, eventContext(id));
    }
    const final = status !== 'running' && status !== 'new';
    const rows = await this.db
      .update(triggerEvents)
      .set({
        status,
        ...(bodyEncrypted ? { bodyEncrypted } : {}),
        ...(extra.tokens !== undefined ? { tokens: extra.tokens } : {}),
        ...(final ? { finishedAt: new Date() } : {}),
      })
      .where(and(eq(triggerEvents.id, id), ...(extra.from ? [eq(triggerEvents.status, extra.from)] : [])))
      .returning({ id: triggerEvents.id });
    return rows.length > 0;
  }

  /** Events of the trigger that count against its daily limit (UTC day). */
  async runsToday(triggerId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(triggerEvents)
      .where(
        and(
          eq(triggerEvents.triggerId, triggerId),
          gte(triggerEvents.createdAt, utcDayStart()),
          inArray(triggerEvents.status, COUNTED),
        ),
      );
    return Number(row?.n ?? 0);
  }

  async runsTodayByTrigger(workspaceId: string): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ id: triggerEvents.triggerId, n: sql<number>`count(*)::int` })
      .from(triggerEvents)
      .where(
        and(
          eq(triggerEvents.workspaceId, workspaceId),
          gte(triggerEvents.createdAt, utcDayStart()),
          inArray(triggerEvents.status, COUNTED),
        ),
      )
      .groupBy(triggerEvents.triggerId);
    return new Map(rows.map((r) => [r.id, Number(r.n)]));
  }

  /** Runs of an AI key skipped today because it reached its limit. */
  async skippedToday(aiKeyId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(triggerEvents)
      .where(
        and(
          eq(triggerEvents.aiKeyId, aiKeyId),
          eq(triggerEvents.status, 'skipped'),
          gte(triggerEvents.createdAt, utcDayStart()),
        ),
      );
    return Number(row?.n ?? 0);
  }

  /** Events of the trigger from one other side since a moment (loop protection). */
  async recentFrom(triggerId: string, counterpartKey: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(triggerEvents)
      .where(
        and(
          eq(triggerEvents.triggerId, triggerId),
          eq(triggerEvents.counterpartKey, counterpartKey),
          gte(triggerEvents.createdAt, since),
          ne(triggerEvents.status, 'skipped'),
        ),
      );
    return Number(row?.n ?? 0);
  }

  /** The latest events of a workspace, newest first, optionally of one trigger. */
  async events(
    workspaceId: string,
    options: { limit?: number; triggerId?: string } = {},
  ): Promise<TriggerEvent[]> {
    const rows = await this.db
      .select()
      .from(triggerEvents)
      .where(
        and(
          eq(triggerEvents.workspaceId, workspaceId),
          ...(options.triggerId ? [eq(triggerEvents.triggerId, options.triggerId)] : []),
        ),
      )
      .orderBy(desc(triggerEvents.seq))
      .limit(Math.min(options.limit ?? 20, 100));
    return Promise.all(rows.map((r) => this.readEvent(r)));
  }

  /**
   * Hands the waiting "anything new?" events to the AI that checks and marks them delivered, oldest
   * first. One conditional UPDATE, so two checks at the same moment never get the same event.
   */
  async takeNew(
    workspaceId: string,
    options: { triggerIds?: string[]; limit: number },
  ): Promise<{ events: TriggerEvent[]; more: boolean }> {
    const waiting = await this.db
      .select({ seq: triggerEvents.seq })
      .from(triggerEvents)
      .where(
        and(
          eq(triggerEvents.workspaceId, workspaceId),
          eq(triggerEvents.status, 'new'),
          ...(options.triggerIds ? [inArray(triggerEvents.triggerId, options.triggerIds)] : []),
        ),
      )
      .orderBy(asc(triggerEvents.seq))
      .limit(options.limit + 1);
    if (!waiting.length) return { events: [], more: false };
    const take = waiting.slice(0, options.limit).map((w) => w.seq);
    const rows = await this.db
      .update(triggerEvents)
      .set({ status: 'delivered', finishedAt: new Date() })
      .where(and(inArray(triggerEvents.seq, take), eq(triggerEvents.status, 'new')))
      .returning();
    rows.sort((a, b) => a.seq - b.seq);
    return {
      events: await Promise.all(rows.map((r) => this.readEvent(r))),
      more: waiting.length > options.limit,
    };
  }

  /** How many "anything new?" events wait, without taking them. */
  async countNew(workspaceId: string, triggerIds?: string[]): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(triggerEvents)
      .where(
        and(
          eq(triggerEvents.workspaceId, workspaceId),
          eq(triggerEvents.status, 'new'),
          ...(triggerIds ? [inArray(triggerEvents.triggerId, triggerIds)] : []),
        ),
      );
    return Number(row?.n ?? 0);
  }

  /**
   * Takes a `running` event for its one run. False when a runner already took it (a job retried
   * after its process stopped, the same job delivered twice): the action must not run again.
   */
  async claim(id: string): Promise<boolean> {
    const rows = await this.db
      .update(triggerEvents)
      .set({ startedAt: new Date() })
      .where(
        and(eq(triggerEvents.id, id), eq(triggerEvents.status, 'running'), isNull(triggerEvents.startedAt)),
      )
      .returning({ id: triggerEvents.id });
    return rows.length > 0;
  }

  /** Gives a taken event back untouched (its run stopped before it did anything), for another try. */
  async release(id: string): Promise<void> {
    await this.db
      .update(triggerEvents)
      .set({ startedAt: null })
      .where(and(eq(triggerEvents.id, id), eq(triggerEvents.status, 'running')));
  }

  /** Runs taken before `startedBefore` and still not over: their process stopped. */
  async interrupted(startedBefore: Date): Promise<string[]> {
    const rows = await this.db
      .select({ id: triggerEvents.id })
      .from(triggerEvents)
      .where(and(eq(triggerEvents.status, 'running'), lt(triggerEvents.startedAt, startedBefore)))
      .limit(200);
    return rows.map((r) => r.id);
  }

  /** Runs recorded before `createdBefore` that no runner has taken yet, oldest first. */
  async waiting(createdBefore: Date): Promise<Array<{ id: string; workspaceId: string; createdAt: Date }>> {
    return this.db
      .select({
        id: triggerEvents.id,
        workspaceId: triggerEvents.workspaceId,
        createdAt: triggerEvents.createdAt,
      })
      .from(triggerEvents)
      .where(
        and(
          eq(triggerEvents.status, 'running'),
          isNull(triggerEvents.startedAt),
          lt(triggerEvents.createdAt, createdBefore),
        ),
      )
      .orderBy(asc(triggerEvents.createdAt))
      .limit(200);
  }

  /** Deletes events older than the retention, and delivered "anything new?" events after a day. */
  async prune(): Promise<void> {
    const now = Date.now();
    await this.db
      .delete(triggerEvents)
      .where(
        or(
          lt(triggerEvents.createdAt, new Date(now - RETENTION_DAYS * 86_400_000)),
          and(
            eq(triggerEvents.status, 'skipped'),
            lt(triggerEvents.createdAt, new Date(now - 7 * 86_400_000)),
          ),
        ),
      );
  }

  // --- Helpers -------------------------------------------------------------------

  private toTrigger(row: TriggerRow): Trigger {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      name: row.name,
      enabled: row.enabled,
      source: row.source,
      connectorId: row.connectorId,
      accountIds: row.accountIds,
      aiKeyId: row.aiKeyId,
      spec: this.secrets.decryptJson<TriggerSpec>(row.specEncrypted, specContext(row.id)),
      dailyRuns: row.dailyRuns,
      pausedReason: row.pausedReason,
      pausedAt: row.pausedAt,
      lastEventAt: row.lastEventAt,
      createdAt: row.createdAt,
    };
  }

  private eventMeta(row: typeof triggerEvents.$inferSelect): Omit<TriggerEvent, 'item' | 'result'> {
    return {
      id: row.id,
      seq: row.seq,
      triggerId: row.triggerId,
      workspaceId: row.workspaceId,
      accountId: row.accountId,
      status: row.status,
      tokens: row.tokens,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
    };
  }

  private async readEvent(row: typeof triggerEvents.$inferSelect): Promise<TriggerEvent> {
    try {
      const cipher = await this.ciphers.forAccount(row.accountId);
      const body = cipher.decryptJson<{ item: TriggerItem; result: EventResult }>(
        row.bodyEncrypted,
        eventContext(row.id),
      );
      return { ...this.eventMeta(row), item: body.item, result: body.result ?? {} };
    } catch {
      // A sealed account outside its vault: the event is listed, its content stays closed.
      return { ...this.eventMeta(row), result: {} };
    }
  }
}
