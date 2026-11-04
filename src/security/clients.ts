import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { aiClients, apiTokens, oauthClients, oauthGrants } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { OAuthClient } from '../oauth/clients.js';
import { isLoopbackRedirect, knownClientName } from '../oauth/redirect.js';

export type AiClientRow = typeof aiClients.$inferSelect;

export interface AiClientView {
  id: string;
  name: string;
  kind: AiClientRow['kind'];
  createdAt: string;
  lastUsedAt: string | null;
}

export function toAiClientView(row: AiClientRow): AiClientView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

/**
 * How an OAuth client is recognised as "the same app" across registrations:
 * well-known apps by their verified host, metadata-document clients by their URL, local apps and
 * other dynamically registered clients by their self-declared name (plus redirect host).
 * Self-declared identities are only suggestions: the consent screen lets the user pick.
 */
export function suggestClientIdentity(
  client: OAuthClient,
  redirectUri: string,
): { matchKey: string; name: string; verified: boolean } {
  const declared = client.metadata.client_name?.trim().slice(0, 100) || undefined;
  const redirect = new URL(redirectUri);
  if (client.registrationType === 'metadata_document') {
    const host = new URL(client.id).host;
    const known = knownClientName(host);
    // The document is served from the app's own host, so its name is as trustworthy as the host.
    // One vendor can host several apps (Claude and Claude Code on claude.ai): an app whose
    // document names it differently from the vendor's main app is its own client, keyed by URL.
    if (known && (!declared || declared.toLowerCase() === known.toLowerCase())) {
      return { matchKey: `app:${known.toLowerCase()}`, name: known, verified: true };
    }
    return { matchKey: `cimd:${client.id}`, name: declared ?? host, verified: true };
  }
  const known = redirect.protocol === 'https:' ? knownClientName(redirect.host) : undefined;
  if (known) return { matchKey: `app:${known.toLowerCase()}`, name: known, verified: true };
  if (isLoopbackRedirect(redirectUri)) {
    const name = declared ?? 'Local app';
    return { matchKey: `local:${name.toLowerCase()}`, name, verified: false };
  }
  const host = redirect.host || redirect.protocol;
  const name = declared ?? host;
  return { matchKey: `dcr:${name.toLowerCase()}@${host}`, name, verified: false };
}

/** AI clients: the subjects of access rules (Claude, ChatGPT, a script...). */
export class AiClientService {
  constructor(private readonly db: Db) {}

  async list(workspaceId: string): Promise<AiClientRow[]> {
    return this.db
      .select()
      .from(aiClients)
      .where(eq(aiClients.workspaceId, workspaceId))
      .orderBy(asc(aiClients.createdAt));
  }

  async get(workspaceId: string, id: string): Promise<AiClientRow> {
    const [row] = await this.db
      .select()
      .from(aiClients)
      .where(and(eq(aiClients.workspaceId, workspaceId), eq(aiClients.id, id)))
      .limit(1);
    if (!row) throw notFound('AI client');
    return row;
  }

  async findByKey(workspaceId: string, matchKey: string): Promise<AiClientRow | undefined> {
    const [row] = await this.db
      .select()
      .from(aiClients)
      .where(and(eq(aiClients.workspaceId, workspaceId), eq(aiClients.matchKey, matchKey)))
      .limit(1);
    return row;
  }

  /** Returns the client with this identity, creating it on first sight. Safe under concurrency. */
  async ensure(
    workspaceId: string,
    identity: { matchKey: string; name: string; kind: AiClientRow['kind'] },
  ): Promise<AiClientRow> {
    await this.db
      .insert(aiClients)
      .values({ id: newId('app'), workspaceId, ...identity })
      .onConflictDoNothing({ target: [aiClients.workspaceId, aiClients.matchKey] });
    const row = await this.findByKey(workspaceId, identity.matchKey);
    if (!row) throw new Error('AI client vanished right after creation');
    return row;
  }

  /** A new client that nothing else will match (e.g. one per personal access token). */
  async createUnique(workspaceId: string, name: string, kind: AiClientRow['kind']): Promise<AiClientRow> {
    const id = newId('app');
    const [row] = await this.db
      .insert(aiClients)
      .values({ id, workspaceId, name: name.slice(0, 100), kind, matchKey: `id:${id}` })
      .returning();
    return row!;
  }

  async rename(workspaceId: string, id: string, name: string): Promise<AiClientRow> {
    const [row] = await this.db
      .update(aiClients)
      .set({ name: name.trim().slice(0, 100) })
      .where(and(eq(aiClients.workspaceId, workspaceId), eq(aiClients.id, id)))
      .returning();
    if (!row) throw notFound('AI client');
    return row;
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    const deleted = await this.db
      .delete(aiClients)
      .where(and(eq(aiClients.workspaceId, workspaceId), eq(aiClients.id, id)))
      .returning({ id: aiClients.id });
    if (deleted.length === 0) throw notFound('AI client');
  }

  async touch(id: string): Promise<void> {
    await this.db
      .update(aiClients)
      .set({ lastUsedAt: new Date(), updatedAt: sql`${aiClients.updatedAt}` })
      .where(eq(aiClients.id, id));
  }

  /**
   * Links grants and personal tokens created before AI clients existed. Grants are matched by the
   * app's identity (as on the consent screen), every token becomes its own client. Idempotent.
   */
  async backfill(): Promise<{ grants: number; tokens: number }> {
    let grants = 0;
    let tokens = 0;
    const orphanGrants = await this.db
      .select({ grant: oauthGrants, client: oauthClients })
      .from(oauthGrants)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
      .where(and(isNull(oauthGrants.aiClientId), isNull(oauthGrants.revokedAt)));
    for (const { grant, client } of orphanGrants) {
      const redirect = client.metadata.redirect_uris[0];
      if (!redirect) continue;
      const identity = suggestClientIdentity(client, redirect);
      const row = await this.ensure(grant.workspaceId, { ...identity, kind: 'oauth' });
      await this.db
        .update(oauthGrants)
        .set({ aiClientId: row.id })
        .where(and(eq(oauthGrants.id, grant.id), isNull(oauthGrants.aiClientId)));
      grants++;
    }
    const orphanTokens = await this.db
      .select()
      .from(apiTokens)
      .where(and(isNull(apiTokens.aiClientId), isNull(apiTokens.revokedAt)));
    for (const token of orphanTokens) {
      const row = await this.createUnique(token.workspaceId, token.name, 'api_token');
      const updated = await this.db
        .update(apiTokens)
        .set({ aiClientId: row.id })
        .where(and(eq(apiTokens.id, token.id), isNull(apiTokens.aiClientId)))
        .returning({ id: apiTokens.id });
      if (updated.length) tokens++;
      else await this.delete(token.workspaceId, row.id); // another instance won the race
    }
    return { grants, tokens };
  }

  /** Ensures a client id belongs to the workspace (for links chosen by the user). */
  async assertInWorkspace(workspaceId: string, id: string): Promise<void> {
    const row = await this.get(workspaceId, id).catch(() => undefined);
    if (!row) throw conflict('Unknown AI client');
  }
}
