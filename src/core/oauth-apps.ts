import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { BUILTIN_PROVIDERS } from '../connectors/oauth/providers.js';
import type { Db } from '../db/client.js';
import { oauthApps } from '../db/schema.js';
import type { SecretBox } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';

/**
 * OAuth apps (client id + secret) the hub uses to connect accounts of a provider. Two sources:
 *
 * - hub-wide apps from env vars (`OAUTH_APP_GOOGLE_CLIENT_ID` ...), referenced as `env:<provider>`;
 * - apps a user registered at the provider themselves ("bring your own app"), stored per workspace
 *   with an encrypted secret and referenced by id.
 *
 * Each connected account remembers which app issued its tokens (`appRef`): refreshes must use it.
 */

export interface ResolvedOAuthApp {
  ref: string;
  providerId: string;
  clientId: string;
  clientSecret: string | undefined;
}

export interface OAuthAppView {
  id: string;
  providerId: string;
  label: string;
  clientId: string;
  hasSecret: boolean;
  source: 'env' | 'workspace';
  createdAt: string | null;
}

export const CreateOAuthAppInput = z.object({
  providerId: z.string().min(1),
  label: z.string().trim().min(1).max(100).optional(),
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().trim().min(1).max(2000).optional(),
});
export type CreateOAuthAppInput = z.infer<typeof CreateOAuthAppInput>;

const ENV_PREFIX = 'env:';
const secretContext = (appId: string) => `oauth_app:${appId}:secret`;

export class OAuthAppService {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
    private readonly envApps: Record<string, { clientId: string; clientSecret: string | undefined }>,
  ) {}

  /** Provider ids that have a hub-wide app configured. */
  envProviders(): string[] {
    return Object.keys(this.envApps);
  }

  async list(workspaceId: string): Promise<OAuthAppView[]> {
    const rows = await this.db
      .select()
      .from(oauthApps)
      .where(eq(oauthApps.workspaceId, workspaceId))
      .orderBy(desc(oauthApps.createdAt));
    const env: OAuthAppView[] = Object.entries(this.envApps).map(([providerId, app]) => ({
      id: `${ENV_PREFIX}${providerId}`,
      providerId,
      label: `${BUILTIN_PROVIDERS[providerId]?.name ?? providerId} (hub)`,
      clientId: app.clientId,
      hasSecret: Boolean(app.clientSecret),
      source: 'env',
      createdAt: null,
    }));
    return [
      ...env,
      ...rows.map((row) => ({
        id: row.id,
        providerId: row.providerId,
        label: row.label,
        clientId: row.clientId,
        hasSecret: Boolean(row.clientSecretEncrypted),
        source: 'workspace' as const,
        createdAt: row.createdAt.toISOString(),
      })),
    ];
  }

  async create(
    workspaceId: string,
    raw: CreateOAuthAppInput,
    knownProviders: Set<string>,
  ): Promise<OAuthAppView> {
    const parsed = CreateOAuthAppInput.safeParse(raw);
    if (!parsed.success) {
      throw badRequest(
        'Invalid OAuth app',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    const input = parsed.data;
    if (!knownProviders.has(input.providerId))
      throw badRequest(`Unknown OAuth provider "${input.providerId}"`);
    const id = newId('oap');
    const [row] = await this.db
      .insert(oauthApps)
      .values({
        id,
        workspaceId,
        providerId: input.providerId,
        label: input.label ?? `${BUILTIN_PROVIDERS[input.providerId]?.name ?? input.providerId} app`,
        clientId: input.clientId,
        clientSecretEncrypted: input.clientSecret
          ? this.secrets.encryptJson(input.clientSecret, secretContext(id))
          : null,
      })
      .returning();
    return (await this.list(workspaceId)).find((a) => a.id === row!.id)!;
  }

  async delete(workspaceId: string, appId: string): Promise<void> {
    const deleted = await this.db
      .delete(oauthApps)
      .where(and(eq(oauthApps.workspaceId, workspaceId), eq(oauthApps.id, appId)))
      .returning({ id: oauthApps.id });
    if (deleted.length === 0) throw notFound('OAuth app');
  }

  /**
   * Picks the app for a new connection: the requested one, else the newest workspace app of the
   * provider, else the hub-wide app. Undefined when none is configured.
   */
  async pick(
    workspaceId: string,
    providerId: string,
    requested?: string,
  ): Promise<ResolvedOAuthApp | undefined> {
    if (requested) {
      const app = await this.resolve(workspaceId, requested);
      if (!app || app.providerId !== providerId)
        throw badRequest('This OAuth app does not belong to the service');
      return app;
    }
    const [row] = await this.db
      .select({ id: oauthApps.id })
      .from(oauthApps)
      .where(and(eq(oauthApps.workspaceId, workspaceId), eq(oauthApps.providerId, providerId)))
      .orderBy(desc(oauthApps.createdAt))
      .limit(1);
    if (row) return this.resolve(workspaceId, row.id);
    return this.resolve(workspaceId, `${ENV_PREFIX}${providerId}`);
  }

  /** Whether the hub itself has an app for the provider (from env), whatever the workspace. */
  hasHubApp(providerId: string): boolean {
    return Boolean(this.envApps[providerId]);
  }

  /** Loads an app by reference with its decrypted secret. Undefined when it no longer exists. */
  async resolve(workspaceId: string, ref: string): Promise<ResolvedOAuthApp | undefined> {
    if (ref.startsWith(ENV_PREFIX)) {
      const providerId = ref.slice(ENV_PREFIX.length);
      const app = this.envApps[providerId];
      return app ? { ref, providerId, clientId: app.clientId, clientSecret: app.clientSecret } : undefined;
    }
    const [row] = await this.db
      .select()
      .from(oauthApps)
      .where(and(eq(oauthApps.workspaceId, workspaceId), eq(oauthApps.id, ref)))
      .limit(1);
    if (!row) return undefined;
    return {
      ref,
      providerId: row.providerId,
      clientId: row.clientId,
      clientSecret: row.clientSecretEncrypted
        ? this.secrets.decryptJson<string>(row.clientSecretEncrypted, secretContext(row.id))
        : undefined,
    };
  }
}
