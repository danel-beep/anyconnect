import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { messengerAccounts } from '../db/schema.js';

/**
 * Exactly one connection per messenger account, across any number of gateway instances.
 *
 * A lease is a row in `messenger_accounts` with an owner, an expiry and a fencing token that
 * grows with every new lease. The owner renews it well before expiry; if it cannot (crash,
 * network split), the lease runs out and another instance takes over with a higher token, and
 * every state write of the old holder is rejected because it carries the old token.
 * Two live copies of one session are the main cause of key conflicts and forced logouts, so
 * the host stops a session the moment a renewal fails.
 */
export class LeaseManager {
  constructor(
    private readonly db: Db,
    readonly owner: string,
    private readonly options: { ownerUrl?: string | undefined; ttlMs: number },
  ) {}

  get ttlMs(): number {
    return this.options.ttlMs;
  }

  /** Takes the lease if it is free or expired. Returns the fencing token, or undefined. */
  async acquire(accountId: string): Promise<number | undefined> {
    await this.db.insert(messengerAccounts).values({ accountId }).onConflictDoNothing();
    const rows = await this.db
      .update(messengerAccounts)
      .set({
        leaseOwner: this.owner,
        leaseOwnerUrl: this.options.ownerUrl ?? null,
        leaseExpiresAt: sql`now() + ${`${this.options.ttlMs} milliseconds`}::interval`,
        fencingToken: sql`${messengerAccounts.fencingToken} + 1`,
      })
      .where(
        and(
          eq(messengerAccounts.accountId, accountId),
          sql`(${messengerAccounts.leaseOwner} is null or ${messengerAccounts.leaseExpiresAt} is null or ${messengerAccounts.leaseExpiresAt} < now())`,
        ),
      )
      .returning({ token: messengerAccounts.fencingToken });
    return rows[0]?.token;
  }

  /** Extends the lease. False means it was lost: stop the session immediately. */
  async renew(accountId: string, token: number): Promise<boolean> {
    const rows = await this.db
      .update(messengerAccounts)
      .set({ leaseExpiresAt: sql`now() + ${`${this.options.ttlMs} milliseconds`}::interval` })
      .where(this.held(accountId, token))
      .returning({ token: messengerAccounts.fencingToken });
    return rows.length === 1;
  }

  async release(accountId: string, token: number): Promise<void> {
    await this.db
      .update(messengerAccounts)
      .set({ leaseOwner: null, leaseOwnerUrl: null, leaseExpiresAt: null })
      .where(this.held(accountId, token));
  }

  /** SQL condition: this instance still holds the lease with this token. */
  held(accountId: string, token: number) {
    return and(
      eq(messengerAccounts.accountId, accountId),
      eq(messengerAccounts.leaseOwner, this.owner),
      eq(messengerAccounts.fencingToken, token),
      sql`${messengerAccounts.leaseExpiresAt} > now()`,
    )!;
  }
}
