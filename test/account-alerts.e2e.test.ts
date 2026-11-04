import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accounts, workspaceMembers } from '../src/db/schema.js';
import { renderNotice } from '../src/security/owner-notifier.js';
import { translator } from '../src/web/i18n.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

/** A fake Telegram Bot API that records messages and can be made to fail. */
function fakeTelegram() {
  const messages: Array<{ chat: string; text: string }> = [];
  const state = { down: false };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split('/').pop()!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (state.down)
      return new Response(JSON.stringify({ ok: false, description: 'Bad Gateway' }), { status: 502 });
    if (method === 'sendMessage') messages.push({ chat: String(body.chat_id), text: String(body.text) });
    const result =
      method === 'getMe'
        ? { id: 1, username: 'manyplug_test_bot' }
        : method === 'sendMessage'
          ? { message_id: messages.length, chat: { id: Number(body.chat_id) } }
          : true;
    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { messages, state, fetch };
}

describe('alerts about accounts that need a new sign-in', () => {
  let hub: TestHub;
  let telegram: ReturnType<typeof fakeTelegram>;
  let main: { id: string; workspaceId: string };

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await hub?.close();
    telegram = fakeTelegram();
    hub = await startTestHub({
      env: { TELEGRAM_BOT_TOKEN: '123:test', TELEGRAM_API_URL: 'http://telegram.invalid' },
      telegramFetch: telegram.fetch,
    });
    const { db, notificationChannels } = hub.services;
    const row = (await db.query.accounts.findFirst({ where: eq(accounts.name, 'main') }))!;
    main = { id: row.id, workspaceId: row.workspaceId };
    const [owner] = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, main.workspaceId));
    const code = await notificationChannels.startTelegramLink(owner!.userId, 'en');
    await notificationChannels.completeTelegramLink(code, '777', 'owner');
  });

  afterAll(async () => {
    await hub?.close();
  });

  const breakAccount = (message = 'Invalid credentials: password=hunter2') =>
    hub.services.accounts.markStatus(main.id, 'needs_reauth', message);

  it('tells the owner once per breakage, with the link that fixes it', async () => {
    const { alerts, accounts: accountService } = hub.services;
    expect(await alerts.notifyReauth()).toEqual({ notified: 0, waiting: 0 });

    await breakAccount();
    expect(await alerts.notifyReauth()).toEqual({ notified: 1, waiting: 0 });
    expect(telegram.messages).toHaveLength(1);
    const { chat, text } = telegram.messages[0]!;
    expect(chat).toBe('777');
    expect(text).toContain('An account needs you to sign in again');
    expect(text).toContain('<b>Demo</b> · Demo — main');
    expect(text).toContain(`href="${hub.baseUrl}/connect/demo?account=${main.id}"`);
    expect(text).not.toContain('hunter2'); // the service's words are scrubbed

    // Still broken: no second message.
    await alerts.notifyReauth();
    expect(telegram.messages).toHaveLength(1);

    // Works again, then breaks again: a new alert.
    await accountService.markStatus(main.id, 'active', null);
    await alerts.notifyReauth();
    await breakAccount('Token revoked');
    await alerts.notifyReauth();
    expect(telegram.messages).toHaveLength(2);
    expect(telegram.messages[1]!.text).toContain('Token revoked');
  });

  it('retries when Telegram is down, skips disabled and never-connected accounts', async () => {
    const { alerts, db } = hub.services;
    await breakAccount();
    telegram.state.down = true;
    expect(await alerts.notifyReauth()).toEqual({ notified: 0, waiting: 1 });
    telegram.state.down = false;
    expect(await alerts.notifyReauth()).toEqual({ notified: 1, waiting: 0 });

    // A disabled account and one whose sign-in was never finished are not "broken".
    await db.update(accounts).set({ reauthNotifiedAt: null, enabled: false }).where(eq(accounts.id, main.id));
    await db
      .update(accounts)
      .set({ status: 'needs_reauth', credentialsEncrypted: null })
      .where(eq(accounts.name, 'second'));
    expect(await alerts.notifyReauth()).toEqual({ notified: 0, waiting: 0 });
  });

  it('marks the account notified even when the owner has no channel', async () => {
    const { alerts, notificationChannels, db } = hub.services;
    const [owner] = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, main.workspaceId));
    await notificationChannels.unlinkTelegram(owner!.userId);
    await breakAccount();
    expect(await alerts.notifyReauth()).toEqual({ notified: 1, waiting: 0 });
    expect(telegram.messages).toHaveLength(0);
  });

  it('renders several accounts in Russian', () => {
    const text = renderNotice(translator('ru'), {
      kind: 'accounts_need_reauth',
      accounts: [
        { service: 'Gmail', account: 'Work <mail>', reason: null, url: 'https://x/connect/gmail?account=a' },
        {
          service: 'Slack',
          account: 'Team',
          reason: 'invalid_auth',
          url: 'https://x/connect/slack?account=b',
        },
      ],
    });
    expect(text).toContain('Нужно войти заново: аккаунты перестали работать');
    expect(text).toContain('Work &lt;mail&gt;');
    expect(text).toContain('<i>invalid_auth</i>');
    expect(text).toContain('не смогут ими пользоваться');
  });
});
