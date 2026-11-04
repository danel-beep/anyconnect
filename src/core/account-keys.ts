import { DataKey, type KeyWrapper, type SecretBox } from '../lib/crypto.js';

/**
 * Per-account envelope encryption.
 *
 * Every account has its own random data key (DEK). The DEK is stored wrapped by the master key
 * (`accounts.data_key_encrypted`, AAD = `account:<id>:dek`) and encrypts the account's secrets
 * (credentials today; cached messages and other per-account data later), always with the account
 * id in the AAD so a ciphertext copied to another row does not decrypt.
 *
 * Accounts created before envelope encryption have credentials encrypted directly with the master
 * key (`v1.` envelopes). They stay readable and are upgraded on the next write or by
 * {@link AccountService.upgradeEncryption}.
 */
export interface AccountKeyMaterial {
  id: string;
  dataKeyEncrypted: string | null;
}

export const dataKeyContext = (accountId: string) => `account:${accountId}:dek`;
export const credentialsContext = (accountId: string) => `account:${accountId}:credentials`;

export class AccountKeyring {
  constructor(
    private readonly wrapper: KeyWrapper,
    /** Reads secrets written before envelope encryption existed. */
    private readonly legacy: SecretBox,
  ) {}

  /** A fresh data key for a new (or not yet upgraded) account, plus its wrapped form to store. */
  createKey(accountId: string): { key: DataKey; wrapped: string } {
    const key = DataKey.generate();
    return { key, wrapped: key.wrap(this.wrapper, dataKeyContext(accountId)) };
  }

  openKey(account: AccountKeyMaterial): DataKey {
    if (!account.dataKeyEncrypted) throw new Error(`Account ${account.id} has no data key`);
    return DataKey.unwrap(this.wrapper, account.dataKeyEncrypted, dataKeyContext(account.id));
  }

  needsRewrap(account: AccountKeyMaterial): boolean {
    return account.dataKeyEncrypted !== null && this.wrapper.needsRewrap(account.dataKeyEncrypted);
  }

  /** Re-wraps the data key with the current master key; the data it protects is untouched. */
  rewrap(account: AccountKeyMaterial): string {
    return this.openKey(account).wrap(this.wrapper, dataKeyContext(account.id));
  }

  encryptCredentials(account: { id: string }, key: DataKey, value: unknown): string {
    return key.encryptJson(value, credentialsContext(account.id));
  }

  decryptCredentials<T = unknown>(account: AccountKeyMaterial, envelope: string): T {
    if (DataKey.isEnvelope(envelope)) {
      return this.openKey(account).decryptJson<T>(envelope, credentialsContext(account.id));
    }
    return this.legacy.decryptJson<T>(envelope, credentialsContext(account.id));
  }

  /** True when the stored credentials predate envelope encryption. */
  isLegacy(envelope: string | null): boolean {
    return envelope !== null && !DataKey.isEnvelope(envelope);
  }
}
