import type { FC } from 'hono/jsx';
import type { Translate } from './i18n.js';
import { Layout, PasskeyForm } from './pages.js';
import { qrMatrix } from './qr.js';
import { fmtAgo, fmtDate, Icon, ServiceLogo } from './ui.js';

/** Second step of the sign-in: TOTP / recovery code form and, when the user has one, a passkey. */
export const VerifyPage: FC<{
  t: Translate;
  lang: string;
  csrf: string;
  next: string;
  /** Show the code form; `totp` false means only recovery codes are possible. */
  codes: boolean;
  totp: boolean;
  passkey: boolean;
  error?: string;
}> = ({ t, lang, csrf, next, codes, totp, passkey, error }) => (
  <Layout title={t('verify.title')} narrow lang={lang} script={passkey}>
    <div class="card">
      <h1>{t('verify.title')}</h1>
      <p class="muted">{t('verify.subtitle')}</p>
      {passkey ? (
        <PasskeyForm
          mode="authenticate"
          options="/login/passkey/options"
          action="/login/passkey"
          error={t('passkey.failed')}
          hidden={{ csrf, next, flow: 'second_factor' }}
          after={codes ? <p class="divider small muted">{t('login.or')}</p> : null}
        >
          <div class="actions">
            <button class="primary" type="submit">
              {t('verify.passkey')}
            </button>
          </div>
        </PasskeyForm>
      ) : null}
      {codes ? (
        <form method="post" action="/login/verify">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="next" value={next} />
          <label for="code">{totp ? t('verify.code') : t('verify.recoveryOnly')}</label>
          <input
            id="code"
            type="text"
            name="code"
            autocomplete="one-time-code"
            autocapitalize="characters"
            spellcheck={false}
            autofocus
            required
          />
          {error ? <p class="error">{error}</p> : null}
          <div class="actions">
            <button class="primary" type="submit">
              {t('verify.submit')}
            </button>
          </div>
        </form>
      ) : null}
      <p class="small">
        <a href={`/login?next=${encodeURIComponent(next)}`}>{t('verify.restart')}</a>
      </p>
    </div>
  </Layout>
);

/** QR code drawn as an SVG path; colors come from the stylesheet (`.qr`). */
export const QrCode: FC<{ text: string; label: string }> = ({ text, label }) => {
  const { size, path } = qrMatrix(text);
  const quiet = 4;
  const box = size + quiet * 2;
  return (
    <svg
      class="qr"
      role="img"
      aria-label={label}
      viewBox={`${-quiet} ${-quiet} ${box} ${box}`}
      shape-rendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
};

export interface SecurityView {
  email: string;
  csrf: string;
  /** Where to go once done (e.g. back to an OAuth consent), already validated. */
  next?: string;
  /** Signed in or re-confirmed within the last 10 minutes: changes are allowed. */
  recent: boolean;
  reauthUrl: string;
  /** REQUIRE_2FA is on and the user has no second factor yet. */
  required: boolean;
  totp: { enabled: boolean; enrollment?: { secret: string; uri: string }; error?: string };
  hasFactor: boolean;
  recoveryCodes: number;
  passkeys: { id: string; name: string; createdAt: Date; lastUsedAt: Date | null; backedUp: boolean }[];
  /** Browsers signed in now (reviewed in Settings). */
  sessions: number;
  /** Approving held-back actions in Telegram; absent when this server has no Telegram bot. */
  telegram?: { linked: boolean } | undefined;
}

type PasskeyView = SecurityView['passkeys'][number];

/** One passkey: where it lives, when it was added and used, and a menu to rename or delete it. */
const PasskeyRow: FC<{ t: Translate; lang: string; p: PasskeyView; Hidden: FC }> = ({
  t,
  lang,
  p,
  Hidden,
}) => (
  <div class="acc pk" id={`pk-${p.id}`}>
    <ServiceLogo glyph="key" name={p.name} />
    <div class="grow">
      <div class="title">
        <span class="pk-name">{p.name}</span>
        {p.backedUp ? (
          <span class="badge" title={t('security.passkeySyncedHint')}>
            {t('security.passkeySynced')}
          </span>
        ) : null}
      </div>
      <div class="sub">
        {t('security.passkeyAdded', { date: fmtDate(lang, p.createdAt) })} ·{' '}
        {p.lastUsedAt
          ? t('security.passkeyUsed', { when: fmtAgo(lang, p.lastUsedAt) })
          : t('security.passkeyNeverUsed')}
      </div>
    </div>
    <div class="ops">
      <details class="menu" data-menu>
        <summary
          aria-label={t('security.passkeyMore', { name: p.name })}
          title={t('security.passkeyMore', { name: p.name })}
        >
          <Icon name="more" />
        </summary>
        <div class="menu-pop">
          <form method="post" action={`/security/passkeys/${p.id}/rename`} class="rename">
            <Hidden />
            <label class="sr-only" for={`pk-name-${p.id}`}>
              {t('security.passkeyName')}
            </label>
            <input id={`pk-name-${p.id}`} type="text" name="name" value={p.name} maxlength={64} required />
            <button type="submit" class="sm">
              {t('security.passkeyRename')}
            </button>
          </form>
          <form
            method="post"
            action={`/security/passkeys/${p.id}/delete`}
            data-confirm={t('security.passkeyDeleteConfirm', { name: p.name })}
          >
            <Hidden />
            <button type="submit" class="danger">
              <Icon name="trash" /> {t('security.passkeyDelete')}
            </button>
          </form>
        </div>
      </details>
    </div>
  </div>
);

export const SecurityPage: FC<{ t: Translate; lang: string; view: SecurityView }> = ({ t, lang, view }) => {
  const hidden = { csrf: view.csrf, ...(view.next ? { next: view.next } : {}) };
  const Hidden = () => (
    <>
      {Object.entries(hidden).map(([name, value]) => (
        <input type="hidden" name={name} value={value} />
      ))}
    </>
  );
  return (
    <Layout title={t('security.title')} lang={lang} script>
      <div class="page-head">
        <div>
          <h1>{t('security.title')}</h1>
          <p>{t('security.sub', { email: view.email })}</p>
        </div>
      </div>
      {view.required ? <div class="warning">{t('security.required')}</div> : null}
      {view.next && view.hasFactor ? (
        <p>
          <a href={view.next}>{t('security.continue')} →</a>
        </p>
      ) : null}
      {view.recent ? null : (
        <div class="notice reauth-row">
          <span class="grow">{t('security.reauthNeeded')}</span>
          <a class="btn primary" href={view.reauthUrl}>
            {t('security.reauth')}
          </a>
        </div>
      )}

      {/* Until the sign-in is confirmed, every control here is visibly off rather than failing on click. */}
      <fieldset class="lock-group" disabled={!view.recent}>
        <div class="card" id="totp">
          <h2>
            {t('security.totp')}{' '}
            <span class={view.totp.enabled ? 'badge ok' : 'badge'}>
              {view.totp.enabled ? t('security.on') : t('security.off')}
            </span>
          </h2>
          <p class="small muted">{t('security.totpHint')}</p>
          {view.totp.enabled ? (
            <form method="post" action="/security/totp/disable">
              <Hidden />
              <button class="danger" type="submit">
                {t('security.totpDisable')}
              </button>
            </form>
          ) : view.totp.enrollment ? (
            <>
              <p>{t('security.totpScan')}</p>
              <QrCode text={view.totp.enrollment.uri} label={t('security.totpLink')} />
              <label for="totp-secret">{t('security.totpSecret')}</label>
              <input id="totp-secret" type="text" readonly value={view.totp.enrollment.secret} />
              <p class="small">
                <a href={view.totp.enrollment.uri}>{t('security.totpLink')}</a>
              </p>
              <form method="post" action="/security/totp/confirm">
                <Hidden />
                <label for="totp-code">{t('security.totpCode')}</label>
                <input
                  id="totp-code"
                  type="text"
                  name="code"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  required
                />
                {view.totp.error ? <p class="error">{view.totp.error}</p> : null}
                <div class="actions">
                  <button class="primary" type="submit">
                    {t('security.totpConfirm')}
                  </button>
                </div>
              </form>
            </>
          ) : (
            <form method="post" action="/security/totp/setup">
              <Hidden />
              <button class="primary" type="submit">
                {t('security.totpSetup')}
              </button>
            </form>
          )}
        </div>

        <div class="card flush" id="passkeys">
          <div class="card-head pad">
            <div>
              <h2>{t('security.passkeys')}</h2>
              <p class="small muted">{t('security.passkeysHint')}</p>
            </div>
            {/* No name to fill in: the hub names the passkey after where it is kept; rename it later. */}
            <PasskeyForm
              mode="register"
              options="/security/passkeys/options"
              action="/security/passkeys"
              error={t('passkey.failed')}
              hidden={hidden}
              class="pk-add"
            >
              <button class={view.passkeys.length === 0 ? 'primary sm' : 'sm'} type="submit">
                <Icon name="plus" /> {t('security.passkeyAdd')}
              </button>
            </PasskeyForm>
          </div>
          {view.passkeys.length === 0 ? (
            <p class="muted pk-empty">{t('security.passkeysNone')}</p>
          ) : (
            <div class="acc-list pk-list">
              {view.passkeys.map((p) => (
                <PasskeyRow t={t} lang={lang} p={p} Hidden={Hidden} />
              ))}
            </div>
          )}
          <p class="small muted pk-empty" data-role="passkey-unsupported">
            {t('security.passkeyUnsupported')}
          </p>
        </div>

        <div class="card" id="recovery">
          <h2>{t('security.recovery')}</h2>
          <p class="small muted">{t('security.recoveryHint')}</p>
          {view.hasFactor ? (
            <>
              <p>
                {view.recoveryCodes > 0
                  ? t('security.recoveryLeft', { count: view.recoveryCodes })
                  : t('security.recoveryNone')}
              </p>
              <form method="post" action="/security/recovery-codes">
                <Hidden />
                <button type="submit">{t('security.recoveryRegenerate')}</button>
              </form>
            </>
          ) : (
            <p class="muted">{t('security.recoveryNeedsFactor')}</p>
          )}
        </div>
      </fieldset>

      <div class="card" id="more">
        <h2>{t('security.more')}</h2>
        <ul class="plain">
          <li>
            <span class="grow">
              <strong>{t('security.browsers')}</strong>
              <div class="small muted">{t('security.browsersN', { n: view.sessions })}</div>
            </span>
            <a class="btn sm" href="/app/settings#sessions">
              {t('security.review')}
            </a>
          </li>
          {view.telegram ? (
            <li>
              <span class="grow">
                <strong>{t('security.telegram')}</strong>
                <div class="small muted">
                  {view.telegram.linked ? t('security.telegramOn') : t('security.telegramOff')}
                </div>
              </span>
              <a class={view.telegram.linked ? 'btn sm' : 'btn sm primary'} href="/confirm#telegram">
                {view.telegram.linked ? t('security.review') : t('security.telegramLink')}
              </a>
            </li>
          ) : null}
        </ul>
        <p class="hint">{t('security.chat')}</p>
      </div>
    </Layout>
  );
};

/** Freshly generated recovery codes: shown exactly once. */
export const RecoveryCodesPage: FC<{ t: Translate; lang: string; codes: string[]; continueTo: string }> = ({
  t,
  lang,
  codes,
  continueTo,
}) => (
  <Layout title={t('codes.title')} narrow lang={lang}>
    <div class="card">
      <h1>{t('codes.title')}</h1>
      <p class="muted">{t('codes.hint')}</p>
      <ul class="codes">
        {codes.map((code) => (
          <li>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <p>
        <a href={continueTo}>{t('codes.done')} →</a>
      </p>
    </div>
  </Layout>
);
