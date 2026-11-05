import { and, eq } from 'drizzle-orm';
import type { Db, DbExecutor } from '../db/client.js';
import { userVaults, type VaultWrapKind, vaultWraps } from '../db/schema.js';
import { generateRecoveryKey, recoveryKeySecret, UnlockedVault, VaultPublicKey } from '../lib/vault.js';

/** The wrap context: names the user, the kind and the secret's row, so a wrap cannot be moved. */
export const vaultWrapContext = (userId: string, kind: VaultWrapKind, ref: string) =>
  `vault:${userId}:${kind}:${ref}`;

/** `ref` of the single recovery wrap. */
export const RECOVERY_REF = '-';

export class VaultLockedError extends Error {
  constructor(message = 'The vault is locked: this request carries no secret that opens it') {
    super(message);
    this.name = 'VaultLockedError';
  }
}

/**
 * Stores and opens user vaults (see `src/lib/vault.ts`). Nothing here can open a vault without a
 * secret the caller brings: there is deliberately no method that takes only a user id.
 */
export class VaultService {
  constructor(private readonly db: Db) {}

  async publicKey(userId: string, db: DbExecutor = this.db): Promise<VaultPublicKey | undefined> {
    const [row] = await db
      .select({ publicKey: userVaults.publicKey })
      .from(userVaults)
      .where(eq(userVaults.userId, userId))
      .limit(1);
    return row ? VaultPublicKey.decode(row.publicKey) : undefined;
  }

  async exists(userId: string): Promise<boolean> {
    return (await this.publicKey(userId)) !== undefined;
  }

  /**
   * Creates the user's vault, wrapped under the secret of the request that creates it (usually the
   * new web session), so protection needs no extra step from the user. Passkeys and a recovery key
   * are optional extra ways in ({@link setRecoveryKey}). Returns the opened vault, to add more wraps
   * in the same request. Fails if the user already has a vault: replacing it would orphan every
   * sealed account.
   */
  async create(
    userId: string,
    first: { kind: VaultWrapKind; ref: string; secret: Buffer },
  ): Promise<UnlockedVault> {
    const vault = UnlockedVault.create();
    await this.db.transaction(async (tx) => {
      await tx.insert(userVaults).values({ userId, publicKey: vault.publicKey.encoded });
      await this.addWrap(userId, vault, first.kind, first.ref, first.secret, tx);
    });
    return vault;
  }

  /** Adds (or replaces) the wrap for one secret. The vault must already be open in this request. */
  async addWrap(
    userId: string,
    vault: UnlockedVault,
    kind: VaultWrapKind,
    ref: string,
    secret: Buffer,
    db: DbExecutor = this.db,
  ): Promise<void> {
    const wrapped = vault.wrap(secret, vaultWrapContext(userId, kind, ref));
    await db
      .insert(vaultWraps)
      .values({ userId, kind, ref, wrapped })
      .onConflictDoUpdate({
        target: [vaultWraps.userId, vaultWraps.kind, vaultWraps.ref],
        set: { wrapped, createdAt: new Date(), lastUsedAt: null },
      });
  }

  /** Opens the vault with one secret, or throws {@link VaultLockedError}. */
  async unlock(userId: string, kind: VaultWrapKind, ref: string, secret: Buffer): Promise<UnlockedVault> {
    const [row] = await this.db
      .select({ wrapped: vaultWraps.wrapped, publicKey: userVaults.publicKey })
      .from(vaultWraps)
      .innerJoin(userVaults, eq(userVaults.userId, vaultWraps.userId))
      .where(and(eq(vaultWraps.userId, userId), eq(vaultWraps.kind, kind), eq(vaultWraps.ref, ref)))
      .limit(1);
    if (!row) throw new VaultLockedError();
    let vault: UnlockedVault;
    try {
      vault = UnlockedVault.unwrap(row.wrapped, secret, vaultWrapContext(userId, kind, ref), row.publicKey);
    } catch {
      throw new VaultLockedError('The secret does not open this vault');
    }
    await this.db
      .update(vaultWraps)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(vaultWraps.userId, userId), eq(vaultWraps.kind, kind), eq(vaultWraps.ref, ref)));
    return vault;
  }

  /** Opens the vault with the recovery key the user typed. */
  unlockWithRecoveryKey(userId: string, recoveryKey: string): Promise<UnlockedVault> {
    let secret: Buffer;
    try {
      secret = recoveryKeySecret(recoveryKey);
    } catch {
      return Promise.reject(new VaultLockedError('That is not a recovery key'));
    }
    return this.unlock(userId, 'recovery', RECOVERY_REF, secret);
  }

  /** Sets (or replaces) the optional recovery key; the vault must be open. Returned once, never stored. */
  async setRecoveryKey(userId: string, vault: UnlockedVault): Promise<string> {
    const recoveryKey = generateRecoveryKey();
    await this.addWrap(userId, vault, 'recovery', RECOVERY_REF, recoveryKeySecret(recoveryKey));
    return recoveryKey;
  }

  /** Revokes one way in (a signed-out session, a revoked token, a removed passkey). */
  async removeWrap(
    userId: string,
    kind: VaultWrapKind,
    ref: string,
    db: DbExecutor = this.db,
  ): Promise<void> {
    await db
      .delete(vaultWraps)
      .where(and(eq(vaultWraps.userId, userId), eq(vaultWraps.kind, kind), eq(vaultWraps.ref, ref)));
  }

  /**
   * Replaces the wrap of a rotated token (OAuth refresh: the old refresh token opens the vault,
   * the new one gets the wrap) in one step, so the old token stops opening it.
   */
  async rotateWrap(
    userId: string,
    kind: VaultWrapKind,
    ref: string,
    oldSecret: Buffer,
    next: { ref: string; secret: Buffer },
  ): Promise<UnlockedVault> {
    const vault = await this.unlock(userId, kind, ref, oldSecret);
    await this.db.transaction(async (tx) => {
      if (next.ref !== ref) await this.removeWrap(userId, kind, ref, tx);
      await this.addWrap(userId, vault, kind, next.ref, next.secret, tx);
    });
    return vault;
  }
}
