import { and, eq, gt, sql } from 'drizzle-orm';
import { type AuthMethod, parseAuthMethods } from '../core/auth-methods.js';
import type { Db } from '../db/client.js';
import { users, webSessions } from '../db/schema.js';
import { generateToken, hashToken } from '../lib/crypto.js';

export type SessionUser = typeof users.$inferSelect;

export interface WebSession {
  user: SessionUser;
  /** How the user signed in (RFC 8176 values). */
  amr: AuthMethod[];
  /** Last sign-in or re-confirmation; null for sessions created before this was recorded. */
  authenticatedAt: Date | null;
}

/** Server-side browser sessions; the cookie holds a random token, the database only its hash. */
export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly ttlSeconds: number,
  ) {}

  async create(
    userId: string,
    meta: { amr: AuthMethod[]; ip?: string | undefined; userAgent?: string | undefined },
  ): Promise<string> {
    const token = generateToken('ac_ses');
    const now = new Date();
    await this.db.insert(webSessions).values({
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(now.getTime() + this.ttlSeconds * 1000),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
      amr: [...new Set(meta.amr)],
      authenticatedAt: now,
    });
    await this.db.update(users).set({ lastLoginAt: now }).where(eq(users.id, userId));
    return token;
  }

  async getSession(token: string | undefined): Promise<WebSession | undefined> {
    if (!token?.startsWith('ac_ses_')) return undefined;
    const tokenHash = hashToken(token);
    const [row] = await this.db
      .select({
        user: users,
        lastSeenAt: webSessions.lastSeenAt,
        amr: webSessions.amr,
        authenticatedAt: webSessions.authenticatedAt,
      })
      .from(webSessions)
      .innerJoin(users, eq(users.id, webSessions.userId))
      .where(and(eq(webSessions.tokenHash, tokenHash), gt(webSessions.expiresAt, new Date())))
      .limit(1);
    if (!row) return undefined;
    if (Date.now() - row.lastSeenAt.getTime() > 5 * 60_000) {
      await this.db
        .update(webSessions)
        .set({ lastSeenAt: new Date() })
        .where(eq(webSessions.tokenHash, tokenHash))
        .catch(() => {});
    }
    return { user: row.user, amr: parseAuthMethods(row.amr), authenticatedAt: row.authenticatedAt };
  }

  async get(token: string | undefined): Promise<SessionUser | undefined> {
    return (await this.getSession(token))?.user;
  }

  /**
   * Records a factor proven inside an existing session (e.g. the code that confirmed a new
   * authenticator app), so the session counts as multi-factor without signing in again.
   */
  async addAuthMethod(token: string | undefined, method: AuthMethod): Promise<void> {
    if (!token) return;
    await this.db
      .update(webSessions)
      .set({
        amr: sql`case when ${method} = any(${webSessions.amr}) then ${webSessions.amr}
                 else array_append(${webSessions.amr}, ${method}::text) end`,
      })
      .where(eq(webSessions.tokenHash, hashToken(token)));
  }

  async destroy(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.db.delete(webSessions).where(eq(webSessions.tokenHash, hashToken(token)));
  }
}
