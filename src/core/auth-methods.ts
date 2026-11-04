/**
 * How a sign-in was proven, stored on the web session as `amr` (RFC 8176 "Authentication Method
 * Reference" values). `rec` (recovery code) and `fed` (an external identity provider such as
 * "Sign in with Google") are our own values: RFC 8176 has none for them.
 */
export const AUTH_METHODS = ['pwd', 'fed', 'otp', 'hwk', 'rec'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/** Changing security settings requires a sign-in (or re-confirmation) at most this long ago. */
export const RECENT_AUTH_MAX_AGE_MS = 10 * 60_000;

export function parseAuthMethods(values: readonly string[]): AuthMethod[] {
  return values.filter((v): v is AuthMethod => (AUTH_METHODS as readonly string[]).includes(v));
}

/** A passkey on its own, or a first factor (password or external sign-in) plus a second factor. */
export function isStrongAuth(amr: readonly AuthMethod[]): boolean {
  const first = amr.includes('pwd') || amr.includes('fed');
  return amr.includes('hwk') || (first && (amr.includes('otp') || amr.includes('rec')));
}

export function isRecentAuth(
  authenticatedAt: Date | null,
  now = Date.now(),
  maxAgeMs = RECENT_AUTH_MAX_AGE_MS,
): boolean {
  return authenticatedAt !== null && now - authenticatedAt.getTime() <= maxAgeMs;
}
