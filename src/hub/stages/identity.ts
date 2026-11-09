import type { Middleware } from '../executor.js';

/** How long to wait before trying again for an account whose identity could not be read. */
const RETRY_MS = 60 * 60_000;
/** The connection test is a cheap profile request; it never holds a call up for longer. */
const TEST_TIMEOUT_MS = 5_000;

/**
 * Fills in the identity (the mailbox address, the username) of accounts that have none, after the
 * first successful call on them. The connection test normally stores it when the account is
 * connected, but that test can be missed: a sealed account connected from a browser that could not
 * open the vault, a test that failed for a moment. Running it here uses the call's own context
 * (credentials already open), so it works for sealed accounts too. Never changes the result.
 */
export function identityStage(deps: {
  /** `defaultLabel`: the service name, which a never renamed account still carries as its label. */
  setIdentity: (accountId: string, identity: string, defaultLabel: string) => Promise<void>;
  /** Clock for tests. */
  now?: () => number;
}): Middleware {
  const tried = new Map<string, number>();
  const now = deps.now ?? Date.now;
  return async (call, next) => {
    const result = await next();
    const { account, connector } = call;
    if (!account || account.identity || !connector.test || result.isError || !call.invoked) return result;
    const last = tried.get(account.id);
    if (last !== undefined && now() - last < RETRY_MS) return result;
    tried.set(account.id, now());
    try {
      const ctx = await call.context();
      const test = await Promise.race([
        connector.test(ctx),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), TEST_TIMEOUT_MS).unref()),
      ]);
      if (test?.ok && test.identity) {
        await deps.setIdentity(account.id, test.identity, connector.name);
        account.identity = test.identity;
        tried.delete(account.id);
      }
    } catch {
      // Best effort: the call itself succeeded; the next one (or the daily health check) tries again.
    }
    return result;
  };
}
