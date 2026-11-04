import { and, eq, isNotNull, lt, ne } from 'drizzle-orm';
import { resolveProvider } from '../connectors/oauth/providers.js';
import {
  type ConnectorDefinition,
  ConnectorError,
  type FetchLike,
  type OAuthAccess,
  type OAuthProviderSpec,
} from '../connectors/sdk.js';
import type { Db } from '../db/client.js';
import { accountOauth, accounts } from '../db/schema.js';
import type { SecretBox } from '../lib/crypto.js';
import type { Logger } from '../logger.js';
import type { OAuthAppService } from './oauth-apps.js';
import { OAuthProtocolError, refreshTokenSet, revokeTokenSet, type TokenSet } from './oauth-client.js';

/** Refresh this long before expiry so a token never expires in the middle of a call. */
const REFRESH_MARGIN_MS = 2 * 60_000;
const tokensContext = (accountId: string) => `account:${accountId}:oauth`;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Owns the OAuth tokens of connected accounts: stores them encrypted, hands connectors a fresh
 * access token (`ctx.oauth`) and refreshes it under a row lock, so concurrent calls and several
 * hub instances never race a rotating refresh token. A grant the provider no longer accepts marks
 * the account `needs_reauth`.
 */
export class TokenManager {
  private readonly inflight = new Map<string, Promise<TokenSet>>();

  constructor(
    private readonly deps: {
      db: Db;
      secrets: SecretBox;
      apps: OAuthAppService;
      fetch: FetchLike;
      logger: Logger;
    },
  ) {}

  async store(
    accountId: string,
    input: { providerId: string; appRef: string; tokens: TokenSet },
    tx: Db | Tx = this.deps.db,
  ): Promise<void> {
    const values = {
      providerId: input.providerId,
      appRef: input.appRef,
      tokensEncrypted: this.deps.secrets.encryptJson(input.tokens, tokensContext(accountId)),
      expiresAt: input.tokens.expiresAt ? new Date(input.tokens.expiresAt) : null,
      scopes: input.tokens.scopes,
      refreshedAt: new Date(),
      lastError: null,
    };
    await tx
      .insert(accountOauth)
      .values({ accountId, ...values })
      .onConflictDoUpdate({ target: accountOauth.accountId, set: values });
  }

  async load(
    accountId: string,
  ): Promise<{ appRef: string; providerId: string; tokens: TokenSet } | undefined> {
    const [row] = await this.deps.db
      .select()
      .from(accountOauth)
      .where(eq(accountOauth.accountId, accountId))
      .limit(1);
    if (!row) return undefined;
    return {
      appRef: row.appRef,
      providerId: row.providerId,
      tokens: this.decrypt(accountId, row.tokensEncrypted),
    };
  }

  private decrypt(accountId: string, envelope: string): TokenSet {
    try {
      return this.deps.secrets.decryptJson<TokenSet>(envelope, tokensContext(accountId));
    } catch {
      throw new ConnectorError('auth', 'The stored OAuth tokens cannot be decrypted; reconnect the account');
    }
  }

  /**
   * The `ctx.oauth` of an account: undefined when it was never connected. Refreshes first when the
   * token is about to expire.
   */
  async access(
    connector: ConnectorDefinition,
    account: { id: string; workspaceId: string },
    signal: AbortSignal,
  ): Promise<OAuthAccess | undefined> {
    if (!connector.oauth) return undefined;
    const stored = await this.load(account.id);
    if (!stored) return undefined;
    const provider = resolveProvider(connector.oauth);
    let tokens = stored.tokens;
    if (tokens.expiresAt !== undefined && tokens.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      tokens = await this.refresh(account, provider, tokens.accessToken, signal);
    }
    const manager = this;
    return {
      get accessToken() {
        return tokens.accessToken;
      },
      get tokenType() {
        return tokens.tokenType;
      },
      get scopes() {
        return tokens.scopes;
      },
      get expiresAt() {
        return tokens.expiresAt ? new Date(tokens.expiresAt) : undefined;
      },
      get extra() {
        return tokens.extra;
      },
      async refresh() {
        tokens = await manager.refresh(account, provider, tokens.accessToken, signal);
        return tokens.accessToken;
      },
    };
  }

  /**
   * Refreshes the tokens unless someone else already did (the stored access token differs from
   * `staleAccessToken` and is still valid). One refresh per account at a time in this process; the
   * row lock serializes instances.
   */
  refresh(
    account: { id: string; workspaceId: string },
    provider: OAuthProviderSpec,
    staleAccessToken: string | undefined,
    signal: AbortSignal,
  ): Promise<TokenSet> {
    const running = this.inflight.get(account.id);
    if (running) return running;
    const promise = this.refreshLocked(account, provider, staleAccessToken, signal).finally(() =>
      this.inflight.delete(account.id),
    );
    this.inflight.set(account.id, promise);
    return promise;
  }

  private async refreshLocked(
    account: { id: string; workspaceId: string },
    provider: OAuthProviderSpec,
    staleAccessToken: string | undefined,
    signal: AbortSignal,
  ): Promise<TokenSet> {
    let failure: { error: ConnectorError; grantInvalid: boolean; message: string } | undefined;
    const result = await this.deps.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(accountOauth)
        .where(eq(accountOauth.accountId, account.id))
        .for('update')
        .limit(1);
      if (!row) throw new ConnectorError('auth', 'The account is not connected yet');
      const current = this.decrypt(account.id, row.tokensEncrypted);
      const fresh = current.expiresAt === undefined || current.expiresAt - Date.now() > REFRESH_MARGIN_MS;
      if (staleAccessToken !== undefined && current.accessToken !== staleAccessToken && fresh) return current;

      const app = await this.deps.apps.resolve(account.workspaceId, row.appRef);
      if (!app) {
        failure = {
          error: new ConnectorError(
            'auth',
            'The OAuth app this account was connected with was removed; reconnect it',
          ),
          grantInvalid: true,
          message: 'OAuth app removed',
        };
        return undefined;
      }
      try {
        const next = await refreshTokenSet({ provider, app, current, fetch: this.deps.fetch, signal });
        await this.store(account.id, { providerId: row.providerId, appRef: row.appRef, tokens: next }, tx);
        return next;
      } catch (error) {
        const protocol = error instanceof OAuthProtocolError ? error : undefined;
        const message = protocol?.message ?? (error as Error).message;
        failure = protocol?.grantInvalid
          ? {
              error: new ConnectorError(
                'auth',
                `${provider.name} no longer accepts this connection: ${message}`,
              ),
              grantInvalid: true,
              message,
            }
          : {
              error: new ConnectorError(
                'upstream',
                `Could not refresh the ${provider.name} token: ${message}`,
              ),
              grantInvalid: false,
              message,
            };
        return undefined;
      }
    });
    if (result) return result;
    const { error, grantInvalid, message } = failure!;
    await this.deps.db
      .update(accountOauth)
      .set({ lastError: message.slice(0, 500) })
      .where(eq(accountOauth.accountId, account.id));
    if (grantInvalid) {
      await this.deps.db
        .update(accounts)
        .set({ status: 'needs_reauth', statusMessage: error.message.slice(0, 500) })
        .where(eq(accounts.id, account.id));
    }
    this.deps.logger.warn(
      { account: account.id, provider: provider.id, grantInvalid },
      'OAuth token refresh failed',
    );
    throw error;
  }

  /** Accounts whose access token expires before `before` and that can be refreshed. */
  async expiring(before: Date): Promise<{ accountId: string; workspaceId: string; connectorId: string }[]> {
    return this.deps.db
      .select({
        accountId: accountOauth.accountId,
        workspaceId: accounts.workspaceId,
        connectorId: accounts.connectorId,
      })
      .from(accountOauth)
      .innerJoin(accounts, eq(accounts.id, accountOauth.accountId))
      .where(
        and(
          isNotNull(accountOauth.expiresAt),
          lt(accountOauth.expiresAt, before),
          eq(accounts.enabled, true),
          // needs_reauth accounts wait for the user
          ne(accounts.status, 'needs_reauth'),
        ),
      );
  }

  /** Revokes the account's grant at the provider (best effort) — before the account is deleted. */
  async revoke(connector: ConnectorDefinition, account: { id: string; workspaceId: string }): Promise<void> {
    if (!connector.oauth) return;
    const stored = await this.load(account.id).catch(() => undefined);
    if (!stored) return;
    const app = await this.deps.apps.resolve(account.workspaceId, stored.appRef);
    if (!app) return;
    await revokeTokenSet({
      provider: resolveProvider(connector.oauth),
      app,
      tokens: stored.tokens,
      fetch: this.deps.fetch,
      signal: AbortSignal.timeout(5000),
    });
  }
}
