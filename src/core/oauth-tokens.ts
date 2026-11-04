import { and, eq, isNotNull, lt, ne, notLike } from 'drizzle-orm';
import { resolveProvider } from '../connectors/oauth/providers.js';
import {
  type ConnectorDefinition,
  ConnectorError,
  type FetchLike,
  type OAuthAccess,
} from '../connectors/sdk.js';
import type { Db } from '../db/client.js';
import { accountOauth, accounts } from '../db/schema.js';
import type { Logger } from '../logger.js';
import { type AccountKeyMaterial, type AccountKeyring, oauthTokensContext } from './account-keys.js';
import type { OAuthAppService } from './oauth-apps.js';
import { OAuthProtocolError, refreshTokenSet, revokeTokenSet, type TokenSet } from './oauth-client.js';

/** Refresh this long before expiry so a token never expires in the middle of a call. */
const REFRESH_MARGIN_MS = 2 * 60_000;

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
      /** Tokens are encrypted with the account's own data key (see `AccountKeyring`). */
      keys: AccountKeyring;
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
    const account = await this.keyMaterial(accountId, tx);
    const values = {
      providerId: input.providerId,
      appRef: input.appRef,
      tokensEncrypted: this.deps.keys.encryptSecret(account, input.tokens, oauthTokensContext(accountId)),
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
    const [found] = await this.deps.db
      .select({ row: accountOauth, dataKeyEncrypted: accounts.dataKeyEncrypted })
      .from(accountOauth)
      .innerJoin(accounts, eq(accounts.id, accountOauth.accountId))
      .where(eq(accountOauth.accountId, accountId))
      .limit(1);
    if (!found) return undefined;
    const { row, dataKeyEncrypted } = found;
    return {
      appRef: row.appRef,
      providerId: row.providerId,
      tokens: this.decrypt({ id: accountId, dataKeyEncrypted }, row.tokensEncrypted),
    };
  }

  private async keyMaterial(accountId: string, tx: Db | Tx = this.deps.db): Promise<AccountKeyMaterial> {
    const [row] = await tx
      .select({ id: accounts.id, dataKeyEncrypted: accounts.dataKeyEncrypted })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (!row) throw new ConnectorError('auth', 'The account was removed');
    return row;
  }

  private decrypt(account: AccountKeyMaterial, envelope: string): TokenSet {
    try {
      return this.deps.keys.decryptSecret<TokenSet>(account, envelope, oauthTokensContext(account.id));
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
    let tokens = stored.tokens;
    if (tokens.expiresAt !== undefined && tokens.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      tokens = await this.refresh(account, connector, tokens.accessToken, signal);
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
        tokens = await manager.refresh(account, connector, tokens.accessToken, signal);
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
    connector: ConnectorDefinition,
    staleAccessToken: string | undefined,
    signal: AbortSignal,
  ): Promise<TokenSet> {
    const running = this.inflight.get(account.id);
    if (running) return running;
    const promise = this.refreshLocked(account, connector, staleAccessToken, signal).finally(() =>
      this.inflight.delete(account.id),
    );
    this.inflight.set(account.id, promise);
    return promise;
  }

  private async refreshLocked(
    account: { id: string; workspaceId: string },
    connector: ConnectorDefinition,
    staleAccessToken: string | undefined,
    signal: AbortSignal,
  ): Promise<TokenSet> {
    if (!connector.oauth)
      throw new ConnectorError('auth', `${connector.name} is not connected through OAuth`);
    const provider = resolveProvider(connector.oauth);
    let failure: { error: ConnectorError; grantInvalid: boolean; message: string } | undefined;
    const result = await this.deps.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(accountOauth)
        .where(eq(accountOauth.accountId, account.id))
        .for('update')
        .limit(1);
      if (!row) throw new ConnectorError('auth', 'The account is not connected yet');
      const current = this.decrypt(await this.keyMaterial(account.id, tx), row.tokensEncrypted);
      const fresh = current.expiresAt === undefined || current.expiresAt - Date.now() > REFRESH_MARGIN_MS;
      if (staleAccessToken !== undefined && current.accessToken !== staleAccessToken && fresh) return current;

      const app = await this.deps.apps.resolve(account.workspaceId, row.appRef, connector);
      if (!app) {
        failure = {
          error: new ConnectorError(
            'auth',
            'The OAuth app this account was connected with was removed or no longer fits the service; reconnect it',
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
                `${connector.name} no longer accepts this connection: ${message}`,
              ),
              grantInvalid: true,
              message,
            }
          : {
              error: new ConnectorError(
                'upstream',
                `Could not refresh the ${connector.name} token: ${message}`,
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

  /**
   * Re-encrypts tokens stored before per-account keys (master-key envelopes) with their account's
   * data key. Run after `AccountService.upgradeEncryption` gave every account a key; rows that
   * changed meanwhile (a refresh) are skipped and already use the new scheme.
   */
  async upgradeEncryption(): Promise<{ upgraded: number; failed: number }> {
    const result = { upgraded: 0, failed: 0 };
    const rows = await this.deps.db
      .select({ row: accountOauth, dataKeyEncrypted: accounts.dataKeyEncrypted })
      .from(accountOauth)
      .innerJoin(accounts, eq(accounts.id, accountOauth.accountId))
      .where(and(isNotNull(accounts.dataKeyEncrypted), notLike(accountOauth.tokensEncrypted, 'd1.%')));
    for (const { row, dataKeyEncrypted } of rows) {
      const account = { id: row.accountId, dataKeyEncrypted };
      try {
        const tokens = this.deps.keys.decryptSecret(
          account,
          row.tokensEncrypted,
          oauthTokensContext(account.id),
        );
        const updated = await this.deps.db
          .update(accountOauth)
          .set({
            tokensEncrypted: this.deps.keys.encryptSecret(account, tokens, oauthTokensContext(account.id)),
          })
          .where(
            and(
              eq(accountOauth.accountId, row.accountId),
              eq(accountOauth.tokensEncrypted, row.tokensEncrypted),
            ),
          )
          .returning({ id: accountOauth.accountId });
        if (updated.length) result.upgraded++;
      } catch {
        result.failed++;
      }
    }
    return result;
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
    const provider = resolveProvider(connector.oauth);
    const app = await this.deps.apps.resolve(account.workspaceId, stored.appRef, connector);
    if (!app) return;
    await revokeTokenSet({
      provider,
      app,
      tokens: stored.tokens,
      fetch: this.deps.fetch,
      signal: AbortSignal.timeout(5000),
    });
  }
}
