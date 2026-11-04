import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { and, asc, count, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { webauthnChallenges, webauthnCredentials } from '../db/schema.js';
import { hashToken } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';

export type Passkey = typeof webauthnCredentials.$inferSelect;

export interface RelyingParty {
  /** Hostname of the hub, e.g. `hub.example.com`. */
  id: string;
  name: string;
  /** Expected origin of the browser ceremony, e.g. `https://hub.example.com`. */
  origin: string;
}

export type PasskeyErrorCode = 'invalid_response' | 'challenge_expired' | 'unknown_credential' | 'rejected';

/** A failed WebAuthn ceremony. The message is safe to log; pages show a translated text by `code`. */
export class PasskeyError extends AppError {
  constructor(code: PasskeyErrorCode, message: string) {
    super(400, code, message);
    this.name = 'PasskeyError';
  }
}

export const PASSKEY_NAME_MAX = 64;
const CHALLENGE_TTL_MS = 5 * 60_000;

const b64url = z
  .string()
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]*$/);

const credentialBase = {
  id: b64url.min(1),
  rawId: b64url.min(1),
  type: z.literal('public-key'),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
};

const RegistrationResponseSchema = z.object({
  ...credentialBase,
  response: z.object({
    clientDataJSON: b64url,
    attestationObject: b64url,
    transports: z.array(z.string().max(32)).max(10).optional(),
  }),
});

const AuthenticationResponseSchema = z.object({
  ...credentialBase,
  response: z.object({
    clientDataJSON: b64url,
    authenticatorData: b64url,
    signature: b64url,
    userHandle: b64url.optional(),
  }),
});

function parseResponse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new PasskeyError('invalid_response', 'Malformed WebAuthn response');
  return parsed.data;
}

function challengeOf(clientDataJSON: string): string {
  try {
    const data = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as unknown;
    const challenge = (data as { challenge?: unknown }).challenge;
    if (typeof challenge === 'string' && challenge.length > 0) return challenge;
  } catch {
    // fall through
  }
  throw new PasskeyError('invalid_response', 'clientDataJSON has no challenge');
}

const userHandle = (userId: string) => new TextEncoder().encode(userId);

/**
 * WebAuthn credentials: registration, sign-in (as a second factor or passwordless with a
 * discoverable credential) and management. Challenges live in the database, expire after five
 * minutes, are deleted on use and are bound to a browser value supplied by the caller.
 */
export class PasskeyService {
  constructor(
    private readonly db: Db,
    private readonly rp: RelyingParty,
  ) {}

  list(userId: string): Promise<Passkey[]> {
    return this.db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId))
      .orderBy(asc(webauthnCredentials.createdAt));
  }

  async count(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId));
    return row?.n ?? 0;
  }

  async registrationOptions(
    user: { id: string; email: string },
    binding: string,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const existing = await this.list(user.id);
    const options = await generateRegistrationOptions({
      rpName: this.rp.name,
      rpID: this.rp.id,
      userName: user.email,
      userID: userHandle(user.id),
      attestationType: 'none',
      timeout: CHALLENGE_TTL_MS,
      excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    await this.storeChallenge(options.challenge, 'registration', user.id, binding);
    return options;
  }

  async register(userId: string, binding: string, input: unknown, name: string): Promise<Passkey> {
    const response = parseResponse(RegistrationResponseSchema, input) as RegistrationResponseJSON;
    const challenge = await this.consumeChallenge(response.response.clientDataJSON, 'registration', binding);
    if (challenge.userId !== userId) throw new PasskeyError('challenge_expired', 'Challenge user mismatch');
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.rp.origin,
      expectedRPID: this.rp.id,
      requireUserVerification: false,
    }).catch((error: unknown) => {
      throw new PasskeyError('rejected', `Registration rejected: ${(error as Error).message}`);
    });
    if (!result.verified) throw new PasskeyError('rejected', 'Registration not verified');
    const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
    const [row] = await this.db
      .insert(webauthnCredentials)
      .values({
        id: newId('pky'),
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: response.response.transports ?? [],
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        name: name.trim().slice(0, PASSKEY_NAME_MAX),
      })
      .onConflictDoNothing({ target: webauthnCredentials.credentialId })
      .returning();
    if (!row) throw new PasskeyError('rejected', 'Credential is already registered');
    return row;
  }

  /**
   * Options for `navigator.credentials.get()`. With `userId`, a second factor after the password
   * (only that user's credentials); without, a passwordless sign-in with user verification.
   */
  async authenticationOptions(
    binding: string,
    opts: { userId?: string } = {},
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const allowCredentials = opts.userId
      ? (await this.list(opts.userId)).map((c) => ({ id: c.credentialId, transports: c.transports }))
      : undefined;
    const options = await generateAuthenticationOptions({
      rpID: this.rp.id,
      timeout: CHALLENGE_TTL_MS,
      userVerification: opts.userId ? 'discouraged' : 'required',
      ...(allowCredentials ? { allowCredentials } : {}),
    });
    await this.storeChallenge(options.challenge, 'authentication', opts.userId ?? null, binding);
    return options;
  }

  /** Verifies an assertion; `userId` must be what was passed to `authenticationOptions`. */
  async authenticate(
    binding: string,
    input: unknown,
    opts: { userId?: string } = {},
  ): Promise<{ userId: string; passkeyId: string }> {
    const response = parseResponse(AuthenticationResponseSchema, input) as AuthenticationResponseJSON;
    const challenge = await this.consumeChallenge(
      response.response.clientDataJSON,
      'authentication',
      binding,
    );
    if (challenge.userId !== (opts.userId ?? null)) {
      throw new PasskeyError('challenge_expired', 'Challenge flow mismatch');
    }
    const [stored] = await this.db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialId, response.id))
      .limit(1);
    if (!stored || (opts.userId && stored.userId !== opts.userId)) {
      throw new PasskeyError('unknown_credential', 'Unknown credential');
    }
    const handle = response.response.userHandle;
    if (handle && Buffer.from(handle, 'base64url').toString('utf8') !== stored.userId) {
      throw new PasskeyError('unknown_credential', 'User handle does not match the credential');
    }
    const passwordless = !opts.userId;
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.rp.origin,
      expectedRPID: this.rp.id,
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
        counter: stored.counter,
        transports: stored.transports,
      },
      requireUserVerification: passwordless,
    }).catch((error: unknown) => {
      throw new PasskeyError('rejected', `Assertion rejected: ${(error as Error).message}`);
    });
    if (!result.verified) throw new PasskeyError('rejected', 'Assertion not verified');
    await this.db
      .update(webauthnCredentials)
      .set({
        counter: result.authenticationInfo.newCounter,
        backedUp: result.authenticationInfo.credentialBackedUp,
        lastUsedAt: new Date(),
      })
      .where(eq(webauthnCredentials.id, stored.id));
    return { userId: stored.userId, passkeyId: stored.id };
  }

  async rename(userId: string, id: string, name: string): Promise<void> {
    const updated = await this.db
      .update(webauthnCredentials)
      .set({ name: name.trim().slice(0, PASSKEY_NAME_MAX) })
      .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, userId)))
      .returning({ id: webauthnCredentials.id });
    if (updated.length === 0) throw notFound('Passkey');
  }

  async remove(userId: string, id: string): Promise<void> {
    const deleted = await this.db
      .delete(webauthnCredentials)
      .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, userId)))
      .returning({ id: webauthnCredentials.id });
    if (deleted.length === 0) throw notFound('Passkey');
  }

  async removeAll(userId: string): Promise<number> {
    const deleted = await this.db
      .delete(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId))
      .returning({ id: webauthnCredentials.id });
    await this.db.delete(webauthnChallenges).where(eq(webauthnChallenges.userId, userId));
    return deleted.length;
  }

  private async storeChallenge(
    challenge: string,
    purpose: 'registration' | 'authentication',
    userId: string | null,
    binding: string,
  ): Promise<void> {
    await this.db.insert(webauthnChallenges).values({
      challengeHash: hashToken(challenge),
      challenge,
      purpose,
      userId,
      bindingHash: hashToken(binding),
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    });
  }

  /** Atomically deletes and returns the challenge the browser signed; each one works once. */
  private async consumeChallenge(
    clientDataJSON: string,
    purpose: 'registration' | 'authentication',
    binding: string,
  ) {
    const [row] = await this.db
      .delete(webauthnChallenges)
      .where(
        and(
          eq(webauthnChallenges.challengeHash, hashToken(challengeOf(clientDataJSON))),
          eq(webauthnChallenges.purpose, purpose),
          eq(webauthnChallenges.bindingHash, hashToken(binding)),
          gt(webauthnChallenges.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!row) throw new PasskeyError('challenge_expired', 'Challenge unknown, used or expired');
    return row;
  }
}
