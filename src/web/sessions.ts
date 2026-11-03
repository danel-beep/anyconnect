import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { users, webSessions } from '../db/schema.js';
import { generateToken, hashToken } from '../lib/crypto.js';

export type SessionUser = typeof users.$inferSelect;

/** Server-side browser sessions; the cookie holds a random token, the database only its hash. */
export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly ttlSeconds: number,
  ) {}

  async create(
    userId: string,
    meta: { ip?: string | undefined; userAgent?: string | undefined },
  ): Promise<string> {
    const token = generateToken('ac_ses');
    await this.db.insert(webSessions).values({
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + this.ttlSeconds * 1000),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    });
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
    return token;
  }

  async get(token: string | undefined): Promise<SessionUser | undefined> {
    if (!token?.startsWith('ac_ses_')) return undefined;
    const tokenHash = hashToken(token);
    const [row] = await this.db
      .select({ user: users, lastSeenAt: webSessions.lastSeenAt })
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
    return row.user;
  }

  async destroy(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.db.delete(webSessions).where(eq(webSessions.tokenHash, hashToken(token)));
  }
}
