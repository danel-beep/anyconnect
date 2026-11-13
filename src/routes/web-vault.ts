import { randomBytes } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { VaultSecret } from '../core/vault-scope.js';
import { isDatabaseUnavailable } from '../db/errors.js';
import { newId } from '../lib/ids.js';
import { readCookie, setSecureCookie } from '../web/http.js';
import { type AppEnv, currentSession } from './context.js';

/** Holds this browser's device key: `<user id>.<device id>.<32-byte secret, base64url>`. */
export const VAULT_COOKIE = 'mp_vault';
/** The device key outlives sessions, so signing in again on the same browser opens the vault. */
const DEVICE_COOKIE_MAX_AGE = 400 * 86_400;

/** Requests that never touch a vault: machine endpoints and static files. */
const SKIP = /^\/(?:mcp|assets|\.well-known|healthz|readyz|hooks|oauth\/(?:token|register|revoke))(?:\/|$)/;

function parse(value: string | undefined): { userId: string; deviceId: string; secret: Buffer } | undefined {
  const parts = value?.split('.');
  if (parts?.length !== 3) return undefined;
  const [userId, deviceId, secretB64] = parts as [string, string, string];
  const secret = Buffer.from(secretB64, 'base64url');
  return secret.length === 32 ? { userId, deviceId, secret } : undefined;
}

/**
 * Opens the signed-in user's vault for the request from this browser's device key, and creates
 * the vault the first time the user is seen, so every account is protected by default with no step
 * from the user (`docs/VAULTS.md`). A new browser (after the vault exists) gets its own device key
 * and a request that a browser where the vault is open approves; until then everything works there
 * except opening sealed accounts.
 */
export function webVault(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (SKIP.test(c.req.path)) return next();
    let session: Awaited<ReturnType<typeof currentSession>>;
    try {
      session = await currentSession(c);
    } catch (error) {
      // The database does not answer: pages that work without it (status, docs) still open, and
      // those that need it answer 503 themselves.
      if (isDatabaseUnavailable(error)) return next();
      throw error;
    }
    if (!session) return next();
    const s = c.get('services');
    const userId = session.user.id;
    const opts = { secure: s.config.secureCookies };
    const device = parse(readCookie(c, VAULT_COOKIE, opts));
    if (device && device.userId === userId) {
      const source = new VaultSecret(userId, 'device', device.deviceId, device.secret);
      c.set('vaultDevice', source);
      return s.vaultScopes.run(source, () => next());
    }

    const deviceId = newId('dev');
    const secret = randomBytes(32);
    const setDeviceCookie = () =>
      setSecureCookie(c, VAULT_COOKIE, `${userId}.${deviceId}.${secret.toString('base64url')}`, {
        ...opts,
        maxAge: DEVICE_COOKIE_MAX_AGE,
      });
    if (await s.vaults.exists(userId)) {
      // A new browser: it gets its own device key and asks a browser where the vault is open to
      // let it in (`/security`). Until then it works without the vault.
      await s.vaults.requestDevice(userId, deviceId, secret);
      setDeviceCookie();
      const source = new VaultSecret(userId, 'device', deviceId, secret);
      c.set('vaultDevice', source);
      return s.vaultScopes.run(source, () => next());
    }

    let vault: Awaited<ReturnType<typeof s.vaults.create>>;
    try {
      vault = await s.vaults.create(userId, { kind: 'device', ref: deviceId, secret });
    } catch {
      // Another request of the same user created it a moment ago: this one runs without it.
      return next();
    }
    setDeviceCookie();
    c.set('vaultDevice', new VaultSecret(userId, 'device', deviceId, secret));
    return s.vaultScopes.runOpened(userId, vault, () => next());
  };
}
