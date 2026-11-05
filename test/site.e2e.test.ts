import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode, totp } from '../src/lib/totp.js';
import { FakeOidc } from './fake-oidc.js';
import { ADMIN, resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

/**
 * The website end to end: "Sign in with Google" (against a fake OpenID provider), the dashboard,
 * plan limits and the admin panel's access control and limit grants.
 */

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
    const scopes = ['mcp', 'api'] as const;
    const before = await hub.services.apiTokens.create({
      workspaceId: ws.id,
      userId: bad.id,
      name: 'a',
      scopes: [...scopes],
    });
    expect((await me(before.token)).status).toBe(200);
    await hub.services.users.setStatus(bad.id, 'suspended', 'spam');
    expect((await me(before.token)).status).toBe(401);
    // A token that slipped through (issued in a race with the suspension) does not work either.
    const late = await hub.services.apiTokens.create({
      workspaceId: ws.id,
      userId: bad.id,
      name: 'b',
      scopes: [...scopes],
    });
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
    // Past the 14-day Pro trial, in the first step down (500 actions, Free accounts).
    await hub.services.database.pool.query(
      `UPDATE workspaces SET created_at = now() - interval '20 days' WHERE id = $1`,
      [ws.id],
    );
    const { token } = await hub.services.apiTokens.create({
      workspaceId: ws.id,
      userId: user.id,
      name: 't',
      scopes: ['mcp', 'api'],
    });
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

    // Free plan in its first step down: 500 actions a month. Use them all up.
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
    const saved = await scoped(account.id, 'read', '');
    expect(saved.status).toBe(303);
    // Rows save on change: the page comes back at the row, marked as saved.
    expect(saved.headers.get('location')).toBe(`/app/rules?saved=${account.id}#rule-${account.id}`);
    expect(await (await browser.request(`/app/rules?saved=${account.id}`)).text()).toContain('Сохранено');
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
    // The admin sidebar counts the request; the user's page has the plan form filled in for it.
    expect(overview).toMatch(/href="\/admin"[\s\S]*?<span class="count"[^>]*><span aria-hidden="true">1</);
    const userPage = `/admin/users/${user.id}`;
    const detail = await (await admin.request(userPage)).text();
    expect(detail).toContain('<option value="pro" selected="">');
    expect(detail).toMatch(/name="until" value="\d{4}-\d\d-\d\d"/);
    const { csrf: adminCsrf } = TestBrowser.hiddenInputs(detail);

    // Declining closes it without touching the plan, and the admin log says so.
    const declined = await admin.request(`${userPage}/request/decline`, { form: { csrf: adminCsrf! } });
    expect(declined.status).toBe(303);
    expect(await hub.services.entitlements.openRequest(ws.id)).toBeUndefined();
    expect((await hub.services.entitlements.summary(ws.id)).plan.id).toBe('free');
    expect(await (await admin.request('/admin/audit')).text()).toContain('Запрос тарифа отклонён');
    expect(await (await admin.request('/admin')).text()).not.toContain('Запросы тарифа');
    const revenue = await (await admin.request('/admin/revenue')).text();
    expect(revenue).toContain('Выручка и конверсия');
    expect(revenue).toContain('BILLING_PROVIDER=none');

    // Setting a plan closes an open request too.
    await browser.request('/app/billing/request', { form: { csrf: csrf!, plan: 'pro' } });
    await admin.request(`${userPage}/plan`, { form: { csrf: adminCsrf!, plan: 'pro', until: '', note: '' } });
    expect(await hub.services.entitlements.openRequest(ws.id)).toBeUndefined();
    expect(await (await admin.request('/admin')).text()).not.toContain('Запросы тарифа');
  });

  it('pages through the activity log, 30 rows at a time', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await oidc.signIn(browser, { sub: 'g-log', email: 'log@example.com' });
    const ws = await workspaceOf((await userByEmail('log@example.com')).id);
    await hub.services.database.pool.query(
      `INSERT INTO tool_calls (workspace_id, connector_id, tool_name, principal_type, status, duration_ms, created_at)
       SELECT $1, 'demo', 'demo_call_' || n, 'api_token', 'ok', 5, now() - n * interval '1 minute'
       FROM generate_series(1, 35) AS n`,
      [ws.id],
    );
    const first = await (await browser.request('/app/activity')).text();
    // A tool the service does not list is shown by its name in words; the exact name is the tooltip.
    expect(first).toContain('>Call 1<');
    expect(first).toContain('title="demo_call_1"');
    expect(first).not.toContain('title="demo_call_31"');
    const more = first.match(/href="(\/app\/activity\?before=[^"#]+)#log"/)![1]!.replaceAll('&amp;', '&');
    const second = await (await browser.request(more)).text();
    expect(second).toContain('title="demo_call_31"');
    expect(second).toContain('title="demo_call_35"');
    expect(second).not.toContain('title="demo_call_30"');
    expect(second).not.toContain('?before=');
  });

  it("shows an account's own page: actions on and off, its rule and its own activity", async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await oidc.signIn(browser, { sub: 'g-acc', email: 'acc@example.com' });
    const ws = await workspaceOf((await userByEmail('acc@example.com')).id);
    const create = (name: string, label: string) =>
      hub.services.accounts.create(ws.id, { connectorId: 'demo', name, label, credentials: { secret: 's' } });
    const home = await create('home', 'Home');
    const work = await create('work', 'Work');
    await hub.services.database.pool.query(
      `INSERT INTO tool_calls (workspace_id, account_id, connector_id, action, tool_name, principal_type, status, duration_ms, created_at)
       VALUES ($1, $2, 'demo', 'echo', 'demo_echo', 'api_token', 'ok', 5, now() - interval '3 minutes'),
              ($1, $2, 'demo', 'fail', 'demo_fail', 'api_token', 'error', 5, now() - interval '2 minutes'),
              ($1, $3, 'demo', 'account_info', 'demo_account_info', 'api_token', 'ok', 5, now() - interval '1 minute')`,
      [ws.id, home.id, work.id],
    );
    const base = `/app/accounts/${home.id}`;

    const page = await (await browser.request(base)).text();
    expect(page).toContain('<h1>Home</h1>');
    expect(page).toContain('name="on.echo" checked=""');
    // Its own activity only, by the action's title.
    expect(page).toContain('title="demo_fail">Имитация ошибки<');
    expect(page).not.toContain('title="demo_account_info"');
    expect(page).toContain(`href="/app/activity?account=${home.id}"`);

    // Unchecked boxes turn actions off; the AI's catalog follows.
    const { csrf } = TestBrowser.hiddenInputs(page);
    const saved = await browser.request(`${base}/tools`, { form: { csrf: csrf!, 'on.echo': 'on' } });
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe('/app/services');
    expect((await hub.services.accounts.get(ws.id, home.id)).settings.disabledActions).toEqual([
      'account_info',
      'fail',
    ]);
    const after = await (await browser.request(base)).text();
    expect(after).toContain('name="on.echo" checked=""');
    expect(after).toMatch(/name="on\.fail"\/>/);

    // Forms on the page come back to it; a foreign "back" falls back to the list.
    const rule = await browser.request('/app/rules/scoped', {
      form: { csrf: csrf!, kind: 'account', id: home.id, access: 'read', confirm: '', back: base },
    });
    expect(rule.headers.get('location')).toBe(base);
    expect(await hub.services.policies.listRules(ws.id)).toEqual([
      expect.objectContaining({ accountId: home.id, access: 'read' }),
    ]);
    const renamed = await browser.request(`${base}/rename`, {
      form: { csrf: csrf!, label: 'Home mail', back: 'https://evil.example/' },
    });
    expect(renamed.headers.get('location')).toBe('/app/services');

    // The activity log filters by account, by service and by errors, and keeps the filter when paging.
    const log = async (query: string) => (await browser.request(`/app/activity${query}`)).text();
    const all = await log('');
    expect(all).toContain('title="demo_echo">Эхо<');
    expect(all).toContain('title="demo_account_info">Об аккаунте<');
    const ofHome = await log(`?account=${home.id}`);
    expect(ofHome).toContain('title="demo_fail"');
    expect(ofHome).not.toContain('title="demo_account_info"');
    const errors = await log('?status=error');
    expect(errors).toContain('title="demo_fail"');
    expect(errors).not.toContain('title="demo_echo"');
    // An unknown account is ignored instead of showing an empty log.
    expect(await log('?account=nope')).toContain('title="demo_account_info"');
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

  it('creates, changes and deletes an access profile in the dashboard', async () => {
    const foreign = (await hub.services.db.query.accounts.findFirst())!;
    const browser = new TestBrowser(hub.baseUrl);
    await oidc.signIn(browser, { sub: 'g-pr', email: 'profiles@example.com' });
    const ws = await workspaceOf((await userByEmail('profiles@example.com')).id);
    const create = (name: string, label: string) =>
      hub.services.accounts.create(ws.id, { connectorId: 'demo', name, label, credentials: { secret: 's' } });
    const work = await create('work', 'Work');
    const home = await create('home', 'Home');

    const list = await (await browser.request('/app/profiles')).text();
    expect(list).toContain(`name="account.${work.id}"`);
    expect(list).not.toContain(foreign.id);
    const { csrf } = TestBrowser.hiddenInputs(list);

    // Without an account the form comes back as filled in.
    const empty = await browser.request('/app/profiles', {
      form: { csrf: csrf!, name: 'Работа', maxAccess: 'read' },
    });
    expect(empty.status).toBe(400);
    const again = await empty.text();
    expect(again).toContain('class="notice bad"');
    expect(again).toContain('value="Работа"');

    // Another workspace's account is ignored; the address comes from the name.
    const created = await browser.request('/app/profiles', {
      form: {
        csrf: csrf!,
        name: 'Работа',
        maxAccess: 'read',
        [`account.${work.id}`]: 'on',
        [`account.${foreign.id}`]: 'on',
      },
    });
    expect(created.status).toBe(303);
    const persona = (await hub.services.personas.bySlug(ws.id, 'rabota'))!;
    expect(persona).toMatchObject({ name: 'Работа', accountIds: [work.id], maxAccess: 'read' });
    const path = `/app/profiles/${persona.id}`;
    expect(created.headers.get('location')).toBe(`${path}?created=1`);
    const page = await (await browser.request(`${path}?created=1`)).text();
    expect(page).toContain(`${hub.baseUrl}/mcp/rabota`);
    // Its own server name in the clients' configs, so it never replaces the main connection.
    expect(page).toContain('manyplug-rabota');
    expect(page).toContain('class="notice ok"');

    const taken = await browser.request('/app/profiles', {
      form: { csrf: csrf!, name: 'Other', slug: 'rabota', [`account.${home.id}`]: 'on' },
    });
    expect(taken.status).toBe(400);
    expect((await hub.services.personas.list(ws.id)).length).toBe(1);

    const saved = await browser.request(path, {
      form: {
        csrf: csrf!,
        name: 'Work AI',
        note: 'office',
        maxAccess: 'full',
        [`account.${work.id}`]: 'on',
        [`account.${home.id}`]: 'on',
      },
    });
    expect(saved.headers.get('location')).toBe(path);
    expect(await hub.services.personas.get(ws.id, persona.id)).toMatchObject({
      name: 'Work AI',
      description: 'office',
      accountIds: [work.id, home.id],
      maxAccess: 'full',
    });

    // A token for the profile is listed on its page, and revoking it comes back there.
    await browser.request('/app/tokens', {
      form: { csrf: csrf!, name: 'office script', days: '30', profile: persona.id },
    });
    const [token] = await hub.services.apiTokens.list(ws.id);
    expect(token).toMatchObject({ name: 'office script', personaId: persona.id });
    expect(await (await browser.request('/app/apps')).text()).toContain('/mcp/rabota');
    expect(await (await browser.request(path)).text()).toContain('office script');
    const revoked = await browser.request(`/app/tokens/${token!.id}/revoke`, {
      form: { csrf: csrf!, back: path },
    });
    expect(revoked.headers.get('location')).toBe(path);

    const deleted = await browser.request(`${path}/delete`, { form: { csrf: csrf! } });
    expect(deleted.headers.get('location')).toBe('/app/profiles');
    expect(await hub.services.personas.list(ws.id)).toEqual([]);
    expect((await browser.request(path)).headers.get('location')).toBe('/app/profiles');
  });

  it("shows an AI app's own page: its tokens, rule and actions; renames, disconnects and removes it", async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await oidc.signIn(browser, { sub: 'g-app', email: 'aiapp@example.com' });
    const ws = await workspaceOf((await userByEmail('aiapp@example.com')).id);
    const { csrf } = TestBrowser.hiddenInputs(await (await browser.request('/app/apps')).text());
    await browser.request('/app/tokens', { form: { csrf: csrf!, name: 'Cursor', days: '0' } });
    const [token] = await hub.services.apiTokens.list(ws.id);
    const appId = token!.aiClientId!;
    const base = `/app/apps/${appId}`;
    // One call with this app's token, one with another credential.
    await hub.services.database.pool.query(
      `INSERT INTO tool_calls (workspace_id, connector_id, action, tool_name, principal_type, principal_id, status, duration_ms, created_at)
       VALUES ($1, 'demo', 'echo', 'demo_echo', 'api_token', $2, 'ok', 5, now() - interval '2 minutes'),
              ($1, 'demo', 'fail', 'demo_fail', 'api_token', 'tok_other', 'error', 5, now() - interval '1 minute')`,
      [ws.id, token!.id],
    );

    expect(await (await browser.request('/app/apps')).text()).toContain(`href="${base}"`);
    const page = await (await browser.request(base)).text();
    expect(page).toContain('<h1>Cursor</h1>');
    expect(page).toContain(`action="/app/tokens/${token!.id}/revoke"`);
    expect(page).toContain('title="demo_echo"');
    expect(page).not.toContain('title="demo_fail"');

    // Its rule is set from its page and comes back there; the rules page links to it.
    const rule = await browser.request('/app/rules/scoped', {
      form: { csrf: csrf!, kind: 'app', id: appId, access: 'read', confirm: '', back: base },
    });
    expect(rule.headers.get('location')).toBe(base);
    expect(await hub.services.policies.listRules(ws.id)).toContainEqual(
      expect.objectContaining({ aiClientId: appId, access: 'read' }),
    );
    expect(await (await browser.request('/app/rules')).text()).toContain(`href="${base}"`);

    const renamed = await browser.request(`${base}/rename`, {
      form: { csrf: csrf!, name: 'Cursor at work' },
    });
    expect(renamed.headers.get('location')).toBe(base);
    expect((await hub.services.aiClients.get(ws.id, appId)).name).toBe('Cursor at work');
    // The token is listed under the app's new name.
    expect(await (await browser.request('/app/apps')).text()).toContain('Cursor at work');

    // Disconnecting ends the token and keeps the rule; then the app can be removed with it.
    const disconnected = await browser.request(`${base}/disconnect`, { form: { csrf: csrf! } });
    expect(disconnected.headers.get('location')).toBe(base);
    expect(await hub.services.apiTokens.list(ws.id)).toEqual([]);
    const after = await (await browser.request(base)).text();
    expect(after).toContain(`action="${base}/forget"`);
    expect(await hub.services.policies.listRules(ws.id)).toHaveLength(1);
    const removed = await browser.request(`${base}/forget`, { form: { csrf: csrf! } });
    expect(removed.headers.get('location')).toBe('/app/apps');
    expect(await hub.services.policies.listRules(ws.id)).toEqual([]);
    expect((await browser.request(base)).headers.get('location')).toBe('/app/apps');
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
    for (const path of [
      '/',
      '/pricing',
      '/services',
      '/services/github',
      '/docs',
      '/privacy',
      '/terms',
      '/refunds',
    ]) {
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

  it('says how each service connects on this server and lists the rest as coming next', async () => {
    const page = async (path: string) => (await fetch(`${hub.baseUrl}${path}`)).text();
    // No Todoist app on this hub: the personal token is the way in, and its page says so.
    const todoist = await page('/services/todoist');
    expect(todoist).toContain('API key or app password');
    expect(todoist).not.toContain('Sign in with Todoist');
    // Token-only services carry their own step-by-step guide.
    const jira = await page('/services/jira');
    expect(jira).toContain('Create API token');
    expect(jira).toContain('https://id.atlassian.com/manage-profile/security/api-tokens');
    // The docs name what connects through the form here, not a fixed list.
    expect(await page('/docs')).toMatch(/<li>[^<]*Todoist[^<]*: paste an app password or API key/);
    // The grid holds what connects today; planned services wait in one row, and any MCP server has a card.
    const services = await page('/services');
    expect(services).toMatch(/<li data-search="Discord"><span class="road">/);
    expect(services).toContain('href="/docs#custom"');
    expect(services).not.toContain('svc soon');
  });

  it('speaks English by default, whatever the browser language, until Russian is picked', async () => {
    const russianBrowser = { 'accept-language': 'ru-RU,ru;q=0.9' };
    const first = await fetch(`${hub.baseUrl}/`, { headers: russianBrowser });
    const html = await first.text();
    expect(html).toContain('<html lang="en"');
    // No Russian text on the English page (search keywords in attributes stay bilingual).
    expect(html.replace(/<[^>]*>/g, ' ')).not.toMatch(/[А-Яа-яЁё]{3}/);

    const picked = await fetch(`${hub.baseUrl}/prefs/lang?to=ru&next=%2F`, {
      headers: russianBrowser,
      redirect: 'manual',
    });
    const cookie = picked.headers.getSetCookie()[0]!.split(';')[0]!;
    const russian = await fetch(`${hub.baseUrl}/`, { headers: { ...russianBrowser, cookie } });
    expect(await russian.text()).toContain('<html lang="ru"');
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
