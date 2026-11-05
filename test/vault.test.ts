import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DataKey, generateToken } from '../src/lib/crypto.js';
import {
  generateRecoveryKey,
  isSealedKey,
  recoveryKeySecret,
  tokenSecret,
  UnlockedVault,
  VaultPublicKey,
} from '../src/lib/vault.js';

describe('user vault', () => {
  it('seals data keys to the public key and opens them only with the private key', () => {
    const vault = UnlockedVault.create();
    const sealer = VaultPublicKey.decode(vault.publicKey.encoded);
    const key = DataKey.generate();
    const envelope = key.encryptJson({ token: 'secret' }, 'account:a1:credentials');
    // Sealing needs only the public key: the hub can connect an account it cannot read later.
    const sealed = sealer.sealKey(randomBytes(32), 'account:a1:dek');
    expect(isSealedKey(sealed)).toBe(true);
    expect(vault.unwrapKey(sealed, 'account:a1:dek')).toHaveLength(32);

    const wrapped = key.wrap(vault, 'account:a1:dek');
    const reopened = DataKey.unwrap(vault, wrapped, 'account:a1:dek');
    expect(reopened.decryptJson(envelope, 'account:a1:credentials')).toEqual({ token: 'secret' });
  });

  it('binds sealed keys to their context and to their vault', () => {
    const vault = UnlockedVault.create();
    const other = UnlockedVault.create();
    const sealed = vault.wrapKey(randomBytes(32), 'account:a1:dek');
    expect(() => vault.unwrapKey(sealed, 'account:a2:dek')).toThrow();
    expect(() => other.unwrapKey(sealed, 'account:a1:dek')).toThrow();
  });

  it('opens from a token wrap, and never from a wrong token, context or vault', () => {
    const vault = UnlockedVault.create();
    const token = generateToken('ac_rt');
    const wrap = vault.wrap(tokenSecret(token), 'vault:u1:oauth:g1');
    const opened = UnlockedVault.unwrap(
      wrap,
      tokenSecret(token),
      'vault:u1:oauth:g1',
      vault.publicKey.encoded,
    );
    const sealed = vault.wrapKey(randomBytes(32), 'ctx');
    expect(opened.unwrapKey(sealed, 'ctx')).toEqual(vault.unwrapKey(sealed, 'ctx'));

    expect(() =>
      UnlockedVault.unwrap(
        wrap,
        tokenSecret(generateToken('ac_rt')),
        'vault:u1:oauth:g1',
        vault.publicKey.encoded,
      ),
    ).toThrow();
    expect(() =>
      UnlockedVault.unwrap(wrap, tokenSecret(token), 'vault:u1:oauth:g2', vault.publicKey.encoded),
    ).toThrow();
    // A wrap of another vault's key swapped into this user's row is rejected.
    const foreign = UnlockedVault.create().wrap(tokenSecret(token), 'vault:u1:oauth:g1');
    expect(() =>
      UnlockedVault.unwrap(foreign, tokenSecret(token), 'vault:u1:oauth:g1', vault.publicKey.encoded),
    ).toThrow(/does not belong/);
  });

  it('never stores the private key in a recognizable form', () => {
    const vault = UnlockedVault.create();
    const secret = randomBytes(32);
    const a = vault.wrap(secret, 'ctx');
    const b = vault.wrap(secret, 'ctx');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^w1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('rejects low-entropy secrets', () => {
    expect(() => UnlockedVault.create().wrap(Buffer.from('password'), 'ctx')).toThrow(/256 bits/);
  });

  it('recovery keys round-trip regardless of case and separators', () => {
    const vault = UnlockedVault.create();
    const recovery = generateRecoveryKey();
    expect(recovery).toMatch(/^([A-Z2-9]{4}-){12}[A-Z2-9]{4}$/);
    const wrap = vault.wrap(recoveryKeySecret(recovery), 'vault:u1:recovery');
    const typed = recovery.toLowerCase().replaceAll('-', ' ');
    expect(() =>
      UnlockedVault.unwrap(wrap, recoveryKeySecret(typed), 'vault:u1:recovery', vault.publicKey.encoded),
    ).not.toThrow();
    expect(() => recoveryKeySecret('ABCD-EFGH')).toThrow();
  });
});
