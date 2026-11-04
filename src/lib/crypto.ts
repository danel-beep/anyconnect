import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';

// ---------------------------------------------------------------------------
// Random tokens
// ---------------------------------------------------------------------------

/**
 * Bearer secrets carry a recognizable prefix (helps secret scanners and debugging)
 * followed by 256 bits of randomness. Only their SHA-256 hash is stored.
 */
export type TokenPrefix = 'ac_at' | 'ac_rt' | 'ac_pat' | 'ac_code' | 'ac_ses' | 'ac_cs' | 'ac_mfa';

export function generateToken(prefix: TokenPrefix): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function sha256Base64Url(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function hmac(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('base64url');
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt, no native dependencies)
// ---------------------------------------------------------------------------

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keyLen: 32, maxmem: 64 * 1024 * 1024 };

function scrypt(
  password: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
  keyLen: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, keyLen, { N, r, p, maxmem: SCRYPT.maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keyLen);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join(
    '$',
  );
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(keyB64, 'base64url');
  const actual = await scrypt(
    password,
    Buffer.from(saltB64, 'base64url'),
    Number(n),
    Number(r),
    Number(p),
    expected.length,
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Secret box: authenticated encryption for credentials at rest
// ---------------------------------------------------------------------------

const ENVELOPE_VERSION = 'v1';
const DEV_KEY_MATERIAL = 'anyconnect-insecure-development-key-do-not-use-in-production';

export function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const asBase64 = Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (asBase64.length === 32) return asBase64;
  if (trimmed.length >= 32) {
    // High-entropy passphrase: derive a 256-bit key from it.
    return Buffer.from(
      hkdfSync('sha256', Buffer.from(trimmed, 'utf8'), Buffer.alloc(0), 'anyconnect/master-key', 32),
    );
  }
  throw new Error(
    'Encryption key must be 32 bytes encoded as base64 or hex (generate one with `npm run cli -- keys:generate`)',
  );
}

export function generateKey(): string {
  return randomBytes(32).toString('base64');
}

interface KeyEntry {
  id: string;
  /** AES key derived for the secret box. */
  key: Buffer;
  /** The raw master key, used only as HKDF input for other purposes. */
  master: Buffer;
}

/**
 * AES-256-GCM envelope encryption with key ids, so the master key can be rotated:
 * new data is always encrypted with the primary key, old data stays readable with previous keys.
 *
 * Envelope format: `v1.<keyId>.<iv>.<ciphertext+tag>` (base64url parts).
 * Every encryption is bound to a context string (AAD), e.g. the account id, so a ciphertext
 * copied to another row will not decrypt.
 */
export class SecretBox implements KeyWrapper {
  private readonly primary: KeyEntry;
  private readonly keys = new Map<string, KeyEntry>();
  readonly usingDevelopmentKey: boolean;
  private readonly derivationRoot: Buffer;

  constructor(primaryKey: string | undefined, previousKeys: string[] = []) {
    this.usingDevelopmentKey = primaryKey === undefined;
    const primary = this.entry(primaryKey === undefined ? parseKey(DEV_KEY_MATERIAL) : parseKey(primaryKey));
    this.primary = primary;
    this.keys.set(primary.id, primary);
    for (const raw of previousKeys) {
      const entry = this.entry(parseKey(raw));
      if (!this.keys.has(entry.id)) this.keys.set(entry.id, entry);
    }
    this.derivationRoot = primary.master;
  }

  private entry(master: Buffer): KeyEntry {
    const id = createHash('sha256').update(master).digest('base64url').slice(0, 8);
    const key = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'anyconnect/secret-box/v1', 32));
    return { id, key, master };
  }

  get primaryKeyId(): string {
    return this.primary.id;
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.primary.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return [ENVELOPE_VERSION, this.primary.id, iv.toString('base64url'), body.toString('base64url')].join(
      '.',
    );
  }

  decrypt(envelope: string, context: string): string {
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) throw new Error('Unsupported secret envelope');
    const [, keyId, ivB64, bodyB64] = parts as [string, string, string, string];
    const entry = this.keys.get(keyId);
    if (!entry)
      throw new Error(
        `Secret was encrypted with an unknown key (${keyId}); add it to ENCRYPTION_KEYS_PREVIOUS`,
      );
    const body = Buffer.from(bodyB64, 'base64url');
    if (body.length < 16) throw new Error('Corrupted secret envelope');
    const decipher = createDecipheriv('aes-256-gcm', entry.key, Buffer.from(ivB64, 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString(
      'utf8',
    );
  }

  encryptJson(value: unknown, context: string): string {
    return this.encrypt(JSON.stringify(value), context);
  }

  decryptJson<T = unknown>(envelope: string, context: string): T {
    return JSON.parse(this.decrypt(envelope, context)) as T;
  }

  /** True when the envelope was produced with a non-primary key and should be re-encrypted. */
  needsRotation(envelope: string): boolean {
    return envelope.split('.')[1] !== this.primary.id;
  }

  wrapKey(key: Buffer, context: string): string {
    return this.encrypt(key.toString('base64'), context);
  }

  unwrapKey(wrapped: string, context: string): Buffer {
    const key = Buffer.from(this.decrypt(wrapped, context), 'base64');
    if (key.length !== DATA_KEY_BYTES) throw new Error('Corrupted data key');
    return key;
  }

  needsRewrap(wrapped: string): boolean {
    return this.needsRotation(wrapped);
  }

  /** Derive an independent sub-key for another purpose (CSRF, signing, ...). */
  deriveKey(purpose: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.derivationRoot, Buffer.alloc(0), `anyconnect/${purpose}`, 32));
  }
}

// ---------------------------------------------------------------------------
// Envelope encryption: per-record data keys wrapped by the master key
// ---------------------------------------------------------------------------

const DATA_KEY_BYTES = 32;
const DATA_ENVELOPE_VERSION = 'd1';

/**
 * Wraps (encrypts) data keys with a key-encryption key. Today the master key in the environment
 * ({@link SecretBox}); a KMS/HSM-backed implementation can replace it without touching callers.
 */
export interface KeyWrapper {
  wrapKey(key: Buffer, context: string): string;
  unwrapKey(wrapped: string, context: string): Buffer;
  /** True when the wrapped key should be re-wrapped with the current key-encryption key. */
  needsRewrap(wrapped: string): boolean;
}

/**
 * A data encryption key (DEK) that protects the secrets of one record (e.g. one account).
 * Only the wrapped form is stored; rotating the master key re-wraps the DEKs and never touches
 * the data itself, and deleting the wrapped DEK makes the record's ciphertexts unreadable.
 *
 * Envelope format: `d1.<iv>.<ciphertext+tag>` (base64url), AES-256-GCM with a context string as AAD.
 */
export class DataKey {
  private constructor(private readonly key: Buffer) {}

  static generate(): DataKey {
    return new DataKey(randomBytes(DATA_KEY_BYTES));
  }

  static unwrap(wrapper: KeyWrapper, wrapped: string, context: string): DataKey {
    return new DataKey(wrapper.unwrapKey(wrapped, context));
  }

  static isEnvelope(value: string): boolean {
    return value.startsWith(`${DATA_ENVELOPE_VERSION}.`);
  }

  wrap(wrapper: KeyWrapper, context: string): string {
    return wrapper.wrapKey(this.key, context);
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return [DATA_ENVELOPE_VERSION, iv.toString('base64url'), body.toString('base64url')].join('.');
  }

  decrypt(envelope: string, context: string): string {
    const parts = envelope.split('.');
    if (parts.length !== 3 || parts[0] !== DATA_ENVELOPE_VERSION)
      throw new Error('Unsupported data envelope');
    const body = Buffer.from(parts[2]!, 'base64url');
    if (body.length < 16) throw new Error('Corrupted data envelope');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(parts[1]!, 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString(
      'utf8',
    );
  }

  encryptJson(value: unknown, context: string): string {
    return this.encrypt(JSON.stringify(value), context);
  }

  decryptJson<T = unknown>(envelope: string, context: string): T {
    return JSON.parse(this.decrypt(envelope, context)) as T;
  }
}
