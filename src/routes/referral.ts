import type { Context, MiddlewareHandler } from 'hono';
import { REFERRAL_CODE } from '../billing/referrals.js';
import { clearCookie, readCookie, setSecureCookie } from '../web/http.js';
import type { AppEnv } from './context.js';
import { cookieOpts } from './page-helpers.js';

const REFERRAL_COOKIE = 'mp_ref';
const KEEP_SECONDS = 30 * 86_400;

/**
 * Remembers the invite code of `/?ref=<code>` (any page) for 30 days, so a visitor who looks around
 * and signs up later still counts as invited. The first invite wins: a later link does not replace it.
 */
export function referralCapture(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const code = c.req.method === 'GET' ? c.req.query('ref')?.toLowerCase() : undefined;
    if (code && REFERRAL_CODE.test(code)) {
      const opts = cookieOpts(c);
      if (!readCookie(c, REFERRAL_COOKIE, opts)) {
        setSecureCookie(c, REFERRAL_COOKIE, code, { ...opts, maxAge: KEEP_SECONDS });
      }
    }
    await next();
  };
}

/** After a sign-up: records the invite (if any) and forgets the code. */
export async function attachReferral(c: Context<AppEnv>, newUserId: string): Promise<void> {
  const opts = cookieOpts(c);
  const code = readCookie(c, REFERRAL_COOKIE, opts);
  if (!code) return;
  clearCookie(c, REFERRAL_COOKIE, opts);
  const attached = await c.get('services').referrals.attach(newUserId, code);
  if (attached) c.get('services').logger.info({ userId: newUserId }, 'invited user signed up');
}
