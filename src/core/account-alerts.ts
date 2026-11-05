import { and, eq, exists, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { ConnectorResolver } from '../connectors/registry.js';
import type { Db } from '../db/client.js';
import { accountOauth, accounts, workspaceMembers } from '../db/schema.js';
import type { Logger } from '../logger.js';
import { scrubSecrets } from '../ops/scrub.js';
import type { OwnerNotice, OwnerNotifier } from './owner-notices.js';

/**
 * Tells whoever manages an account when it needs them to sign in again (`needs_reauth`: the
 * service stopped accepting the password or token), once per breakage: the account is marked
 * (`reauth_notified_at`) and the mark is cleared when it works again, so the next breakage is
 * reported too. Expired OAuth tokens are refreshed on their own (`accounts.refresh_tokens`); this
 * is for what only the user can fix.
 *
 * An account's owner hears about it (in a team, the member it belongs to); a team account, the
 * team's owner and admins. Nobody else learns that a member's own account exists.
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
        ownerUserId: accounts.ownerUserId,
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

    // One notice per person, listing every account they need to sign in again.
    const notices = new Map<string, { workspaceId: string; userId: string; items: typeof rows }>();
    const managers = new Map<string, string[]>();
    for (const row of rows) {
      let recipients = row.ownerUserId ? [row.ownerUserId] : managers.get(row.workspaceId);
      if (!recipients) {
        recipients = await this.managers(row.workspaceId);
        managers.set(row.workspaceId, recipients);
      }
      for (const userId of recipients) {
        const key = `${row.workspaceId} ${userId}`;
        const notice = notices.get(key) ?? { workspaceId: row.workspaceId, userId, items: [] };
        notice.items.push(row);
        notices.set(key, notice);
      }
    }
    const urls = new Map<string, Promise<string>>();
    const urlOf = (row: (typeof rows)[number]) => {
      let url = urls.get(row.id);
      if (!url) {
        url = this.deps.reconnectUrl(row.workspaceId, row.connectorId, row.id);
        urls.set(row.id, url);
      }
      return url;
    };
    const waitingIds = new Set<string>();
    for (const { workspaceId, userId, items } of notices.values()) {
      const notice: OwnerNotice = {
        kind: 'accounts_need_reauth',
        accounts: await Promise.all(
          items.map(async (row) => ({
            service: (await this.deps.connectors.get(workspaceId, row.connectorId))?.name ?? row.connectorId,
            account: row.label,
            reason: row.statusMessage ? scrubSecrets(row.statusMessage, 200) : null,
            url: await urlOf(row),
          })),
        ),
      };
      // The channel is down right now: the next run tries again.
      if ((await this.deps.notifier.notify(userId, notice)) === 'failed')
        for (const row of items) waitingIds.add(row.id);
    }
    const done = rows.filter((row) => !waitingIds.has(row.id)).map((row) => row.id);
    if (done.length) {
      await db
        .update(accounts)
        .set({ reauthNotifiedAt: new Date(), updatedAt: sql`${accounts.updatedAt}` })
        .where(inArray(accounts.id, done));
    }
    const notified = done.length;
    const waiting = waitingIds.size;
    if (rows.length) this.deps.logger.info({ notified, waiting }, 'reconnect alerts sent');
    return { notified, waiting };
  }

  /** Who runs a workspace: its owner (and in a team, the admins). */
  private async managers(workspaceId: string): Promise<string[]> {
    const rows = await this.deps.db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          inArray(workspaceMembers.role, ['owner', 'admin']),
        ),
      );
    return rows.map((row) => row.userId);
  }
}
