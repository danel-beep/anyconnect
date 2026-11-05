import { createHash } from 'node:crypto';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { Db, DbExecutor } from '../db/client.js';
import {
  userVaults,
  type VaultRequestKind,
  type VaultWrapKind,
  vaultRequests,
  vaultWraps,
} from '../db/schema.js';
import { generateRecoveryKey, recoveryKeySecret, UnlockedVault, VaultPublicKey } from '../lib/vault.js';

/** The wrap context: names the user, the kind and the secret's row, so a wrap cannot be moved. */
export const vaultWrapContext = (userId: string, kind: VaultWrapKind, ref: string) =>
  `vault:${userId}:${kind}:${ref}`;

/** `ref` of the single recovery wrap. */
export const RECOVERY_REF = '-';

/** How long a request to open the vault waits for an approval. */
export const VAULT_REQUEST_TTL_MS = 7 * 86_400_000;
/** Keys one request keeps (an AI app's latest access and refresh tokens, and one spare). */
const MAX_REQUEST_KEYS = 4;

/**
 * The code both browsers show for one request, so the user approves the browser in front of them
 * and not one an attacker signed in at the same time: 6 digits of the device public key's hash.
 */
export function deviceCode(publicKey: string): string {
  const n = createHash('sha256').update(publicKey).digest().readUInt32BE(0) % 1_000_000;
  const digits = n.toString().padStart(6, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** A waiting request; `code` is what a browser shows on its own Security page (devices only). */
export interface VaultRequest {
  kind: VaultRequestKind;
  subject: string;
  code: string;
  createdAt: Date;
}

const requestKey = (userId: string, kind: VaultRequestKind, subject: string) =>
  and(eq(vaultRequests.userId, userId), eq(vaultRequests.kind, kind), eq(vaultRequests.subject, subject));

function toRequest(row: typeof vaultRequests.$inferSelect): VaultRequest {
  return {
    kind: row.kind,
    subject: row.subject,
    code: deviceCode(row.keys[0]?.publicKey ?? row.subject),
    createdAt: row.createdAt,
  };
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
   * Something of the user's without a way into the vault asks for one (see `vault_requests`): only
   * the public half of each secret is stored, and approving it ({@link approve}) needs a request
   * where the vault is open. `merge` adds keys to a waiting request (the same AI app presenting a
   * newer token) instead of replacing them; the newest {@link MAX_REQUEST_KEYS} are kept.
   */
  async request(
    userId: string,
    kind: VaultRequestKind,
    subject: string,
    secrets: { ref: string; secret: Buffer }[],
    options: { merge?: boolean } = {},
  ): Promise<VaultRequest> {
    const fresh = secrets.map((s) => ({
      ref: s.ref,
      publicKey: UnlockedVault.devicePublicKey(s.secret).encoded,
    }));
    return this.db.transaction(async (tx) => {
      let keys = fresh;
      if (options.merge) {
        const [existing] = await tx
          .select({ keys: vaultRequests.keys })
          .from(vaultRequests)
          .where(requestKey(userId, kind, subject))
          .for('update');
        const kept = (existing?.keys ?? []).filter((k) => !fresh.some((f) => f.ref === k.ref));
        keys = [...kept, ...fresh].slice(-MAX_REQUEST_KEYS);
      }
      const [row] = await tx
        .insert(vaultRequests)
        .values({ userId, kind, subject, keys })
        .onConflictDoUpdate({
          target: [vaultRequests.userId, vaultRequests.kind, vaultRequests.subject],
          set: { keys, createdAt: new Date() },
        })
        .returning();
      return toRequest(row!);
    });
  }

  /** A browser without a way in asks for one with its device key (`web-vault.ts`). */
  requestDevice(userId: string, deviceId: string, secret: Buffer): Promise<VaultRequest> {
    return this.request(userId, 'device', deviceId, [{ ref: deviceId, secret }]);
  }

  /** Requests still waiting, newest first. */
  async requests(userId: string): Promise<VaultRequest[]> {
    const rows = await this.db
      .select()
      .from(vaultRequests)
      .where(
        and(
          eq(vaultRequests.userId, userId),
          gt(vaultRequests.createdAt, new Date(Date.now() - VAULT_REQUEST_TTL_MS)),
        ),
      )
      .orderBy(desc(vaultRequests.createdAt));
    return rows.map(toRequest);
  }

  /** One waiting request, if any. */
  async findRequest(
    userId: string,
    kind: VaultRequestKind,
    subject: string,
  ): Promise<VaultRequest | undefined> {
    const [row] = await this.db
      .select()
      .from(vaultRequests)
      .where(requestKey(userId, kind, subject))
      .limit(1);
    return row && row.createdAt.getTime() >= Date.now() - VAULT_REQUEST_TTL_MS ? toRequest(row) : undefined;
  }

  /**
   * Lets the requester in: seals the private key to each of its public keys, which become wraps of
   * its kind. The vault must be open in this request (another browser of the same user). False if
   * the request is gone or expired.
   */
  async approve(
    userId: string,
    vault: UnlockedVault,
    kind: VaultRequestKind,
    subject: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [request] = await tx
        .delete(vaultRequests)
        .where(requestKey(userId, kind, subject))
        .returning();
      if (!request || request.createdAt.getTime() < Date.now() - VAULT_REQUEST_TTL_MS) return false;
      for (const key of request.keys) {
        const wrapped = vault.sealTo(
          VaultPublicKey.decode(key.publicKey),
          vaultWrapContext(userId, kind, key.ref),
        );
        await tx
          .insert(vaultWraps)
          .values({ userId, kind, ref: key.ref, wrapped })
          .onConflictDoUpdate({
            target: [vaultWraps.userId, vaultWraps.kind, vaultWraps.ref],
            set: { wrapped, createdAt: new Date(), lastUsedAt: null },
          });
      }
      return true;
    });
  }

  async deny(userId: string, kind: VaultRequestKind, subject: string): Promise<void> {
    await this.db.delete(vaultRequests).where(requestKey(userId, kind, subject));
  }

  /** A revoked AI app or token: its request goes with it (any user, by subject). */
  async removeRequests(kind: VaultRequestKind, subjects: string[], db: DbExecutor = this.db): Promise<void> {
    if (subjects.length === 0) return;
    await db
      .delete(vaultRequests)
      .where(and(eq(vaultRequests.kind, kind), inArray(vaultRequests.subject, subjects)));
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
