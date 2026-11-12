import type { AuthMethod } from './auth-methods.js';
import type { PasskeyService } from './passkeys.js';
import type { RecoveryCodeService } from './recovery-codes.js';
import type { TotpService } from './totp.js';

export interface SecondFactorSummary {
  totp: boolean;
  passkeys: number;
  /** Unused recovery codes. */
  recoveryCodes: number;
}

/** Recovery codes alone are not a factor: they only back up TOTP or passkeys. */
export const hasSecondFactor = (summary: SecondFactorSummary): boolean =>
  summary.totp || summary.passkeys > 0;

/**
 * One place for the rules that span all second factors: what counts as one, which code a user
 * typed, and that recovery codes go away together with the last factor.
 */
export class SecondFactorService {
  constructor(
    readonly totp: TotpService,
    readonly recoveryCodes: RecoveryCodeService,
    readonly passkeys: PasskeyService,
  ) {}

  async summary(userId: string): Promise<SecondFactorSummary> {
    const [totp, passkeys, recoveryCodes] = await Promise.all([
      this.totp.isEnabled(userId),
      this.passkeys.count(userId),
      this.recoveryCodes.remaining(userId),
    ]);
    return { totp, passkeys, recoveryCodes };
  }

  async hasAny(userId: string): Promise<boolean> {
    return hasSecondFactor(await this.summary(userId));
  }

  /** A six-digit code is checked as TOTP, anything else as a recovery code. */
  async verifyCode(userId: string, code: string): Promise<AuthMethod | undefined> {
    const trimmed = code.replace(/\s/g, '');
    if (/^\d{6}$/.test(trimmed)) return (await this.totp.verify(userId, trimmed)) ? 'otp' : undefined;
    if (!(await this.hasAny(userId))) return undefined;
    return (await this.recoveryCodes.consume(userId, trimmed)) ? 'rec' : undefined;
  }

  async disableTotp(userId: string): Promise<void> {
    await this.totp.disable(userId);
    await this.dropOrphanedRecoveryCodes(userId);
  }

  /** Returns the removed passkey's name. */
  async removePasskey(userId: string, passkeyId: string): Promise<string> {
    const name = await this.passkeys.remove(userId, passkeyId);
    await this.dropOrphanedRecoveryCodes(userId);
    return name;
  }

  /** Break-glass reset (admin CLI): removes every second factor of the user. */
  async reset(userId: string): Promise<SecondFactorSummary> {
    const before = await this.summary(userId);
    await this.totp.disable(userId);
    await this.passkeys.removeAll(userId);
    await this.recoveryCodes.clear(userId);
    return before;
  }

  private async dropOrphanedRecoveryCodes(userId: string): Promise<void> {
    if (!(await this.hasAny(userId))) await this.recoveryCodes.clear(userId);
  }
}
