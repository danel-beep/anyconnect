import { UnauthorizedError } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode, totp } from '../../src/lib/totp.js';
import { ADMIN, resetDatabase, startTestHub, TestBrowser, type TestHub } from '../helpers.js';
import { AI_CLIENTS, SimulatedAiClient, serveClientDocuments } from './ai-clients.js';
import { FakeInternet } from './fake-internet.js';
import { FakeGoogle, type GoogleUser } from './fakes/google.js';
import { allow, decodeEntities, mailboxes, signInWithGoogle, textOf } from './journey.js';

/**
 * The less common turns of a connection, each from the AI client's side: the address pasted with
 * a slash at the end, a persona's own address, the user saying no (at Google or on the consent
 * screen), sign-ups closed, a required second factor set up in the middle of connecting, and an
 * app that signs out with the revocation endpoint.
 */
describe('connection edge cases', () => {
  let hub: TestHub;
  let internet: FakeInternet;
  let google: FakeGoogle;
  let newcomer: GoogleUser;
  const claudeProfile = AI_CLIENTS.find((c) => c.id === 'claude')!;
  const open: SimulatedAiClient[] = [];

  const start = async (env: Record<string, string> = {}) => {
    await hub?.close();
    hub = await startTestHub({ internet, env: { ...google.env, CONFIRMATION_WAIT_SECONDS: '0', ...env } });
  };
  const claude = (url = hub.mcpUrl) => {
    const client = new SimulatedAiClient(claudeProfile, url);
    open.push(client);
    return client;
  };
  /** Signs the owner in with the password in a new window, then allows access. */
  const ownerAllows = async (authorizationUrl: URL) => {
    const browser = new TestBrowser(hub.baseUrl, internet.fetch);
    const { url } = await browser.walk(authorizationUrl);
    const signedIn = await browser.login(ADMIN.email, ADMIN.password, url.searchParams.get('next')!);
    const { response } = await browser.walk(signedIn.headers.get('location')!);
    expect(response.status).toBe(200);
    return allow(browser, response, claudeProfile);
  };

  beforeAll(async () => {
    await resetDatabase();
    internet = new FakeInternet();
    google = new FakeGoogle().install(internet);
    serveClientDocuments(internet);
    newcomer = google.addUser({ email: 'new.user@gmail.com', mailbox: mailboxes.personal });
  });

  beforeEach(async () => {
    google.signedIn = newcomer;
    google.consent = 'allow';
    await start();
  });

  afterEach(async () => {
    for (const client of open.splice(0)) await client.close();
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('connects when the address is pasted with a slash at the end', async () => {
    const client = await claude(`${hub.mcpUrl}/`).connect(ownerAllows);
    expect(await client.toolNames()).toContain('demo_echo');
    const echo = await client.call('demo_echo', { account: 'main', message: 'slash' });
    expect(textOf(echo)).toContain('slash');
  });

  it('connects to a persona’s own address and sees only its accounts', async () => {
    const workspaceId = (await hub.services.db.query.workspaces.findFirst())!.id;
    const main = (await hub.services.accounts.list(workspaceId)).find((a) => a.name === 'main')!;
    await hub.services.personas.create(workspaceId, { slug: 'work', name: 'Work', accountIds: [main.id] });

    let consentPage = '';
    const client = await claude(`${hub.mcpUrl}/work`).connect(async (authorizationUrl) => {
      const browser = new TestBrowser(hub.baseUrl, internet.fetch);
      const { url } = await browser.walk(authorizationUrl);
      const signedIn = await browser.login(ADMIN.email, ADMIN.password, url.searchParams.get('next')!);
      const { response } = await browser.walk(signedIn.headers.get('location')!);
      consentPage = await response.text();
      return allow(browser, new Response(consentPage), claudeProfile);
    });
    expect(consentPage).toContain('<strong>Work</strong> (work)');
    const echo = (await client.mcp.listTools()).tools.find((t) => t.name === 'demo_echo')!;
    expect(
      (echo.inputSchema.properties as Record<string, { enum?: string[] }>).account?.enum ?? ['main'],
    ).toEqual(['main']);
    // Setup tools would let the persona widen its own access: it has none.
    expect(
      (await client.toolNames()).filter(
        (n) => n.startsWith('manyplug_') && n !== 'manyplug_list_accounts' && n !== 'manyplug_call_tools',
      ),
    ).toEqual([]);
    const other = await client.call('demo_echo', { account: 'second', message: 'x' });
    expect(other.isError).toBe(true);
  });

  it('hands the refusal back to the app when the user denies access', async () => {
    const client = claude();
    await expect(
      client.connect(async (authorizationUrl) => {
        const browser = new TestBrowser(hub.baseUrl, internet.fetch);
        const { url } = await browser.walk(authorizationUrl);
        const signedIn = await browser.login(ADMIN.email, ADMIN.password, url.searchParams.get('next')!);
        const { response } = await browser.walk(signedIn.headers.get('location')!);
        const callback = await allow(browser, response, claudeProfile, 'deny');
        expect(callback.searchParams.get('error')).toBe('access_denied');
        expect(callback.searchParams.get('state')).toBe(authorizationUrl.searchParams.get('state'));
        return callback;
      }),
    ).rejects.toThrow();
    expect(await hub.services.db.query.oauthGrants.findMany()).toEqual([]);
  });

  it('brings the user back to sign-in when they cancel at Google, and they can try again', async () => {
    const browser = new TestBrowser(hub.baseUrl, internet.fetch);
    const client = claude();
    const connected = client.connect(async (authorizationUrl) => {
      google.consent = 'deny';
      const { url } = await browser.walk(authorizationUrl);
      const next = url.searchParams.get('next')!;
      const { response, url: landed } = await browser.walk(`/auth/google?next=${encodeURIComponent(next)}`);
      // Back on the hub's sign-in page, with a message and the way to continue.
      expect(landed.origin).toBe(hub.baseUrl);
      const page = await response.text();
      expect(landed.pathname).toBe('/login');
      expect(page).toContain('Вход через Google отменён');
      expect(decodeEntities(page)).toContain(`/auth/google?next=${encodeURIComponent(next)}`);
      google.consent = 'allow';
      const consent = await signInWithGoogle(browser, authorizationUrl);
      return allow(browser, consent, claudeProfile);
    });
    await connected;
    expect(await client.toolNames()).toContain('manyplug_connect_account');
  });

  it('says plainly in the sign-in window when new sign-ups are closed', async () => {
    await start({ SIGNUPS: 'closed' });
    const browser = new TestBrowser(hub.baseUrl, internet.fetch);
    const client = claude();
    await expect(
      client.connect(async (authorizationUrl) => {
        const { url } = await browser.walk(authorizationUrl);
        const next = url.searchParams.get('next')!;
        const { response, url: landed } = await browser.walk(`/auth/google?next=${encodeURIComponent(next)}`);
        expect(landed.origin).toBe(hub.baseUrl);
        const page = await response.text();
        expect(page).toMatch(/закрыт|closed|приглаш|invit/i);
        // Still on the way back to the app, should the user sign in another way.
        expect(landed.searchParams.get('next')).toBe(next);
        throw new Error('no account');
      }),
    ).rejects.toThrow('no account');
    expect(
      await hub.services.db.query.users.findFirst({ where: (u, { eq }) => eq(u.email, newcomer.email) }),
    ).toBeUndefined();
  });

  it('sets up the required second factor in the middle of connecting, then continues to the consent screen', async () => {
    await start({ REQUIRE_2FA: 'true' });
    const browser = new TestBrowser(hub.baseUrl, internet.fetch);
    const client = await claude().connect(async (authorizationUrl) => {
      const { url } = await browser.walk(authorizationUrl);
      const next = url.searchParams.get('next')!;
      const { response, url: landed } = await browser.walk(`/auth/google?next=${encodeURIComponent(next)}`);
      // A new account must add a second factor before any app gets access.
      expect(landed.pathname).toBe('/security');
      expect(landed.searchParams.get('next')).toBe(next);
      const { csrf } = TestBrowser.hiddenInputs(await response.text());
      await browser.request('/security/totp/setup', { form: { csrf: csrf!, next } });
      const setup = await (await browser.request(`/security?next=${encodeURIComponent(next)}`)).text();
      const secret = /id="totp-secret"[^>]*value="([A-Z2-7]+)"/.exec(setup)![1]!;
      const confirmed = await browser.request('/security/totp/confirm', {
        form: { csrf: csrf!, next, code: totp(base32Decode(secret), Date.now()) },
      });
      expect(confirmed.status).toBe(200);
      // The recovery codes page leads back to the security page, which offers to continue.
      const security = await (await browser.request(`/security?next=${encodeURIComponent(next)}`)).text();
      expect(decodeEntities(security)).toContain(`href="${next}"`);
      const { response: consent } = await browser.walk(next);
      expect(consent.status).toBe(200);
      return allow(browser, consent, claudeProfile);
    });
    expect(await client.toolNames()).toContain('manyplug_connect_account');
  });

  it('signs an app out with the revocation endpoint', async () => {
    const client = await claude().connect(ownerAllows);
    const { refresh_token } = client.provider.savedTokens!;
    const revoked = await fetch(`${hub.baseUrl}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refresh_token!, client_id: client.provider.client!.client_id }),
    });
    expect(revoked.status).toBe(200);
    await expect(client.open()).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
