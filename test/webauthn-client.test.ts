import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEBAUTHN_JS } from '../src/web/webauthn-client.js';
import { resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';
import { SoftwareAuthenticator } from './webauthn-authenticator.js';

const toB64url = (buffer: ArrayBuffer) => Buffer.from(buffer).toString('base64url');
const toBuffer = (value: string) => new Uint8Array(Buffer.from(value, 'base64url')).buffer;

/** What a browser's PublicKeyCredential looks like to the script: ArrayBuffers and methods. */
function asBrowserCredential(json: any) {
  const response: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json.response)) {
    if (key === 'transports') response.getTransports = () => value;
    else response[key] = toBuffer(value as string);
  }
  return {
    id: json.id,
    rawId: toBuffer(json.rawId),
    type: json.type,
    authenticatorAttachment: json.authenticatorAttachment,
    response,
    getClientExtensionResults: () => ({}),
  };
}

/**
 * Runs /assets/webauthn.js against a fake DOM with one passkey form, forwarding fetch() to the
 * test hub and navigator.credentials to the software authenticator. Resolves with the URL the
 * script navigates to, or rejects with the text it shows as an error.
 */
function runScript(
  browser: TestBrowser,
  authenticator: SoftwareAuthenticator,
  form: { mode: string; options: string; action: string; fields: Record<string, string> },
): Promise<string> {
  return new Promise((resolve, reject) => {
    let submit: ((event: { preventDefault(): void }) => void) | undefined;
    const errorBox = {
      hidden: true,
      set textContent(text: string) {
        if (text) reject(new Error(text));
      },
    };
    const element = {
      hidden: true,
      getAttribute: (name: string) =>
        ({
          'data-passkey': form.mode,
          'data-options': form.options,
          action: form.action,
          'data-error': 'failed',
        })[name] ?? null,
      querySelector: (selector: string) =>
        selector.includes('passkey-error') ? errorBox : { disabled: false },
      addEventListener: (_type: string, listener: typeof submit) => {
        submit = listener;
      },
    };
    const fetchToHub = async (url: string, init: { body: string }) =>
      browser.request(url, { json: JSON.parse(init.body) });
    const credentials = {
      create: async ({ publicKey }: any) =>
        asBrowserCredential(
          authenticator.create({
            challenge: toB64url(publicKey.challenge),
            user: { id: toB64url(publicKey.user.id) },
          }),
        ),
      get: async ({ publicKey }: any) =>
        asBrowserCredential(
          authenticator.get({
            challenge: toB64url(publicKey.challenge),
            allowCredentials: (publicKey.allowCredentials ?? []).map((c: any) => ({ id: toB64url(c.id) })),
          }),
        ),
    };
    class FakeFormData {
      forEach(callback: (value: string, key: string) => void) {
        for (const [key, value] of Object.entries(form.fields)) callback(value, key);
      }
    }
    const window = {
      PublicKeyCredential: () => {},
      fetch: fetchToHub,
      location: { assign: resolve },
    };
    runInNewContext(WEBAUTHN_JS, {
      window,
      navigator: { credentials },
      document: {
        querySelectorAll: (selector: string) => (selector.startsWith('form') ? [element] : []),
      },
      fetch: fetchToHub,
      FormData: FakeFormData,
      atob,
      btoa,
    });
    expect(element.hidden).toBe(false);
    submit!({ preventDefault() {} });
  });
}

describe('/assets/webauthn.js against the hub', () => {
  let hub: TestHub;

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub();
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('registers a passkey and signs in with it the way a browser would', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    const authenticator = new SoftwareAuthenticator(hub.baseUrl);
    await browser.login();
    const { csrf } = TestBrowser.hiddenInputs(await (await browser.request('/security')).text());

    const afterRegistration = await runScript(browser, authenticator, {
      mode: 'register',
      options: '/security/passkeys/options',
      action: '/security/passkeys',
      fields: { csrf: csrf!, name: 'Script key' },
    });
    expect(afterRegistration).toBe('/security#passkeys');
    expect(await (await browser.request('/security')).text()).toContain('Script key');

    const signedOut = new TestBrowser(hub.baseUrl);
    const login = TestBrowser.hiddenInputs(await (await signedOut.request('/login?next=%2Fsecurity')).text());
    const afterLogin = await runScript(signedOut, authenticator, {
      mode: 'authenticate',
      options: '/login/passkey/options',
      action: '/login/passkey',
      fields: { csrf: login.csrf!, next: login.next!, flow: 'passwordless' },
    });
    expect(afterLogin).toBe('/security');
    expect((await signedOut.request('/')).status).toBe(200);
  });

  it('shows the server error when the ceremony is rejected', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    const login = TestBrowser.hiddenInputs(await (await browser.request('/login')).text());
    const stranger = new SoftwareAuthenticator(hub.baseUrl);
    stranger.create({ challenge: 'AAAA', user: { id: 'dXNyX3Vua25vd24' } });
    await expect(
      runScript(browser, stranger, {
        mode: 'authenticate',
        options: '/login/passkey/options',
        action: '/login/passkey',
        fields: { csrf: login.csrf!, next: '/', flow: 'passwordless' },
      }),
    ).rejects.toThrow('Passkey не сработал');
  });
});
