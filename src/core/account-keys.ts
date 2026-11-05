import { isNull, notLike, or, type SQL } from 'drizzle-orm';
import { accounts } from '../db/schema.js';
import { DataKey, type KeyWrapper, type SecretBox } from '../lib/crypto.js';
import { isSealedKey, type VaultPublicKey } from '../lib/vault.js';
import { lockedError, type VaultScopes } from './vault-scope.js';

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
 *
 * Sealed accounts (`docs/VAULTS.md`): the DEK is sealed to the owner's vault public key instead of
 * being wrapped by the master key. Sealing needs only the public key; opening needs the owner's
 * vault, open in the current request ({@link VaultScopes}). Call {@link prepare} at an async
 * boundary before the synchronous methods below touch a sealed account.
 */
export interface AccountKeyMaterial {
  id: string;
  dataKeyEncrypted: string | null;
}

/**
 * SQL filter for accounts background jobs may open: not sealed to a vault. Sealed accounts open
 * only inside a request of their owner, so their tokens refresh and their tests run at call time.
 */
export const notSealedAccount = (): SQL =>
  or(isNull(accounts.dataKeyEncrypted), notLike(accounts.dataKeyEncrypted, 's1.%')) as SQL;

export const dataKeyContext = (accountId: string) => `account:${accountId}:dek`;
export const credentialsContext = (accountId: string) => `account:${accountId}:credentials`;
export const oauthTokensContext = (accountId: string) => `account:${accountId}:oauth`;

export class AccountKeyring {
  constructor(
    private readonly wrapper: KeyWrapper,
    /** Reads secrets written before envelope encryption existed. */
    private readonly legacy: SecretBox,
    /** The caller's vault for sealed accounts; without it sealed accounts never open. */
    private readonly scopes?: VaultScopes,
  ) {}

  /**
   * A fresh data key for a new (or not yet upgraded) account, plus its wrapped form to store:
   * sealed to `sealTo` (the owner's vault) when given, otherwise wrapped by the master key.
   */
  createKey(accountId: string, sealTo?: VaultPublicKey): { key: DataKey; wrapped: string } {
    const key = DataKey.generate();
    const context = dataKeyContext(accountId);
    return { key, wrapped: key.wrap(sealTo ? sealOnly(sealTo) : this.wrapper, context) };
  }

  isSealed(account: AccountKeyMaterial): boolean {
    return account.dataKeyEncrypted !== null && isSealedKey(account.dataKeyEncrypted);
  }

  /** Opens the caller's vault when the account is sealed, so the synchronous methods can use it. */
  async prepare(account: AccountKeyMaterial): Promise<void> {
    if (this.isSealed(account)) await this.scopes?.prepare();
  }

  /** Throws {@link VaultLockedError} for a sealed account whose vault is not open in this request. */
  openKey(account: AccountKeyMaterial): DataKey {
    if (!account.dataKeyEncrypted) throw new Error(`Account ${account.id} has no data key`);
    if (isSealedKey(account.dataKeyEncrypted)) {
      const vault = this.scopes?.current();
      if (!vault) throw lockedError();
      try {
        return DataKey.unwrap(vault, account.dataKeyEncrypted, dataKeyContext(account.id));
      } catch {
        // Sealed to someone else's vault (another member's account): locked for this caller.
        throw lockedError();
      }
    }
    return DataKey.unwrap(this.wrapper, account.dataKeyEncrypted, dataKeyContext(account.id));
  }

  needsRewrap(account: AccountKeyMaterial): boolean {
    if (account.dataKeyEncrypted === null || isSealedKey(account.dataKeyEncrypted)) return false;
    return this.wrapper.needsRewrap(account.dataKeyEncrypted);
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

/** Seals with a vault public key; opening needs the vault itself ({@link UnlockedVault}). */
function sealOnly(publicKey: VaultPublicKey): KeyWrapper {
  return {
    wrapKey: (key, context) => publicKey.sealKey(key, context),
    unwrapKey: () => {
      throw lockedError();
    },
    needsRewrap: () => false,
  };
}
