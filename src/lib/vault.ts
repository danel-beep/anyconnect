import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto';
import type { KeyWrapper } from './crypto.js';

/**
 * User vaults: the key material that makes accounts "sealed".
 *
 * Every user has an X25519 key pair. Account data keys are sealed to the user's PUBLIC key, so the
 * hub can connect a new account (or store an incoming message) without being able to read it
 * later. The PRIVATE key is never stored in the clear and never wrapped by `ENCRYPTION_KEY`: it is
 * only stored wrapped under secrets the hub does not keep, such as a passkey PRF output, a
 * recovery key, or a bearer token an AI app presents (only its hash is stored). So a copy of the
 * database, a backup, the environment variables or the admin panel opens no account; a vault opens
 * only for the length of a request that brings one of those secrets.
 *
 * Formats (base64url parts, AES-256-GCM, the context string as AAD):
 * - sealed key `s1.<ephemeral public key>.<iv>.<ciphertext+tag>`: ECIES to the vault public key
 * - wrapped private key `w1.<salt>.<iv>.<ciphertext+tag>`: under a key derived from a secret
 */

const SEALED_VERSION = 's1';
const WRAPPED_VERSION = 'w1';
const KEY_BYTES = 32;
// HKDF labels keep the former product name, like the rest of the crypto labels (see `LEGACY_SLUGS`).
const SEAL_INFO = 'anyconnect/vault/seal/v1';
const WRAP_INFO = 'anyconnect/vault/wrap/v1';
/** Bearer tokens and passkey PRF outputs carry at least this much entropy; HKDF is enough for them. */
const MIN_SECRET_BYTES = 32;

function seal(key: Buffer, plaintext: Buffer, context: string): { iv: Buffer; body: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  return { iv, body: Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]) };
}

function open(key: Buffer, iv: Buffer, body: Buffer, context: string): Buffer {
  if (body.length < 16) throw new Error('Corrupted vault envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
}

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

function rawPublic(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' });
  if (!jwk.x) throw new Error('Not an X25519 public key');
  return unb64(jwk.x);
}

function publicFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== KEY_BYTES) throw new Error('Invalid vault public key');
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64(raw) }, format: 'jwk' });
}

/** PKCS#8 header of an X25519 private key (RFC 8410); the raw 32-byte key follows it. */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function privateFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== KEY_BYTES) throw new Error('Invalid vault private key');
  return createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
}

/** The public half of a vault: enough to seal keys to it, never to open them. */
export class VaultPublicKey {
  private constructor(
    private readonly key: KeyObject,
    /** Raw 32-byte key, base64url: what is stored in `user_vaults.public_key`. */
    readonly encoded: string,
  ) {}

  static decode(encoded: string): VaultPublicKey {
    return new VaultPublicKey(publicFromRaw(unb64(encoded)), encoded);
  }

  /** Seals a data key to this vault (ECIES: ephemeral X25519, HKDF-SHA256, AES-256-GCM). */
  sealKey(dataKey: Buffer, context: string): string {
    const { publicKey: ephPublic, privateKey: ephPrivate } = generateKeyPairSync('x25519');
    const shared = diffieHellman({ privateKey: ephPrivate, publicKey: this.key });
    const eph = rawPublic(ephPublic);
    const kek = Buffer.from(
      hkdfSync('sha256', shared, Buffer.concat([eph, unb64(this.encoded)]), SEAL_INFO, KEY_BYTES),
    );
    const { iv, body } = seal(kek, dataKey, context);
    return [SEALED_VERSION, b64(eph), b64(iv), b64(body)].join('.');
  }
}

/**
 * An opened vault. It exists only in memory, for the request that brought the secret, and is a
 * {@link KeyWrapper}: data keys sealed to the vault can be wrapped and unwrapped with it.
 */
export class UnlockedVault implements KeyWrapper {
  private constructor(
    private readonly privateKey: KeyObject,
    private readonly raw: Buffer,
    readonly publicKey: VaultPublicKey,
  ) {}

  /** A new vault: the caller stores `publicKey.encoded` and at least one wrap of the private key. */
  static create(): UnlockedVault {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const d = privateKey.export({ format: 'jwk' }).d;
    if (!d) throw new Error('Could not create a vault key');
    return new UnlockedVault(privateKey, unb64(d), VaultPublicKey.decode(b64(rawPublic(publicKey))));
  }

  /**
   * Opens a vault from one of its wraps. Throws when the secret or the context is wrong, or when the
   * private key does not match the stored public key (a wrap swapped in from another vault).
   */
  static unwrap(wrapped: string, secret: Buffer, context: string, publicKey: string): UnlockedVault {
    const parts = wrapped.split('.');
    if (parts.length !== 4 || parts[0] !== WRAPPED_VERSION) throw new Error('Unsupported vault wrap');
    const [, salt, iv, body] = parts as [string, string, string, string];
    const raw = open(wrapKeyFrom(secret, unb64(salt)), unb64(iv), unb64(body), context);
    const privateKey = privateFromRaw(raw);
    const derived = b64(rawPublic(createPublicKey(privateKey)));
    if (derived !== publicKey) throw new Error('Vault wrap does not belong to this vault');
    return new UnlockedVault(privateKey, raw, VaultPublicKey.decode(publicKey));
  }

  /**
   * Wraps the private key under a high-entropy secret (a bearer token, a passkey PRF output, a
   * recovery key). The context names what the wrap is for, so a wrap cannot be moved to another row.
   */
  wrap(secret: Buffer, context: string): string {
    const salt = randomBytes(16);
    const { iv, body } = seal(wrapKeyFrom(secret, salt), this.raw, context);
    return [WRAPPED_VERSION, b64(salt), b64(iv), b64(body)].join('.');
  }

  wrapKey(key: Buffer, context: string): string {
    return this.publicKey.sealKey(key, context);
  }

  unwrapKey(wrapped: string, context: string): Buffer {
    const parts = wrapped.split('.');
    if (parts.length !== 4 || parts[0] !== SEALED_VERSION) throw new Error('Unsupported sealed key');
    const [, ephB64, iv, body] = parts as [string, string, string, string];
    const eph = unb64(ephB64);
    const shared = diffieHellman({ privateKey: this.privateKey, publicKey: publicFromRaw(eph) });
    const kek = Buffer.from(
      hkdfSync('sha256', shared, Buffer.concat([eph, unb64(this.publicKey.encoded)]), SEAL_INFO, KEY_BYTES),
    );
    const key = open(kek, unb64(iv), unb64(body), context);
    if (key.length !== KEY_BYTES) throw new Error('Corrupted sealed key');
    return key;
  }

  needsRewrap(): boolean {
    return false;
  }
}

/** True for a data key sealed to a user vault (as opposed to one wrapped by `ENCRYPTION_KEY`). */
export function isSealedKey(wrapped: string): boolean {
  return wrapped.startsWith(`${SEALED_VERSION}.`);
}

function wrapKeyFrom(secret: Buffer, salt: Buffer): Buffer {
  if (secret.length < MIN_SECRET_BYTES) throw new Error('Vault secrets must carry at least 256 bits');
  return Buffer.from(hkdfSync('sha256', secret, salt, WRAP_INFO, KEY_BYTES));
}

/** The secret a bearer token contributes to a vault wrap (the token itself, never its hash). */
export function tokenSecret(token: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(token, 'utf8'), Buffer.alloc(0), 'anyconnect/vault/token', 32),
  );
}

/**
 * A recovery key the user writes down: 32 random bytes shown as groups of base32 characters.
 * Only the user has it; it opens the vault when every passkey is lost.
 */
export function generateRecoveryKey(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(32);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join('-');
}

/** The secret a recovery key contributes (case and separators do not matter when typing it back). */
export function recoveryKeySecret(recoveryKey: string): Buffer {
  const normalized = recoveryKey.toUpperCase().replace(/[^A-Z2-9]/g, '');
  if (normalized.length < 52) throw new Error('Recovery key is too short');
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(normalized, 'utf8'), Buffer.alloc(0), 'anyconnect/vault/recovery', 32),
  );
}
