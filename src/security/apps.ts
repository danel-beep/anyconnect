import { and, desc, eq, isNotNull, isNull, max } from 'drizzle-orm';
import type { ApiTokenService } from '../core/api-tokens.js';
import type { Db } from '../db/client.js';
import { apiTokens, oauthGrants } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import type { AiClientRow, AiClientService } from './clients.js';

/** One live way an AI app reaches the workspace: an OAuth sign-in or a personal token. */
export interface AiAppConnection {
  id: string;
  kind: 'oauth' | 'token';
  /** The name the app gave at sign-in, or the token's name. */
  name: string;
  /** The access profile (persona) whose address it uses, if any. */
  personaId: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
}

/** An AI app (the subject of access rules) with its live connections. */
export interface AiApp {
  id: string;
  name: string;
  kind: AiClientRow['kind'];
  createdAt: Date;
  lastUsedAt: Date | null;
  connections: AiAppConnection[];
}

/**
 * AI apps as the user sees them: each app with the sign-ins and tokens it uses now. Renaming,
 * disconnecting (every sign-in and token at once) and forgetting an app that is no longer
 * connected, for the dashboard (`/app/apps/:id`) and the chat (`manyplug_apps` and friends).
 */
export class AiAppService {
  constructor(
    private readonly deps: {
      db: Db;
      clients: AiClientService;
      /** Revokes an OAuth grant with its tokens (`OAuthServer.revokeGrant`). */
      revokeGrant: (workspaceId: string, grantId: string) => Promise<boolean>;
      tokens: ApiTokenService;
    },
  ) {}

  private async liveConnections(workspaceId: string): Promise<Map<string, AiAppConnection[]>> {
    const { db } = this.deps;
    const now = Date.now();
    const [grants, tokens] = await Promise.all([
      db
        .select()
        .from(oauthGrants)
        .where(and(eq(oauthGrants.workspaceId, workspaceId), isNull(oauthGrants.revokedAt)))
        .orderBy(desc(oauthGrants.createdAt)),
      db
        .select()
        .from(apiTokens)
        .where(and(eq(apiTokens.workspaceId, workspaceId), isNull(apiTokens.revokedAt)))
        .orderBy(desc(apiTokens.createdAt)),
    ]);
    const byApp = new Map<string, AiAppConnection[]>();
    const add = (appId: string | null, connection: AiAppConnection) => {
      if (!appId) return;
      byApp.set(appId, [...(byApp.get(appId) ?? []), connection]);
    };
    for (const g of grants) {
      add(g.aiClientId, {
        id: g.id,
        kind: 'oauth',
        name: g.clientName ?? g.clientId,
        personaId: g.personaId,
        createdAt: g.createdAt,
        lastUsedAt: g.lastUsedAt,
        expiresAt: null,
      });
    }
    for (const t of tokens) {
      if (t.expiresAt && t.expiresAt.getTime() <= now) continue;
      add(t.aiClientId, {
        id: t.id,
        kind: 'token',
        name: t.name,
        personaId: t.personaId,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        expiresAt: t.expiresAt,
      });
    }
    return byApp;
  }

  /** When each app last used any of its sign-ins or tokens, revoked ones included. */
  private async lastUse(workspaceId: string): Promise<Map<string, Date>> {
    const { db } = this.deps;
    const [grants, tokens] = await Promise.all([
      db
        .select({ app: oauthGrants.aiClientId, at: max(oauthGrants.lastUsedAt) })
        .from(oauthGrants)
        .where(and(eq(oauthGrants.workspaceId, workspaceId), isNotNull(oauthGrants.aiClientId)))
        .groupBy(oauthGrants.aiClientId),
      db
        .select({ app: apiTokens.aiClientId, at: max(apiTokens.lastUsedAt) })
        .from(apiTokens)
        .where(and(eq(apiTokens.workspaceId, workspaceId), isNotNull(apiTokens.aiClientId)))
        .groupBy(apiTokens.aiClientId),
    ]);
    const last = new Map<string, Date>();
    for (const { app, at } of [...grants, ...tokens]) {
      if (!app || !at) continue;
      const known = last.get(app);
      if (!known || known < at) last.set(app, at);
    }
    return last;
  }

  private view(row: AiClientRow, connections: AiAppConnection[] = [], lastUsedAt?: Date): AiApp {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      createdAt: row.createdAt,
      lastUsedAt: lastUsedAt ?? row.lastUsedAt,
      connections,
    };
  }

  /** Every app of the workspace, connected ones first, then by last use. */
  async list(workspaceId: string): Promise<AiApp[]> {
    const [rows, live, last] = await Promise.all([
      this.deps.clients.list(workspaceId),
      this.liveConnections(workspaceId),
      this.lastUse(workspaceId),
    ]);
    const time = (d: Date | null) => d?.getTime() ?? 0;
    return rows
      .map((row) => this.view(row, live.get(row.id), last.get(row.id)))
      .sort(
        (a, b) =>
          Number(b.connections.length > 0) - Number(a.connections.length > 0) ||
          time(b.lastUsedAt) - time(a.lastUsedAt) ||
          time(b.createdAt) - time(a.createdAt),
      );
  }

  async get(workspaceId: string, id: string): Promise<AiApp> {
    const [row, live, last] = await Promise.all([
      this.deps.clients.get(workspaceId, id),
      this.liveConnections(workspaceId),
      this.lastUse(workspaceId),
    ]);
    return this.view(row, live.get(row.id), last.get(row.id));
  }

  /** By id or name (any case); a name two apps share must be given as an id. */
  async find(workspaceId: string, ref: string): Promise<AiApp> {
    const all = await this.list(workspaceId);
    const wanted = ref.trim().toLowerCase();
    const byId = all.find((a) => a.id === ref.trim());
    if (byId) return byId;
    const matches = all.filter((a) => a.name.toLowerCase() === wanted);
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw notFound(`AI app "${ref}"`);
    throw badRequest(
      `Several AI apps are called "${ref}": use one of the ids ${matches.map((a) => a.id).join(', ')}.`,
    );
  }

  async rename(workspaceId: string, id: string, name: string): Promise<AiApp> {
    const trimmed = name.trim();
    if (!trimmed) throw badRequest('Name the app');
    await this.deps.clients.rename(workspaceId, id, trimmed);
    return this.get(workspaceId, id);
  }

  /** Ends every sign-in and token of the app; its rules stay for when it connects again. */
  async disconnect(workspaceId: string, id: string): Promise<{ signIns: number; tokens: number }> {
    const app = await this.get(workspaceId, id);
    let signIns = 0;
    let tokens = 0;
    for (const c of app.connections) {
      if (c.kind === 'oauth') {
        if (await this.deps.revokeGrant(workspaceId, c.id)) signIns++;
      } else {
        await this.deps.tokens.revoke(workspaceId, c.id);
        tokens++;
      }
    }
    return { signIns, tokens };
  }

  /** Removes an app that is no longer connected, with its access rules. */
  async forget(workspaceId: string, id: string): Promise<void> {
    const app = await this.get(workspaceId, id);
    if (app.connections.length) throw conflict('Disconnect the app before removing it');
    await this.deps.clients.delete(workspaceId, id);
  }

  /** Every sign-in and token the app ever used (revoked ones too): its calls in the activity log. */
  async credentialIds(workspaceId: string, id: string): Promise<string[]> {
    const { db } = this.deps;
    const [grants, tokens] = await Promise.all([
      db
        .select({ id: oauthGrants.id })
        .from(oauthGrants)
        .where(and(eq(oauthGrants.workspaceId, workspaceId), eq(oauthGrants.aiClientId, id))),
      db
        .select({ id: apiTokens.id })
        .from(apiTokens)
        .where(and(eq(apiTokens.workspaceId, workspaceId), eq(apiTokens.aiClientId, id))),
    ]);
    return [...grants, ...tokens].map((r) => r.id);
  }
}
