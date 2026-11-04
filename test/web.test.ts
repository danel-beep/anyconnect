import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

const json = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

describe('web pages: login, consent and home', () => {
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

  it('serves discovery documents that point at each other', async () => {
    const prm = await json(fetch(`${hub.baseUrl}/.well-known/oauth-protected-resource/mcp`));
    expect(prm.resource).toBe(hub.mcpUrl);
    expect(prm.authorization_servers).toEqual([hub.baseUrl]);
    const as = await json(fetch(`${hub.baseUrl}/.well-known/oauth-authorization-server`));
    expect(as.issuer).toBe(hub.baseUrl);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.token_endpoint_auth_methods_supported).toContain('none');
    expect(as.client_id_metadata_document_supported).toBe(true);
  });

  it('answers unauthenticated MCP requests with a 401 pointing at the metadata', async () => {
    const response = await fetch(hub.mcpUrl, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      `resource_metadata="${hub.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('signs in, shows the home page and signs out', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    expect((await browser.request('/app')).headers.get('location')).toBe('/login?next=%2Fapp');
    const wrong = await browser.login(ADMIN.email, 'nope');
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('Неверный email или пароль');

    const ok = await browser.login();
    expect(ok.status).toBe(303);
    const home = await browser.request('/app');
    const html = await home.text();
    expect(home.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(html).toContain(hub.mcpUrl);
    expect(html).toContain('Demo — second');

    const hidden = TestBrowser.hiddenInputs(html);
    await browser.request('/logout', { form: { csrf: hidden.csrf! } });
    expect((await browser.request('/app')).status).toBe(302);
  });

  it('rejects forms without a valid CSRF token or from another origin', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await browser.request('/login');
    const response = await browser.request('/login', {
      form: { csrf: 'forged-token-forged-token-forged', email: ADMIN.email, password: ADMIN.password },
    });
    expect(response.status).toBe(403);
    const crossSite = await fetch(`${hub.baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      body: new URLSearchParams({ email: ADMIN.email, password: ADMIN.password }),
      redirect: 'manual',
    });
    expect(crossSite.status).toBe(403);
  });

  it('rate-limits password guessing', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await browser.login(ADMIN.email, `wrong-${i}`)).status;
    expect(last).toBe(429);
  });

  it('shows who is asking and where the user will be sent on the consent screen', async () => {
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
    const browser = new TestBrowser(hub.baseUrl);
    await browser.login();
    const url = new URL('/oauth/authorize', hub.baseUrl);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: registration.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      scope: 'mcp offline_access openid',
    }).toString();
    const page = await browser.request(url.toString());
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('Подключить Claude к AnyConnect?');
    expect(html).toContain('claude.ai');
    expect(html).toContain('Известное ИИ-приложение');
    expect(html).toContain('оставаться подключённым');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
  });

  it('never redirects to an unregistered redirect_uri', async () => {
    const registration = await json(
      fetch(`${hub.baseUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['https://good.example/cb'],
          token_endpoint_auth_method: 'none',
        }),
      }),
    );
    const url = new URL('/oauth/authorize', hub.baseUrl);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: registration.client_id,
      redirect_uri: 'https://evil.example/cb',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
    }).toString();
    const response = await fetch(url, { redirect: 'manual' });
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();

    url.searchParams.set('redirect_uri', 'https://good.example/cb');
    url.searchParams.set('code_challenge_method', 'plain');
    const pkceError = await fetch(url, { redirect: 'manual' });
    expect(pkceError.status).toBe(302);
    const location = new URL(pkceError.headers.get('location')!);
    expect(location.origin).toBe('https://good.example');
    expect(location.searchParams.get('error')).toBe('invalid_request');
  });

  it('rejects dangerous dynamic registrations', async () => {
    const register = (body: unknown) =>
      fetch(`${hub.baseUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const http = await register({ redirect_uris: ['http://evil.example/cb'] });
    expect(http.status).toBe(400);
    expect((await json(http)).error).toBe('invalid_redirect_uri');
    expect((await register({ redirect_uris: [] })).status).toBe(400);
    const confidential = await json(register({ redirect_uris: ['https://ok.example/cb'] }));
    expect(confidential.client_secret).toMatch(/^ac_cs_/);
    expect(confidential.token_endpoint_auth_method).toBe('client_secret_basic');
  });
});
