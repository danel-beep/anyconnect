import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InboundMessage } from '../src/connectors/messaging.js';
import { messengerMessages } from '../src/db/schema.js';
import { resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

const DAY = 24 * 3_600_000;

describe('how long a messenger account keeps its messages', () => {
  let hub: TestHub;
  let workspaceId: string;

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub();
    workspaceId = (await hub.services.db.query.workspaces.findFirst())!.id;
  });

  afterAll(async () => {
    await hub?.close();
  });

  const addBot = (name: string) =>
    hub.services.accounts.create(workspaceId, {
      connectorId: 'telegram_bot',
      name,
      label: `Bot ${name}`,
      credentials: { botToken: '123456:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-bs' },
    });

  const message = (id: string, daysAgo: number): InboundMessage => ({
    chat: { externalId: '42', kind: 'direct', title: 'Anna' },
    externalId: id,
    direction: 'in',
    sentAt: new Date(Date.now() - daysAgo * DAY),
    text: `message ${id}`,
  });

  const stored = async (accountId: string) =>
    (
      await hub.services.db
        .select({ sentAt: messengerMessages.sentAt })
        .from(messengerMessages)
        .where(eq(messengerMessages.accountId, accountId))
    ).length;

  it('starts a new messenger account at 90 days and other services with no setting', async () => {
    const bot = await addBot('fresh');
    expect(bot.settings.keepMessagesDays).toBe(90);
    const demo = (await hub.services.accounts.list(workspaceId)).find((a) => a.connectorId === 'demo')!;
    expect(demo.settings.keepMessagesDays).toBeUndefined();
    await expect(
      hub.services.accounts.update(workspaceId, demo.id, { settings: { keepMessagesDays: 30 } }),
    ).rejects.toThrow(/keeps no copy/);
    await expect(
      hub.services.accounts.update(workspaceId, bot.id, { settings: { keepMessagesDays: 7 } }),
    ).rejects.toThrow();
  });

  it('deletes only what is past each account’s period, and does not store old history again', async () => {
    const short = await addBot('short');
    const forever = await addBot('forever');
    const { accounts, messaging } = hub.services;
    await accounts.update(workspaceId, forever.id, { settings: { keepMessagesDays: null } });
    for (const account of [short, forever])
      expect(await messaging.store.ingest(account.id, [message('a', 10), message('b', 80)])).toHaveLength(2);

    // Hiding a tool does not touch the period, and choosing a period does not touch hidden tools.
    await accounts.update(workspaceId, short.id, { settings: { disabledActions: ['send'] } });
    const updated = await accounts.update(workspaceId, short.id, { settings: { keepMessagesDays: 30 } });
    expect(updated.settings).toEqual({ disabledActions: ['send'], keepMessagesDays: 30 });

    expect(await messaging.store.prune({ batch: 1 })).toBe(1);
    expect(await stored(short.id)).toBe(1);
    expect(await stored(forever.id)).toBe(2);
    expect(await messaging.store.prune()).toBe(0);

    // A backfill after a restart brings the old message again: it is not stored. (The period is
    // remembered for a minute, so this account is asked about with a later clock.)
    const again = await addBot('again');
    await accounts.update(workspaceId, again.id, { settings: { keepMessagesDays: 30 } });
    const kept = await messaging.store.ingest(again.id, [message('old', 45), message('new', 1)]);
    expect(kept.map((m) => m.body.text)).toEqual(['message new']);
  });

  it('is chosen on the account page', async () => {
    const bot = await addBot('page');
    const browser = new TestBrowser(hub.baseUrl);
    await browser.login();
    const page = await browser.request(`/app/accounts/${bot.id}`);
    const html = await page.text();
    expect(html).toContain('<option value="90" selected');
    const csrf = TestBrowser.hiddenInputs(html).csrf!;
    const back = `/app/accounts/${bot.id}`;
    const post = (days: string) =>
      browser.request(`/app/accounts/${bot.id}/retention`, { form: { csrf, back, days } });

    expect((await post('30')).status).toBe(303);
    expect((await hub.services.accounts.get(workspaceId, bot.id)).settings.keepMessagesDays).toBe(30);
    expect(await (await browser.request(back)).text()).toContain('<option value="30" selected');
    await post('');
    expect((await hub.services.accounts.get(workspaceId, bot.id)).settings.keepMessagesDays).toBeUndefined();
    // Not one of the offered periods: refused, nothing changes.
    expect((await post('1')).status).toBeGreaterThanOrEqual(300);
    expect((await hub.services.accounts.get(workspaceId, bot.id)).settings.keepMessagesDays).toBeUndefined();

    // A service without stored messages has no such choice.
    const demo = (await hub.services.accounts.list(workspaceId)).find((a) => a.connectorId === 'demo')!;
    expect(await (await browser.request(`/app/accounts/${demo.id}`)).text()).not.toContain('acc-keep');
  });
});
