import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238) on top of HOTP (RFC 4226), with the parameters every
 * authenticator app supports: HMAC-SHA-1, 6 digits, 30-second steps.
 */
export const TOTP = { digits: 6, periodSeconds: 30, algorithm: 'SHA1' } as const;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding (the format authenticator apps expect). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret (the size RFC 4226 recommends for SHA-1), base32 encoded. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** HOTP value for a counter (RFC 4226 §5.3, dynamic truncation). */
export function hotp(
  secret: Buffer,
  counter: number,
  digits: number = TOTP.digits,
  algorithm = 'sha1',
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The time step a moment falls into. */
export function totpStep(timeMs: number, periodSeconds: number = TOTP.periodSeconds): number {
  return Math.floor(timeMs / 1000 / periodSeconds);
}

export function totp(secret: Buffer, timeMs: number, options: { digits?: number; algorithm?: string } = {}) {
  return hotp(secret, totpStep(timeMs), options.digits ?? TOTP.digits, options.algorithm ?? 'sha1');
}

/**
 * Checks a code against the current step and `window` steps around it (clock drift).
 * Returns the matched step, so callers can reject reuse of the same or an older step.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  options: { timeMs?: number; window?: number } = {},
): number | undefined {
  const normalized = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return undefined;
  const current = totpStep(options.timeMs ?? Date.now());
  const window = options.window ?? 1;
  let matched: number | undefined;
  // Check every candidate (no early exit) so timing does not reveal which step matched.
  for (let step = current - window; step <= current + window; step++) {
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(normalized)) && matched === undefined) matched = step;
  }
  return matched;
}

/** `otpauth://` URI understood by authenticator apps (also encoded in the QR code). */
export function otpauthUri(input: { secret: string; issuer: string; account: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: TOTP.algorithm,
    digits: String(TOTP.digits),
    period: String(TOTP.periodSeconds),
  });
  return `otpauth://totp/${label}?${params}`;
}
