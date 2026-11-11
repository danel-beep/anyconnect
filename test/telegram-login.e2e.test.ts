import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../src/core/principal.js';
import { gatewayApi } from '../src/gateway/api.js';
import { loadGatewayConfig } from '../src/gateway/config.js';
import { telegramUserDriver } from '../src/gateway/drivers/telegram/driver.js';
import { createGatewayRuntime } from '../src/gateway/runtime.js';
import { createLogger } from '../src/logger.js';
import { ANNA_ID, createFakeTelegram, type FakeTelegramState, fakeClientFactory } from './fake-telegram.js';
import {
  resetDatabase,
  startTestHub,
  TEST_DATABASE_URL,
  TEST_KEY,
  TestBrowser,
  type TestHub,
  unwrapUntrusted,
} from './helpers.js';

const TOKEN = 'gateway-test-token-0123456789abcdef';
const logger = createLogger({ level: 'silent' });

async function until<T>(
  probe: () => Promise<T> | T,
  what: string,
  timeoutMs = 8_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The gateway with the real Telegram driver on a fake Telegram (no network). */
async function startGateway(fake: FakeTelegramState) {
  let handler: ((req: Request) => Response | Promise<Response>) | undefined;
  const server = serve({
    fetch: (req) => (handler ? handler(req) : new Response('starting', { status: 503 })),
    hostname: '127.0.0.1',
    port: 0,
  });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const runtime = createGatewayRuntime(
    loadGatewayConfig({
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      DATABASE_POOL_MAX: '4',
      ENCRYPTION_KEY: TEST_KEY,
      GATEWAY_TOKEN: TOKEN,
      GATEWAY_ADVERTISE_URL: url,
      ALLOW_PRIVATE_NETWORK: 'true',
      LOG_LEVEL: 'silent',
    }),
    {
      logger,
      drivers: [
        telegramUserDriver({
          app: { apiId: 1, apiHash: '0123456789abcdef0123456789abcdef' },
          createClient: fakeClientFactory(fake),
          initialSync: { chats: 10, messagesPerChat: 5, gapMs: 0 },
        }),
      ],
      instanceId: 'gw-tg',
      leaseTtlMs: 3_000,
      dispatchIntervalMs: 100,
      host: { startJitterMs: 0, scanIntervalMs: 100 },
    },
  );
  await runtime.start();
  handler = gatewayApi({ host: runtime.host, token: TOKEN, logger, version: 'test' }).fetch;
  return {
    url,
    async close() {
      await runtime.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('Telegram personal account: connect on the website, log in, use from the AI', () => {
  let hub: TestHub;
  let gateway: Awaited<ReturnType<typeof startGateway>>;
  let browser: TestBrowser;
  let principal: Principal;
  const fake = createFakeTelegram();

  beforeAll(async () => {
    await resetDatabase();
    gateway = await startGateway(fake);
    hub = await startTestHub({ seed: false, env: { GATEWAY_URL: gateway.url, GATEWAY_TOKEN: TOKEN } });
    const workspace = (await hub.services.db.query.workspaces.findFirst())!;
    const user = (await hub.services.db.query.users.findFirst())!;
    principal = { kind: 'session', userId: user.id, workspaceId: workspace.id, scopes: ['mcp', 'api'] };
    await hub.services.policies.createRule(workspace.id, { connectorId: 'telegram', confirm: 'never' });
    browser = new TestBrowser(hub.baseUrl);
    expect((await browser.login()).status).toBe(303);
  });

  afterAll(async () => {
    await hub?.close();
    await gateway?.close();
  });

  const call = async (tool: string, args: Record<string, unknown>) => {
    const catalog = await hub.services.hub.getCatalog(principal);
    const result = await hub.services.hub.callTool(principal, catalog, tool, args);
    const text = (result.content[0] as { text?: string } | undefined)?.text ?? '';
    if (result.isError) throw new Error(text);
    return JSON.parse(unwrapUntrusted(text));
  };

  it('walks the whole flow: form, QR login with cloud password, chats, sending', async () => {
    fake.twoFactor = true;
    // The personal account is its own service and needs nothing typed in the form.
    const form = await browser.request('/connect/telegram');
    const formHtml = await form.text();
    expect(formHtml).not.toContain('credentials.botToken');
    const created = await browser.request('/connect/telegram', {
      form: { ...TestBrowser.hiddenInputs(formHtml), label: 'Мой Telegram' },
    });
    expect(created.status).toBe(303);
    const loginPath = created.headers.get('location')!;
    expect(loginPath).toMatch(/^\/connect\/messenger\/acc_/);
    const accountId = decodeURIComponent(loginPath.split('/')[3]!);

    // Until the login is done, the AI sees why the account does not work yet.
    const start = await browser.request(loginPath);
    const startHtml = await start.text();
    expect(startHtml).toContain('Войти по QR-коду');
    expect((await hub.services.accounts.get(principal.workspaceId, accountId)).status).toBe('needs_reauth');

    const csrf = TestBrowser.hiddenInputs(startHtml).csrf!;
    const started = await browser.request(loginPath, { form: { csrf, method: 'qr' } });
    expect(started.status).toBe(303);
    const stepPath = started.headers.get('location')!;
    const qrPage = await until(async () => {
      const html = await (await browser.request(stepPath)).text();
      return html.includes('<svg class="qr"') ? html : undefined;
    }, 'the QR code on the page');
    expect(qrPage).toContain('http-equiv="refresh"');
    expect(qrPage).toContain('Настройки → Устройства');

    fake.scan();
    const passwordPage = await until(async () => {
      const html = await (await browser.request(stepPath)).text();
      return html.includes('name="password"') ? html : undefined;
    }, 'the password step');
    expect(passwordPage).toContain('first pet');
    const submitted = await browser.request(stepPath, { form: { csrf, password: 'secret-pass' } });
    expect(submitted.status).toBe(303);
    const donePage = await until(async () => {
      const html = await (await browser.request(stepPath)).text();
      return html.includes('Вход выполнен') ? html : undefined;
    }, 'the done page');
    expect(donePage).toContain('@dana_test');

    // The account is online, its chats are synced, and the AI can read and write.
    await until(
      async () => (await hub.services.messaging.accounts.get(accountId))?.state === 'online',
      'online',
    );
    const account = await hub.services.accounts.get(principal.workspaceId, accountId);
    expect(account.status).toBe('active');
    expect(account.metadata.identity).toBe('@dana_test');
    const chats = await until(async () => {
      const result = await call('telegram_list_chats', {});
      return result.chats?.length >= 2 ? result : undefined;
    }, 'synced chats');
    const anna = chats.chats.find((c: { title: string }) => c.title === 'Anna');
    // Telegram's own unread counter, not a count of the synced history.
    expect(anna).toMatchObject({ unread: 2 });
    const chat = await call('telegram_read_chat', { chat: anna.id });
    expect(chat.messages.map((m: { text: string }) => m.text)).toContain('hello');

    await call('telegram_send', { chat: anna.id, text: 'Running 5 minutes late' });
    await until(() => fake.sent.some((s) => s.text === 'Running 5 minutes late'), 'the message to go out');
    expect(fake.sent.at(-1)?.peer).toBe(ANNA_ID);
  });

  it('refuses another user and posts without the CSRF token', async () => {
    const [row] = await hub.services.db.query.accounts.findMany({ limit: 1 });
    const stranger = new TestBrowser(hub.baseUrl);
    expect((await stranger.request(`/connect/messenger/${row!.id}`)).status).toBe(302);
    expect((await browser.request(`/connect/messenger/${row!.id}`, { form: { method: 'qr' } })).status).toBe(
      403,
    );
    expect((await browser.request('/connect/messenger/acc_missing')).status).toBe(404);
  });

  it('passes only its own login ids to the gateway', async () => {
    const [row] = await hub.services.db.query.accounts.findMany({ limit: 1 });
    const page = `/connect/messenger/${row!.id}`;
    const csrf = TestBrowser.hiddenInputs(await (await browser.request(page)).text()).csrf!;
    expect((await hub.services.messaging.accounts.get(row!.id))?.state).toBe('online');
    // "../../<account>/logout" in place of a login id would reach the gateway's logout endpoint of
    // any account whose id the user knows.
    const climb = `..%2F..%2F${row!.id}%2Flogout`;
    expect((await browser.request(`${page}/login/${climb}`, { form: { csrf } })).status).toBe(404);
    expect((await browser.request(`${page}/login/${climb}/cancel`, { form: { csrf } })).status).toBe(404);
    expect((await browser.request(`${page}/login/${climb}`)).status).toBe(404);
    expect((await browser.request(`${page}/login/lgn_x`)).status).toBe(404);
    expect((await hub.services.messaging.accounts.get(row!.id))?.state).toBe('online');
  });
});
