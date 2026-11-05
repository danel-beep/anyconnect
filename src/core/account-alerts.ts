import { and, eq, exists, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { ConnectorResolver } from '../connectors/registry.js';
import type { Db } from '../db/client.js';
import { accountOauth, accounts, workspaceMembers } from '../db/schema.js';
import type { Logger } from '../logger.js';
import { scrubSecrets } from '../ops/scrub.js';
import type { OwnerNotice, OwnerNotifier } from './owner-notices.js';

/**
 * Tells a workspace's owners when an account needs them to sign in again (`needs_reauth`: the
 * service stopped accepting the password or token), once per breakage: the account is marked
 * (`reauth_notified_at`) and the mark is cleared when it works again, so the next breakage is
 * reported too. Expired OAuth tokens are refreshed on their own (`accounts.refresh_tokens`); this
 * is for what only the user can fix.
 */
export class AccountAlerts {
  constructor(
    private readonly deps: {
      db: Db;
      connectors: ConnectorResolver;
      notifier: OwnerNotifier;
      /** The page where the owner reconnects the account. */
      reconnectUrl: (workspaceId: string, service: string, accountId: string) => Promise<string>;
      logger: Logger;
    },
  ) {}

  async notifyReauth(limit = 200): Promise<{ notified: number; waiting: number }> {
    const { db } = this.deps;
    // Accounts that work again: forget the alert so the next breakage is reported.
    await db
      .update(accounts)
      .set({ reauthNotifiedAt: null, updatedAt: sql`${accounts.updatedAt}` })
      .where(and(isNotNull(accounts.reauthNotifiedAt), ne(accounts.status, 'needs_reauth')));

    const rows = await db
      .select({
        id: accounts.id,
        workspaceId: accounts.workspaceId,
        connectorId: accounts.connectorId,
        label: accounts.label,
        statusMessage: accounts.statusMessage,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.status, 'needs_reauth'),
          eq(accounts.enabled, true),
          isNull(accounts.reauthNotifiedAt),
          // Only accounts that were connected once: one whose sign-in was never finished is not
          // broken, the dashboard already asks to finish it.
          or(
            isNotNull(accounts.credentialsEncrypted),
            exists(
              db.select({ one: sql`1` }).from(accountOauth).where(eq(accountOauth.accountId, accounts.id)),
            ),
          ),
        ),
      )
      .orderBy(accounts.workspaceId)
      .limit(limit);

    const byWorkspace = new Map<string, typeof rows>();
    for (const row of rows)
      byWorkspace.set(row.workspaceId, [...(byWorkspace.get(row.workspaceId) ?? []), row]);
    let notified = 0;
    let waiting = 0;
    for (const [workspaceId, items] of byWorkspace) {
      const notice: OwnerNotice = {
        kind: 'accounts_need_reauth',
        accounts: await Promise.all(
          items.map(async (row) => ({
            service: (await this.deps.connectors.get(workspaceId, row.connectorId))?.name ?? row.connectorId,
            account: row.label,
            reason: row.statusMessage ? scrubSecrets(row.statusMessage, 200) : null,
            url: await this.deps.reconnectUrl(workspaceId, row.connectorId, row.id),
          })),
        ),
      };
      const owners = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            inArray(workspaceMembers.role, ['owner', 'admin']),
          ),
        );
      const deliveries = await Promise.all(owners.map((o) => this.deps.notifier.notify(o.userId, notice)));
      if (deliveries.includes('failed')) {
        // The channel is down right now: the next run tries again.
        waiting += items.length;
        continue;
      }
      await db
        .update(accounts)
        .set({ reauthNotifiedAt: new Date(), updatedAt: sql`${accounts.updatedAt}` })
        .where(
          inArray(
            accounts.id,
            items.map((row) => row.id),
          ),
        );
      notified += items.length;
    }
    if (rows.length) this.deps.logger.info({ notified, waiting }, 'reconnect alerts sent');
    return { notified, waiting };
  }
}
