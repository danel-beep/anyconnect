/**
 * Live updates in a real browser (`data-poll` in site.js): a request the AI makes while the
 * Confirmations, Activity, Overview or Services page is open shows up without a reload, copy buttons
 * and row menus in a refreshed block still work and what the user picked outside the live blocks stays.
 * For keyboard and screen-reader users: focus stays where it was and the news is read out.
 * Runs with `npm run test:visual` (needs Postgres and Chromium).
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
let workId: string;

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
    workId = (await s.accounts.create(workspaceId, { connectorId: 'inbox', name: 'work', label: 'Work' })).id;
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
    // A keyboard user is on the link in the empty card, which the new request replaces.
    await page.locator('#pending-live a[href="/app/rules"]').focus();
    await call('inbox_send', { account: 'work', to: 'anna@example.com', text: 'Q3 numbers' });
    await page.locator('#pending-live .pending-call').waitFor({ timeout: 15_000 });
    await expect(page.locator('#pending-live').textContent()).resolves.toContain('anna@example.com');
    // Screen readers hear about it, and focus stays in the block instead of falling to the page top.
    await expect.poll(() => page.locator('#live-news').textContent()).toMatch(/1/);
    await expect(page.evaluate(() => (globalThis as any).document.activeElement.id)).resolves.toBe(
      'pending-live',
    );
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

  it('ticks the first steps on the open overview and keeps the AI app the user picked', async () => {
    await hub.services.database.pool.query('delete from tool_calls');
    const { page, context } = await openPage('/app');
    const count = page.locator('#overview-status .onboard-count');
    // A service is there (the demo accounts); the AI app is not yet, so the full AI card shows.
    await expect(count.textContent()).resolves.toMatch(/\D1\D/);
    const chatgpt = page.locator('#connect-ai [role=tab]', { hasText: 'ChatGPT' });
    await chatgpt.click();
    // The user adds the app elsewhere (here: a token), then the AI uses a service.
    await hub.services.apiTokens.create({
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      name: 'Agent',
    });
    await expect.poll(() => count.textContent(), { timeout: 15_000 }).toMatch(/\D2\D/);
    // The AI card is not a live block: the app the user picked is still picked.
    await expect(chatgpt.getAttribute('aria-selected')).resolves.toBe('true');
    await call('demo_echo', { account: 'main', message: 'hi' });
    await page.locator('#overview-status .onboard').waitFor({ state: 'detached', timeout: 15_000 });
    await page.locator('#overview-lists table.calls').waitFor();
    await context.close();
  }, 45_000);

  it('shows an account connected elsewhere on the open Services page, and its menu works', async () => {
    const { page, context } = await openPage('/app/services');
    const rows = page.locator('#services-live .acc[id^="acc-"]');
    await expect(rows.count()).resolves.toBe(1);
    const menuOf = (id: string) => page.locator(`#acc-${id} details[data-menu]`);
    // A menu the user has open is not pulled away by a refresh: the block waits for it to close.
    await menuOf(workId).locator('summary').click();
    const home = await hub.services.accounts.create(principal.workspaceId, {
      connectorId: 'inbox',
      name: 'home',
      label: 'Home',
    });
    await page.waitForResponse((r) => r.request().headers()['x-live-update'] === '1', { timeout: 15_000 });
    await expect(rows.count()).resolves.toBe(1);
    await expect(menuOf(workId).getAttribute('open')).resolves.toBe('');
    await page.keyboard.press('Escape');
    await expect.poll(() => rows.count(), { timeout: 15_000 }).toBe(2);
    await expect(page.locator('#svc-n-inbox').textContent()).resolves.toMatch(/2/);
    // The rows the refresh brought in have working menus: one open at a time, outside click closes.
    await menuOf(home.id).locator('summary').click();
    // (toggle fires a moment after the click, hence the polls)
    await expect
      .poll(() => page.locator(`#acc-${home.id} .menu-pop`).getAttribute('class'))
      .toContain('floating');
    await menuOf(workId).locator('summary').click();
    await expect.poll(() => menuOf(home.id).getAttribute('open')).toBeNull();
    await page.locator('h1').click();
    await expect.poll(() => menuOf(workId).getAttribute('open')).toBeNull();
    // From the keyboard: Escape closes the menu and returns to its button, tabbing out closes it too.
    await menuOf(home.id).locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => menuOf(home.id).getAttribute('open')).toBe('');
    await page.keyboard.press('Escape');
    await expect.poll(() => menuOf(home.id).getAttribute('open')).toBeNull();
    await expect(
      menuOf(home.id)
        .locator('summary')
        .evaluate((s) => s === s.ownerDocument.activeElement),
    ).resolves.toBe(true);
    await page.keyboard.press('Enter');
    await expect.poll(() => menuOf(home.id).getAttribute('open')).toBe('');
    await page.locator(`#acc-${workId} .acc-link`).focus();
    await expect.poll(() => menuOf(home.id).getAttribute('open')).toBeNull();
    await context.close();
  }, 60_000);

  it('keeps keyboard focus on the same button when the Services list refreshes, and reads out the news', async () => {
    const { page, context } = await openPage('/app/services');
    const rows = page.locator('#services-live .acc[id^="acc-"]');
    const before = await rows.count();
    const test = page.locator(`#acc-${workId} form[action$="/test"] button`);
    await test.focus();
    await hub.services.accounts.create(principal.workspaceId, {
      connectorId: 'inbox',
      name: 'travel',
      label: 'Travel',
    });
    await expect.poll(() => rows.count(), { timeout: 15_000 }).toBe(before + 1);
    // The button is a new element after the refresh, but focus is on it, not on the page.
    await expect(test.evaluate((b) => b === b.ownerDocument.activeElement)).resolves.toBe(true);
    // The new count is read out: the list heading ("Connected 3"), as it reads now.
    const heading = (await page.locator('#services-live h2').textContent())!.replace(/\s+/g, ' ').trim();
    await expect.poll(() => page.locator('#live-news').textContent()).toBe(heading);
    await context.close();
  }, 30_000);
});
