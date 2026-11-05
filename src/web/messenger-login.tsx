import type { FC } from 'hono/jsx';
import { BRAND } from '../brand.js';
import type { LoginView } from '../messaging/gateway-client.js';
import { serviceMeta } from './catalog.js';
import type { Translate } from './i18n.js';
import { Layout } from './pages.js';
import { QrCode } from './security-pages.js';
import { Icon, ServiceLogo } from './ui.js';

export interface MessengerLoginView {
  accountId: string;
  connectorId: string;
  service: string;
  label: string;
  csrf: string;
  /** Who the account is logged in as, when it is connected now. */
  identity?: string;
  online: boolean;
  /** Status in words when the account is not online (logged out, stopped, reconnecting). */
  status?: string;
  /** The login in progress; absent on the start page. */
  login?: LoginView;
  /** False when this hub has no messenger gateway. */
  available: boolean;
  error?: string;
  /** Team slug of a team's account, carried in every URL. */
  team?: string;
}

/** A URL of this login, with the team carried along. */
const url = (view: MessengerLoginView, rest = '') =>
  `/connect/messenger/${encodeURIComponent(view.accountId)}${rest}${view.team ? `?team=${encodeURIComponent(view.team)}` : ''}`;

/**
 * Logging in to a messenger that keeps a session in the gateway (Telegram personal account):
 * the start page (QR code or phone number) and each step of the login. The QR step reloads
 * itself every few seconds, so the page follows the code's refreshes and the scan without a script.
 */
export const MessengerLoginPage: FC<{ t: Translate; lang: string; view: MessengerLoginView }> = ({
  t,
  lang,
  view,
}) => {
  const meta = serviceMeta(view.connectorId);
  const step = view.login?.step;
  const refresh = step === 'scan_qr' ? 3 : undefined;
  return (
    <Layout
      title={t('mlogin.title', { service: view.service })}
      lang={lang}
      {...(refresh ? { refreshSeconds: refresh } : {})}
    >
      <div class="connected">
        <div class="card connected-card">
          <div class="connected-logos" aria-hidden="true">
            <ServiceLogo icon={meta?.icon} glyph={meta?.glyph} name={view.service} size="lg" />
            {step === 'done' ? (
              <span class="result-icon ok">
                <Icon name="check" />
              </span>
            ) : step === 'failed' ? (
              <span class="result-icon warn">
                <Icon name="alert" />
              </span>
            ) : null}
          </div>
          <h1>{heading(t, view)}</h1>
          {view.error ? (
            <div class="notice" role="alert">
              {view.error}
            </div>
          ) : null}
          {!view.available ? (
            <p>{t('mlogin.unavailable')}</p>
          ) : view.login ? (
            <Step t={t} view={view} />
          ) : (
            <Start t={t} view={view} />
          )}
        </div>
      </div>
    </Layout>
  );
};

function heading(t: Translate, view: MessengerLoginView): string {
  switch (view.login?.step) {
    case 'scan_qr':
      return t('mlogin.scanTitle');
    case 'enter_code':
      return t('mlogin.codeTitle');
    case 'enter_password':
      return t('mlogin.passwordTitle');
    case 'done':
      return t('mlogin.doneTitle');
    case 'failed':
      return t('mlogin.failedTitle');
    default:
      return t('mlogin.title', { service: view.service });
  }
}

const Start: FC<{ t: Translate; view: MessengerLoginView }> = ({ t, view }) => (
  <>
    <p>{t('mlogin.intro', { brand: BRAND.name })}</p>
    {view.online ? (
      <p>
        <strong>
          {view.identity ? t('mlogin.online', { identity: view.identity }) : t('mlogin.onlinePlain')}
        </strong>{' '}
        {t('mlogin.again')}
      </p>
    ) : view.status ? (
      <p class="muted">{t('mlogin.status', { status: view.status })}</p>
    ) : null}
    <form method="post" action={url(view)} class="stack">
      <input type="hidden" name="csrf" value={view.csrf} />
      <input type="hidden" name="method" value="qr" />
      <div class="actions start">
        <button type="submit" class="btn primary">
          {t('mlogin.qr')}
        </button>
        <span class="small muted">{t('mlogin.qrHint')}</span>
      </div>
    </form>
    <details class="guide-variant">
      <summary>{t('mlogin.phone')}</summary>
      <form method="post" action={url(view)} class="stack">
        <input type="hidden" name="csrf" value={view.csrf} />
        <input type="hidden" name="method" value="phone" />
        <label class="field">
          <span>{t('mlogin.phoneLabel')}</span>
          <input
            type="tel"
            name="phone"
            required
            autocomplete="tel"
            inputmode="tel"
            pattern="\+?[0-9 ()\-]{6,24}"
            placeholder="+44 7700 900123"
          />
        </label>
        <div class="actions start">
          <button type="submit" class="btn">
            {t('mlogin.phoneSubmit')}
          </button>
        </div>
      </form>
    </details>
  </>
);

const Step: FC<{ t: Translate; view: MessengerLoginView }> = ({ t, view }) => {
  const login = view.login!;
  const stepUrl = url(view, `/login/${encodeURIComponent(login.id)}`);
  const cancel = (
    <form method="post" action={url(view, `/login/${encodeURIComponent(login.id)}/cancel`)}>
      <input type="hidden" name="csrf" value={view.csrf} />
      <button type="submit" class="btn ghost">
        {t('mlogin.cancel')}
      </button>
    </form>
  );
  switch (login.step) {
    case 'scan_qr':
      return (
        <>
          <p>{t('mlogin.scanTelegram')}</p>
          {login.qr ? (
            <QrCode text={login.qr} label={t('mlogin.qrLabel')} />
          ) : (
            <p class="muted">{t('mlogin.scanWait')}</p>
          )}
          {login.error ? <div class="notice">{login.error}</div> : null}
          <div class="actions start">{cancel}</div>
        </>
      );
    case 'enter_code':
    case 'enter_password': {
      const password = login.step === 'enter_password';
      return (
        <>
          <p>
            {password
              ? login.hint
                ? t('mlogin.passwordHint', { hint: login.hint })
                : t('mlogin.passwordHintNone')
              : t('mlogin.codeHint')}
          </p>
          {login.error ? (
            <div class="notice" role="alert">
              {login.error}
            </div>
          ) : null}
          <form method="post" action={stepUrl} class="stack">
            <input type="hidden" name="csrf" value={view.csrf} />
            <label class="field" for="mlogin-secret">
              <span>{password ? t('mlogin.passwordLabel') : t('mlogin.codeLabel')}</span>
              {password ? (
                <input
                  type="password"
                  name="password"
                  required
                  autocomplete="current-password"
                  maxlength={256}
                />
              ) : (
                <input
                  id="mlogin-secret"
                  type="text"
                  name="code"
                  required
                  autocomplete="one-time-code"
                  inputmode="numeric"
                  maxlength={32}
                />
              )}
            </label>
            <div class="actions start">
              <button type="submit" class="btn primary">
                {t('mlogin.submit')}
              </button>
            </div>
          </form>
          <div class="actions start">{cancel}</div>
        </>
      );
    }
    case 'done':
      return (
        <>
          <p>
            {login.identity ? t('mlogin.done', { identity: login.identity }) : t('mlogin.doneNoIdentity')}
          </p>
          <p class="small muted">{t('mlogin.devices', { brand: BRAND.name })}</p>
          <div class="actions start">
            <a class="btn primary" href="/app/services">
              {t('mlogin.toServices')}
            </a>
          </div>
        </>
      );
    default:
      return (
        <>
          {login.error ? <p>{login.error}</p> : null}
          <div class="actions start">
            <a class="btn primary" href={url(view)}>
              {t('mlogin.retry')}
            </a>
          </div>
        </>
      );
  }
};
