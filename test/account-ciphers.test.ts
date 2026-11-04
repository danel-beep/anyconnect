import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountKeyring } from '../src/core/account-keys.js';
import { accounts, workspaces } from '../src/db/schema.js';
import { SecretBox } from '../src/lib/crypto.js';
import { AccountCiphers } from '../src/messaging/ciphers.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

describe('per-account messenger ciphers', () => {
  let hub: TestHub;

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ seed: false });
  });

  afterAll(async () => {
    await hub?.close();
  });

  async function insertAccount(id: string, dataKeyEncrypted: string | null) {
    const [workspace] = await hub.services.db.select().from(workspaces).limit(1);
    await hub.services.db.insert(accounts).values({
      id,
      workspaceId: workspace!.id,
      connectorId: 'telegram',
      name: id,
      label: id,
      dataKeyEncrypted,
    });
  }

  it('caches opened keys, bounds the cache and fails for unknown accounts', async () => {
    const secrets = new SecretBox(Buffer.alloc(32, 7).toString('base64'));
    const keyring = new AccountKeyring(secrets, secrets);
    let now = 0;
    const ciphers = new AccountCiphers(hub.services.db, keyring, {
      ttlMs: 1_000,
      maxEntries: 2,
      now: () => now,
    });
    await insertAccount('acc_cipher_a', keyring.createKey('acc_cipher_a').wrapped);
    await insertAccount('acc_cipher_b', keyring.createKey('acc_cipher_b').wrapped);
    await insertAccount('acc_cipher_legacy', null);

    const a = await ciphers.forAccount('acc_cipher_a');
    expect(await ciphers.forAccount('acc_cipher_a')).toBe(a);
    const envelope = a.encryptJson({ text: 'hi' }, 'ctx');
    expect(envelope).toMatch(/^d1\./);
    expect(a.decryptJson(envelope, 'ctx')).toEqual({ text: 'hi' });
    expect(() => a.decryptJson(envelope, 'other-ctx')).toThrow();

    // An account without a data key yet keeps using the master key, readable after its upgrade.
    const legacy = await ciphers.forAccount('acc_cipher_legacy');
    const old = legacy.encryptJson({ text: 'old' }, 'ctx');
    expect(old).not.toMatch(/^d1\./);
    expect(secrets.decryptJson(old, 'ctx')).toEqual({ text: 'old' });

    // The cache holds two keys: loading b evicts a, the least recently used, so a is opened again.
    await ciphers.forAccount('acc_cipher_b');
    expect(await ciphers.forAccount('acc_cipher_a')).not.toBe(a);

    // Expired entries are reloaded too.
    const fresh = await ciphers.forAccount('acc_cipher_a');
    now += 1_001;
    expect(await ciphers.forAccount('acc_cipher_a')).not.toBe(fresh);
    expect((await ciphers.forAccount('acc_cipher_a')).decryptJson(envelope, 'ctx')).toEqual({ text: 'hi' });

    await expect(ciphers.forAccount('acc_missing')).rejects.toThrow(/not found/);
    // A failed load is not cached.
    await insertAccount('acc_missing', keyring.createKey('acc_missing').wrapped);
    await expect(ciphers.forAccount('acc_missing')).resolves.toBeDefined();
  });
});
