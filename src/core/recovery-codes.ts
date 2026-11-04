import { randomBytes } from 'node:crypto';
import { and, count, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { userRecoveryCodes } from '../db/schema.js';
import { hashToken } from '../lib/crypto.js';

export const RECOVERY_CODE_COUNT = 10;

/** Crockford base32: no I, L, O, U, so codes are easy to read and type. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 16 characters = 80 random bits, shown as XXXX-XXXX-XXXX-XXXX. */
function newCode(): string {
  const bytes = randomBytes(16);
  let code = '';
  for (const byte of bytes) code += ALPHABET[byte & 31];
  return code.match(/.{4}/g)!.join('-');
}

/** Uppercases and drops separators; maps look-alike letters the way Crockford base32 does. */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

const hashCode = (userId: string, normalized: string) => hashToken(`${userId}:${normalized}`);

/** Single-use codes for when the authenticator is lost. Only hashes are stored. */
export class RecoveryCodeService {
  constructor(private readonly db: Db) {}

  /** Replaces all codes of the user. The returned codes cannot be shown again. */
  async regenerate(userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newCode);
    await this.db.transaction(async (tx) => {
      await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
      await tx
        .insert(userRecoveryCodes)
        .values(codes.map((code) => ({ userId, codeHash: hashCode(userId, normalizeRecoveryCode(code)) })));
    });
    return codes;
  }

  /** Marks the code used; true only the first time a valid code is presented. */
  async consume(userId: string, input: string): Promise<boolean> {
    const normalized = normalizeRecoveryCode(input);
    if (normalized.length !== 16) return false;
    const used = await this.db
      .update(userRecoveryCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(userRecoveryCodes.codeHash, hashCode(userId, normalized)),
          eq(userRecoveryCodes.userId, userId),
          isNull(userRecoveryCodes.usedAt),
        ),
      )
      .returning({ codeHash: userRecoveryCodes.codeHash });
    return used.length > 0;
  }

  async remaining(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(userRecoveryCodes)
      .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
    return row?.n ?? 0;
  }

  async clear(userId: string): Promise<void> {
    await this.db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
  }
}
