import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { emailLogins } from '../db/schema.js';
import { generateToken, hashToken } from '../lib/crypto.js';

export const EMAIL_LOGIN_TTL_SECONDS = 15 * 60;

export interface EmailLogin {
  /** The address the link was sent to. */
  email: string;
  /** Where to go after signing in. */
  next: string;
}

/**
 * Sign-in links sent by email. The mail holds a random token, the database only its hash; a link
 * lasts 15 minutes and works once. Opening the link only shows a confirmation page (mail scanners
 * that follow links do not use it up); the sign-in happens when the person presses the button.
 */
export class EmailLoginService {
  /**
   * @param enabled Whether the hub can deliver mail (a real provider, not `none` or `log`); without
   * it the sign-in pages do not offer a link.
   */
  constructor(
    private readonly db: Db,
    readonly enabled: boolean,
  ) {}

  async create(email: string, next: string): Promise<string> {
    const token = generateToken('ac_el');
    await this.db.insert(emailLogins).values({
      tokenHash: hashToken(token),
      email,
      next,
      expiresAt: new Date(Date.now() + EMAIL_LOGIN_TTL_SECONDS * 1000),
    });
    return token;
  }

  async get(token: string | undefined): Promise<EmailLogin | undefined> {
    if (!token?.startsWith('ac_el_')) return undefined;
    const [row] = await this.db
      .select()
      .from(emailLogins)
      .where(and(eq(emailLogins.tokenHash, hashToken(token)), gt(emailLogins.expiresAt, new Date())))
      .limit(1);
    return row ? { email: row.email, next: row.next } : undefined;
  }

  /** Deletes and returns the link, so it signs in only once. */
  async consume(token: string | undefined): Promise<EmailLogin | undefined> {
    if (!token?.startsWith('ac_el_')) return undefined;
    const [row] = await this.db
      .delete(emailLogins)
      .where(and(eq(emailLogins.tokenHash, hashToken(token)), gt(emailLogins.expiresAt, new Date())))
      .returning();
    return row ? { email: row.email, next: row.next } : undefined;
  }
}
