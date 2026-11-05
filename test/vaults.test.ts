import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VaultLockedError, VaultService } from '../src/core/vaults.js';
import { users, vaultWraps } from '../src/db/schema.js';
import { generateToken } from '../src/lib/crypto.js';
import { tokenSecret } from '../src/lib/vault.js';
import { ADMIN, resetDatabase, startTestHub, type TestHub } from './helpers.js';

describe('user vaults (storage)', () => {
  let hub: TestHub;
  let userId: string;
  let vaults: VaultService;

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ seed: false });
    const [owner] = await hub.services.db.select().from(users).where(eq(users.email, ADMIN.email));
    userId = owner!.id;
    vaults = new VaultService(hub.services.db);
  });

  afterAll(async () => {
    await hub.close();
  });

  /** A vault created the default way: wrapped under the first browser's device key. */
  async function newVault() {
    const user = await newUser();
    const session = generateToken('ac_ses');
    const vault = await vaults.create(user.id, {
      kind: 'device',
      ref: 'ses_1',
      secret: tokenSecret(session),
    });
    return { userId: user.id, vault, session };
  }

  it('protects by default: the vault is created under the first browser, with no extra step', async () => {
    const session = generateToken('ac_ses');
    const vault = await vaults.create(userId, {
      kind: 'device',
      ref: 'ses_0',
      secret: tokenSecret(session),
    });
    expect(await vaults.exists(userId)).toBe(true);
    const rows = await hub.services.db.select().from(vaultWraps).where(eq(vaultWraps.userId, userId));
    expect(rows.map((r) => r.kind)).toEqual(['device']);
    // Nothing stored is the secret: the browser keeps the secret.
    expect(rows[0]!.wrapped).not.toContain(session);
    const reopened = await vaults.unlock(userId, 'device', 'ses_0', tokenSecret(session));
    expect(reopened.publicKey.encoded).toBe(vault.publicKey.encoded);
    await expect(
      vaults.create(userId, { kind: 'device', ref: 'ses_x', secret: randomBytes(32) }),
    ).rejects.toThrow();
  });

  it('opens with a token wrap and stops opening once the token rotates or is revoked', async () => {
    const { userId: owner, vault } = await newVault();
    const first = generateToken('ac_rt');
    await vaults.addWrap(owner, vault, 'oauth', 'grant_1', tokenSecret(first));
    await expect(vaults.unlock(owner, 'oauth', 'grant_1', tokenSecret(first))).resolves.toBeDefined();

    const second = generateToken('ac_rt');
    await vaults.rotateWrap(owner, 'oauth', 'grant_1', tokenSecret(first), {
      ref: 'grant_1',
      secret: tokenSecret(second),
    });
    await expect(vaults.unlock(owner, 'oauth', 'grant_1', tokenSecret(first))).rejects.toBeInstanceOf(
      VaultLockedError,
    );
    await expect(vaults.unlock(owner, 'oauth', 'grant_1', tokenSecret(second))).resolves.toBeDefined();

    await vaults.removeWrap(owner, 'oauth', 'grant_1');
    await expect(vaults.unlock(owner, 'oauth', 'grant_1', tokenSecret(second))).rejects.toBeInstanceOf(
      VaultLockedError,
    );
  });

  it('never opens without the secret, with a wrong one, or with another user’s wrap', async () => {
    const a = await newVault();
    const b = await newVault();
    await expect(vaults.unlock(a.userId, 'device', 'ses_1', randomBytes(32))).rejects.toBeInstanceOf(
      VaultLockedError,
    );
    await expect(vaults.unlock(a.userId, 'device', 'other', tokenSecret(a.session))).rejects.toBeInstanceOf(
      VaultLockedError,
    );
    await expect(vaults.unlock(a.userId, 'device', 'ses_1', tokenSecret(b.session))).rejects.toBeInstanceOf(
      VaultLockedError,
    );

    // Copy A's wrap onto B's row: the context and the public key check both reject it.
    const secret = randomBytes(32);
    await vaults.addWrap(a.userId, a.vault, 'api_token', 'tok_1', secret);
    const [wrap] = await hub.services.db.select().from(vaultWraps).where(eq(vaultWraps.ref, 'tok_1'));
    await hub.services.db.insert(vaultWraps).values({ ...wrap!, userId: b.userId });
    await expect(vaults.unlock(b.userId, 'api_token', 'tok_1', secret)).rejects.toBeInstanceOf(
      VaultLockedError,
    );
  });

  it('adds an optional recovery key and replaces it', async () => {
    const { userId: owner, vault } = await newVault();
    await expect(vaults.unlockWithRecoveryKey(owner, 'AAAA-BBBB')).rejects.toBeInstanceOf(VaultLockedError);
    const first = await vaults.setRecoveryKey(owner, vault);
    await expect(vaults.unlockWithRecoveryKey(owner, first)).resolves.toBeDefined();
    const next = await vaults.setRecoveryKey(owner, vault);
    await expect(vaults.unlockWithRecoveryKey(owner, first)).rejects.toBeInstanceOf(VaultLockedError);
    await expect(vaults.unlockWithRecoveryKey(owner, next)).resolves.toBeDefined();
  });

  let n = 0;
  async function newUser() {
    n++;
    const [row] = await hub.services.db
      .insert(users)
      .values({ id: `usr_vault_${n}`, email: `vault${n}@example.com` })
      .returning();
    return row!;
  }
});
