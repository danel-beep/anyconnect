import { eq } from 'drizzle-orm';
import type { AccountKeyring } from '../core/account-keys.js';
import type { Db } from '../db/client.js';
import { accounts } from '../db/schema.js';

/** Encrypts and decrypts the stored messenger data of one account. */
export interface JsonCipher {
  encryptJson(value: unknown, context: string): string;
  decryptJson<T = unknown>(envelope: string, context: string): T;
}

/** Gives the cipher of an account (see {@link AccountCiphers}). */
export interface CipherSource {
  forAccount(accountId: string): Promise<JsonCipher>;
}

/**
 * Per-account encryption of messenger content (chats, messages, outbox payloads, session state).
 *
 * Everything is encrypted with the account's own data key (`accounts.data_key_encrypted`, see
 * `AccountKeyring`), not the master key directly. So deleting an account crypto-shreds its copy
 * of the conversation even where a backup or a stray row survives, and rotating ENCRYPTION_KEY
 * only re-wraps one key per account. Envelopes written before an account had a data key stay
 * readable through the keyring's legacy path.
 *
 * Data keys never change once set (rotation only re-wraps them), so an opened key can be cached.
 * The cache is bounded and expires, so a deleted account's key leaves memory soon after.
 */
export class AccountCiphers implements CipherSource {
  private readonly cache = new Map<string, { cipher: Promise<JsonCipher>; expiresAt: number }>();

  constructor(
    private readonly db: Db,
    private readonly keyring: AccountKeyring,
    private readonly options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
  ) {}

  forAccount(accountId: string): Promise<JsonCipher> {
    const now = (this.options.now ?? Date.now)();
    const hit = this.cache.get(accountId);
    if (hit && hit.expiresAt > now) {
      // Refresh the position: the map's insertion order is the eviction order.
      this.cache.delete(accountId);
      this.cache.set(accountId, hit);
      return hit.cipher;
    }
    const cipher = this.load(accountId);
    cipher.catch(() => {
      if (this.cache.get(accountId)?.cipher === cipher) this.cache.delete(accountId);
    });
    this.cache.delete(accountId);
    this.cache.set(accountId, { cipher, expiresAt: now + (this.options.ttlMs ?? 10 * 60_000) });
    const max = this.options.maxEntries ?? 5_000;
    while (this.cache.size > max) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return cipher;
  }

  /** Drops a cached key, for example right after the account was deleted. */
  forget(accountId: string): void {
    this.cache.delete(accountId);
  }

  private async load(accountId: string): Promise<JsonCipher> {
    const [row] = await this.db
      .select({ id: accounts.id, dataKeyEncrypted: accounts.dataKeyEncrypted })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (!row) throw new Error(`account ${accountId} not found`);
    const keyring = this.keyring;
    // Opening the data key once here (not per message) keeps listing a chat cheap.
    const opened = row.dataKeyEncrypted ? keyring.openKey(row) : undefined;
    const material = { id: row.id, dataKeyEncrypted: row.dataKeyEncrypted };
    return {
      encryptJson: (value, context) =>
        opened ? opened.encryptJson(value, context) : keyring.encryptSecret(material, value, context),
      decryptJson: <T>(envelope: string, context: string) =>
        opened && !keyring.isLegacy(envelope)
          ? opened.decryptJson<T>(envelope, context)
          : keyring.decryptSecret<T>(material, envelope, context),
    };
  }
}
