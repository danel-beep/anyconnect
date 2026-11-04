import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountKeyring, credentialsContext } from '../src/core/account-keys.js';
import { AccountService } from '../src/core/accounts.js';
import { getDefaultWorkspace } from '../src/core/identity.js';
import { accounts } from '../src/db/schema.js';
import { generateKey, SecretBox } from '../src/lib/crypto.js';
import { createLogger } from '../src/logger.js';
import { ADMIN, resetDatabase, startTestHub, TEST_KEY, type TestHub } from './helpers.js';

describe('per-account envelope encryption', () => {
  let hub: TestHub;
  let workspaceId: string;
  const logger = createLogger({ level: 'silent' });

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ seed: false });
    const s = hub.services;
    const owner = await s.database.pool.query('select id from users where email = $1', [ADMIN.email]);
    workspaceId = (await getDefaultWorkspace(s.db, owner.rows[0].id))!.id;
  });

  afterAll(async () => {
    await hub.close();
  });

  const rowOf = async (id: string) => {
    const [row] = await hub.services.db.select().from(accounts).where(eq(accounts.id, id));
    return row!;
  };

  it('gives every new account its own data key and encrypts credentials with it', async () => {
    const s = hub.services;
    const a = await s.accounts.create(workspaceId, {
      connectorId: 'demo',
      label: 'A',
      credentials: { secret: 'secret-a' },
    });
    const b = await s.accounts.create(workspaceId, {
      connectorId: 'demo',
      label: 'B',
      credentials: { secret: 'secret-a' },
    });
    expect(a.dataKeyEncrypted).toMatch(/^v1\./);
    expect(a.credentialsEncrypted).toMatch(/^d1\./);
    expect(a.dataKeyEncrypted).not.toBe(b.dataKeyEncrypted);
    expect(a.credentialsEncrypted).not.toContain('secret-a');
    // Swapping ciphertexts between accounts does not decrypt.
    const keyring = new AccountKeyring(s.secrets, s.secrets);
    expect(() => keyring.decryptCredentials(b, a.credentialsEncrypted!)).toThrow();
    const ctx = await s.accounts.buildContext((await s.connectors.get(workspaceId, 'demo'))!, a, {
      signal: AbortSignal.timeout(1000),
      logger,
    });
    expect(ctx.credentials).toEqual({ secret: 'secret-a' });
  });

  it('keeps reading legacy master-key credentials and upgrades them', async () => {
    const s = hub.services;
    const row = await s.accounts.create(workspaceId, {
      connectorId: 'demo',
      label: 'Legacy',
      credentials: { secret: 'old' },
    });
    // Simulate an account written before envelope encryption.
    await s.db
      .update(accounts)
      .set({
        dataKeyEncrypted: null,
        credentialsEncrypted: s.secrets.encryptJson({ secret: 'old' }, credentialsContext(row.id)),
      })
      .where(eq(accounts.id, row.id));
    const legacy = await rowOf(row.id);
    const ctx = await s.accounts.buildContext((await s.connectors.get(workspaceId, 'demo'))!, legacy, {
      signal: AbortSignal.timeout(1000),
      logger,
    });
    expect(ctx.credentials).toEqual({ secret: 'old' });

    const result = await s.accounts.upgradeEncryption();
    expect(result.upgraded).toBeGreaterThanOrEqual(1);
    const upgraded = await rowOf(row.id);
    expect(upgraded.dataKeyEncrypted).toMatch(/^v1\./);
    expect(upgraded.credentialsEncrypted).toMatch(/^d1\./);
    expect(upgraded.updatedAt.getTime()).toBe(legacy.updatedAt.getTime());
    // Running again is a no-op.
    expect(await s.accounts.upgradeEncryption()).toEqual({ upgraded: 0, rewrapped: 0, failed: 0 });
  });

  it('rotates the master key by re-wrapping data keys only', async () => {
    const s = hub.services;
    const row = await s.accounts.create(workspaceId, {
      connectorId: 'demo',
      label: 'Rotate',
      credentials: { secret: 'rotate-me' },
    });
    const rotatedBox = new SecretBox(generateKey(), [TEST_KEY]);
    const rotated = new AccountService(
      s.db,
      s.connectors,
      new AccountKeyring(rotatedBox, rotatedBox),
      s.network,
    );
    const result = await rotated.upgradeEncryption();
    expect(result.rewrapped).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
    const after = await rowOf(row.id);
    expect(after.credentialsEncrypted).toBe(row.credentialsEncrypted);
    expect(after.dataKeyEncrypted).not.toBe(row.dataKeyEncrypted);
    expect(rotatedBox.needsRewrap(after.dataKeyEncrypted!)).toBe(false);
    const ctx = await rotated.buildContext((await s.connectors.get(workspaceId, 'demo'))!, after, {
      signal: AbortSignal.timeout(1000),
      logger,
    });
    expect(ctx.credentials).toEqual({ secret: 'rotate-me' });
    // Without the old key the old master cannot open the new wrapping.
    expect(() => new AccountKeyring(s.secrets, s.secrets).openKey(after)).toThrow();
  });

  it('reports accounts that cannot be decrypted instead of failing startup', async () => {
    const s = hub.services;
    const stranger = new SecretBox(generateKey());
    const service = new AccountService(s.db, s.connectors, new AccountKeyring(stranger, stranger), s.network);
    const result = await service.upgradeEncryption();
    expect(result.failed).toBeGreaterThan(0);
  });
});
