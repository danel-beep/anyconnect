import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import demo from '../src/connectors/builtin/demo.js';
import gmail from '../src/connectors/builtin/gmail.js';
import http from '../src/connectors/builtin/http.js';
import imap from '../src/connectors/builtin/imap/index.js';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { defineConnector } from '../src/connectors/sdk.js';
import { connectFormFields, readConnectForm } from '../src/core/connect-form.js';
import type { Principal } from '../src/core/principal.js';
import { resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

/** A service that takes a personal token when the hub has no OAuth app for it. */
const tokenOrOAuth = defineConnector({
  id: 'tracker',
  name: 'Tracker',
  description: 'Issue tracker',
  version: '1.0.0',
  oauth: { provider: 'github', scopes: [], optional: true },
  config: z.object({
    region: z.enum(['eu', 'us']).default('eu').describe('Data region'),
    retries: z.number().int().min(0).max(5).default(1),
  }),
  credentials: z.object({ token: z.string().min(1).optional().describe('Personal token') }),
  actions: () => [],
});

/** A service that accepts only one key: its check fails for anything else ("down": server away). */
const picky = defineConnector({
  id: 'picky',
  name: 'Picky',
  description: 'Accepts one key only',
  version: '1.0.0',
  config: z.object({}),
  credentials: z.object({ key: z.string().min(1).describe('API key') }),
  async test(ctx) {
    if (ctx.credentials.key === 'down') return { ok: false, message: 'getaddrinfo ENOTFOUND api.picky.test' };
    return ctx.credentials.key === 'right' ? { ok: true } : { ok: false, message: 'Key not valid' };
  },
  actions: () => [],
});

describe('connect form for services without OAuth', () => {
  let hub: TestHub;
  let browser: TestBrowser;
  let workspaceId: string;

  const openForm = async (path: string) => {
    const page = await browser.request(path);
    expect(page.status).toBe(200);
    const html = await page.text();
    return { html, hidden: TestBrowser.hiddenInputs(html) };
  };

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({
      connectors: new ConnectorRegistry()
        .register(demo)
        .register(tokenOrOAuth)
        .register(imap)
        .register(gmail)
        .register(picky),
      seed: false,
    });
    workspaceId = (await hub.services.db.query.workspaces.findFirst())!.id;
    browser = new TestBrowser(hub.baseUrl);
    expect((await browser.login()).status).toBe(303);
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('builds fields from the connector schemas', () => {
    const fields = connectFormFields(tokenOrOAuth);
    expect(fields.map((f) => [f.name, f.kind, f.required, f.advanced])).toEqual([
      ['config.region', 'select', false, false],
      ['config.retries', 'number', false, false],
      ['credentials.token', 'secret', false, false],
    ]);
    expect(readConnectForm(fields, { 'config.retries': 'x', 'credentials.token': ' t ' })).toEqual({
      config: {},
      credentials: { token: ' t ' },
      problems: { 'config.retries': 'not a number' },
    });
  });

  it('shows sign-in names as typed and completes bare addresses', () => {
    const fields = connectFormFields(http);
    const kinds = Object.fromEntries(fields.map((f) => [f.name, f.kind]));
    expect(kinds).toMatchObject({
      'credentials.username': 'text',
      'credentials.password': 'secret',
      'credentials.token': 'secret',
    });
    // A setting with a default has no blank choice.
    expect(fields.find((f) => f.name === 'config.auth')?.defaultValue).toBe('bearer');
    expect(readConnectForm(fields, { 'config.baseUrl': 'api.example.com/v1' }).config).toMatchObject({
      baseUrl: 'https://api.example.com/v1',
    });
    expect(readConnectForm(fields, { 'config.baseUrl': 'http://localhost:8080' }).config).toMatchObject({
      baseUrl: 'http://localhost:8080',
    });
  });

  it('needs a signed-in user', async () => {
    const res = await new TestBrowser(hub.baseUrl).request('/connect/demo?label=Work');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/login?next=');
  });

  it('connects an account from the link the AI gives out', async () => {
    const principal: Principal = {
      kind: 'session',
      userId: (await hub.services.db.query.users.findFirst())!.id,
      workspaceId,
      scopes: ['mcp'],
    };
    const catalog = await hub.services.hub.getCatalog(principal);
    const link = await hub.services.hub.callTool(principal, catalog, 'manyplug_connect_account', {
      service: 'demo',
      label: 'Work',
      name: 'work',
    });
    const { url } = link.structuredContent as { url: string };
    const { html, hidden } = await openForm(url);
    expect(html).toContain('name="credentials.secret"');
    expect(html).toContain('type="password"');
    expect(hidden.name).toBe('work');

    // A missing secret comes back with the error and without the secret.
    const invalid = await browser.request('/connect/demo', {
      form: { ...hidden, label: 'Work', 'config.greeting': 'Hi', 'credentials.secret': '' },
    });
    expect(invalid.status).toBe(400);
    const retry = await invalid.text();
    expect(retry).toContain('value="Hi"');
    expect(await hub.services.accounts.findByName(workspaceId, 'demo', 'work')).toBeUndefined();

    const done = await browser.request('/connect/demo', {
      form: {
        ...TestBrowser.hiddenInputs(retry),
        label: 'Work',
        'config.greeting': 'Hi',
        'credentials.secret': 'secret-s3-value',
      },
    });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('demo:work');
    const account = (await hub.services.accounts.findByName(workspaceId, 'demo', 'work'))!;
    expect(account).toMatchObject({ label: 'Work', config: { greeting: 'Hi' }, status: 'active' });
  });

  it('does not keep a new account whose check fails, and says why in plain words', async () => {
    const { hidden } = await openForm('/connect/picky');
    const send = (key: string, extra: Record<string, string> = {}) =>
      browser.request('/connect/picky', {
        form: { ...hidden, label: 'Main', 'credentials.key': key, ...extra },
      });

    const rejected = await send('wrong');
    expect(rejected.status).toBe(400);
    const html = await rejected.text();
    expect(html).toContain('Picky не принял эти данные (Key not valid).');
    expect(html).toContain('Ничего не сохранено.');
    // Wrong details are fixed in the form, not kept as a broken account.
    expect(html).not.toContain('name="keep" value="1"');
    expect(html).toContain('aria-invalid="true"');
    // The key is never sent back, and nothing is saved.
    expect(html).not.toContain('wrong');
    expect((await hub.services.accounts.list(workspaceId)).filter((a) => a.connectorId === 'picky')).toEqual(
      [],
    );

    // A server that cannot be reached is named without the system code, and the key is not blamed.
    const away = await (await send('down')).text();
    expect(away).toContain('Не удалось связаться с api.picky.test');
    expect(away).not.toContain('ENOTFOUND');
    expect(away).not.toContain('aria-invalid="true"');
    expect(away).toContain('name="keep" value="1"');

    // Kept on purpose: saved, marked as failing.
    const kept = await send('down', { keep: '1' });
    expect(kept.status).toBe(200);
    expect(await kept.text()).toContain('Подключено, но проверка не прошла');
    const [account] = (await hub.services.accounts.list(workspaceId)).filter(
      (a) => a.connectorId === 'picky',
    );
    expect(account).toMatchObject({ label: 'Main', status: 'error' });

    // The right key on a fresh form connects without any warning.
    const { hidden: again } = await openForm('/connect/picky');
    const ok = await browser.request('/connect/picky', {
      form: { ...again, label: 'Second', 'credentials.key': 'right' },
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).not.toContain('проверка не прошла');
  });

  it('reconnects an account and keeps a secret left empty', async () => {
    const account = (await hub.services.accounts.findByName(workspaceId, 'demo', 'work'))!;
    const { html, hidden } = await openForm(`/connect/demo?account=${account.id}`);
    expect(html).toContain('value="Hi"');
    expect(html).not.toContain('secret-s3-value');
    const saved = await browser.request('/connect/demo', {
      form: { ...hidden, 'config.greeting': 'Hello again', 'credentials.secret': '' },
    });
    expect(saved.status).toBe(200);
    const updated = await hub.services.accounts.get(workspaceId, account.id);
    expect(updated.config).toEqual({ greeting: 'Hello again' });
    const ctx = await hub.services.accounts.buildContext(demo, updated, {
      signal: AbortSignal.timeout(5000),
      logger: hub.services.logger,
    });
    expect(ctx.credentials).toEqual({ secret: 'secret-s3-value' });
  });

  it('offers the form for optional OAuth when the hub has no app', async () => {
    const { html, hidden } = await openForm('/connect/tracker?label=Team');
    expect(html).toContain('name="config.region"');
    // Without `ui` the form is built from the schemas alone: all fields up front, values as is.
    expect(html).toContain('Data region');
    expect(html).toContain('<option value="eu" selected="">eu</option>');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('Войти через сервис');
    const done = await browser.request('/connect/tracker', {
      form: { ...hidden, label: 'Team', 'config.region': 'us', 'credentials.token': 'tok' },
    });
    expect(done.status).toBe(200);
    const [row] = (await hub.services.accounts.list(workspaceId)).filter((a) => a.connectorId === 'tracker');
    expect(row).toMatchObject({ label: 'Team', config: { region: 'us', retries: 1 } });
  });

  it('shows the mailbox form in Russian with server settings under "Advanced"', async () => {
    const { html } = await openForm('/connect/imap?label=Почта');
    expect(html).toContain('Подключение: Почта (IMAP/SMTP)');
    expect(html).toContain('>Адрес почты<span class="req" aria-hidden="true"> *</span></label>');
    expect(html).toContain('>Пароль приложения<span class="req" aria-hidden="true"> *</span></label>');
    expect(html).toContain('<option value="">Определить по адресу</option>');
    expect(html).toContain('<option value="yandex">Яндекс Почта</option>');
    expect(html).not.toContain('Imap Host');
    const [up, advanced = ''] = html.split('<details class="connect-advanced"');
    expect(up).toContain('name="config.email"');
    expect(up).toContain('name="config.provider"');
    expect(up).toContain('name="credentials.password"');
    expect(advanced).toMatch(/^>\s*<summary>Дополнительные настройки<\/summary>/);
    // An optional yes/no without a default is a three-way choice, so the provider preset can decide.
    expect(advanced).toContain('<option value="">Автоматически</option><option value="true">Да</option>');
    for (const name of [
      'config.imapHost',
      'config.smtpPort',
      'config.fromName',
      'credentials.smtpPassword',
    ]) {
      expect(up).not.toContain(`name="${name}"`);
      expect(advanced).toContain(`name="${name}"`);
    }
    expect(advanced).toContain('<option value="starttls">STARTTLS</option>');

    const english = new TestBrowser(hub.baseUrl);
    await english.login();
    await english.request('/prefs/lang?to=en&next=%2F');
    const en = await (await english.request('/connect/imap')).text();
    expect(en).toContain('>App password<span class="req" aria-hidden="true"> *</span></label>');
    expect(en).toContain('<summary>Advanced settings</summary>');
  });

  it('shows the setup guide next to the form: time, needs, where each value goes, fixes', async () => {
    const { html } = await openForm('/connect/imap');
    const guide = imap.ui!.locales!.ru!.setup!.form!;
    expect(html).toContain(`<b class="guide-minutes">Около ${guide.minutes} мин</b>`);
    expect(html).toContain('<p class="guide-label">Понадобится</p>');
    // A step that yields a form value names the field by its label in the page language.
    expect(html).toMatch(/<span class="guide-fills">Вставьте в поле:\s*<b>Адрес почты<\/b>/);
    expect(html).toContain('<summary>Если что-то не получилось</summary>');
    expect(html).toContain(`<dt>${guide.problems[0]!.problem.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</dt>`);
  });

  it('names the field at fault by its label and opens "Advanced" for it', async () => {
    const { hidden } = await openForm('/connect/imap');
    const res = await browser.request('/connect/imap', {
      form: {
        ...hidden,
        label: 'Своя почта',
        'config.email': 'me@example.org',
        'config.provider': 'custom',
        'config.smtpHost': 'smtp.example.org',
        'credentials.password': 'pw',
      },
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Проверьте поля: Адрес сервера IMAP:');
    expect(html).toContain('<details class="connect-advanced" open="">');
    expect(html).toMatch(/name="config.imapHost"[^>]*aria-invalid="true"/);
    expect(html).toContain('value="smtp.example.org"');
  });

  it('describes actions on the service page in the page language', async () => {
    const ru = await (await browser.request('/services/gmail')).text();
    expect(ru).toContain('Поиск писем');
    expect(ru).toContain('Переносит письма в корзину.');
    expect(ru).not.toContain('Finds messages, newest first');
    expect(ru).toContain('<code class="tool-id">gmail_search</code>');

    const english = new TestBrowser(hub.baseUrl);
    await english.request('/prefs/lang?to=en&next=%2F');
    const en = await (await english.request('/services/gmail')).text();
    expect(en).toContain('Labels, archive and marks');
  });

  it('refuses a post without the form token', async () => {
    const res = await browser.request('/connect/demo', {
      form: { label: 'X', 'credentials.secret': 'x' },
    });
    expect(res.status).toBe(403);
  });
});
