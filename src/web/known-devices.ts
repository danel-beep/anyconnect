import { hmac, safeEqual } from '../lib/crypto.js';

/** Remembers, in the browser, which users have signed in from it (one tag per user, newest last). */
export const DEVICE_COOKIE = 'ac_dev';
/** Browsers cap cookie lifetime at about 400 days; every sign-in renews it. */
export const DEVICE_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
/** A shared computer keeps the last few users. */
const MAX_USERS = 5;
const TAG = /^[\w-]{22}$/;

/**
 * Tells a browser the user has signed in from before from a new one, so a sign-in from somewhere
 * else can be reported to them (`SecurityNotices`). The tag is a keyed hash of the user id: it
 * names no one, cannot be made without the hub's key and needs no table.
 */
export class KnownDevices {
  constructor(private readonly key: Buffer) {}

  private tag(userId: string): string {
    return hmac(this.key, `known-device|${userId}`).slice(0, 22);
  }

  knows(cookie: string | undefined, userId: string): boolean {
    const tag = this.tag(userId);
    return (cookie ?? '').split('.').some((candidate) => safeEqual(candidate, tag));
  }

  /** The cookie value once the user has signed in from this browser. */
  remember(cookie: string | undefined, userId: string): string {
    const tag = this.tag(userId);
    const others = (cookie ?? '').split('.').filter((x) => TAG.test(x) && !safeEqual(x, tag));
    return [...others, tag].slice(-MAX_USERS).join('.');
  }
}
