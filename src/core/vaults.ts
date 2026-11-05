import { createHash } from 'node:crypto';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { Db, DbExecutor } from '../db/client.js';
import { userVaults, type VaultWrapKind, vaultDeviceRequests, vaultWraps } from '../db/schema.js';
import { generateRecoveryKey, recoveryKeySecret, UnlockedVault, VaultPublicKey } from '../lib/vault.js';

/** The wrap context: names the user, the kind and the secret's row, so a wrap cannot be moved. */
export const vaultWrapContext = (userId: string, kind: VaultWrapKind, ref: string) =>
  `vault:${userId}:${kind}:${ref}`;

/** `ref` of the single recovery wrap. */
export const RECOVERY_REF = '-';

/** How long a browser's request to open the vault waits for an approval. */
export const DEVICE_REQUEST_TTL_MS = 7 * 86_400_000;

/**
 * The code both browsers show for one request, so the user approves the browser in front of them
 * and not one an attacker signed in at the same time: 6 digits of the device public key's hash.
 */
export function deviceCode(publicKey: string): string {
  const n = createHash('sha256').update(publicKey).digest().readUInt32BE(0) % 1_000_000;
  const digits = n.toString().padStart(6, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export interface DeviceRequest {
  deviceId: string;
  code: string;
  createdAt: Date;
}

export interface VaultDevice {
  deviceId: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

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

  /** True when the user has a wrap for this secret (e.g. this browser was approved). */
  async hasWrap(userId: string, kind: VaultWrapKind, ref: string): Promise<boolean> {
    const [row] = await this.db
      .select({ ref: vaultWraps.ref })
      .from(vaultWraps)
      .where(and(eq(vaultWraps.userId, userId), eq(vaultWraps.kind, kind), eq(vaultWraps.ref, ref)))
      .limit(1);
    return row !== undefined;
  }

  /** True when a recovery key is set. */
  hasRecoveryKey(userId: string): Promise<boolean> {
    return this.hasWrap(userId, 'recovery', RECOVERY_REF);
  }

  /**
   * A browser without a way into the vault asks for one. Only the public half of its device key is
   * stored; approving it ({@link approveDevice}) needs a browser where the vault is open.
   */
  async requestDevice(userId: string, deviceId: string, secret: Buffer): Promise<DeviceRequest> {
    const publicKey = UnlockedVault.devicePublicKey(secret).encoded;
    const [row] = await this.db
      .insert(vaultDeviceRequests)
      .values({ userId, deviceId, publicKey })
      .onConflictDoUpdate({
        target: [vaultDeviceRequests.userId, vaultDeviceRequests.deviceId],
        set: { publicKey, createdAt: new Date() },
      })
      .returning();
    return { deviceId, code: deviceCode(publicKey), createdAt: row!.createdAt };
  }

  /** Requests still waiting, newest first. */
  async deviceRequests(userId: string): Promise<DeviceRequest[]> {
    const rows = await this.db
      .select()
      .from(vaultDeviceRequests)
      .where(
        and(
          eq(vaultDeviceRequests.userId, userId),
          gt(vaultDeviceRequests.createdAt, new Date(Date.now() - DEVICE_REQUEST_TTL_MS)),
        ),
      )
      .orderBy(desc(vaultDeviceRequests.createdAt));
    return rows.map((r) => ({ deviceId: r.deviceId, code: deviceCode(r.publicKey), createdAt: r.createdAt }));
  }

  /**
   * Lets the requesting browser in: seals the private key to its device public key. The vault must
   * be open in this request (another browser of the same user). False if the request is gone.
   */
  async approveDevice(userId: string, vault: UnlockedVault, deviceId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [request] = await tx
        .delete(vaultDeviceRequests)
        .where(and(eq(vaultDeviceRequests.userId, userId), eq(vaultDeviceRequests.deviceId, deviceId)))
        .returning();
      if (!request || request.createdAt.getTime() < Date.now() - DEVICE_REQUEST_TTL_MS) return false;
      const wrapped = vault.sealTo(
        VaultPublicKey.decode(request.publicKey),
        vaultWrapContext(userId, 'device', deviceId),
      );
      await tx
        .insert(vaultWraps)
        .values({ userId, kind: 'device', ref: deviceId, wrapped })
        .onConflictDoUpdate({
          target: [vaultWraps.userId, vaultWraps.kind, vaultWraps.ref],
          set: { wrapped, createdAt: new Date(), lastUsedAt: null },
        });
      return true;
    });
  }

  async denyDevice(userId: string, deviceId: string): Promise<void> {
    await this.db
      .delete(vaultDeviceRequests)
      .where(and(eq(vaultDeviceRequests.userId, userId), eq(vaultDeviceRequests.deviceId, deviceId)));
  }

  /** Browsers that can open the vault. */
  async devices(userId: string): Promise<VaultDevice[]> {
    const rows = await this.db
      .select({ ref: vaultWraps.ref, createdAt: vaultWraps.createdAt, lastUsedAt: vaultWraps.lastUsedAt })
      .from(vaultWraps)
      .where(and(eq(vaultWraps.userId, userId), eq(vaultWraps.kind, 'device')))
      .orderBy(desc(vaultWraps.createdAt));
    return rows.map((r) => ({ deviceId: r.ref, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt }));
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

  /** Removes the wraps of several secrets of one kind at once (revoked or expired tokens). */
  async removeWrapsByRef(kind: VaultWrapKind, refs: string[], db: DbExecutor = this.db): Promise<void> {
    if (refs.length === 0) return;
    await db.delete(vaultWraps).where(and(eq(vaultWraps.kind, kind), inArray(vaultWraps.ref, refs)));
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
