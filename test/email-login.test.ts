import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findUserByEmail } from '../src/core/identity.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import { ADMIN, enableTotp, resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

/** The confirmation URL in a sign-in mail, as a path on the hub. */
const linkIn = (mail: { text: string }, hub: TestHub): string => {
  const match = mail.text.match(/https?:\/\/\S+\/login\/email\/confirm\?token=\S+/);
  if (!match) throw new Error('no sign-in link in the mail');
  return match[0].replace(hub.baseUrl, '');
};

describe('sign-in link by email', () => {
  let hub: TestHub;
  let mailer: MemoryMailer;

  const start = async (env: Record<string, string> = {}) => {
    await hub?.close();
    mailer = new MemoryMailer();
    hub = await startTestHub({ mailer, env });
  };

  /** Asks for a link from the sign-in page; returns the answer page. */
  const ask = async (browser: TestBrowser, email: string, next?: string) => {
    const page = await browser.request(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
    const hidden = TestBrowser.hiddenInputs(await page.text());
    return browser.request('/login/email', { form: { csrf: hidden.csrf!, next: hidden.next!, email } });
  };

  /** Opens the link from the mail and presses the button. */
  const follow = async (browser: TestBrowser, path: string) => {
    const page = await browser.request(path);
    if (page.status !== 200) return page;
    const hidden = TestBrowser.hiddenInputs(await page.text());
    return browser.request('/login/email/confirm', { form: { csrf: hidden.csrf!, token: hidden.token! } });
  };

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await start();
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('offers the link only when the hub can send mail', async () => {
    const withMail = await (await new TestBrowser(hub.baseUrl).request('/login')).text();
    expect(withMail).toContain('action="/login/email"');
    expect(await (await new TestBrowser(hub.baseUrl).request('/signup')).text()).toContain(
      'action="/login/email"',
    );
    await hub.close();
    hub = await startTestHub();
    const browser = new TestBrowser(hub.baseUrl);
    const page = await browser.request('/login');
    const html = await page.text();
    expect(html).not.toContain('action="/login/email"');
    const hidden = TestBrowser.hiddenInputs(html);
    const post = await browser.request('/login/email', {
      form: { csrf: hidden.csrf!, email: 'a@b.example' },
    });
    expect(post.status).toBe(404);
  });

  it('creates an account for a new address and signs in; the link works once', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    const sent = await ask(browser, ' New.Person@Example.com ');
    expect(sent.status).toBe(200);
    expect(await sent.text()).toContain('new.person@example.com');
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.to).toBe('new.person@example.com');
    expect(mail.tag).toBe('auth.sign_in_link');
    // The visitor chose Russian, so the mail is in Russian.
    expect(mail.subject).toBe('Ссылка для входа в Manyplug');

    // Opening the link signs nobody in (mail scanners follow links): only the button does.
    const path = linkIn(mail, hub);
    const confirm = await browser.request(path);
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain('new.person@example.com');
    expect((await browser.request('/app')).status).toBe(302);

    const done = await follow(browser, path);
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/app?welcome=1');
    const home = await browser.request('/app');
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('new.person@example.com');

    // A second use, here or elsewhere, is refused.
    const again = await follow(new TestBrowser(hub.baseUrl), path);
    expect(again.status).toBe(302);
    expect(again.headers.get('location')).toBe('/login?error=linkExpired');
    const user = await findUserByEmail(hub.services.db, 'new.person@example.com');
    expect(user?.role).toBe('user');
  });

  it('signs an existing user in, returns to where they were going and never makes an admin', async () => {
    const next = '/app/services';
    const browser = new TestBrowser(hub.baseUrl);
    await ask(browser, ADMIN.email, next);
    const done = await follow(browser, linkIn(mailer.sent[0]!, hub));
    expect(done.headers.get('location')).toBe(next);
    expect((await browser.request(next)).status).toBe(200);

    // A new address listed in ADMIN_EMAILS gets an ordinary account: a mailbox is not proof enough.
    await start({ ADMIN_EMAILS: 'boss@example.com' });
    const other = new TestBrowser(hub.baseUrl);
    await ask(other, 'boss@example.com');
    await follow(other, linkIn(mailer.sent[0]!, hub));
    expect((await findUserByEmail(hub.services.db, 'boss@example.com'))?.role).toBe('user');
  });

  it('asks for the second factor before a session exists', async () => {
    const admin = new TestBrowser(hub.baseUrl);
    await admin.login();
    await enableTotp(admin);
    const browser = new TestBrowser(hub.baseUrl);
    await ask(browser, ADMIN.email);
    const done = await follow(browser, linkIn(mailer.sent[0]!, hub));
    expect(done.headers.get('location')).toBe('/login/verify?next=%2Fapp');
    expect((await browser.request('/app')).status).toBe(302);
  });

  it('answers the same for unknown addresses when sign-up is closed, and sends nothing', async () => {
    await start({ SIGNUPS: 'closed' });
    const browser = new TestBrowser(hub.baseUrl);
    const unknown = await ask(browser, 'nobody@example.com');
    expect(unknown.status).toBe(200);
    expect(mailer.sent).toHaveLength(0);
    const known = await ask(browser, ADMIN.email);
    expect(known.status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
  });

  it('limits links per address quietly and refuses forged or foreign requests', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    for (let i = 0; i < 5; i++) expect((await ask(browser, 'busy@example.com')).status).toBe(200);
    expect(mailer.sent).toHaveLength(3);

    const forged = await browser.request('/login/email', {
      form: { csrf: 'forged-token-forged-token-forged', email: 'x@example.com' },
    });
    expect(forged.status).toBe(403);
    const invalid = await ask(browser, 'not-an-address');
    expect(invalid.status).toBe(400);
    // A made-up token leads back to the sign-in page.
    const bogus = await browser.request('/login/email/confirm?token=ac_el_nope');
    expect(bogus.headers.get('location')).toBe('/login?error=linkExpired');
    expect(mailer.sent).toHaveLength(3);
  });
});
