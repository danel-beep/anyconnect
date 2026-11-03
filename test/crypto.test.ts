import { describe, expect, it } from 'vitest';
import { generateKey, hashPassword, parseKey, SecretBox, verifyPassword } from '../src/lib/crypto.js';

describe('SecretBox', () => {
  const key = generateKey();

  it('round-trips JSON and never stores plaintext', () => {
    const box = new SecretBox(key);
    const envelope = box.encryptJson({ token: 'super-secret' }, 'account:1');
    expect(envelope).toMatch(/^v1\.[\w-]{8}\.[\w-]+\.[\w-]+$/);
    expect(envelope).not.toContain('super-secret');
    expect(box.decryptJson(envelope, 'account:1')).toEqual({ token: 'super-secret' });
  });

  it('binds ciphertexts to their context', () => {
    const box = new SecretBox(key);
    const envelope = box.encrypt('x', 'account:1');
    expect(() => box.decrypt(envelope, 'account:2')).toThrow();
  });

  it('detects tampering', () => {
    const box = new SecretBox(key);
    const parts = box.encrypt('hello', 'ctx').split('.');
    const body = Buffer.from(parts[3]!, 'base64url');
    body[0]! ^= 1;
    parts[3] = body.toString('base64url');
    expect(() => box.decrypt(parts.join('.'), 'ctx')).toThrow();
  });

  it('supports key rotation through previous keys', () => {
    const oldBox = new SecretBox(key);
    const envelope = oldBox.encrypt('rotate me', 'ctx');
    const newKey = generateKey();
    const rotated = new SecretBox(newKey, [key]);
    expect(rotated.decrypt(envelope, 'ctx')).toBe('rotate me');
    expect(rotated.needsRotation(envelope)).toBe(true);
    expect(rotated.needsRotation(rotated.encrypt('fresh', 'ctx'))).toBe(false);
    expect(() => new SecretBox(newKey).decrypt(envelope, 'ctx')).toThrow(/unknown key/);
  });

  it('accepts base64, hex and long passphrases but rejects short keys', () => {
    expect(parseKey(Buffer.alloc(32, 1).toString('base64'))).toHaveLength(32);
    expect(parseKey('ab'.repeat(32))).toHaveLength(32);
    expect(parseKey('a passphrase that is definitely longer than 32 chars')).toHaveLength(32);
    expect(() => parseKey('short')).toThrow();
  });

  it('derives distinct purpose keys', () => {
    const box = new SecretBox(key);
    expect(box.deriveKey('csrf').equals(box.deriveKey('signing'))).toBe(false);
  });
});

describe('passwords', () => {
  it('hashes with scrypt and verifies', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});
