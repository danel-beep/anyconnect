import { and, asc, eq, isNull, lt, or } from 'drizzle-orm';
import { resolveProvider } from '../connectors/oauth/providers.js';
import type { ConnectorResolver } from '../connectors/registry.js';
import type { Db } from '../db/client.js';
import { accounts } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { AccountService } from './accounts.js';
import type { TokenManager } from './oauth-tokens.js';

/**
 * Keeps connected accounts usable without the user noticing:
 *
 * - refreshes OAuth tokens shortly before they expire (also keeps "sliding" refresh tokens alive,
 *   e.g. Microsoft's expire after 90 days without use);
 * - periodically re-runs each account's connection test, so a revoked password or token shows up
 *   as `needs_reauth` / `error` in the panel and in `manyplug_list_accounts` before the AI hits it.
 */
export class AccountHealthService {
  constructor(
    private readonly deps: {
      db: Db;
      connectors: ConnectorResolver;
      accounts: AccountService;
      tokens: TokenManager;
      logger: Logger;
    },
  ) {}

  async refreshExpiringTokens(windowMs = 15 * 60_000): Promise<{ refreshed: number; failed: number }> {
    const due = await this.deps.tokens.expiring(new Date(Date.now() + windowMs));
    let refreshed = 0;
    let failed = 0;
    for (const item of due) {
      const connector = await this.deps.connectors.get(item.workspaceId, item.connectorId);
      if (!connector?.oauth) continue;
      try {
        await this.deps.tokens.refresh(
          { id: item.accountId, workspaceId: item.workspaceId },
          resolveProvider(connector.oauth),
          undefined,
          AbortSignal.timeout(20_000),
        );
        refreshed += 1;
      } catch {
        failed += 1; // already recorded on the account by the token manager
      }
    }
    if (due.length) this.deps.logger.info({ refreshed, failed }, 'OAuth tokens refreshed');
    return { refreshed, failed };
  }

  /** Re-tests enabled accounts not checked for `maxAgeMs`, oldest first, `limit` per run. */
  async checkStaleAccounts(
    maxAgeMs = 24 * 3_600_000,
    limit = 50,
  ): Promise<{ checked: number; failing: number }> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const rows = await this.deps.db
      .select({ id: accounts.id, workspaceId: accounts.workspaceId })
      .from(accounts)
      .where(and(eq(accounts.enabled, true), or(isNull(accounts.checkedAt), lt(accounts.checkedAt, cutoff))))
      .orderBy(asc(accounts.checkedAt))
      .limit(limit);
    let failing = 0;
    for (const row of rows) {
      const result = await this.deps.accounts
        .test(row.workspaceId, row.id, this.deps.logger)
        .catch((error: Error) => ({ ok: false, message: error.message }));
      if (!result.ok) failing += 1;
    }
    if (rows.length) this.deps.logger.info({ checked: rows.length, failing }, 'account health checked');
    return { checked: rows.length, failing };
  }
}
