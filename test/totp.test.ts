import { describe, expect, it } from 'vitest';
import { isRecentAuth, isStrongAuth, parseAuthMethods } from '../src/core/auth-methods.js';
import { normalizeRecoveryCode } from '../src/core/recovery-codes.js';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totp,
  totpStep,
  verifyTotp,
} from '../src/lib/totp.js';
import { qrMatrix } from '../src/web/qr.js';

// RFC 6238 Appendix B: seeds are ASCII "1234567890" repeated to the hash length.
const SEED_SHA1 = Buffer.from('12345678901234567890');
const SEED_SHA256 = Buffer.from('12345678901234567890123456789012');
const SEED_SHA512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234');

const RFC6238: [number, string, string, string][] = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];

describe('TOTP (RFC 6238)', () => {
  for (const [seconds, sha1, sha256, sha512] of RFC6238) {
    it(`matches the RFC test vectors at T=${seconds}`, () => {
      const ms = seconds * 1000;
      expect(totp(SEED_SHA1, ms, { digits: 8 })).toBe(sha1);
      expect(totp(SEED_SHA256, ms, { digits: 8, algorithm: 'sha256' })).toBe(sha256);
      expect(totp(SEED_SHA512, ms, { digits: 8, algorithm: 'sha512' })).toBe(sha512);
    });
  }

  it('matches the HOTP test vectors (RFC 4226 Appendix D)', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583'];
    expected.forEach((code, counter) => {
      expect(hotp(SEED_SHA1, counter)).toBe(code);
    });
  });

  it('accepts one step of clock drift and returns the matched step', () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    const at = (offsetSteps: number) => totp(SEED_SHA1, now + offsetSteps * 30_000);
    expect(verifyTotp(SEED_SHA1, at(0), { timeMs: now })).toBe(step);
    expect(verifyTotp(SEED_SHA1, at(-1), { timeMs: now })).toBe(step - 1);
    expect(verifyTotp(SEED_SHA1, at(1), { timeMs: now })).toBe(step + 1);
    expect(verifyTotp(SEED_SHA1, at(2), { timeMs: now })).toBeUndefined();
    expect(verifyTotp(SEED_SHA1, at(-2), { timeMs: now })).toBeUndefined();
    expect(verifyTotp(SEED_SHA1, '12345', { timeMs: now })).toBeUndefined();
    expect(verifyTotp(SEED_SHA1, 'abcdef', { timeMs: now })).toBeUndefined();
  });

  it('round-trips base32 secrets and builds otpauth URIs', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxw 6ytb-oi').toString()).toBe('foobar');
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    const uri = new URL(otpauthUri({ secret, issuer: 'Manyplug', account: 'a@b.c' }));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host + uri.pathname).toBe('totp/Manyplug:a%40b.c');
    expect(uri.searchParams.get('secret')).toBe(secret);
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
  });

  it('renders a QR code as an SVG path', () => {
    const { size, path } = qrMatrix('otpauth://totp/Manyplug:a?secret=ABC');
    expect(size).toBeGreaterThanOrEqual(21);
    expect(path).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
  });
});

describe('sign-in method helpers', () => {
  it('normalizes recovery codes', () => {
    expect(normalizeRecoveryCode('abcd-efgh 1234-o0il')).toBe('ABCDEFGH12340011');
  });

  it('classifies strong and recent authentication', () => {
    expect(isStrongAuth(['pwd'])).toBe(false);
    expect(isStrongAuth(['pwd', 'otp'])).toBe(true);
    expect(isStrongAuth(['pwd', 'rec'])).toBe(true);
    expect(isStrongAuth(['hwk'])).toBe(true);
    expect(parseAuthMethods(['pwd', 'bogus', 'hwk'])).toEqual(['pwd', 'hwk']);
    const now = Date.now();
    expect(isRecentAuth(new Date(now - 60_000), now)).toBe(true);
    expect(isRecentAuth(new Date(now - 11 * 60_000), now)).toBe(false);
    expect(isRecentAuth(null, now)).toBe(false);
  });
});
