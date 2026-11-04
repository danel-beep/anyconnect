import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { googleEmailAuthority, OidcLoginProvider } from '../src/core/external-login.js';
import { base32Decode, totp } from '../src/lib/totp.js';
import { ADMIN, resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

/**
 * The website end to end: "Sign in with Google" (against a fake OpenID provider), the dashboard,
 * plan limits and the admin panel's access control and limit grants.
 */

const CLIENT_ID = 'test-client.apps.example';
const ISSUER = 'https://accounts.example';

type Claims = Record<string, unknown>;

/** A fake OpenID provider: the test decides the ID token's claims for every code it hands out. */
class FakeOidc {
  private readonly tokens = new Map<string, Claims>();
  private counter = 0;
  readonly provider = new OidcLoginProvider(
    {
      id: 'google',
      name: 'Google',
      authorizationUrl: `${ISSUER}/auth`,
      tokenUrl: `${ISSUER}/token`,
      issuers: [ISSUER],
      clientId: CLIENT_ID,
      clientSecret: 'shh',
      scopes: ['openid', 'email', 'profile'],
      emailAuthority: googleEmailAuthority,
    },
    async (_url, init) => {
      const code = new URLSearchParams(String(init?.body)).get('code') ?? '';
      const claims = this.tokens.get(code);
      this.tokens.delete(code);
      if (!claims) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
      return Response.json({ id_token: `${part({ alg: 'RS256' })}.${part(claims)}.sig` });
    },
  );

  /** Walks /auth/google → provider → callback. Returns the callback response. */
  async signIn(
    browser: TestBrowser,
    claims: Claims,
    opts: { next?: string; state?: string; nonce?: string } = {},
  ): Promise<Response> {
    const start = await browser.request(
      `/auth/google${opts.next ? `?next=${encodeURIComponent(opts.next)}` : ''}`,
    );
    expect(start.status).toBe(302);
    const url = new URL(start.headers.get('location')!);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/auth`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const code = `code-${++this.counter}`;
    this.tokens.set(code, {
      iss: ISSUER,
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 600,
      nonce: opts.nonce ?? url.searchParams.get('nonce'),
      email_verified: true,
      ...claims,
    });
    const state = opts.state ?? url.searchParams.get('state')!;
    return browser.request(`/auth/google/callback?state=${encodeURIComponent(state)}&code=${code}`);
  }
}

const codeFor = (secret: string, offsetSteps = 0) =>
  totp(base32Decode(secret), Date.now() + offsetSteps * 30_000);

async function hiddenOf(browser: TestBrowser, path: string): Promise<Record<string, string>> {
  const page = await browser.request(path);
  expect(page.status).toBe(200);
  return TestBrowser.hiddenInputs(await page.text());
}

/** Turns on TOTP for the signed-in user; confirming it upgrades the current session (pwd + otp). */
async function enableTotp(browser: TestBrowser): Promise<string> {
  const { csrf } = await hiddenOf(browser, '/security');
  await browser.request('/security/totp/setup', { form: { csrf: csrf! } });
  const page = await (await browser.request('/security')).text();
  const secret = page.match(/id="totp-secret"[^>]*value="([A-Z2-7]+)"/)![1]!;
  const confirm = await browser.request('/security/totp/confirm', {
    form: { csrf: csrf!, code: codeFor(secret) },
  });
  expect(confirm.status).toBe(200);
  return secret;
}

describe('website: Google sign-in, dashboard, limits and the admin panel', () => {
  let hub: TestHub;
  let oidc: FakeOidc;

  const userByEmail = async (email: string) =>
    (await hub.services.db.query.users.findFirst({ where: (u, { eq }) => eq(u.email, email) }))!;
  const workspaceOf = async (userId: string) => (await hub.services.users.ownedWorkspaces(userId))[0]!;

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await hub?.close();
    oidc = new FakeOidc();
    hub = await startTestHub({
      loginProviders: [oidc.provider],
      env: { ADMIN_EMAILS: 'boss@example.com' },
    });
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('signs up with Google into a new workspace and welcomes the user on the dashboard', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    const login = await (await browser.request('/login')).text();
    expect(login).toContain('href="/auth/google?next=%2Fapp"');

    const done = await oidc.signIn(browser, { sub: 'g-1', email: 'Anna@Example.com', name: 'Анна' });
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('/app?welcome=1');
    const user = await userByEmail('anna@example.com');
    expect(user).toMatchObject({ name: 'Анна', role: 'user', status: 'active' });

    const home = await browser.request('/app?welcome=1');
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain('Анна');
    expect(html).toContain('/mcp');

    // Signing in again finds the same user (by the Google subject), not a new one.
    await browser.request('/logout', { form: await hiddenOf(browser, '/app/settings') });
    const again = await oidc.signIn(
      browser,
      { sub: 'g-1', email: 'anna@example.com' },
      { next: '/app/apps' },
    );
    expect(again.headers.get('location')).toBe('/app/apps');
    const { rows } = await hub.services.database.pool.query('SELECT count(*)::int AS n FROM users');
    expect(rows[0].n).toBe(2); // the owner and Anna
  });

  it('refuses forged or replayed callbacks and unverified addresses', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    const wrongState = await oidc.signIn(
      browser,
      { sub: 'g-2', email: 'x@example.com' },
      { state: 'forged' },
    );
    expect(wrongState.headers.get('location')).toBe('/login?error=externalFailed');

    const wrongNonce = await oidc.signIn(browser, { sub: 'g-2', email: 'x@example.com' }, { nonce: 'other' });
    expect(wrongNonce.headers.get('location')).toBe('/login?error=externalFailed');

    // A callback without the browser's state cookie (another browser, or replayed).
    const stranger = new TestBrowser(hub.baseUrl);
    const replay = await stranger.request('/auth/google/callback?state=abc&code=def');
    expect(replay.headers.get('location')).toBe('/login?error=expired');

    const unverified = await oidc.signIn(browser, {
      sub: 'g-3',
      email: 'owner@example.com',
      email_verified: false,
    });
    expect(unverified.headers.get('location')).toBe('/login?error=email_unverified');
    const page = await (await browser.request('/login?error=email_unverified')).text();
    expect(page).toContain('role="alert"');
    expect((await browser.request('/app')).status).toBe(302);
    const { rows } = await hub.services.database.pool.query('SELECT count(*)::int AS n FROM user_identities');
    expect(rows[0].n).toBe(0);
  });

  it('links Google to an existing account by its verified address and keeps its second factor', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await browser.login();
    const secret = await enableTotp(browser);
    await browser.request('/logout', { form: await hiddenOf(browser, '/app/settings') });

    // A Google account for the address that Google does not vouch for (not Gmail, no Workspace domain)
    // must not take over the existing user.
    const squatter = await oidc.signIn(new TestBrowser(hub.baseUrl), { sub: 'g-old', email: ADMIN.email });
    expect(squatter.headers.get('location')).toBe('/login?error=email_unverified');

    const google = await oidc.signIn(browser, { sub: 'g-owner', email: ADMIN.email, hd: 'example.com' });
    expect(google.headers.get('location')).toBe('/login/verify?next=%2Fapp');
    expect((await browser.request('/app')).status).toBe(302);
    const hidden = await hiddenOf(browser, '/login/verify');
    const ok = await browser.request('/login/verify', { form: { ...hidden, code: codeFor(secret, 1) } });
    expect(ok.headers.get('location')).toBe('/app');
    const { rows } = await hub.services.database.pool.query(
      'SELECT amr FROM web_sessions ORDER BY created_at DESC LIMIT 1',
    );
    expect(rows[0].amr).toEqual(['fed', 'otp']);
  });

  it('gives the admin role to ADMIN_EMAILS and refuses new sign-ups when they are closed', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    // Not vouched for by Google: no admin is created from the address alone.
    const unvouched = await oidc.signIn(new TestBrowser(hub.baseUrl), {
      sub: 'g-x',
      email: 'boss@example.com',
    });
    expect(unvouched.headers.get('location')).toBe('/login?error=email_unverified');
    await oidc.signIn(browser, { sub: 'g-boss', email: 'boss@example.com', hd: 'example.com' });
    expect((await userByEmail('boss@example.com')).role).toBe('admin');
    // Admins get the unlimited plan on their own workspace.
    const ws = await workspaceOf((await userByEmail('boss@example.com')).id);
    expect((await hub.services.entitlements.summary(ws.id)).plan.id).toBe('unlimited');

    await hub.close();
    oidc = new FakeOidc();
    hub = await startTestHub({ loginProviders: [oidc.provider], env: { SIGNUPS: 'closed' } });
    const closed = await oidc.signIn(new TestBrowser(hub.baseUrl), {
      sub: 'g-new',
      email: 'new@example.com',
    });
    expect(closed.headers.get('location')).toBe('/login?error=signups_closed');
    expect(
      await hub.services.db.query.users.findFirst({ where: (u, { eq }) => eq(u.email, 'new@example.com') }),
    ).toBeUndefined();
    // The sign-up page says so instead of offering a form.
    const signup = await (await new TestBrowser(hub.baseUrl).request('/signup')).text();
    expect(signup).not.toContain('href="/auth/google');
  });

  it('does not promote an account whose address was never proven when it is added to ADMIN_EMAILS later', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    // A consumer Google account for a non-Google domain: allowed to sign up, but not authoritative.
    await oidc.signIn(browser, { sub: 'g-late', email: 'late@example.com' });
    // Later the owner lists that address as an admin (here: the account's address becomes one).
    await hub.services.database.pool.query(
      `UPDATE users SET email = 'boss@example.com' WHERE email = 'late@example.com'`,
    );
    await oidc.signIn(browser, { sub: 'g-late', email: 'boss@example.com' });
    expect((await userByEmail('boss@example.com')).role).toBe('user');
    // The same address proven by its Workspace domain is promoted.
    await oidc.signIn(browser, { sub: 'g-late', email: 'boss@example.com', hd: 'example.com' });
    expect((await userByEmail('boss@example.com')).role).toBe('admin');
  });

  it('keeps suspended users out on every path and ends their sessions', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await oidc.signIn(browser, { sub: 'g-bad', email: 'bad@example.com' });
    expect((await browser.request('/app')).status).toBe(200);
    const bad = await userByEmail('bad@example.com');
    const ws = await workspaceOf(bad.id);
    const me = (token: string) =>
      fetch(`${hub.baseUrl}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } });
    const before = await hub.services.apiTokens.create({ workspaceId: ws.id, userId: bad.id, name: 'a' });
    expect((await me(before.token)).status).toBe(200);
    await hub.services.users.setStatus(bad.id, 'suspended', 'spam');
    expect((await me(before.token)).status).toBe(401);
    // A token that slipped through (issued in a race with the suspension) does not work either.
    const late = await hub.services.apiTokens.create({ workspaceId: ws.id, userId: bad.id, name: 'b' });
    expect((await me(late.token)).status).toBe(401);

    expect((await browser.request('/app')).status).toBe(302);
    const google = await oidc.signIn(new TestBrowser(hub.baseUrl), {
      sub: 'g-bad',
      email: 'bad@example.com',
    });
    expect(google.headers.get('location')).toBe('/login?error=suspended');
  });

  it('enforces plan limits for actions and accounts; the admin can add more', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await oidc.signIn(browser, { sub: 'g-lim', email: 'lim@example.com' });
    const user = await userByEmail('lim@example.com');
    const ws = await workspaceOf(user.id);
    const { token } = await hub.services.apiTokens.create({ workspaceId: ws.id, userId: user.id, name: 't' });
    const api = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${hub.baseUrl}/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    await api('/workspace', 'PATCH', { settings: { toolExposure: 'per_account' } });

    // Free plan: 3 accounts.
    for (const name of ['a1', 'a2', 'a3']) {
      const created = await api('/accounts', 'POST', {
        connectorId: 'demo',
        name,
        label: name,
        credentials: { secret: 's' },
      });
      expect(created.status).toBe(201);
    }
    const fourth = await api('/accounts', 'POST', {
      connectorId: 'demo',
      name: 'a4',
      label: 'a4',
      credentials: { secret: 's' },
    });
    expect(fourth.status).toBe(402);

    // Free plan with the sign-up bonus: 500 actions a month. Use them all up.
    const today = new Date().toISOString().slice(0, 10);
    await hub.services.database.pool.query(
      `INSERT INTO usage_counters (workspace_id, day, caller, connector_id, action, calls)
       VALUES ($1, $2, 'test', 'demo', 'echo', 500)`,
      [ws.id, today],
    );
    const blocked = await api('/tools/demo_a1_echo/call', 'POST', { arguments: { message: 'hi' } });
    expect(blocked.body.isError).toBe(true);
    expect(blocked.body.content[0].text).toContain('plan limit is reached');

    // The dashboard shows the usage.
    const billing = await (await browser.request('/app/billing')).text();
    expect(billing).toContain('500');

    // The admin grants 100 more actions through the panel.
    const admin = new TestBrowser(hub.baseUrl);
    await admin.login();
    await enableTotp(admin);
    const userPage = `/admin/users/${user.id}`;
    const { csrf } = await hiddenOf(admin, userPage);
    const grant = await admin.request(`${userPage}/limits`, {
      form: { csrf: csrf!, metric: 'actions', amount: '100', duration: 'month', reason: 'support' },
    });
    expect(grant.status).toBe(303);
    expect(grant.headers.get('location')).toBe(userPage);
    const after = await (await admin.request(userPage)).text();
    expect(after).toContain('support');

    const allowed = await api('/tools/demo_a1_echo/call', 'POST', { arguments: { message: 'hi' } });
    expect(allowed.body.isError).toBeFalsy();
    expect(allowed.body.content[0].text).toContain(': hi');

    // A plan change lifts the account limit too.
    const plan = await admin.request(`${userPage}/plan`, {
      form: { csrf: csrf!, plan: 'personal', until: '', note: '' },
    });
    expect(plan.status).toBe(303);
    expect(
      (
        await api('/accounts', 'POST', {
          connectorId: 'demo',
          name: 'a4',
          label: 'a4',
          credentials: { secret: 's' },
        })
      ).status,
    ).toBe(201);
    const { rows } = await hub.services.database.pool.query(
      'SELECT action FROM admin_audit_log ORDER BY created_at',
    );
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['limit.grant', 'plan.set']));
  });

  it('opens the admin panel only to admins with a fresh two-step sign-in', async () => {
    // Signed out: sent to sign in.
    const anonymous = new TestBrowser(hub.baseUrl);
    expect((await anonymous.request('/admin')).headers.get('location')).toBe('/login?next=%2Fadmin');

    // A regular user: the panel does not exist.
    const user = new TestBrowser(hub.baseUrl);
    await oidc.signIn(user, { sub: 'g-u', email: 'user@example.com' });
    expect((await user.request('/admin')).status).toBe(404);
    expect((await user.request('/admin/users')).status).toBe(404);
    const userId = (await userByEmail('user@example.com')).id;
    const { csrf: userCsrf } = await hiddenOf(user, '/app/settings');
    const sneaky = await user.request(`/admin/users/${userId}/plan`, {
      form: { csrf: userCsrf!, plan: 'unlimited', until: '', note: '' },
    });
    expect(sneaky.status).toBe(404);

    // The owner without a second factor: told to set one up.
    const admin = new TestBrowser(hub.baseUrl);
    await admin.login();
    const no2fa = await admin.request('/admin');
    expect(no2fa.status).toBe(403);
    expect(await no2fa.text()).toContain('/security?next=%2Fadmin');

    // With TOTP turned on in this session: allowed.
    const secret = await enableTotp(admin);
    expect((await admin.request('/admin')).status).toBe(200);
    expect((await admin.request('/admin/users?q=user')).status).toBe(200);
    expect(await (await admin.request('/admin/users?q=user')).text()).toContain('user@example.com');

    // A password-only session (second factor skipped) is sent to sign in again.
    await hub.services.database.pool.query(`UPDATE web_sessions SET amr = '{pwd}'`);
    expect((await admin.request('/admin')).headers.get('location')).toMatch(
      /^\/login\?reauth=1&next=%2Fadmin/,
    );
    await hub.services.database.pool.query(`UPDATE web_sessions SET amr = '{pwd,otp}'`);

    // An old sign-in is sent to sign in again too.
    await hub.services.database.pool.query(
      `UPDATE web_sessions SET authenticated_at = now() - interval '13 hours'`,
    );
    expect((await admin.request('/admin')).status).toBe(302);
    await hub.services.database.pool.query(`UPDATE web_sessions SET authenticated_at = now()`);

    // Changes need the CSRF token, and the admin cannot lock themselves out.
    const ownerId = (await userByEmail(ADMIN.email)).id;
    const noCsrf = await admin.request(`/admin/users/${ownerId}/suspend`, { form: { reason: 'x' } });
    expect(noCsrf.status).toBe(403);
    const { csrf } = await hiddenOf(admin, `/admin/users/${ownerId}`);
    const self = await admin.request(`/admin/users/${ownerId}/suspend`, {
      form: { csrf: csrf!, reason: 'x' },
    });
    expect(self.status).toBe(303);
    expect((await userByEmail(ADMIN.email)).status).toBe('active');

    // Suspending a user signs them out at once.
    const suspend = await admin.request(`/admin/users/${userId}/suspend`, {
      form: { csrf: csrf!, reason: 'abuse' },
    });
    expect(suspend.status).toBe(303);
    expect((await user.request('/app')).status).toBe(302);
    void secret;
  });

  it('only lets users change their own accounts', async () => {
    const owner = (await hub.services.db.query.accounts.findFirst())!;
    const browser = new TestBrowser(hub.baseUrl);
    await oidc.signIn(browser, { sub: 'g-i', email: 'i@example.com' });
    const { csrf } = await hiddenOf(browser, '/app/services');
    const response = await browser.request(`/app/accounts/${owner.id}/delete`, { form: { csrf: csrf! } });
    expect(response.status).toBe(303);
    expect(
      await hub.services.db.query.accounts.findFirst({ where: (a, { eq }) => eq(a.id, owner.id) }),
    ).toBeDefined();
    const page = await (await browser.request('/app/services')).text();
    expect(page).toContain('class="notice bad"');
  });
  it('edits confirmation defaults and per-account rules on the Rules page', async () => {
    const foreign = (await hub.services.db.query.accounts.findFirst())!;
    const browser = new TestBrowser(hub.baseUrl);
    await oidc.signIn(browser, { sub: 'g-r', email: 'rules@example.com' });
    const user = await userByEmail('rules@example.com');
    const ws = await workspaceOf(user.id);
    const account = await hub.services.accounts.create(ws.id, {
      connectorId: 'demo',
      name: 'home',
      label: 'Дом',
      credentials: { secret: 's' },
    });

    const page = await (await browser.request('/app/rules')).text();
    expect(page).toContain('Дом');
    const { csrf } = TestBrowser.hiddenInputs(page);

    const defaults = await browser.request('/app/rules/defaults', {
      form: { csrf: csrf!, confirm: 'write', undo: '30' },
    });
    expect(defaults.status).toBe(303);
    expect(await hub.services.admin.security(ws.id)).toMatchObject({
      defaultConfirm: 'write',
      undoWindowSeconds: 30,
    });

    const scoped = (id: string, access: string, confirm: string) =>
      browser.request('/app/rules/scoped', { form: { csrf: csrf!, kind: 'account', id, access, confirm } });
    expect((await scoped(account.id, 'read', '')).status).toBe(303);
    const rules = await hub.services.policies.listRules(ws.id);
    expect(rules).toEqual([
      expect.objectContaining({ accountId: account.id, access: 'read', confirm: null }),
    ]);
    const shown = await (await browser.request('/app/rules')).text();
    expect(shown).toContain('<option value="read" selected="">');

    // Saving it again updates the same rule; "as by default" for both removes it.
    expect((await scoped(account.id, 'read', 'always')).status).toBe(303);
    expect(await hub.services.policies.listRules(ws.id)).toHaveLength(1);
    expect((await scoped(account.id, '', '')).status).toBe(303);
    expect(await hub.services.policies.listRules(ws.id)).toHaveLength(0);

    // Another workspace's account is refused.
    expect(foreign.workspaceId).not.toBe(ws.id);
    await scoped(foreign.id, 'none', '');
    expect(await hub.services.policies.listRules(ws.id)).toHaveLength(0);
    expect(await (await browser.request('/app/rules')).text()).toContain('class="notice bad"');
  });

  it('records a paid plan request, shows it to the admin and closes it when the plan is set', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await oidc.signIn(browser, { sub: 'g-p', email: 'payer@example.com' });
    const user = await userByEmail('payer@example.com');
    const ws = await workspaceOf(user.id);
    const { csrf } = await hiddenOf(browser, '/app/billing');
    const sent = await browser.request('/app/billing/request', { form: { csrf: csrf!, plan: 'personal' } });
    expect(sent.status).toBe(303);
    expect(await hub.services.entitlements.openRequest(ws.id)).toMatchObject({ planId: 'personal' });
    // Asking twice keeps one open request.
    await browser.request('/app/billing/request', { form: { csrf: csrf!, plan: 'pro' } });
    expect(
      (await hub.services.entitlements.openRequests(10)).filter((r) => r.workspaceId === ws.id),
    ).toHaveLength(1);
    // Only public paid plans can be asked for.
    await browser.request('/app/billing/request', { form: { csrf: csrf!, plan: 'unlimited' } });
    expect(await hub.services.entitlements.openRequest(ws.id)).toMatchObject({ planId: 'pro' });

    const admin = new TestBrowser(hub.baseUrl);
    await admin.login();
    await enableTotp(admin);
    const overview = await (await admin.request('/admin')).text();
    expect(overview).toContain('Запросы тарифа');
    expect(overview).toContain('payer@example.com');
    const userPage = `/admin/users/${user.id}`;
    const { csrf: adminCsrf } = await hiddenOf(admin, userPage);
    await admin.request(`${userPage}/plan`, { form: { csrf: adminCsrf!, plan: 'pro', until: '', note: '' } });
    expect(await hub.services.entitlements.openRequest(ws.id)).toBeUndefined();
    expect(await (await admin.request('/admin')).text()).not.toContain('Запросы тарифа');
  });

  it('gives the custom MCP form back as filled when the address is wrong', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await oidc.signIn(browser, { sub: 'g-c', email: 'custom@example.com' });
    const { csrf } = await hiddenOf(browser, '/app/services');
    const sent = await browser.request('/app/custom', {
      form: { csrf: csrf!, name: 'Мой сервер', url: 'ftp://nope', token: 'secret-token' },
    });
    expect(sent.status).toBe(303);
    const location = sent.headers.get('location')!;
    expect(location).toMatch(/^\/app\/services\?draft=1&/);
    expect(location).not.toContain('secret-token');
    const html = await (await browser.request(location)).text();
    expect(html).toContain('value="ftp://nope"');
    expect(html).toContain('class="notice bad"');
  });
});

describe('website: public pages', () => {
  let hub: TestHub;

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub();
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('serves the landing, pricing, services, docs and legal pages in both languages', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    for (const path of ['/', '/pricing', '/services', '/services/github', '/docs', '/privacy', '/terms']) {
      const page = await browser.request(path);
      expect(page.status, path).toBe(200);
      const html = await page.text();
      expect(html, path).toContain('<html lang="ru"');
      expect(html, path).toContain('<main id="main"');
    }
    const english = await browser.request('/prefs/lang?to=en&next=%2Fpricing');
    expect(english.headers.get('location')).toBe('/pricing');
    expect(await (await browser.request('/pricing')).text()).toContain('<html lang="en"');
    // Only same-site paths are followed.
    const evil = await browser.request('/prefs/lang?to=ru&next=https%3A%2F%2Fevil.example');
    expect(evil.headers.get('location')).toBe('/');
  });

  it('answers unknown pages with a styled 404 and keeps robots and the sitemap', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    const missing = await fetch(`${hub.baseUrl}/no-such-page`, { headers: { accept: 'text/html' } });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('<html');
    const apiMissing = await fetch(`${hub.baseUrl}/no-such-page`, {
      headers: { accept: 'application/json' },
    });
    expect(apiMissing.status).toBe(404);

    const robots = await (await browser.request('/robots.txt')).text();
    expect(robots).toContain('Disallow: /admin');
    expect(robots).toContain('Disallow: /app');
    const sitemap = await (await browser.request('/sitemap.xml')).text();
    expect(sitemap).toContain(`${hub.baseUrl}/pricing`);
    expect(sitemap).not.toContain('/admin');

    const csp = (await browser.request('/')).headers.get('content-security-policy')!;
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect((await browser.request('/favicon.svg')).headers.get('content-type')).toContain('image/svg+xml');
    expect((await browser.request('/assets/fonts/constructor')).status).toBe(404);
    expect((await browser.request('/assets/fonts/__proto__')).status).toBe(404);
  });
});
