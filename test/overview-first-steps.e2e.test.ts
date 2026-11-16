import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import demo from '../src/connectors/builtin/demo.js';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

/**
 * The Overview as a new user lives it: setting the hub up from the chat ("what can you connect?",
 * "connect my email") is free and does not tick "Ask the AI something"; a call to a service does.
 * The steps, numbers and lists are live blocks, so the page follows the AI app without a reload.
 */
describe('overview: first steps', () => {
  let hub: TestHub;
  let browser: TestBrowser;
  let ai: Client;
  let workspaceId: string;

  const overview = async () => (await browser.request('/app')).text();
  const progress = (html: string) => /class="onboard-count">\D*(\d)/.exec(html)?.[1];
  const charged = async () =>
    (
      await hub.services.database.pool.query<{ n: string }>(
        'SELECT coalesce(sum(calls), 0) AS n FROM usage_counters WHERE workspace_id = $1',
        [workspaceId],
      )
    ).rows[0]!.n;

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ connectors: new ConnectorRegistry().register(demo) });
    browser = new TestBrowser(hub.baseUrl);
    expect((await browser.login()).status).toBe(303);
    const user = (await hub.services.db.query.users.findFirst())!;
    workspaceId = (await hub.services.db.query.workspaces.findFirst())!.id;
    const { token } = await hub.services.apiTokens.create({ workspaceId, userId: user.id, name: 'Agent' });
    ai = new Client({ name: 'agent', version: '1.0.0' });
    await ai.connect(
      new StreamableHTTPClientTransport(new URL(hub.mcpUrl), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
  });

  afterAll(async () => {
    await ai?.close();
    await hub?.close();
  });

  it('keeps the steps, numbers and lists in live blocks, and the AI card out of them', async () => {
    const html = await overview();
    for (const id of ['overview-status', 'overview-usage', 'overview-lists'])
      expect(html).toMatch(new RegExp(`id="${id}" data-poll="\\d+"`));
    // The AI card keeps the app the user picked: it sits between live blocks, not in one.
    const at = (marker: string) => html.indexOf(marker);
    expect(at('id="connect-ai"')).toBeGreaterThan(at('id="overview-usage"'));
    expect(at('id="connect-ai"')).toBeLessThan(at('id="overview-lists"'));
    expect(html.slice(at('id="overview-usage"'), at('id="connect-ai"'))).toContain('class="stats"');
  });

  it('does not charge or tick "ask the AI" for setting the hub up from the chat', async () => {
    const before = progress(await overview());
    expect(before).toBe('2');
    for (const name of ['manyplug_services', 'manyplug_list_accounts']) {
      const result = await ai.callTool({ name, arguments: {} });
      expect(result.isError, name).toBeFalsy();
    }
    expect(await charged()).toBe('0');
    expect(progress(await overview())).toBe(before);
  });

  it('ticks it and counts an action once the AI uses a service', async () => {
    // AI app (a token) and a service (the demo accounts) are there: only the last step is left.
    expect(progress(await overview())).toBe('2');
    const result = await ai.callTool({ name: 'demo_echo', arguments: { account: 'main', message: 'hi' } });
    expect(result.isError).toBeFalsy();
    expect(await charged()).toBe('1');
    // All three done: the steps make way for the usual overview.
    const after = await overview();
    expect(progress(after)).toBeUndefined();
    expect(after).not.toContain('onboard-title');
  });
});
