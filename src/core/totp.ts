import { and, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { DbExecutor } from '../db/client.js';
import { userTotp } from '../db/schema.js';
import type { SecretBox } from '../lib/crypto.js';
import { conflict } from '../lib/errors.js';
import { base32Decode, generateTotpSecret, otpauthUri, verifyTotp } from '../lib/totp.js';

export interface TotpEnrollment {
  secret: string;
  uri: string;
}

const aad = (userId: string) => `user:${userId}:totp`;

/** Authenticator-app codes: enrollment (active only after a valid code), verification, removal. */
export class TotpService {
  constructor(
    private readonly db: DbExecutor,
    private readonly secrets: SecretBox,
    private readonly issuer: string,
    private readonly now: () => number = Date.now,
  ) {}

  async isEnabled(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ userId: userTotp.userId })
      .from(userTotp)
      .where(and(eq(userTotp.userId, userId), isNotNull(userTotp.confirmedAt)))
      .limit(1);
    return Boolean(row);
  }

  /** Starts (or restarts) enrollment with a fresh secret. Sign-in keeps working without it until confirmed. */
  async beginEnrollment(user: { id: string; email: string }): Promise<TotpEnrollment> {
    if (await this.isEnabled(user.id)) throw conflict('An authenticator app is already set up');
    const secret = generateTotpSecret();
    const secretEncrypted = this.secrets.encrypt(secret, aad(user.id));
    await this.db
      .insert(userTotp)
      .values({ userId: user.id, secretEncrypted })
      .onConflictDoUpdate({
        target: userTotp.userId,
        set: { secretEncrypted, confirmedAt: null, lastUsedStep: null, createdAt: new Date(this.now()) },
      });
    return { secret, uri: this.uri(secret, user.email) };
  }

  /** The enrollment waiting for confirmation, if any. */
  async pendingEnrollment(user: { id: string; email: string }): Promise<TotpEnrollment | undefined> {
    const [row] = await this.db
      .select()
      .from(userTotp)
      .where(and(eq(userTotp.userId, user.id), isNull(userTotp.confirmedAt)))
      .limit(1);
    if (!row) return undefined;
    const secret = this.secrets.decrypt(row.secretEncrypted, aad(user.id));
    return { secret, uri: this.uri(secret, user.email) };
  }

  /** Activates a pending enrollment when the code is valid. */
  async confirm(userId: string, code: string): Promise<boolean> {
    return this.check(userId, code, { pending: true });
  }

  /** Checks a sign-in code. Each time step is accepted once (replay protection). */
  async verify(userId: string, code: string): Promise<boolean> {
    return this.check(userId, code, { pending: false });
  }

  async disable(userId: string): Promise<void> {
    await this.db.delete(userTotp).where(eq(userTotp.userId, userId));
  }

  private async check(userId: string, code: string, opts: { pending: boolean }): Promise<boolean> {
    const state = opts.pending ? isNull(userTotp.confirmedAt) : isNotNull(userTotp.confirmedAt);
    const [row] = await this.db
      .select()
      .from(userTotp)
      .where(and(eq(userTotp.userId, userId), state))
      .limit(1);
    if (!row) return false;
    const secret = base32Decode(this.secrets.decrypt(row.secretEncrypted, aad(userId)));
    const step = verifyTotp(secret, code, { timeMs: this.now() });
    if (step === undefined) return false;
    // Conditional update: a concurrent request with the same code loses the race.
    const updated = await this.db
      .update(userTotp)
      .set({
        lastUsedStep: step,
        ...(opts.pending ? { confirmedAt: new Date(this.now()) } : {}),
      })
      .where(
        and(
          eq(userTotp.userId, userId),
          state,
          or(isNull(userTotp.lastUsedStep), lt(userTotp.lastUsedStep, step)),
        ),
      )
      .returning({ userId: userTotp.userId });
    return updated.length > 0;
  }

  private uri(secret: string, email: string): string {
    return otpauthUri({ secret, issuer: this.issuer, account: email });
  }
}
