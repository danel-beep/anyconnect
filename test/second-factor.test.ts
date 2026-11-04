import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode, totp } from '../src/lib/totp.js';
import { ADMIN, resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';
import { SoftwareAuthenticator } from './webauthn-authenticator.js';

const json = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

/** A code for `offsetSteps` steps from now (+1 avoids the step a previous code already used). */
const codeFor = (secret: string, offsetSteps = 0) =>
  totp(base32Decode(secret), Date.now() + offsetSteps * 30_000);

async function csrfOf(browser: TestBrowser, path: string): Promise<Record<string, string>> {
  const page = await browser.request(path);
  return TestBrowser.hiddenInputs(await page.text());
}

/** Signs in with the password only and enables TOTP through /security. Returns secret and recovery codes. */
async function enableTotp(browser: TestBrowser): Promise<{ secret: string; codes: string[] }> {
  const hidden = await csrfOf(browser, '/security');
  const setup = await browser.request('/security/totp/setup', { form: { csrf: hidden.csrf! } });
  expect(setup.status).toBe(303);
  const page = await (await browser.request('/security')).text();
  const secret = page.match(/id="totp-secret"[^>]*value="([A-Z2-7]+)"/)?.[1];
  expect(secret).toBeDefined();
  expect(page).toContain('otpauth://totp/');
  expect(page).toContain('<svg class="qr"');
  const confirm = await browser.request('/security/totp/confirm', {
    form: { csrf: hidden.csrf!, code: codeFor(secret!) },
  });
  expect(confirm.status).toBe(200);
  const html = await confirm.text();
  const codes = [...html.matchAll(/<code>([0-9A-Z]{4}(?:-[0-9A-Z]{4}){3})<\/code>/g)].map((m) => m[1]!);
  expect(codes).toHaveLength(10);
  return { secret: secret!, codes };
}

async function logout(browser: TestBrowser) {
  const hidden = await csrfOf(browser, '/security');
  await browser.request('/logout', { form: { csrf: hidden.csrf! } });
}

/** An authorization URL of a freshly registered public client. */
async function authorizationUrl(hub: TestHub): Promise<string> {
  const registration = await json(
    fetch(`${hub.baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      }),
    }),
  );
  const url = new URL('/oauth/authorize', hub.baseUrl);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: registration.client_id,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
  }).toString();
  return url.pathname + url.search;
}

async function sessionAmr(hub: TestHub): Promise<string[][]> {
  const { rows } = await hub.services.database.pool.query(
    'SELECT amr FROM web_sessions ORDER BY created_at DESC',
  );
  return rows.map((r) => r.amr);
}

describe('second factors: TOTP, recovery codes, passkeys', () => {
  let hub: TestHub;

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await hub?.close();
    hub = await startTestHub();
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('serves the passkey script under a CSP that allows only own scripts', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    const login = await browser.request('/login');
    const csp = login.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('unsafe-inline');
    const html = await login.text();
    expect(html).toMatch(/<script src="\/assets\/webauthn\.js\?v=[0-9a-f]{12}"/);
    expect(html).toContain('Войти с ключом доступа');
    const script = await browser.request('/assets/webauthn.js');
    expect(script.headers.get('content-type')).toContain('text/javascript');
    expect(await script.text()).toContain('navigator.credentials.get');
  });

  it('signs in with password + TOTP and only then creates a session', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await browser.login();
    expect(await sessionAmr(hub)).toEqual([['pwd']]);
    const { secret } = await enableTotp(browser);
    // Confirming the code upgrades the current session.
    expect((await sessionAmr(hub))[0]).toEqual(['pwd', 'otp']);
    await logout(browser);

    const password = await browser.login(ADMIN.email, ADMIN.password, '/security');
    expect(password.status).toBe(303);
    expect(password.headers.get('location')).toBe('/login/verify?next=%2Fsecurity');
    expect(await sessionAmr(hub)).toEqual([]);
    expect((await browser.request('/app')).headers.get('location')).toBe('/login?next=%2Fapp');

    const verify = await browser.request(password.headers.get('location')!);
    expect(verify.status).toBe(200);
    const page = await verify.text();
    expect(page).toContain('Двухэтапная проверка');
    const hidden = TestBrowser.hiddenInputs(page);
    const code = codeFor(secret, 1);
    const ok = await browser.request('/login/verify', { form: { ...hidden, code } });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/security');
    expect((await browser.request('/app')).status).toBe(200);
    expect(await sessionAmr(hub)).toEqual([['pwd', 'otp']]);

    // The same code cannot be replayed for another sign-in.
    await logout(browser);
    await browser.login();
    const replay = await browser.request('/login/verify', {
      form: { ...TestBrowser.hiddenInputs(await (await browser.request('/login/verify')).text()), code },
    });
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain('Неверный или уже использованный код');
  });

  it('keeps the OAuth authorize -> sign-in -> second factor -> consent round trip', async () => {
    const setup = new TestBrowser(hub.baseUrl);
    await setup.login();
    const { secret } = await enableTotp(setup);

    const browser = new TestBrowser(hub.baseUrl);
    const authorize = await authorizationUrl(hub);
    const toLogin = await browser.request(authorize);
    expect(toLogin.status).toBe(302);
    const next = new URL(toLogin.headers.get('location')!, hub.baseUrl).searchParams.get('next')!;
    expect(next).toBe(authorize);
    const password = await browser.login(ADMIN.email, ADMIN.password, next);
    expect(password.headers.get('location')).toBe(`/login/verify?next=${encodeURIComponent(authorize)}`);
    const hidden = TestBrowser.hiddenInputs(
      await (await browser.request(password.headers.get('location')!)).text(),
    );
    expect(hidden.next).toBe(authorize);
    const verified = await browser.request('/login/verify', {
      form: { ...hidden, code: codeFor(secret, 1) },
    });
    expect(verified.headers.get('location')).toBe(authorize);
    const consent = await browser.request(authorize);
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain('Подключить Claude к AnyConnect?');
  });

  it('accepts each recovery code once', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await browser.login();
    const { codes } = await enableTotp(browser);
    await logout(browser);

    const signInWith = async (code: string) => {
      await browser.login();
      const hidden = TestBrowser.hiddenInputs(await (await browser.request('/login/verify')).text());
      return browser.request('/login/verify', { form: { ...hidden, code } });
    };
    const first = await signInWith(codes[0]!.toLowerCase());
    expect(first.status).toBe(303);
    expect(await sessionAmr(hub)).toEqual([['pwd', 'rec']]);
    const security = await (await browser.request('/security')).text();
    expect(security).toContain('Неиспользованных: 9 из 10');
    await logout(browser);

    const again = await signInWith(codes[0]!);
    expect(again.status).toBe(400);
  });

  it('rejects wrong codes and rate-limits guessing', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await browser.login();
    const { secret } = await enableTotp(browser);
    await logout(browser);
    await browser.login();
    const hidden = TestBrowser.hiddenInputs(await (await browser.request('/login/verify')).text());
    const wrong = codeFor(secret, 1) === '000000' ? '111111' : '000000';
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await browser.request('/login/verify', { form: { ...hidden, code: wrong } })).status);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
    // Even the right code is refused while the limit holds.
    const right = await browser.request('/login/verify', { form: { ...hidden, code: codeFor(secret, 1) } });
    expect(right.status).toBe(429);
    expect(await sessionAmr(hub)).toEqual([]);
  });

  it('does not offer the verify step without a pending login', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    const response = await browser.request('/login/verify?next=%2Fsecurity');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login?next=%2Fsecurity');
  });

  it('registers a passkey and signs in with it, passwordless and as a second factor', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    const authenticator = new SoftwareAuthenticator(hub.baseUrl);
    await browser.login();
    const { csrf } = await csrfOf(browser, '/security');

    const options = await json(browser.request('/security/passkeys/options', { json: { csrf } }));
    expect(options.rp.id).toBe('127.0.0.1');
    const created = await browser.request('/security/passkeys', {
      json: { csrf, name: 'Ноутбук', response: authenticator.create(options) },
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ redirect: '/security#passkeys' });
    expect(await (await browser.request('/security')).text()).toContain('Ноутбук');
    expect((await sessionAmr(hub))[0]).toEqual(['pwd', 'hwk']);
    await logout(browser);

    // Passwordless: discoverable credential, no email typed.
    const loginCsrf = (await csrfOf(browser, '/login')).csrf!;
    const request = await json(
      browser.request('/login/passkey/options', { json: { csrf: loginCsrf, flow: 'passwordless' } }),
    );
    expect(request.allowCredentials ?? []).toEqual([]);
    expect(request.userVerification).toBe('required');
    const assertion = authenticator.get(request);
    const signedIn = await browser.request('/login/passkey', {
      json: { csrf: loginCsrf, flow: 'passwordless', next: '/security', response: assertion },
    });
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toEqual({ redirect: '/security' });
    expect((await browser.request('/app')).status).toBe(200);
    expect(await sessionAmr(hub)).toEqual([['hwk']]);

    // The same assertion (and its challenge) cannot be used twice.
    const replay = await browser.request('/login/passkey', {
      json: { csrf: loginCsrf, flow: 'passwordless', response: assertion },
    });
    expect(replay.status).toBe(400);
    await logout(browser);

    // Second factor after the password.
    const password = await browser.login();
    expect(password.headers.get('location')).toBe('/login/verify?next=%2F');
    const verifyPage = await (await browser.request('/login/verify')).text();
    expect(verifyPage).toContain('Подтвердить ключом доступа');
    const hidden = TestBrowser.hiddenInputs(verifyPage);
    const second = await json(
      browser.request('/login/passkey/options', { json: { csrf: hidden.csrf, flow: 'second_factor' } }),
    );
    expect(second.allowCredentials).toHaveLength(1);
    const done = await browser.request('/login/passkey', {
      json: { csrf: hidden.csrf, flow: 'second_factor', next: '/', response: authenticator.get(second) },
    });
    expect(done.status).toBe(200);
    expect(await sessionAmr(hub)).toEqual([['pwd', 'hwk']]);
  });

  it('rejects passkey assertions from another origin or another browser', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    const authenticator = new SoftwareAuthenticator(hub.baseUrl);
    await browser.login();
    const { csrf } = await csrfOf(browser, '/security');
    const options = await json(browser.request('/security/passkeys/options', { json: { csrf } }));
    await browser.request('/security/passkeys', { json: { csrf, response: authenticator.create(options) } });
    await logout(browser);

    // A phishing site would produce clientDataJSON with its own origin.
    const phishing = new SoftwareAuthenticator('https://evil.example', '127.0.0.1');
    phishing.keys.push(...authenticator.keys);
    const loginCsrf = (await csrfOf(browser, '/login')).csrf!;
    const request = await json(
      browser.request('/login/passkey/options', { json: { csrf: loginCsrf, flow: 'passwordless' } }),
    );
    const bad = await browser.request('/login/passkey', {
      json: { csrf: loginCsrf, flow: 'passwordless', response: phishing.get(request) },
    });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toContain('Passkey не сработал');

    // A challenge issued to one browser does not work in another one.
    const other = new TestBrowser(hub.baseUrl);
    const otherCsrf = (await csrfOf(other, '/login')).csrf!;
    const stolen = await json(
      browser.request('/login/passkey/options', { json: { csrf: loginCsrf, flow: 'passwordless' } }),
    );
    const response = await other.request('/login/passkey', {
      json: { csrf: otherCsrf, flow: 'passwordless', response: authenticator.get(stolen) },
    });
    expect(response.status).toBe(400);
    expect(await sessionAmr(hub)).toEqual([]);
  });

  it('requires a recent sign-in for security changes', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await browser.login();
    await hub.services.database.pool.query(
      "UPDATE web_sessions SET authenticated_at = now() - interval '11 minutes'",
    );
    const page = await (await browser.request('/security')).text();
    expect(page).toContain('сначала подтвердите вход');
    const { csrf } = TestBrowser.hiddenInputs(page);

    const setup = await browser.request('/security/totp/setup', { form: { csrf: csrf! } });
    expect(setup.status).toBe(303);
    expect(setup.headers.get('location')).toBe('/login?reauth=1&next=%2Fsecurity');
    const options = await browser.request('/security/passkeys/options', { json: { csrf } });
    expect(options.status).toBe(403);
    expect((await json(options)).redirect).toBe('/login?reauth=1&next=%2Fsecurity');
    const { rows } = await hub.services.database.pool.query('SELECT count(*)::int AS n FROM user_totp');
    expect(rows[0].n).toBe(0);

    // Re-confirming replaces the session; then the change goes through.
    const reauth = await browser.request('/login?reauth=1&next=%2Fsecurity');
    expect(reauth.status).toBe(200);
    const reauthPage = await reauth.text();
    expect(reauthPage).toContain('Подтвердите, что это вы');
    const again = await browser.request('/login', {
      form: { ...TestBrowser.hiddenInputs(reauthPage), email: ADMIN.email, password: ADMIN.password },
    });
    expect(again.headers.get('location')).toBe('/security');
    expect(await sessionAmr(hub)).toHaveLength(1);
    const fresh = TestBrowser.hiddenInputs(await (await browser.request('/security')).text());
    expect((await browser.request('/security/totp/setup', { form: { csrf: fresh.csrf! } })).status).toBe(303);
    const after = await hub.services.database.pool.query('SELECT count(*)::int AS n FROM user_totp');
    expect(after.rows[0].n).toBe(1);
  });

  it('keeps sign-in working until TOTP enrollment is confirmed, and removes codes with the last factor', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await browser.login();
    const { csrf } = await csrfOf(browser, '/security');
    await browser.request('/security/totp/setup', { form: { csrf: csrf! } });
    const wrong = await browser.request('/security/totp/confirm', { form: { csrf: csrf!, code: '000000' } });
    expect(wrong.status).toBe(400);
    await logout(browser);
    // Unconfirmed enrollment is not a factor yet.
    expect((await browser.login()).headers.get('location')).toBe('/');

    await enableTotp(browser);
    const hidden = await csrfOf(browser, '/security');
    expect((await browser.request('/security/totp/disable', { form: { csrf: hidden.csrf! } })).status).toBe(
      303,
    );
    const { rows } = await hub.services.database.pool.query(
      'SELECT count(*)::int AS n FROM user_recovery_codes',
    );
    expect(rows[0].n).toBe(0);
    await logout(browser);
    expect((await browser.login()).headers.get('location')).toBe('/');
  });

  it('resets every second factor (admin break-glass)', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await browser.login();
    await enableTotp(browser);
    const user = (await hub.services.db.query.users.findFirst())!;
    const removed = await hub.services.secondFactors.reset(user.id);
    expect(removed).toEqual({ totp: true, passkeys: 0, recoveryCodes: 10 });
    await logout(browser);
    expect((await browser.login()).headers.get('location')).toBe('/');
  });
});

describe('REQUIRE_2FA', () => {
  let hub: TestHub;

  beforeAll(async () => {
    hub = await startTestHub({ env: { REQUIRE_2FA: 'true' } });
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('sends users without a second factor to /security first, then lets them continue', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await browser.login();
    const home = await browser.request('/app');
    expect(home.status).toBe(302);
    expect(home.headers.get('location')).toBe('/security?next=%2Fapp');
    const api = await browser.request('/api/v1/me');
    expect(api.status).toBe(403);

    const page = await (await browser.request('/security?next=%2F')).text();
    expect(page).toContain('обязателен второй фактор');
    await enableTotp(browser);
    expect((await browser.request('/app')).status).toBe(200);
    expect((await browser.request('/security?next=%2F')).status).toBe(200);
  });

  it('does not show the consent screen before a second factor is set up', async () => {
    await hub.services.secondFactors.reset((await hub.services.db.query.users.findFirst())!.id);
    const browser = new TestBrowser(hub.baseUrl);
    await browser.login();
    const authorize = await authorizationUrl(hub);
    const response = await browser.request(authorize);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`/security?next=${encodeURIComponent(authorize)}`);
  });
});
