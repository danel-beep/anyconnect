import type { FC } from 'hono/jsx';
import type { Translate } from './i18n.js';
import { fmt, Layout, PasskeyForm } from './pages.js';
import { qrMatrix } from './qr.js';

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
const QrCode: FC<{ text: string; label: string }> = ({ text, label }) => {
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
}

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
          <p>{view.email}</p>
        </div>
      </div>
      {view.required ? <div class="warning">{t('security.required')}</div> : null}
      {view.next && view.hasFactor ? (
        <p>
          <a href={view.next}>{t('security.continue')} →</a>
        </p>
      ) : null}
      {view.recent ? null : (
        <div class="warning small">
          {t('security.reauthNeeded')} <a href={view.reauthUrl}>{t('security.reauth')}</a>
        </div>
      )}

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

      <div class="card" id="passkeys">
        <h2>{t('security.passkeys')}</h2>
        <p class="small muted">{t('security.passkeysHint')}</p>
        {view.passkeys.length === 0 ? (
          <p class="muted">{t('security.passkeysNone')}</p>
        ) : (
          <ul class="plain">
            {view.passkeys.map((p) => (
              <li>
                <span>
                  <strong>{p.name}</strong>
                  <span class="small muted">
                    {' '}
                    · {t('security.passkeyAdded')} {fmt(p.createdAt)} · {t('home.lastUsed')}:{' '}
                    {p.lastUsedAt ? fmt(p.lastUsedAt) : t('home.never')}
                    {p.backedUp ? ` · ${t('security.passkeySynced')}` : ''}
                  </span>
                </span>
                <span class="row">
                  <form class="row" method="post" action={`/security/passkeys/${p.id}/rename`}>
                    <Hidden />
                    <input
                      type="text"
                      name="name"
                      required
                      maxlength={64}
                      value={p.name}
                      aria-label={t('security.passkeyName')}
                    />
                    <button type="submit">{t('security.passkeyRename')}</button>
                  </form>
                  <form class="inline" method="post" action={`/security/passkeys/${p.id}/delete`}>
                    <Hidden />
                    <button class="danger" type="submit">
                      {t('security.passkeyDelete')}
                    </button>
                  </form>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p class="small muted" data-role="passkey-unsupported">
          {t('security.passkeyUnsupported')}
        </p>
        <PasskeyForm
          mode="register"
          options="/security/passkeys/options"
          action="/security/passkeys"
          error={t('passkey.failed')}
          hidden={hidden}
        >
          <label for="passkey-name">{t('security.passkeyName')}</label>
          <input
            id="passkey-name"
            type="text"
            name="name"
            maxlength={64}
            placeholder={t('security.passkeyDefaultName')}
          />
          <div class="actions">
            <button class="primary" type="submit">
              {t('security.passkeyAdd')}
            </button>
          </div>
        </PasskeyForm>
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
