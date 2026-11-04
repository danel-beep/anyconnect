import { createHash } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Principal } from '../core/principal.js';
import type { Db } from '../db/client.js';
import {
  type PendingCallPrincipal,
  type PendingCallStatus,
  pendingCalls,
  type RiskLevel,
} from '../db/schema.js';
import type { SecretBox } from '../lib/crypto.js';
import { notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';

export type PendingCallRow = typeof pendingCalls.$inferSelect;

/** The stored outcome of a held-back call, in the hub's result shape. */
export interface StoredResult {
  content: { type: string; [key: string]: unknown }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface PendingCallInput {
  principal: Principal;
  toolName: string;
  connectorId: string;
  action: string;
  accountId: string;
  risk: RiskLevel;
  reason?: string | undefined;
  args: Record<string, unknown>;
  channels: string[];
  /** Applied once the call is approved (or right away for calls that need no confirmation). */
  undoWindowSeconds: number;
}

const FINAL: PendingCallStatus[] = ['succeeded', 'failed', 'denied', 'cancelled', 'expired'];
const DAY = 86_400_000;

/** Stable hash of tool arguments (key order does not matter). */
export function argumentsHash(toolName: string, accountId: string, args: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify([toolName, accountId, canonical(args)]))
    .digest('base64url');
}

function snapshot(principal: Principal): PendingCallPrincipal {
  return {
    kind: principal.kind,
    userId: principal.userId,
    scopes: principal.scopes,
    ...(principal.clientId ? { clientId: principal.clientId } : {}),
    ...(principal.credentialId ? { credentialId: principal.credentialId } : {}),
    ...(principal.aiClientId ? { aiClientId: principal.aiClientId } : {}),
    ...(principal.personaId ? { personaId: principal.personaId } : {}),
  };
}

/** Rebuilds the caller of a pending call, to execute it later exactly as they would have. */
export function principalOf(row: PendingCallRow): Principal {
  return { ...row.principal, workspaceId: row.workspaceId };
}

/**
 * Calls the hub holds back: waiting for the user's confirmation, or approved and waiting for the
 * end of their undo window. Arguments and results are encrypted (AAD = the call id) and the rows
 * are deleted a day after they finish.
 *
 * Every state change is a single conditional UPDATE, so concurrent deciders (Telegram, the web
 * page, the chat) and several hub instances cannot run a call twice.
 */
export class PendingCallService {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
    private readonly options: { confirmationTtlMs: number },
  ) {}

  private encryptArgs(id: string, args: unknown): string {
    return this.secrets.encryptJson(args, `pending:${id}:args`);
  }

  args(row: PendingCallRow): Record<string, unknown> {
    return this.secrets.decryptJson(row.argsEncrypted, `pending:${row.id}:args`);
  }

  result(row: PendingCallRow): StoredResult | undefined {
    return row.resultEncrypted
      ? this.secrets.decryptJson<StoredResult>(row.resultEncrypted, `pending:${row.id}:result`)
      : undefined;
  }

  private async insert(
    input: PendingCallInput,
    status: PendingCallStatus,
    executeAt: Date | null,
  ): Promise<PendingCallRow> {
    const id = newId('pcl');
    const [row] = await this.db
      .insert(pendingCalls)
      .values({
        id,
        workspaceId: input.principal.workspaceId,
        principal: snapshot(input.principal),
        toolName: input.toolName,
        connectorId: input.connectorId,
        action: input.action,
        accountId: input.accountId,
        risk: input.risk,
        reason: input.reason?.slice(0, 500) ?? null,
        argsEncrypted: this.encryptArgs(id, input.args),
        argsHash: argumentsHash(input.toolName, input.accountId, input.args),
        status,
        channels: input.channels,
        undoWindowSeconds: input.undoWindowSeconds,
        executeAt,
        expiresAt: new Date(Date.now() + this.options.confirmationTtlMs),
      })
      .returning();
    return row!;
  }

  /** A call that must be confirmed by the user before anything happens. */
  requestConfirmation(input: PendingCallInput): Promise<PendingCallRow> {
    return this.insert(input, 'awaiting_confirmation', null);
  }

  /** An allowed call that runs after its undo window unless cancelled. */
  schedule(input: PendingCallInput): Promise<PendingCallRow> {
    return this.insert(input, 'scheduled', new Date(Date.now() + input.undoWindowSeconds * 1000));
  }

  /** The hash a call with this input is stored under (to match a retry to its held-back call). */
  hashOf(input: Pick<PendingCallInput, 'toolName' | 'accountId' | 'args'>): string {
    return argumentsHash(input.toolName, input.accountId, input.args);
  }

  async get(id: string): Promise<PendingCallRow | undefined> {
    const [row] = await this.db.select().from(pendingCalls).where(eq(pendingCalls.id, id)).limit(1);
    return row;
  }

  async getInWorkspace(workspaceId: string, id: string): Promise<PendingCallRow> {
    const row = await this.get(id);
    if (!row || row.workspaceId !== workspaceId) throw notFound('Pending call');
    return row;
  }

  /**
   * Whether `principal` may see this call: the same AI client (or, for callers without one, the
   * same credential). Another app must not read results it was never allowed to request.
   */
  belongsTo(row: PendingCallRow, principal: Principal): boolean {
    if (row.workspaceId !== principal.workspaceId) return false;
    if (principal.kind === 'session') return true;
    if (row.principal.aiClientId || principal.aiClientId)
      return row.principal.aiClientId === principal.aiClientId;
    return row.principal.credentialId === principal.credentialId;
  }

  /**
   * The latest not yet consumed call of this caller with exactly these arguments, so repeating a
   * held-back call returns its status or result instead of asking the user again.
   */
  async findRepeat(principal: Principal, toolName: string, accountId: string, args: unknown) {
    const rows = await this.db
      .select()
      .from(pendingCalls)
      .where(
        and(
          eq(pendingCalls.workspaceId, principal.workspaceId),
          eq(pendingCalls.argsHash, argumentsHash(toolName, accountId, args)),
          isNull(pendingCalls.consumedAt),
          gt(pendingCalls.createdAt, new Date(Date.now() - this.options.confirmationTtlMs)),
        ),
      )
      .orderBy(desc(pendingCalls.createdAt))
      .limit(5);
    return rows.find((row) => this.belongsTo(row, principal));
  }

  /** Marks the final result as delivered to the caller. */
  async consume(id: string): Promise<void> {
    await this.db
      .update(pendingCalls)
      .set({ consumedAt: new Date() })
      .where(and(eq(pendingCalls.id, id), isNull(pendingCalls.consumedAt)));
  }

  isFinal(row: PendingCallRow): boolean {
    return FINAL.includes(row.status);
  }

  async listOpen(workspaceId: string): Promise<PendingCallRow[]> {
    return this.db
      .select()
      .from(pendingCalls)
      .where(
        and(
          eq(pendingCalls.workspaceId, workspaceId),
          inArray(pendingCalls.status, ['awaiting_confirmation', 'scheduled']),
        ),
      )
      .orderBy(pendingCalls.createdAt);
  }

  /**
   * The user's answer. Approval moves the call to `scheduled` (running at once, or after the undo
   * window); a refusal ends it. Returns undefined when the call was already decided or expired.
   */
  async decide(id: string, approve: boolean, via: string): Promise<PendingCallRow | undefined> {
    const now = new Date();
    const [row] = await this.db
      .update(pendingCalls)
      .set(
        approve
          ? {
              status: 'scheduled',
              decidedVia: via,
              decidedAt: now,
              executeAt: sql`now() + make_interval(secs => ${pendingCalls.undoWindowSeconds})`,
            }
          : { status: 'denied', decidedVia: via, decidedAt: now },
      )
      .where(
        and(
          eq(pendingCalls.id, id),
          eq(pendingCalls.status, 'awaiting_confirmation'),
          sql`${pendingCalls.expiresAt} > now()`,
        ),
      )
      .returning();
    return row;
  }

  /** Approves and immediately claims the call for the caller to run inline (chat confirmation). */
  async approveAndClaim(id: string, via: string): Promise<PendingCallRow | undefined> {
    const now = new Date();
    const [row] = await this.db
      .update(pendingCalls)
      .set({ status: 'running', decidedVia: via, decidedAt: now, executeAt: now })
      .where(
        and(
          eq(pendingCalls.id, id),
          eq(pendingCalls.status, 'awaiting_confirmation'),
          sql`${pendingCalls.expiresAt} > now()`,
        ),
      )
      .returning();
    return row;
  }

  /** Undo: stops a call that has not started yet (awaiting confirmation or in its undo window). */
  async cancel(id: string, via: string): Promise<PendingCallRow | undefined> {
    const [row] = await this.db
      .update(pendingCalls)
      .set({ status: 'cancelled', decidedVia: via, decidedAt: new Date() })
      .where(
        and(eq(pendingCalls.id, id), inArray(pendingCalls.status, ['awaiting_confirmation', 'scheduled'])),
      )
      .returning();
    return row;
  }

  /** Claims due calls for execution (multi-instance safe). */
  async claimDue(limit = 10): Promise<PendingCallRow[]> {
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE ${pendingCalls} SET status = 'running', updated_at = now()
      WHERE id IN (
        SELECT id FROM ${pendingCalls}
        WHERE status = 'scheduled' AND execute_at <= now()
        ORDER BY execute_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      RETURNING id`);
    const ids = result.rows.map((r) => r.id);
    if (ids.length === 0) return [];
    return this.db.select().from(pendingCalls).where(inArray(pendingCalls.id, ids));
  }

  async complete(id: string, result: StoredResult): Promise<PendingCallRow | undefined> {
    const [row] = await this.db
      .update(pendingCalls)
      .set({
        status: result.isError ? 'failed' : 'succeeded',
        resultEncrypted: this.secrets.encryptJson(result, `pending:${id}:result`),
      })
      .where(and(eq(pendingCalls.id, id), eq(pendingCalls.status, 'running')))
      .returning();
    return row;
  }

  async setTelegramMessage(id: string, message: { chatId: string; messageId: number }): Promise<void> {
    await this.db.update(pendingCalls).set({ telegramMessage: message }).where(eq(pendingCalls.id, id));
  }

  /** Waits until the call leaves `awaiting_confirmation`/`scheduled`/`running`, or the timeout. */
  async waitForOutcome(
    id: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<PendingCallRow | undefined> {
    const deadline = Date.now() + timeoutMs;
    let row = await this.get(id);
    while (row && !FINAL.includes(row.status) && Date.now() < deadline && !signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      row = await this.get(id);
    }
    return row;
  }

  /** Expires unanswered confirmations, recovers calls stuck in `running`, deletes old rows. */
  async maintain(): Promise<void> {
    const now = Date.now();
    await this.db
      .update(pendingCalls)
      .set({ status: 'expired' })
      .where(
        and(eq(pendingCalls.status, 'awaiting_confirmation'), lt(pendingCalls.expiresAt, new Date(now))),
      );
    // A crash while running leaves the outcome unknown: never retry automatically (it may have
    // been sent already), report it as failed instead.
    await this.db
      .update(pendingCalls)
      .set({
        status: 'failed',
        resultEncrypted: null,
      })
      .where(
        and(eq(pendingCalls.status, 'running'), lt(pendingCalls.updatedAt, new Date(now - 15 * 60_000))),
      );
    await this.db
      .delete(pendingCalls)
      .where(and(inArray(pendingCalls.status, FINAL), lt(pendingCalls.updatedAt, new Date(now - DAY))));
  }
}
