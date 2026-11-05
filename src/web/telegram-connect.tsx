import type { FC } from 'hono/jsx';
import { BRAND } from '../brand.js';
import type { ResolvedSetupGuide } from '../connectors/sdk.js';
import { serviceMeta } from './catalog.js';
import type { Translate } from './i18n.js';
import { Layout } from './pages.js';
import { QrCode } from './security-pages.js';
import { SetupGuideView } from './setup-guide.js';
import { Icon, ServiceLogo } from './ui.js';

/** Where a link is, as the page shows it (connected links show the "Connected" page instead). */
export type TelegramConnectState = 'pending' | 'opened' | 'confirmed' | 'failed' | 'cancelled' | 'expired';

export interface TelegramConnectView {
  state: TelegramConnectState;
  /** The hub's bot, `@username`. */
  bot: string;
  /** The bot's link with the one-time code, while the QR code is shown. */
  deepLink?: string | undefined;
  /** Who opened the link in Telegram (@username or name). */
  telegram?: string | undefined;
  /** Why connecting failed, when it is the user's to fix (a plan limit). */
  error?: string | undefined;
  /** Label of the account being connected again. */
  reconnecting?: string | undefined;
  csrf: string;
  /** This page ("Check now"), its state (the site script asks it every few seconds), its cancel action. */
  pageUrl: string;
  stateUrl: string;
  cancelUrl: string;
  /** A new QR code with the same settings. */
  restartUrl: string;
  /** The connect form: a personal account with full access, or an own bot. */
  formUrl: string;
  guide?: ResolvedSetupGuide | undefined;
}

const STEPS = ['open', 'confirm', 'add'] as const;

/** The step the person is on: 0 open the link, 1 tap Connect, 2 add the bot. */
function stepOf(state: TelegramConnectState): number {
  return state === 'pending' ? 0 : state === 'opened' ? 1 : 2;
}

/**
 * Connecting Telegram through the hub's bot (Chat Automation): a QR code with the bot's one-time
 * link, then the last step in Telegram, while the page follows the link by itself (`data-poll`).
 * Every state renders on the server; the script only reloads the page when the state changes.
 */
export const TelegramConnectPage: FC<{ t: Translate; lang: string; view: TelegramConnectView }> = ({
  t,
  lang,
  view,
}) => {
  const meta = serviceMeta('telegram');
  const title = view.reconnecting ? t('tgc.reconnectTitle', { label: view.reconnecting }) : t('tgc.title');
  const waiting = view.state === 'pending' || view.state === 'opened' || view.state === 'confirmed';
  return (
    <Layout title={title} lang={lang}>
      <div class="page-head connect-head">
        <div class="row nowrap-row">
          <ServiceLogo icon={meta?.icon} glyph={meta?.glyph} name="Telegram" size="lg" />
          <div>
            <p class="crumbs">
              <a href="/app/services">{t('app.nav.services')}</a> / Telegram
            </p>
            <h1>{title}</h1>
            <p>{t('tgc.lead')}</p>
          </div>
        </div>
      </div>
      <div class="connect-grid">
        <div
          class="card tg-card"
          data-poll={waiting ? view.stateUrl : undefined}
          data-poll-state={waiting ? view.state : undefined}
        >
          {waiting ? <Waiting t={t} view={view} /> : <Outcome t={t} view={view} />}
          <p class="tg-other">
            {t('tgc.otherTitle')} <a href={view.formUrl}>{t('tgc.otherLink')}</a>
          </p>
        </div>
        <aside class="connect-aside">
          {view.guide ? (
            <div class="card guide-card" id="connect-guide">
              <h2 class="h3">{t('connect.howTo')}</h2>
              <SetupGuideView t={t} guide={view.guide} />
            </div>
          ) : null}
          <div class="card tight tg-safe">
            <h2 class="h3">
              <Icon name="shield" /> {t('tgc.safeTitle')}
            </h2>
            <ul>
              <li>{t('tgc.safe1')}</li>
              <li>{t('tgc.safe2')}</li>
              <li>{t('tgc.safe3', { brand: BRAND.name })}</li>
            </ul>
          </div>
        </aside>
      </div>
    </Layout>
  );
};

/** The QR code (until the link is confirmed), the three steps and what the page waits for. */
const Waiting: FC<{ t: Translate; view: TelegramConnectView }> = ({ t, view }) => {
  const step = stepOf(view.state);
  return (
    <div class={view.deepLink ? 'tg-flow' : 'tg-flow single'}>
      {view.deepLink ? (
        <div class="tg-qr">
          <QrCode text={view.deepLink} label={t('tgc.qrLabel', { brand: BRAND.name })} />
          <p>{t('tgc.qrHint')}</p>
        </div>
      ) : null}
      <div class="tg-now">
        <ol class="tg-progress">
          {STEPS.map((name, i) => (
            <li data-step={i < step ? 'done' : i === step ? 'current' : undefined}>
              {t(`tgc.step.${name}` as const, { brand: BRAND.name })}
            </li>
          ))}
        </ol>
        {view.state === 'confirmed' ? (
          <div class="tg-last">
            <p class="guide-label">{t('tgc.lastTitle')}</p>
            <ol>
              <li>{t('tgc.last1')}</li>
              <li>
                {t('tgc.last2')} <code class="tg-bot">{view.bot}</code>
              </li>
              <li>{t('tgc.last3')}</li>
            </ol>
          </div>
        ) : view.deepLink ? (
          <a class="btn primary tg-open" href={view.deepLink} target="_blank" rel="noopener noreferrer">
            {t('tgc.open')} <Icon name="external" />
          </a>
        ) : null}
        <p class="tg-wait" role="status">
          {view.state === 'confirmed'
            ? t('tgc.waitTelegram')
            : view.state === 'opened'
              ? t('tgc.opened', { who: view.telegram ?? 'Telegram' })
              : t('tgc.waitOpen')}
        </p>
        <noscript>
          <p class="small muted">{t('tgc.noscript')}</p>
        </noscript>
        <div class="tg-foot">
          <a class="btn ghost sm" href={view.pageUrl}>
            <Icon name="refresh" /> {t('tgc.check')}
          </a>
          <form method="post" action={view.cancelUrl}>
            <input type="hidden" name="csrf" value={view.csrf} />
            <button type="submit" class="ghost sm">
              {t('tgc.cancel')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

/** Expired, failed or cancelled: what happened and a new QR code. */
const Outcome: FC<{ t: Translate; view: TelegramConnectView }> = ({ t, view }) => {
  const [heading, text] =
    view.state === 'failed'
      ? [t('tgc.failedTitle'), view.error ?? t('tgc.failed')]
      : view.state === 'cancelled'
        ? [t('tgc.cancelledTitle'), t('tgc.cancelled')]
        : [t('tgc.expiredTitle'), t('tgc.expired')];
  return (
    <div class="tg-outcome">
      <h2 class="h3">{heading}</h2>
      <p
        class={view.state === 'failed' ? 'notice bad' : undefined}
        role={view.state === 'failed' ? 'alert' : undefined}
      >
        {text}
      </p>
      <div class="actions start">
        <a class="btn primary" href={view.restartUrl}>
          {t('tgc.again')}
        </a>
      </div>
    </div>
  );
};
