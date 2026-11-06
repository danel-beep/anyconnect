import { and, asc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { type AiProviderId, aiKeys, triggerEvents } from '../db/schema.js';
import type { SecretBox } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { AI_PROVIDERS } from './ai/providers.js';
import { utcDayStart } from './match.js';
import { MAX_DAILY_RUNS } from './spec.js';

export type AiKeyRow = typeof aiKeys.$inferSelect;

/** An AI key as pages and tools see it: never the key itself. */
export interface AiKeyView {
  id: string;
  provider: AiProviderId;
  providerName: string;
  label: string;
  model: string;
  keyHint: string;
  /** Null: no limit. */
  dailyRuns: number | null;
  runsToday: number;
  tokensToday: number;
  lastUsedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

export interface AiKeyInput {
  provider: AiProviderId;
  label?: string | undefined;
  model?: string | undefined;
  key: string;
  dailyRuns: number | null;
}

const MAX_KEYS = 10;
const context = (id: string) => `aikey:${id}`;

/**
 * The user's own AI API keys (`/app/ai`): triggers wake the AI with them, so the hub spends nothing
 * on models and the user pays their provider directly. Keys are encrypted with the master key
 * (they must work in the background, when no browser or AI app is there to open a vault), are never
 * shown again after saving, and each has a daily run limit the user picks.
 */
export class AiKeyStore {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
  ) {}

  async list(workspaceId: string): Promise<AiKeyView[]> {
    const rows = await this.db
      .select()
      .from(aiKeys)
      .where(eq(aiKeys.workspaceId, workspaceId))
      .orderBy(asc(aiKeys.createdAt));
    const usage = await this.usageToday(rows.map((r) => r.id));
    return rows.map((row) => this.view(row, usage.get(row.id)));
  }

  async get(workspaceId: string, id: string): Promise<AiKeyView> {
    const row = await this.row(workspaceId, id);
    return this.view(row, (await this.usageToday([id])).get(id));
  }

  /** By id, label or provider name (any case), for the chat tools. */
  async find(workspaceId: string, ref: string): Promise<AiKeyView | undefined> {
    const needle = ref.trim().toLowerCase();
    const all = await this.list(workspaceId);
    return (
      all.find((k) => k.id === ref) ??
      all.find((k) => k.label.toLowerCase() === needle) ??
      all.find((k) => k.provider === needle || k.providerName.toLowerCase() === needle)
    );
  }

  async create(workspaceId: string, input: AiKeyInput): Promise<AiKeyView> {
    const provider = AI_PROVIDERS[input.provider];
    if (!provider) throw badRequest('Unknown AI provider');
    const key = input.key.trim();
    if (key.length < 16 || key.length > 500 || /\s/.test(key))
      throw badRequest('This does not look like an API key');
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(aiKeys)
      .where(eq(aiKeys.workspaceId, workspaceId));
    if (n >= MAX_KEYS) throw badRequest(`At most ${MAX_KEYS} AI keys`);
    const id = newId('aik');
    const [row] = await this.db
      .insert(aiKeys)
      .values({
        id,
        workspaceId,
        provider: provider.id,
        label: input.label?.trim().slice(0, 60) || provider.name,
        model: input.model?.trim().slice(0, 100) || provider.defaultModel,
        keyEncrypted: this.secrets.encrypt(key, context(id)),
        keyHint: key.slice(-4),
        dailyRuns: clampRuns(input.dailyRuns),
      })
      .returning();
    return this.view(row!, undefined);
  }

  async update(
    workspaceId: string,
    id: string,
    patch: { label?: string; model?: string; dailyRuns?: number | null },
  ): Promise<AiKeyView> {
    await this.row(workspaceId, id);
    await this.db
      .update(aiKeys)
      .set({
        ...(patch.label?.trim() ? { label: patch.label.trim().slice(0, 60) } : {}),
        ...(patch.model?.trim() ? { model: patch.model.trim().slice(0, 100) } : {}),
        ...(patch.dailyRuns !== undefined ? { dailyRuns: clampRuns(patch.dailyRuns) } : {}),
      })
      .where(and(eq(aiKeys.workspaceId, workspaceId), eq(aiKeys.id, id)));
    return this.get(workspaceId, id);
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    const rows = await this.db
      .delete(aiKeys)
      .where(and(eq(aiKeys.workspaceId, workspaceId), eq(aiKeys.id, id)))
      .returning({ id: aiKeys.id });
    if (!rows.length) throw notFound('AI key');
  }

  /** The key for a run, with its row. Only the trigger engine calls this. */
  async open(id: string): Promise<{ row: AiKeyRow; key: string } | undefined> {
    const [row] = await this.db.select().from(aiKeys).where(eq(aiKeys.id, id)).limit(1);
    if (!row) return undefined;
    return { row, key: this.secrets.decrypt(row.keyEncrypted, context(id)) };
  }

  /** Runs today on the key (UTC day), against its limit. */
  async runsToday(id: string): Promise<number> {
    return (await this.usageToday([id])).get(id)?.runs ?? 0;
  }

  async recordUse(id: string, error: string | null): Promise<void> {
    await this.db
      .update(aiKeys)
      .set({ lastUsedAt: new Date(), lastError: error ? error.slice(0, 300) : null })
      .where(eq(aiKeys.id, id));
  }

  private async row(workspaceId: string, id: string): Promise<AiKeyRow> {
    const [row] = await this.db
      .select()
      .from(aiKeys)
      .where(and(eq(aiKeys.workspaceId, workspaceId), eq(aiKeys.id, id)))
      .limit(1);
    if (!row) throw notFound('AI key');
    return row;
  }

  private async usageToday(ids: string[]): Promise<Map<string, { runs: number; tokens: number }>> {
    const usage = new Map<string, { runs: number; tokens: number }>();
    if (!ids.length) return usage;
    const rows = await this.db
      .select({
        id: triggerEvents.aiKeyId,
        runs: sql<number>`count(*)::int`,
        tokens: sql<number>`coalesce(sum(${triggerEvents.tokens}), 0)::int`,
      })
      .from(triggerEvents)
      .where(
        and(
          inArray(triggerEvents.aiKeyId, ids),
          ne(triggerEvents.status, 'skipped'),
          gte(triggerEvents.createdAt, utcDayStart()),
        ),
      )
      .groupBy(triggerEvents.aiKeyId);
    for (const r of rows) if (r.id) usage.set(r.id, { runs: Number(r.runs), tokens: Number(r.tokens) });
    return usage;
  }

  private view(row: AiKeyRow, usage: { runs: number; tokens: number } | undefined): AiKeyView {
    return {
      id: row.id,
      provider: row.provider,
      providerName: AI_PROVIDERS[row.provider]?.name ?? row.provider,
      label: row.label,
      model: row.model,
      keyHint: row.keyHint,
      dailyRuns: row.dailyRuns,
      runsToday: usage?.runs ?? 0,
      tokensToday: usage?.tokens ?? 0,
      lastUsedAt: row.lastUsedAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
    };
  }
}

export function clampRuns(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) return null;
  return Math.max(1, Math.min(MAX_DAILY_RUNS, Math.round(value)));
}
