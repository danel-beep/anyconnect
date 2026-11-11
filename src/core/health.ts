import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { resolveProvider } from '../connectors/oauth/providers.js';
import type { ConnectorResolver } from '../connectors/registry.js';
import type { Db } from '../db/client.js';
import { accounts } from '../db/schema.js';
import { mapLimit } from '../lib/concurrency.js';
import type { Logger } from '../logger.js';
import { notSealedAccount } from './account-keys.js';
import type { AccountService } from './accounts.js';
import type { TokenManager } from './oauth-tokens.js';

/**
 * Keeps connected accounts usable without the user noticing:
 *
 * - refreshes OAuth tokens shortly before they expire (also keeps "sliding" refresh tokens alive,
 *   e.g. Microsoft's expire after 90 days without use);
 * - periodically re-runs each account's connection test, so a revoked password or token shows up
 *   as `needs_reauth` / `error` in the panel and in `manyplug_list_accounts` before the AI hits it.
 *
 * Accounts sealed to their owner's vault are skipped: the hub cannot open them outside the owner's
 * requests, so their tokens refresh on the next call (`docs/VAULTS.md`).
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

  /**
   * Refreshes tokens about to expire, for accounts in use (see `TokenManager.expiring`); `signal`
   * ends the pass early (the job's deadline, a shutdown) and the next run takes what is left.
   */
  async refreshExpiringTokens(
    windowMs = 15 * 60_000,
    signal?: AbortSignal,
  ): Promise<{ refreshed: number; failed: number }> {
    const due = await this.deps.tokens.expiring(new Date(Date.now() + windowMs));
    let refreshed = 0;
    let failed = 0;
    // Two at a time: a slow provider does not hold up the others, and the refreshes that tool
    // calls need right now still find a free slot (`TokenManager.refresh`).
    await mapLimit(due, 2, async (item) => {
      if (signal?.aborted) return;
      const connector = await this.deps.connectors.get(item.workspaceId, item.connectorId);
      if (!connector?.oauth) return;
      try {
        await this.deps.tokens.refresh(
          { id: item.accountId, workspaceId: item.workspaceId },
          resolveProvider(connector.oauth),
          undefined,
          signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
          connector,
        );
        refreshed += 1;
      } catch {
        failed += 1; // already recorded on the account by the token manager
      }
    });
    if (due.length) this.deps.logger.info({ due: due.length, refreshed, failed }, 'OAuth tokens refreshed');
    return { refreshed, failed };
  }

  /**
   * Re-tests enabled accounts not checked for `maxAgeMs`: never checked first, then oldest first, a
   * few at a time. Without `limit` a run takes a share of all accounts that lets hourly runs get
   * through every account twice a day, so the check keeps its daily promise as the hub grows.
   */
  async checkStaleAccounts(
    maxAgeMs = 24 * 3_600_000,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<{ checked: number; failing: number }> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const checkable = and(eq(accounts.enabled, true), notSealedAccount());
    const batch = limit ?? healthBatch(await this.deps.db.$count(accounts, checkable));
    const rows = await this.deps.db
      .select({ id: accounts.id, workspaceId: accounts.workspaceId })
      .from(accounts)
      .where(and(checkable, or(isNull(accounts.checkedAt), lt(accounts.checkedAt, cutoff))))
      .orderBy(sql`${accounts.checkedAt} asc nulls first`)
      .limit(batch);
    // Accounts a pass did not get to (its time ran out) keep their old check time and come first
    // in the next one.
    const results = await mapLimit(rows, HEALTH_CONCURRENCY, async (row) => {
      if (signal?.aborted) return undefined;
      return this.deps.accounts
        .test(row.workspaceId, row.id, this.deps.logger)
        .catch((error: Error) => ({ ok: false, message: error.message }));
    });
    const done = results.filter((result) => result !== undefined);
    const failing = done.filter((result) => !result.ok).length;
    if (done.length) this.deps.logger.info({ checked: done.length, failing }, 'account health checked');
    return { checked: done.length, failing };
  }
}

/** Connection tests in flight at once (each is a request or two to the account's service). */
const HEALTH_CONCURRENCY = 4;
const HEALTH_BATCH_MIN = 50;
const HEALTH_BATCH_MAX = 2000;

/** Accounts one hourly run re-tests: a twelfth of them all, within sane bounds. */
export const healthBatch = (accounts: number): number =>
  Math.min(HEALTH_BATCH_MAX, Math.max(HEALTH_BATCH_MIN, Math.ceil(accounts / 12)));
