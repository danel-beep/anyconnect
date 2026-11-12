import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findUserByEmail } from '../src/core/identity.js';
import { SharedRateLimiter, WorkLeases } from '../src/core/shared-limits.js';
import { SignInRefused } from '../src/core/users.js';
import { rateCounters } from '../src/db/schema.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import { ADMIN, resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What must hold with several instances and across restarts: attempt counters and work leases. */
describe('limits and leases shared through the database', () => {
  let hub: TestHub;

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ mailer: new MemoryMailer() });
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('counts attempts the same for every instance, until the window ends', async () => {
    // Two limiters on one database stand for two instances (or one before and after a restart).
    const one = new SharedRateLimiter(hub.services.db);
    const two = new SharedRateLimiter(hub.services.db);
    expect((await one.consume('guess:alice@example.com', 3, 60_000)).allowed).toBe(true);
    expect((await two.consume('guess:alice@example.com', 3, 60_000)).allowed).toBe(true);
    expect((await one.consume('guess:alice@example.com', 3, 60_000)).allowed).toBe(true);
    const refused = await two.consume('guess:alice@example.com', 3, 60_000);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
    // Another key has its own count, and a reset (a successful sign-in) starts over.
    expect((await one.consume('guess:bob@example.com', 3, 60_000)).allowed).toBe(true);
    await two.reset('guess:alice@example.com');
    expect((await one.consume('guess:alice@example.com', 3, 60_000)).allowed).toBe(true);
    // The address in the key is not stored, only a hash of the key.
    const stored = await hub.services.db.select().from(rateCounters);
    expect(JSON.stringify(stored)).not.toContain('example.com');

    expect((await one.consume('short', 1, 150)).allowed).toBe(true);
    expect((await two.consume('short', 1, 150)).allowed).toBe(false);
    await wait(200);
    expect((await two.consume('short', 1, 150)).allowed).toBe(true);
  });

  it('lets one instance at a time hold a piece of background work', async () => {
    const one = new WorkLeases(hub.services.db);
    const two = new WorkLeases(hub.services.db);
    expect(await one.hold('poll', 60_000)).toBe(true);
    expect(await two.hold('poll', 60_000)).toBe(false);
    // The holder renews; other work is its own lease.
    expect(await one.hold('poll', 60_000)).toBe(true);
    expect(await two.hold('other', 60_000)).toBe(true);
    // A clean stop hands over at once.
    await one.release();
    expect(await two.hold('poll', 150)).toBe(true);
    expect(await one.hold('poll', 60_000)).toBe(false);
    // A holder that went away without a word loses the lease when it runs out.
    await wait(200);
    expect(await one.hold('poll', 60_000)).toBe(true);
    await one.release();
    await two.release();
  });

  it('keeps counting wrong passwords across what would be a restart', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    const attempt = async (password: string) => {
      const page = await browser.request('/login');
      const hidden = TestBrowser.hiddenInputs(await page.text());
      return browser.request('/login', { form: { csrf: hidden.csrf!, email: ADMIN.email, password } });
    };
    for (let i = 0; i < 10; i++) expect((await attempt('wrong-password')).status).toBe(400);
    // The in-memory limiter of a fresh process knows nothing; the count is in the database.
    expect(hub.services.rateLimiter.size).toBe(0);
    expect((await attempt(ADMIN.password)).status).toBe(429);
  });

  it('limits new accounts per address without holding back people who have one', async () => {
    const users = hub.services.users;
    let asked = 0;
    const full = {
      admit: async () => {
        asked += 1;
        return false;
      },
    };
    await expect(users.signInEmail('newcomer@example.com', full)).rejects.toBeInstanceOf(SignInRefused);
    expect(asked).toBe(1);
    expect(await findUserByEmail(hub.services.db, 'newcomer@example.com')).toBeUndefined();
    // Someone who already has an account is not counted at all.
    const existing = await users.signInEmail(ADMIN.email, full);
    expect(existing.created).toBe(false);
    expect(asked).toBe(1);

    // Through the site: the eleventh new account of the day from one address is refused.
    const confirm = async (email: string) => {
      const visitor = new TestBrowser(hub.baseUrl);
      const token = await hub.services.emailLogins.create(email, '/app');
      const page = await visitor.request(`/login/email/confirm?token=${encodeURIComponent(token)}`);
      const hidden = TestBrowser.hiddenInputs(await page.text());
      return visitor.request('/login/email/confirm', { form: { csrf: hidden.csrf!, token: hidden.token! } });
    };
    for (let i = 0; i < 10; i++) {
      const done = await confirm(`person${i}@example.com`);
      expect(done.headers.get('location')).toBe('/app?welcome=1');
    }
    const refused = await confirm('person10@example.com');
    expect(refused.headers.get('location')).toBe('/login?error=signups_limited');
    expect(await findUserByEmail(hub.services.db, 'person10@example.com')).toBeUndefined();
    const back = await confirm('person3@example.com');
    expect(back.headers.get('location')).toBe('/app');
  });
});
