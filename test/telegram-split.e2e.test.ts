import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTelegramConnector } from '../src/connectors/builtin/telegram.js';
import { createTelegramBotConnector } from '../src/connectors/builtin/telegram-bot.js';
import type { MessagingPort } from '../src/connectors/messaging.js';
import { accessRules, accounts } from '../src/db/schema.js';
import { SessionAvailability } from '../src/messaging/availability.js';
import type { DriverStatus, GatewayApi } from '../src/messaging/gateway-client.js';
import { resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

const port = {} as MessagingPort;
const personal = createTelegramConnector(port);
const bot = createTelegramBotConnector(port);

function fakeGateway(answer: () => DriverStatus[]): GatewayApi & { calls: number } {
  const gateway = {
    calls: 0,
    async drivers() {
      gateway.calls++;
      return answer();
    },
  };
  return gateway as unknown as GatewayApi & { calls: number };
}

describe('SessionAvailability (can personal Telegram accounts log in here?)', () => {
  it('needs the messenger gateway', async () => {
    const gap = await new SessionAvailability({ gateway: undefined }).check(personal);
    expect(gap?.env).toEqual(['GATEWAY_EMBEDDED']);
  });

  it("reports the driver's missing API keys, and nothing once they are set", async () => {
    const missing = {
      connectorId: 'telegram',
      ready: false,
      missing: { message: 'no app', env: ['TELEGRAM_API_ID', 'TELEGRAM_API_HASH'] },
    };
    expect(await new SessionAvailability({ gateway: fakeGateway(() => [missing]) }).check(personal)).toEqual({
      problem: 'no app',
      env: ['TELEGRAM_API_ID', 'TELEGRAM_API_HASH'],
    });
    const ready = new SessionAvailability({
      gateway: fakeGateway(() => [{ connectorId: 'telegram', ready: true }]),
    });
    expect(await ready.check(personal)).toBeUndefined();
  });

  it('ignores services that are not gateway sessions, and a gateway that does not answer', async () => {
    const down = fakeGateway(() => {
      throw new Error('unreachable');
    });
    const availability = new SessionAvailability({ gateway: down });
    expect(await availability.check(bot)).toBeUndefined();
    expect(down.calls).toBe(0);
    expect(await availability.check(personal)).toBeUndefined();
  });

  it("caches the gateway's answer briefly", async () => {
    let now = 0;
    const gateway = fakeGateway(() => [{ connectorId: 'telegram', ready: true }]);
    const availability = new SessionAvailability({ gateway, ttlMs: 1_000, now: () => now });
    await availability.check(personal);
    await availability.check(personal);
    expect(gateway.calls).toBe(1);
    now = 2_000;
    await availability.check(personal);
    expect(gateway.calls).toBe(2);
  });
});

describe('Telegram as two services: personal account and bot', () => {
  let hub: TestHub;
  let browser: TestBrowser;
  let workspaceId: string;

  beforeAll(async () => {
    await resetDatabase();
    // No messenger gateway: personal accounts cannot log in on this server.
    hub = await startTestHub({ seed: false });
    workspaceId = (await hub.services.db.query.workspaces.findFirst())!.id;
    browser = new TestBrowser(hub.baseUrl);
    expect((await browser.login()).status).toBe(303);
  });

  afterAll(async () => {
    await hub?.close();
  });

  it('says why a personal account cannot be connected, offers the bot, and creates nothing', async () => {
    const page = await browser.request('/connect/telegram');
    expect(page.status).toBe(400);
    const html = await page.text();
    expect(html).toContain('href="/connect/telegram_bot"');
    expect(html).toContain('GATEWAY_EMBEDDED');

    const bot = await browser.request('/connect/telegram_bot');
    expect(bot.status).toBe(200);
    const botHtml = await bot.text();
    expect(botHtml).toContain('credentials.botToken');
    const posted = await browser.request('/connect/telegram', {
      form: { ...TestBrowser.hiddenInputs(botHtml), label: 'Мой Telegram' },
    });
    expect(posted.status).toBe(400);
    expect(await hub.services.db.select().from(accounts).where(eq(accounts.connectorId, 'telegram'))).toEqual(
      [],
    );
  });

  it('lists the two services apart, with the personal account waiting for setup', async () => {
    const services = await hub.services.admin.services(workspaceId);
    expect(services.find((s) => s.service === 'telegram')).toMatchObject({
      name: 'Telegram',
      ready: false,
      setupVar: 'GATEWAY_EMBEDDED',
    });
    expect(services.find((s) => s.service === 'telegram_bot')).toMatchObject({
      name: 'Telegram Bot',
      ready: true,
    });
  });

  it('migrates existing accounts: bots to the new service, personal accounts stay', async () => {
    const db = hub.services.db;
    const row = (id: string, name: string, config: Record<string, unknown>) => ({
      id,
      workspaceId,
      connectorId: 'telegram',
      name,
      label: name,
      config,
    });
    await db
      .insert(accounts)
      .values([
        row('acc_tgbot', 'shop', { mode: 'bot', botApiUrl: 'https://api.telegram.org' }),
        row('acc_tgold', 'old', {}),
        row('acc_tgme', 'me', { mode: 'user', botApiUrl: 'https://api.telegram.org' }),
      ]);
    await db.insert(accessRules).values([
      { id: 'rul_tgall', workspaceId, connectorId: 'telegram', confirm: 'never' },
      { id: 'rul_tgshop', workspaceId, connectorId: 'telegram', accountId: 'acc_tgbot', access: 'read' },
    ]);

    const migration = readFileSync(new URL('../drizzle/0024_telegram_split.sql', import.meta.url), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) await db.execute(sql.raw(statement));
    }

    const after = await db
      .select({ id: accounts.id, connectorId: accounts.connectorId, config: accounts.config })
      .from(accounts)
      .where(sql`${accounts.id} like 'acc_tg%'`)
      .orderBy(accounts.id);
    expect(after).toEqual([
      { id: 'acc_tgbot', connectorId: 'telegram_bot', config: { botApiUrl: 'https://api.telegram.org' } },
      { id: 'acc_tgme', connectorId: 'telegram', config: {} },
      { id: 'acc_tgold', connectorId: 'telegram_bot', config: {} },
    ]);
    const rules = await db
      .select({
        connectorId: accessRules.connectorId,
        accountId: accessRules.accountId,
        confirm: accessRules.confirm,
      })
      .from(accessRules)
      .where(eq(accessRules.workspaceId, workspaceId));
    expect(rules).toEqual(
      expect.arrayContaining([
        { connectorId: 'telegram', accountId: null, confirm: 'never' },
        { connectorId: 'telegram_bot', accountId: null, confirm: 'never' },
        { connectorId: 'telegram_bot', accountId: 'acc_tgbot', confirm: null },
      ]),
    );
    expect(rules).toHaveLength(3);
  });
});
