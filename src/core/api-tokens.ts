import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { apiTokens } from '../db/schema.js';
import { generateToken, hashToken } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';

export type ApiTokenRow = typeof apiTokens.$inferSelect;

export interface ApiTokenView {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  aiClientId: string | null;
  personaId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export function toApiTokenView(row: ApiTokenRow): ApiTokenView {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scopes: row.scopes,
    aiClientId: row.aiClientId,
    personaId: row.personaId,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

/**
 * What a token may be used for: `mcp` (the AI's tools at `/mcp`) and `api` (the management REST API:
 * accounts, rules, security settings, other tokens). A token is MCP-only unless `api` is asked for:
 * a token pasted into an AI app's config must not let that app change its own rules.
 */
export const TOKEN_SCOPES = ['mcp', 'api'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export const DEFAULT_TOKEN_SCOPES: TokenScope[] = ['mcp'];

/** Far-future expiry reported for non-expiring tokens (bearer verification requires an expiry). */
const NO_EXPIRY = new Date('2100-01-01T00:00:00Z');

/**
 * Personal access tokens (`ac_pat_...`): for MCP clients that support static headers
 * (Claude Code, Cursor, scripts) and for the REST API / CLI.
 */
export class ApiTokenService {
  constructor(private readonly db: Db) {}

  async create(input: {
    workspaceId: string;
    userId: string;
    name: string;
    expiresInDays?: number;
    /** Default: MCP only (`DEFAULT_TOKEN_SCOPES`). */
    scopes?: TokenScope[];
    /** The AI client this token acts as (policies apply to it). */
    aiClientId?: string;
    /** Bind the token to a persona's MCP URL. */
    personaId?: string;
  }): Promise<{ token: string; row: ApiTokenRow }> {
    const scopes = [...new Set(input.scopes?.length ? input.scopes : DEFAULT_TOKEN_SCOPES)];
    // A profile narrows what the AI sees; the management API would see (and change) everything.
    if (input.personaId && scopes.includes('api')) {
      throw badRequest('A token bound to an access profile can only use MCP (scope "mcp")');
    }
    const token = generateToken('ac_pat');
    const [row] = await this.db
      .insert(apiTokens)
      .values({
        id: newId('pat'),
        workspaceId: input.workspaceId,
        userId: input.userId,
        name: input.name,
        tokenHash: hashToken(token),
        tokenPrefix: `${token.slice(0, 11)}…`,
        scopes,
        aiClientId: input.aiClientId ?? null,
        personaId: input.personaId ?? null,
        expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
      })
      .returning();
    return { token, row: row! };
  }

  async list(workspaceId: string): Promise<ApiTokenRow[]> {
    return this.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.workspaceId, workspaceId), isNull(apiTokens.revokedAt)))
      .orderBy(desc(apiTokens.createdAt));
  }

  async revoke(workspaceId: string, id: string): Promise<void> {
    const rows = await this.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.workspaceId, workspaceId), eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id });
    if (rows.length === 0) throw notFound('Token');
  }

  async verify(token: string): Promise<(ApiTokenRow & { effectiveExpiresAt: Date }) | undefined> {
    if (!token.startsWith('ac_pat_')) return undefined;
    const [row] = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, hashToken(token)))
      .limit(1);
    if (!row || row.revokedAt) return undefined;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return undefined;
    if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 5 * 60_000) {
      await this.db
        .update(apiTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiTokens.id, row.id))
        .catch(() => {});
    }
    return { ...row, effectiveExpiresAt: row.expiresAt ?? NO_EXPIRY };
  }
}
