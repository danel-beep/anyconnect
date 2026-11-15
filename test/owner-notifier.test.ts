import { describe, expect, it, vi } from 'vitest';
import type { OwnerNotice } from '../src/core/owner-notices.js';
import type { NotificationChannels } from '../src/security/notifications.js';
import { renderNotice, TelegramOwnerNotifier } from '../src/security/owner-notifier.js';
import type { TelegramBot } from '../src/security/telegram.js';
import { translator } from '../src/web/i18n.js';

/**
 * Owner notices through the hub's Telegram bot: who gets one, in which language, and how every
 * kind reads. Third-party text in a notice (a message preview, a sender) is escaped for Telegram HTML.
 */

const fired: OwnerNotice = {
  kind: 'trigger_fired',
  trigger: 'Invoices',
  service: 'Telegram',
  account: 'Main',
  from: '<Ann>',
  title: 'Q4 & more',
  preview: 'Pay <b>now</b>',
  summary: 'Asked Ann for the PDF',
  url: 'https://hub.example/app/triggers?x="1"',
};

function notifier(target: { chat: string; locale: string | null } | undefined, bot?: Partial<TelegramBot>) {
  const channels = { telegram: vi.fn(async () => target) } as unknown as NotificationChannels;
  const warn = vi.fn();
  return {
    warn,
    instance: new TelegramOwnerNotifier({
      channels,
      bot: bot as TelegramBot | undefined,
      t: translator,
      logger: { warn } as never,
    }),
  };
}

describe('Telegram owner notifier', () => {
  it('has no channel without a bot or a linked chat', async () => {
    expect(await notifier({ chat: '1', locale: 'en' }).instance.notify('usr_1', fired)).toBe('no_channel');
    const sendMessage = vi.fn();
    expect(await notifier(undefined, { sendMessage }).instance.notify('usr_1', fired)).toBe('no_channel');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends in the owner’s language and reports a failed send', async () => {
    const sendMessage = vi.fn(async () => ({}));
    expect(
      await notifier({ chat: '42', locale: 'ru-RU' }, { sendMessage } as never).instance.notify('u', fired),
    ).toBe('sent');
    const [chat, text] = sendMessage.mock.calls[0] as unknown as [string, string];
    expect(chat).toBe('42');
    expect(text).toContain(translator('ru')('notice.trigger.open'));

    const failing = notifier({ chat: '42', locale: null }, {
      sendMessage: vi.fn(async () => {
        throw new Error('Forbidden: bot was blocked by the user');
      }),
    } as never);
    expect(await failing.instance.notify('u', fired)).toBe('failed');
    expect(failing.warn).toHaveBeenCalledOnce();
  });
});

describe('renderNotice', () => {
  const t = translator('en');

  it('escapes third-party text and shows the AI’s summary', () => {
    const text = renderNotice(t, fired);
    expect(text).toContain('Telegram · Main · &lt;Ann&gt;');
    expect(text).toContain('<i>Q4 &amp; more</i>');
    expect(text).toContain('Pay &lt;b&gt;now&lt;/b&gt;');
    expect(text).toContain('Asked Ann for the PDF');
    expect(text).toContain('href="https://hub.example/app/triggers?x=&quot;1&quot;"');
    expect(text).not.toContain('<b>now</b>');
  });

  it('leaves out the sender, title and summary when there are none', () => {
    const text = renderNotice(t, { ...fired, from: null, title: null, summary: null });
    expect(text).not.toContain('<i>');
    expect(text.split('\n')[1]).toBe('Telegram · Main');
    expect(text).not.toContain(t('notice.trigger.ai'));
  });

  it('lists accounts to sign in again, with the service’s reason when given', () => {
    const text = renderNotice(t, {
      kind: 'accounts_need_reauth',
      accounts: [
        { service: 'Gmail', account: 'Work', reason: 'Token revoked', url: 'https://hub.example/a' },
        { service: 'Slack', account: 'Team', reason: null, url: 'https://hub.example/b' },
      ],
    });
    expect(text).toContain('• <b>Gmail</b> · Work');
    expect(text).toContain('<i>Token revoked</i>');
    expect(text.match(/<i>/g)).toHaveLength(1);
  });

  it('renders confirmations, security events and both kinds of pauses', () => {
    expect(
      renderNotice(t, {
        kind: 'confirmation_waiting',
        action: 'Send message',
        service: 'Telegram',
        account: 'Main',
        url: 'https://hub.example/c',
        expiresMinutes: 30,
      }),
    ).toContain(t('email.confirm.cta'));
    const security = renderNotice(t, {
      kind: 'security',
      event: 'sign_in',
      subject: 'Chrome on macOS',
      url: 'u',
    });
    expect(security).toContain('Chrome on macOS');
    const bare = renderNotice(t, { kind: 'security', event: 'totp_removed', subject: '', url: 'u' });
    expect(bare.split('\n')[1]).toBe('');
    const limit = renderNotice(t, {
      kind: 'trigger_paused',
      trigger: 'T',
      reason: 'limit',
      limit: 5,
      url: 'u',
    });
    const ai = renderNotice(t, {
      kind: 'trigger_paused',
      trigger: 'T',
      reason: 'ai_limit',
      limit: 5,
      url: 'u',
    });
    expect(limit.split('\n')[0]).not.toBe(ai.split('\n')[0]);
  });
});
