import type { FC } from 'hono/jsx';
import { ASSET_URLS } from './asset-urls.js';
import type { Translate } from './i18n.js';
import { Layout } from './pages.js';
import { fmtDate, Hidden } from './ui.js';

/**
 * Pages of the payment flow served by the hub itself: the page that hosts Paddle's checkout overlay
 * and the "hosted" pages of the test provider (development only).
 */

export const PaddleCheckoutPage: FC<{
  t: Translate;
  lang: string;
  view: {
    clientToken: string;
    sandbox: boolean;
    transactionId: string;
    email: string | null;
    success: string;
    back: string;
  };
}> = ({ t, lang, view }) => (
  <Layout title={t('billing.checkout.title')} narrow lang={lang}>
    <div class="card">
      <h1>{t('billing.checkout.title')}</h1>
      <p
        id="paddle-checkout"
        data-token={view.clientToken}
        data-sandbox={view.sandbox ? '1' : '0'}
        data-txn={view.transactionId}
        data-email={view.email ?? ''}
        data-success={view.success}
        data-back={view.back}
        data-lang={lang}
      >
        {t('billing.checkout.opening')}
      </p>
      <p class="muted small checkout-failed">{t('billing.checkout.failed')}</p>
      {view.sandbox ? <p class="notice info">{t('app.billing.testMode')}</p> : null}
      <div class="actions start">
        <a class="btn" href={view.back}>
          {t('billing.checkout.back')}
        </a>
      </div>
    </div>
    <script src="https://cdn.paddle.com/paddle/v2/paddle.js" defer />
    <script src={ASSET_URLS.paddleCheckout} defer />
  </Layout>
);

export const TestCheckoutPage: FC<{
  t: Translate;
  lang: string;
  csrf: string;
  view: { token: string; planName: string; interval: 'month' | 'year'; cancelUrl: string } | undefined;
}> = ({ t, lang, csrf, view }) => (
  <Layout title={t('billing.test.title')} narrow lang={lang}>
    <div class="card">
      <h1>{t('billing.test.title')}</h1>
      {view ? (
        <>
          <p class="notice info">{t('billing.test.lead')}</p>
          <p>
            <strong>{view.planName}</strong> ·{' '}
            {t(view.interval === 'year' ? 'pricing.yearly' : 'pricing.monthly')}
          </p>
          <form method="post" action="/billing/test/checkout" class="actions start">
            <Hidden values={{ csrf, t: view.token }} />
            <button type="submit" class="primary">
              {t('billing.test.pay')}
            </button>
            <a class="btn" href={view.cancelUrl}>
              {t('billing.test.cancel')}
            </a>
          </form>
        </>
      ) : (
        <p>{t('billing.test.expired')}</p>
      )}
    </div>
  </Layout>
);

export const TestPortalPage: FC<{
  t: Translate;
  lang: string;
  csrf: string;
  view:
    | { token: string; status: string; periodEnd: Date; cancelAtPeriodEnd: boolean; back: string }
    | undefined;
}> = ({ t, lang, csrf, view }) => (
  <Layout title={t('billing.test.portalTitle')} narrow lang={lang}>
    <div class="card">
      <h1>{t('billing.test.portalTitle')}</h1>
      {view ? (
        <>
          <p class="notice info">{t('billing.test.portalLead')}</p>
          <p>
            {t('billing.test.status', { status: view.status, date: fmtDate(lang, view.periodEnd) })}
            {view.cancelAtPeriodEnd ? ` ${t('billing.test.cancelling')}` : ''}
          </p>
          <div class="actions start wrap">
            {(['cancel', 'resume', 'renew', 'fail', 'end'] as const).map((what) => (
              <form method="post" action="/billing/test/portal">
                <Hidden values={{ csrf, t: view.token, what }} />
                <button type="submit">{t(`billing.test.do_${what}`)}</button>
              </form>
            ))}
          </div>
          <div class="actions start">
            <a class="btn primary" href={view.back}>
              {t('billing.checkout.back')}
            </a>
          </div>
        </>
      ) : (
        <p>{t('billing.test.expired')}</p>
      )}
    </div>
  </Layout>
);
