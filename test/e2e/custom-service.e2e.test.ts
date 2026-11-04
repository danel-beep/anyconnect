import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, startTestHub, TestBrowser, type TestHub } from '../helpers.js';
import { AI_CLIENTS, SimulatedAiClient, serveClientDocuments } from './ai-clients.js';
import { FakeInternet } from './fake-internet.js';
import { FakeCrm } from './fakes/crm.js';
import { allow, approveOnWeb, textOf } from './journey.js';

/**
 * The hub's reason to exist, end to end: a service that has no MCP server of its own ("Acme CRM",
 * a plain REST API) is added from the chat with an HTTP manifest, the user confirms it and enters
 * the API key on the hub's page (never in the chat), and Claude then works with it like with any
 * built-in service, under the same confirmation rules.
 */
describe('a service without MCP, added from the chat', () => {
  let hub: TestHub;
  let internet: FakeInternet;
  let crm: FakeCrm;
  let browser: TestBrowser;
  let claude: SimulatedAiClient;
  let service: string;
  const profile = AI_CLIENTS.find((c) => c.id === 'claude')!;

  beforeAll(async () => {
    await resetDatabase();
    internet = new FakeInternet();
    serveClientDocuments(internet);
    crm = new FakeCrm().install(internet);
    hub = await startTestHub({ internet, seed: false, env: { CONFIRMATION_WAIT_SECONDS: '0' } });
    browser = new TestBrowser(hub.baseUrl, internet.fetch);
    expect((await browser.login()).status).toBe(303);
    claude = await new SimulatedAiClient(profile, hub.mcpUrl).connect(async (url) => {
      const { response } = await browser.walk(url);
      return allow(browser, response, profile);
    });
  });

  afterAll(async () => {
    await claude?.close();
    await hub?.close();
  });

  it('adds the service only after the user confirms it', async () => {
    const manifest = crm.manifest();
    const held = await claude.call('manyplug_add_service', { manifest });
    expect(textOf(held)).toContain('/confirm/pcl_');
    expect(await hub.services.db.query.customConnectors.findMany()).toEqual([]);

    await approveOnWeb(browser, textOf(held));
    await hub.services.pendingRunner.tick();
    const added = await claude.call('manyplug_add_service', { manifest });
    expect(added.isError, textOf(added)).toBeFalsy();
    const data = added.structuredContent as { added: { service: string; tools: number }; next: string };
    expect(data.added.tools).toBe(3);
    service = data.added.service;
    expect(data.next).toContain('manyplug_connect_account');
  });

  it('connects an account with the API key typed on the hub’s page, checking it first', async () => {
    const link = await claude.call('manyplug_connect_account', {
      service,
      label: 'Sales CRM',
      name: 'sales',
    });
    const { url, method } = link.structuredContent as { url: string; method: string };
    expect(method).toBe('form');

    const form = await browser.request(url);
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).toContain('name="credentials.apiKey"');
    const hidden = TestBrowser.hiddenInputs(html);
    const path = new URL(url).pathname;

    // A wrong key is refused by the service's own check and nothing is saved.
    const wrong = await browser.request(path, {
      form: { ...hidden, label: 'Sales CRM', 'credentials.apiKey': 'not-the-key' },
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('Invalid API key');
    expect(await hub.services.db.query.accounts.findMany()).toEqual([]);

    const right = await browser.request(path, {
      form: { ...hidden, label: 'Sales CRM', 'credentials.apiKey': crm.apiKey },
    });
    expect(right.status, await right.clone().text()).toBeLessThan(400);
    const [account] = await hub.services.db.query.accounts.findMany();
    expect(account).toMatchObject({ name: 'sales', label: 'Sales CRM', status: 'active' });
    expect(JSON.stringify(account)).not.toContain(crm.apiKey);
  });

  it('lets Claude search the service with the key, returning only the declared fields', async () => {
    const names = await claude.toolNames();
    expect(names).toEqual(
      expect.arrayContaining([
        `${service}_search_contacts`,
        `${service}_create_contact`,
        `${service}_delete_contact`,
      ]),
    );
    internet.clear();
    const found = await claude.call(`${service}_search_contacts`, { q: 'contoso' });
    expect(found.isError, textOf(found)).toBeFalsy();
    const text = textOf(found);
    expect(text).toContain('Dana Whitfield');
    expect(text).not.toContain('Lee Park');
    // Fields the manifest did not ask for never reach the model.
    expect(text).not.toContain('internal_notes');
    const [request] = internet.requestsTo(crm.host, '/v1/contacts');
    expect(request!.headers.get('x-api-key')).toBe(crm.apiKey);
    expect(request!.url.searchParams.get('q')).toBe('contoso');
  });

  it('applies the confirmation rules to it like to any service', async () => {
    const created = await claude.call(`${service}_create_contact`, {
      name: 'Sam Rivera',
      company: 'Tailspin',
    });
    expect(created.isError, textOf(created)).toBeFalsy();
    expect(crm.contacts.map((c) => c.name)).toContain('Sam Rivera');

    const id = crm.contacts.find((c) => c.name === 'Sam Rivera')!.id;
    const held = await claude.call(`${service}_delete_contact`, { id });
    expect(textOf(held)).toContain('/confirm/pcl_');
    expect(crm.contacts.some((c) => c.id === id)).toBe(true);
    await approveOnWeb(browser, textOf(held));
    await hub.services.pendingRunner.tick();
    expect(crm.contacts.some((c) => c.id === id)).toBe(false);
  });

  it('passes the service’s own error message back to Claude', async () => {
    const missing = await claude.call(`${service}_delete_contact`, { id: 'nope' });
    await approveOnWeb(browser, textOf(missing));
    await hub.services.pendingRunner.tick();
    const result = await claude.call(`${service}_delete_contact`, { id: 'nope' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No such contact');
  });
});
