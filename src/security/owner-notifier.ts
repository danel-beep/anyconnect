import type { NoticeDelivery, OwnerNotice, OwnerNotifier } from '../core/owner-notices.js';
import type { Logger } from '../logger.js';
import type { Locale, Translate } from '../web/i18n.js';
import { pickLocale } from './confirmations.js';
import type { NotificationChannels } from './notifications.js';
import { escapeHtml, type TelegramBot } from './telegram.js';

/** Owner notices through the hub's Telegram bot, in the owner's language. */
export class TelegramOwnerNotifier implements OwnerNotifier {
  constructor(
    private readonly deps: {
      channels: NotificationChannels;
      bot: TelegramBot | undefined;
      t: (locale: Locale) => Translate;
      logger: Logger;
    },
  ) {}

  async notify(userId: string, notice: OwnerNotice): Promise<NoticeDelivery> {
    const { bot, channels, logger } = this.deps;
    if (!bot) return 'no_channel';
    const target = await channels.telegram(userId);
    if (!target) return 'no_channel';
    try {
      await bot.sendMessage(target.chat, renderNotice(this.deps.t(pickLocale(target.locale)), notice));
      return 'sent';
    } catch (error) {
      logger.warn({ err: error, notice: notice.kind }, 'owner notice not delivered');
      return 'failed';
    }
  }
}

/** A notice as a Telegram HTML message. */
export function renderNotice(t: Translate, notice: OwnerNotice): string {
  switch (notice.kind) {
    case 'accounts_need_reauth':
      return [
        `<b>${escapeHtml(t('notice.reauth.title', { n: notice.accounts.length }))}</b>`,
        '',
        ...notice.accounts.map(
          (a) =>
            `• <b>${escapeHtml(a.service)}</b> · ${escapeHtml(a.account)}: <a href="${escapeHtml(a.url)}">${escapeHtml(t('notice.reauth.action'))}</a>` +
            (a.reason ? `\n  <i>${escapeHtml(a.reason)}</i>` : ''),
        ),
        '',
        escapeHtml(t('notice.reauth.why', { n: notice.accounts.length })),
      ].join('\n');
  }
}
