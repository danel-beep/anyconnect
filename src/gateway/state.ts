import { and, eq, like, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { messengerAccounts, messengerState } from '../db/schema.js';
import type { CipherSource } from '../messaging/ciphers.js';
import type { SessionState } from './drivers/types.js';

export class LeaseLostError extends Error {
  constructor(accountId: string) {
    super(`lease of ${accountId} was lost; refusing to write session state`);
    this.name = 'LeaseLostError';
  }
}

/**
 * Session state in Postgres instead of the container disk, so a restart or a move to another
 * instance continues the same session. Values are envelopes of the account's data key bound to account + key;
 * writes are fenced by the lease token.
 */
export class FencedSessionState implements SessionState {
  constructor(
    private readonly db: Db,
    private readonly ciphers: CipherSource,
    private readonly accountId: string,
    private readonly lease: { owner: string; token: number },
  ) {}

  private cipher() {
    return this.ciphers.forAccount(this.accountId);
  }

  private context(key: string): string {
    return `messenger:state:${this.accountId}:${key}`;
  }

  private stillHeld() {
    return sql`exists (select 1 from ${messengerAccounts} where ${messengerAccounts.accountId} = ${this.accountId}
      and ${messengerAccounts.leaseOwner} = ${this.lease.owner} and ${messengerAccounts.fencingToken} = ${this.lease.token}
      and ${messengerAccounts.leaseExpiresAt} > now())`;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const [row] = await this.db
      .select()
      .from(messengerState)
      .where(and(eq(messengerState.accountId, this.accountId), eq(messengerState.key, key)))
      .limit(1);
    if (!row) return undefined;
    return (await this.cipher()).decryptJson<T>(row.valueEncrypted, this.context(key));
  }

  async set(key: string, value: unknown): Promise<void> {
    const encrypted = (await this.cipher()).encryptJson(value, this.context(key));
    // One statement: the insert only happens while the lease is held.
    const result = await this.db.execute(sql`
      insert into ${messengerState} (account_id, key, value_encrypted, updated_at)
      select ${this.accountId}, ${key}, ${encrypted}, now() where ${this.stillHeld()}
      on conflict (account_id, key) do update set value_encrypted = excluded.value_encrypted, updated_at = now()`);
    if (result.rowCount !== 1) throw new LeaseLostError(this.accountId);
  }

  async delete(key: string): Promise<void> {
    const result = await this.db.execute(sql`
      delete from ${messengerState} where account_id = ${this.accountId} and key = ${key} and ${this.stillHeld()}`);
    if (result.rowCount === 0 && !(await this.holds())) throw new LeaseLostError(this.accountId);
  }

  async list<T = unknown>(prefix: string): Promise<{ key: string; value: T }[]> {
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = await this.db
      .select()
      .from(messengerState)
      .where(and(eq(messengerState.accountId, this.accountId), like(messengerState.key, `${escaped}%`)));
    const cipher = await this.cipher();
    return rows.map((row) => ({
      key: row.key,
      value: cipher.decryptJson<T>(row.valueEncrypted, this.context(row.key)),
    }));
  }

  async clear(): Promise<void> {
    if (!(await this.holds())) throw new LeaseLostError(this.accountId);
    await this.db.delete(messengerState).where(eq(messengerState.accountId, this.accountId));
  }

  private async holds(): Promise<boolean> {
    const result = await this.db.execute(sql`select 1 where ${this.stillHeld()}`);
    return result.rows.length === 1;
  }
}
