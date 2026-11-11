import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { knownAppInName } from '../src/core/ai-apps.js';
import { type OwnerNotice, SECURITY_EVENTS } from '../src/core/owner-notices.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import { emailOf } from '../src/notices/owner-email.js';
import { renderNotice } from '../src/security/owner-notifier.js';
import { translator } from '../src/web/i18n.js';
import { KnownDevices } from '../src/web/known-devices.js';
import { ADMIN, enableTotp, startTestHub, TestBrowser, type TestHub } from './helpers.js';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const FIREFOX_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';

const mailer = new MemoryMailer();
let hub: TestHub;

/** A browser of the given kind; `signIn` leaves it signed in as the owner. */
function browser(userAgent: string): TestBrowser {
  const b = new TestBrowser(hub.baseUrl);
  b.headers['user-agent'] = userAgent;
  return b;
}
async function signIn(b: TestBrowser): Promise<void> {
  expect((await b.login()).status).toBe(303);
}
async function signOut(b: TestBrowser): Promise<void> {
  expect((await b.request('/logout', { form: { csrf: await csrfOf(b, '/security') } })).status).toBe(303);
}
/** Notices are sent after the response: waits for the next one with this tag. */
async function notice(tag: string, count = 1) {
  await vi.waitFor(() => expect(mailer.sent.filter((m) => m.tag === tag)).toHaveLength(count));
  return mailer.sent.filter((m) => m.tag === tag).at(-1)!;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
async function csrfOf(b: TestBrowser, page: string): Promise<string> {
  return TestBrowser.hiddenInputs(await (await b.request(page)).text()).csrf!;
}

beforeAll(async () => {
  hub = await startTestHub({ mailer });
});
afterAll(async () => {
  await hub?.close();
});
beforeEach(() => {
  mailer.sent.length = 0;
});

describe('security notices', () => {
  it('reports a sign-in from a new browser, and only that', async () => {
    // The first sign-in ever is the sign-up: nothing to report.
    const home = browser(CHROME_MAC);
    await signIn(home);
    await settle();
    expect(mailer.sent).toEqual([]);

    // Another browser: the owner hears about it, with the browser named.
    const other = browser(FIREFOX_WINDOWS);
    await signIn(other);
    const mail = await notice('notice.security.sign_in');
    expect(mail.to).toBe(ADMIN.email);
    expect(mail.subject).toContain('New sign-in');
    expect(mail.text).toContain('Firefox · Windows');
    expect(mail.text).toContain(`${hub.baseUrl}/app/settings`);

    // Signing in again from that browser (its cookie remembers it) is not news.
    await signOut(other);
    await signIn(other);
    // Nor is a browser that lost its cookies but comes from the same address and browser.
    await signIn(browser(CHROME_MAC));
    await settle();
    expect(mailer.sent.filter((m) => m.tag === 'notice.security.sign_in')).toHaveLength(1);
  });

  it('reports a new access token and a newly connected AI app', async () => {
    const b = browser(CHROME_MAC);
    await signIn(b);
    const created = await b.request('/app/tokens', {
      form: { csrf: await csrfOf(b, '/app/apps'), name: 'Night script', days: '0' },
    });
    expect(created.status).toBe(200);
    expect((await notice('notice.security.token_created')).text).toContain('Night script');

    // An app that only borrows a famous name: the consent screen says so, and the notice names
    // where the access went.
    const registration = (await (
      await fetch(`${hub.baseUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Claude',
          redirect_uris: ['https://claude-login.example/cb'],
          token_endpoint_auth_method: 'none',
        }),
      })
    ).json()) as { client_id: string };
    const url = new URL('/oauth/authorize', hub.baseUrl);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: registration.client_id,
      redirect_uri: 'https://claude-login.example/cb',
      code_challenge: createHash('sha256').update('v'.repeat(64)).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    const consent = await (await b.request(url.toString())).text();
    const ru = translator('ru');
    expect(consent).toContain(ru('consent.lookalike', { app: 'Claude' }));
    expect(consent).not.toContain(ru('consent.unknown'));
    expect(consent).not.toContain(ru('consent.known'));

    await b.authorize(url);
    const mail = await notice('notice.security.app_connected');
    expect(mail.text).toContain('Claude · claude-login.example');
    expect(mail.text).toContain(`${hub.baseUrl}/app/apps`);
  });

  it('reports a sign-in protection that was turned off', async () => {
    const b = browser(CHROME_MAC);
    await signIn(b);
    await enableTotp(b);
    const csrf = await csrfOf(b, '/security');
    // Turning off what is not on is not an event.
    expect((await b.request('/security/totp/disable', { form: { csrf } })).status).toBe(303);
    const mail = await notice('notice.security.totp_removed');
    expect(mail.text).toContain(`${hub.baseUrl}/security`);
    expect((await b.request('/security/totp/disable', { form: { csrf } })).status).toBe(303);
    await settle();
    expect(mailer.sent.filter((m) => m.tag === 'notice.security.totp_removed')).toHaveLength(1);
  });

  it('has a Telegram message and an email for every event, in both languages', () => {
    for (const event of SECURITY_EVENTS) {
      const sample: OwnerNotice = {
        kind: 'security',
        event,
        subject: '<b>Safari</b>',
        url: 'https://hub.example/x',
      };
      for (const locale of ['en', 'ru'] as const) {
        const message = renderNotice(translator(locale), sample);
        // The subject is someone's text (an app's or a passkey's name): always escaped.
        expect(message).toContain('&lt;b&gt;Safari&lt;/b&gt;');
        expect(message).toContain('<a href="https://hub.example/x">');
        expect(message).not.toMatch(/\{\w+\}/);
      }
      const email = emailOf(sample)!;
      expect(email.tag).toBe(`notice.security.${event}`);
      expect(email.cta.url).toBe('https://hub.example/x');
    }
  });
});

describe('known devices', () => {
  const devices = new KnownDevices(Buffer.alloc(32, 1));

  it('knows a browser only for the users who signed in from it', () => {
    const cookie = devices.remember(undefined, 'usr_a');
    expect(devices.knows(cookie, 'usr_a')).toBe(true);
    expect(devices.knows(cookie, 'usr_b')).toBe(false);
    expect(devices.knows(undefined, 'usr_a')).toBe(false);
    // Another hub's key (or a made-up value) proves nothing.
    expect(new KnownDevices(Buffer.alloc(32, 2)).knows(cookie, 'usr_a')).toBe(false);
    expect(devices.knows('x.y.z', 'usr_a')).toBe(false);
  });

  it('keeps the last few users of a shared computer and drops junk', () => {
    let cookie: string | undefined = 'junk.<script>';
    for (const user of ['a', 'b', 'c', 'd', 'e', 'f', 'a']) cookie = devices.remember(cookie, user);
    expect(cookie!.split('.')).toHaveLength(5);
    expect(devices.knows(cookie, 'a')).toBe(true);
    expect(devices.knows(cookie, 'f')).toBe(true);
    expect(devices.knows(cookie, 'b')).toBe(false);
  });
});

describe('borrowed app names', () => {
  it('spots a well-known app in a self-declared name', () => {
    expect(knownAppInName('Claude')).toBe('Claude');
    expect(knownAppInName('claude desktop (official)')).toBe('Claude');
    expect(knownAppInName('Anthropic Connector')).toBe('Claude');
    expect(knownAppInName('ChatGPT Plus')).toBe('ChatGPT');
    expect(knownAppInName('OpenAI Agent')).toBe('ChatGPT');
    expect(knownAppInName('Cursor')).toBeUndefined();
    expect(knownAppInName('Visual Studio Code')).toBeUndefined();
  });
});
