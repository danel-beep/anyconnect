import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

describe('downloading your own data', () => {
  let hub: TestHub;

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub();
  });

  afterAll(async () => {
    await hub?.close();
  });

  const download = async (browser: TestBrowser) => {
    const page = await browser.request('/app/settings');
    const html = await page.text();
    expect(html).toContain('action="/app/settings/export"');
    return browser.request('/app/settings/export', { form: { csrf: TestBrowser.hiddenInputs(html).csrf! } });
  };

  it('gives the signed-in person one file with their data and no secrets', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await browser.login();
    const workspace = (await hub.services.db.query.workspaces.findFirst())!;
    const secret = '123456:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs';
    await hub.services.accounts.create(workspace.id, {
      connectorId: 'telegram_bot',
      name: 'shop',
      label: 'Shop bot',
      credentials: { botToken: secret },
    });
    const user = (await hub.services.db.query.users.findFirst())!;
    const token = await hub.services.apiTokens.create({
      workspaceId: workspace.id,
      userId: user.id,
      name: 'laptop',
    });

    const response = await download(browser);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="manyplug-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    const data = JSON.parse(text);

    expect(data.profile).toMatchObject({ email: ADMIN.email, hasPassword: true });
    expect(data.signIn.sessions.length).toBeGreaterThan(0);
    expect(data.workspaces).toHaveLength(1);
    const [mine] = data.workspaces;
    expect(mine.accounts.map((a: { service: string }) => a.service).sort()).toEqual([
      'demo',
      'demo',
      'telegram_bot',
    ]);
    expect(mine.accounts.find((a: { name: string }) => a.name === 'shop')).toMatchObject({
      label: 'Shop bot',
      settings: { keepMessagesDays: 90 },
    });
    expect(mine.personalTokens).toEqual([expect.objectContaining({ name: 'laptop' })]);

    // Nothing that signs in or decrypts: no credentials, hashes, keys or the token itself.
    expect(text).not.toContain(secret);
    expect(text).not.toContain(token.token);
    expect(text).not.toMatch(/passwordHash|tokenHash|Encrypted|"credentials"|secret/i);
  });

  it('needs a session and a valid form, and is limited per person', async () => {
    const visitor = new TestBrowser(hub.baseUrl);
    await visitor.request('/login');
    const anonymous = await visitor.request('/app/settings/export', { form: { csrf: 'x'.repeat(32) } });
    expect(anonymous.status).not.toBe(200);

    const browser = new TestBrowser(hub.baseUrl);
    await browser.login();
    const forged = await browser.request('/app/settings/export', {
      form: { csrf: 'forged-token-forged-token' },
    });
    expect(forged.status).toBe(403);

    let last = 200;
    for (let i = 0; i < 7 && last === 200; i++) last = (await download(browser)).status;
    expect(last).toBe(303);
  });
});
