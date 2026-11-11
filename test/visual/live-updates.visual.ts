/**
 * Live updates in a real browser (`data-poll` in site.js): a request the AI makes while the
 * Confirmations or Activity page is open shows up without a reload, and copy buttons in a refreshed
 * block still work. Runs with `npm run test:visual` (needs Postgres and Chromium).
 */
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import demo from '../../src/connectors/builtin/demo.js';
import { ConnectorRegistry } from '../../src/connectors/registry.js';
import { defineConnector } from '../../src/connectors/sdk.js';
import type { Principal } from '../../src/core/principal.js';
import { resetDatabase, startTestHub, TestBrowser, type TestHub } from '../helpers.js';

const inbox = defineConnector({
  id: 'inbox',
  name: 'Inbox',
  description: 'A test mailbox',
  version: '1.0.0',
  actions: (action) => [
    action({
      name: 'send',
      description: 'Sends an email',
      input: z.object({ to: z.string(), text: z.string() }),
      risk: 'dangerous',
      run: ({ to }) => ({ to }),
    }),
  ],
});

let hub: TestHub;
let browser: Browser;
let principal: Principal;
let cookies: [string, string][];

const call = async (tool: string, args: Record<string, unknown>) => {
  const caller = { ...principal };
  return hub.services.hub.callTool(caller, await hub.services.hub.getCatalog(caller), tool, args);
};

async function openPage(path: string) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const url = new URL(hub.baseUrl);
  await context.addCookies(
    cookies.map(([name, value]) => ({ name, value, domain: url.hostname, path: '/' })),
  );
  const page = await context.newPage();
  await page.goto(hub.baseUrl + path);
  return { page, context };
}

describe('live updates', () => {
  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({
      connectors: new ConnectorRegistry().register(demo).register(inbox),
      env: { CONFIRMATION_WAIT_SECONDS: '0' },
    });
    const owner = new TestBrowser(hub.baseUrl);
    await owner.login();
    cookies = owner.cookieEntries();
    const s = hub.services;
    const workspaceId = (await s.db.query.workspaces.findFirst())!.id;
    const userId = (await s.db.query.users.findFirst())!.id;
    await s.accounts.create(workspaceId, { connectorId: 'inbox', name: 'work', label: 'Work' });
    const aiClientId = (await s.aiClients.createUnique(workspaceId, 'Claude', 'oauth')).id;
    principal = {
      kind: 'oauth',
      userId,
      workspaceId,
      scopes: ['mcp'],
      clientId: 'client_test',
      credentialId: 'grant_test',
      aiClientId,
    };
    browser = await chromium.launch(
      process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
    );
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await hub?.close();
  });

  it('shows a new confirmation request on the open page without a reload', async () => {
    const { page, context } = await openPage('/confirm');
    await page.locator('#pending-live .empty-state').waitFor();
    await call('inbox_send', { account: 'work', to: 'anna@example.com', text: 'Q3 numbers' });
    await page.locator('#pending-live .pending-call').waitFor({ timeout: 15_000 });
    await expect(page.locator('#pending-live').textContent()).resolves.toContain('anna@example.com');
    await context.close();
  }, 30_000);

  it('turns the first-run card into the log once the AI acts, and copy buttons keep working', async () => {
    await hub.services.database.pool.query('delete from pending_calls');
    await hub.services.database.pool.query('delete from tool_calls');
    const { page, context } = await openPage('/app/activity');
    await page.locator('#activity-try-0').waitFor();
    await page.locator('[data-copy="#activity-try-0"]').click();
    await expect(
      page.evaluate(() => (globalThis as any).navigator.clipboard.readText() as Promise<string>),
    ).resolves.toContain('Manyplug');
    // The empty card asks the user to try a request: the new action appears in the same card.
    await call('demo_echo', { account: 'main', message: 'hi' });
    await page.locator('#activity-live table.calls').waitFor({ timeout: 15_000 });
    await context.close();
  }, 30_000);
});
