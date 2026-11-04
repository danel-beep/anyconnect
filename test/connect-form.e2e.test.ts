import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import demo from '../src/connectors/builtin/demo.js';
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
      connectors: new ConnectorRegistry().register(demo).register(tokenOrOAuth),
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
    expect(fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ['config.region', 'select', false],
      ['config.retries', 'number', false],
      ['credentials.token', 'secret', false],
    ]);
    expect(readConnectForm(fields, { 'config.retries': 'x', 'credentials.token': ' t ' })).toEqual({
      config: {},
      credentials: { token: ' t ' },
      problems: { 'config.retries': 'not a number' },
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
    const link = await hub.services.hub.callTool(principal, catalog, 'anyconnect_connect_account', {
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
        'credentials.secret': 's3',
      },
    });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('demo:work');
    const account = (await hub.services.accounts.findByName(workspaceId, 'demo', 'work'))!;
    expect(account).toMatchObject({ label: 'Work', config: { greeting: 'Hi' }, status: 'active' });
  });

  it('reconnects an account and keeps a secret left empty', async () => {
    const account = (await hub.services.accounts.findByName(workspaceId, 'demo', 'work'))!;
    const { html, hidden } = await openForm(`/connect/demo?account=${account.id}`);
    expect(html).toContain('value="Hi"');
    expect(html).not.toContain('s3');
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
    expect(ctx.credentials).toEqual({ secret: 's3' });
  });

  it('offers the form for optional OAuth when the hub has no app', async () => {
    const { html, hidden } = await openForm('/connect/tracker?label=Team');
    expect(html).toContain('name="config.region"');
    expect(html).not.toContain('Войти через сервис');
    const done = await browser.request('/connect/tracker', {
      form: { ...hidden, label: 'Team', 'config.region': 'us', 'credentials.token': 'tok' },
    });
    expect(done.status).toBe(200);
    const [row] = (await hub.services.accounts.list(workspaceId)).filter((a) => a.connectorId === 'tracker');
    expect(row).toMatchObject({ label: 'Team', config: { region: 'us', retries: 1 } });
  });

  it('refuses a post without the form token', async () => {
    const res = await browser.request('/connect/demo', {
      form: { label: 'X', 'credentials.secret': 'x' },
    });
    expect(res.status).toBe(403);
  });
});
