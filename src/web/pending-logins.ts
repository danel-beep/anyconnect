import { and, eq, gt } from 'drizzle-orm';
import { type AuthMethod, parseAuthMethods } from '../core/auth-methods.js';
import type { Db } from '../db/client.js';
import { pendingLogins } from '../db/schema.js';
import { generateToken, hashToken } from '../lib/crypto.js';

export const PENDING_LOGIN_TTL_SECONDS = 5 * 60;

export interface PendingLogin {
  userId: string;
  /** Methods already passed, e.g. `pwd`. */
  amr: AuthMethod[];
}

/**
 * "Password accepted, second factor due": no session exists yet. The cookie holds a random
 * token, the database only its hash; the row expires after five minutes and is deleted on use.
 */
export class PendingLoginService {
  constructor(private readonly db: Db) {}

  async create(userId: string, amr: AuthMethod[]): Promise<string> {
    const token = generateToken('ac_mfa');
    await this.db.insert(pendingLogins).values({
      tokenHash: hashToken(token),
      userId,
      amr,
      expiresAt: new Date(Date.now() + PENDING_LOGIN_TTL_SECONDS * 1000),
    });
    return token;
  }

  async get(token: string | undefined): Promise<PendingLogin | undefined> {
    if (!token?.startsWith('ac_mfa_')) return undefined;
    const [row] = await this.db
      .select()
      .from(pendingLogins)
      .where(and(eq(pendingLogins.tokenHash, hashToken(token)), gt(pendingLogins.expiresAt, new Date())))
      .limit(1);
    return row ? { userId: row.userId, amr: parseAuthMethods(row.amr) } : undefined;
  }

  /** Deletes and returns the pending login, so it can complete only once. */
  async consume(token: string | undefined): Promise<PendingLogin | undefined> {
    if (!token?.startsWith('ac_mfa_')) return undefined;
    const [row] = await this.db
      .delete(pendingLogins)
      .where(and(eq(pendingLogins.tokenHash, hashToken(token)), gt(pendingLogins.expiresAt, new Date())))
      .returning();
    return row ? { userId: row.userId, amr: parseAuthMethods(row.amr) } : undefined;
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.db.delete(pendingLogins).where(eq(pendingLogins.userId, userId));
  }
}
