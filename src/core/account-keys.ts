import { DataKey, type KeyWrapper, type SecretBox } from '../lib/crypto.js';

/**
 * Per-account envelope encryption.
 *
 * Every account has its own random data key (DEK). The DEK is stored wrapped by the master key
 * (`accounts.data_key_encrypted`, AAD = `account:<id>:dek`) and encrypts the account's secrets
 * (credentials, OAuth tokens, the stored messenger chats and messages: `AccountCiphers`), always with the account
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
export const oauthTokensContext = (accountId: string) => `account:${accountId}:oauth`;

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
    return this.decryptSecret<T>(account, envelope, credentialsContext(account.id));
  }

  /**
   * Encrypts any other per-account secret (e.g. OAuth tokens) with the account's data key. The
   * context must name the account so the ciphertext only opens for it. An account without a data
   * key yet (not upgraded) falls back to the master key until it is upgraded.
   */
  encryptSecret(account: AccountKeyMaterial, value: unknown, context: string): string {
    return account.dataKeyEncrypted
      ? this.openKey(account).encryptJson(value, context)
      : this.legacy.encryptJson(value, context);
  }

  decryptSecret<T = unknown>(account: AccountKeyMaterial, envelope: string, context: string): T {
    if (DataKey.isEnvelope(envelope)) return this.openKey(account).decryptJson<T>(envelope, context);
    return this.legacy.decryptJson<T>(envelope, context);
  }

  /** True when the stored credentials predate envelope encryption. */
  isLegacy(envelope: string | null): boolean {
    return envelope !== null && !DataKey.isEnvelope(envelope);
  }
}
