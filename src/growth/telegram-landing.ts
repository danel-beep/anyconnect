import type { Logger } from '../logger.js';
import { pickLocale } from '../security/confirmations.js';
import type { BotStartHandler, TelegramBot } from '../security/telegram.js';
import type { Locale, Translate } from '../web/i18n.js';

/**
 * A campaign tag in a bot deep link (`t.me/<bot>?start=<tag>`), e.g. `tg_ai_1`. The same tag goes
 * to the site as `utm_campaign`, so the analytics funnel joins bot starts with sign-ups. Lowercase
 * only: one-time link codes for confirmations are mixed-case base64url and are tried first.
 */
export const CAMPAIGN_TAG = /^[a-z0-9_-]{1,64}$/;

/** Where the landing button leads: the site with standard UTM tags. */
export function landingUrl(publicUrl: string, campaign: string | null): string {
  const url = new URL('/', publicUrl);
  url.searchParams.set('utm_source', 'telegram');
  url.searchParams.set('utm_medium', campaign ? 'ads' : 'bot');
  if (campaign) url.searchParams.set('utm_campaign', campaign);
  return url.toString();
}

/**
 * The bot's answer to people who come from an ad or a plain `t.me/<bot>` link: what the product is
 * and a button to the site carrying the campaign tag. Telegram Ads may only link to a channel or a
 * bot, so this is the step between an ad and the site.
 */
export class TelegramLanding {
  constructor(
    private readonly deps: {
      bot: TelegramBot;
      publicUrl: string;
      t: (locale: Locale) => Translate;
      logger: Logger;
      /** Called for every start this handler answers (analytics: `campaign` is null without a tag). */
      onStart?: (campaign: string | null) => Promise<void> | void;
    },
  ) {}

  readonly handle: BotStartHandler = async (start) => {
    const campaign = start.payload === '' ? null : start.payload;
    if (campaign !== null && !CAMPAIGN_TAG.test(campaign)) return false;
    const { bot, publicUrl, logger, onStart } = this.deps;
    const t = this.deps.t(pickLocale(start.languageCode));
    const host = new URL(publicUrl).host;
    await bot
      .sendMessage(start.chatId, t('bot.landing.text'), [
        [{ text: t('bot.landing.open', { host }), url: landingUrl(publicUrl, campaign) }],
      ])
      .catch((error) => logger.warn({ err: error }, 'telegram reply failed'));
    try {
      await onStart?.(campaign);
    } catch (error) {
      logger.warn({ err: error }, 'bot start tracking failed');
    }
    return true;
  };
}
