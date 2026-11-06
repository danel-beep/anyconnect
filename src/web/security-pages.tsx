import type { FC } from 'hono/jsx';
import type { Translate } from './i18n.js';
import { Layout, PasskeyForm } from './pages.js';
import { qrMatrix } from './qr.js';
import { AskAi, fmtAgo, fmtDate, Icon, type IconName, SectionHead, ServiceLogo } from './ui.js';

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
  vault?: VaultView;
  flash?: { kind: 'ok' | 'bad'; text: string };
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

/** The personal vault as seen from this browser (`docs/VAULTS.md`). */
export interface VaultView {
  open: boolean;
  /** Locked here: the code this browser's request shows, and whether the request still waits. */
  thisCode?: string;
  waiting?: boolean;
  /**
   * Open here: other browsers (with the code they show) and AI apps or personal tokens (by name)
   * asking to be let in.
   */
  requests: {
    kind: 'device' | 'oauth' | 'api_token';
    subject: string;
    code?: string;
    name?: string;
    createdAt: Date;
  }[];
  /** Locked here: AI apps waiting for an Allow from a browser where the vault is open. */
  waitingApps: string[];
  devices: number;
  recovery: boolean;
}

const VaultCard: FC<{ t: Translate; lang: string; vault: VaultView; Hidden: FC }> = ({
  t,
  lang,
  vault,
  Hidden,
}) => (
  <div class="card" id="vault">
    <SectionHead
      icon="lock"
      title={t('vault.title')}
      hint={t('vault.hint')}
      aside={
        <span class={vault.open ? 'badge ok' : 'badge'}>
          {vault.open ? t('vault.open') : t('vault.locked')}
        </span>
      }
    />
    {vault.open ? (
      <>
        {vault.requests.length > 0 ? (
          <>
            <h3>{t('vault.requests')}</h3>
            <p class="small muted">{t('vault.requestsHint')}</p>
            <ul class="plain">
              {vault.requests.map((r) => (
                <li>
                  <span class="grow">
                    {r.kind === 'device' ? (
                      <code class="device-code">{r.code}</code>
                    ) : (
                      <strong>{r.name}</strong>
                    )}
                    <div class="small muted">
                      {r.kind === 'device' ? t('vault.requestBrowser') : t('vault.requestApp')} ·{' '}
                      {t('vault.requested', { when: fmtAgo(lang, r.createdAt) })}
                    </div>
                  </span>
                  <span class="row">
                    <form
                      class="inline"
                      method="post"
                      action={`/security/vault/requests/${r.kind}/${r.subject}/allow`}
                    >
                      <Hidden />
                      <button class="primary" type="submit">
                        {t('vault.allow')}
                      </button>
                    </form>
                    <form
                      class="inline"
                      method="post"
                      action={`/security/vault/requests/${r.kind}/${r.subject}/deny`}
                    >
                      <Hidden />
                      <button type="submit">{t('vault.deny')}</button>
                    </form>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <p class="small muted">{t('vault.devices', { n: vault.devices })}</p>
      </>
    ) : vault.waiting ? (
      <>
        {vault.waitingApps.length > 0 ? (
          <p class="notice info">{t('vault.lockedApps', { apps: vault.waitingApps.join(', ') })}</p>
        ) : null}
        <p>{t('vault.lockedHint')}</p>
        <p>
          <code class="device-code">{vault.thisCode}</code>
        </p>
      </>
    ) : (
      <form method="post" action="/security/vault/ask">
        <Hidden />
        <p>{t('vault.lockedExpired')}</p>
        <button class="primary" type="submit">
          {t('vault.askAgain')}
        </button>
      </form>
    )}

    <div class="sub-block">
      <h3>
        {t('vault.recovery')}{' '}
        <span class={vault.recovery ? 'badge ok' : 'badge'}>
          {vault.recovery ? t('security.on') : t('vault.optional')}
        </span>
      </h3>
      <p class="small muted">{t('vault.recoveryHint')}</p>
      {vault.open ? (
        <form method="post" action="/security/vault/recovery-key">
          <Hidden />
          {vault.recovery ? <p class="small muted">{t('vault.recoveryReplaceHint')}</p> : null}
          <button type="submit">
            {vault.recovery ? t('vault.recoveryReplace') : t('vault.recoveryCreate')}
          </button>
        </form>
      ) : vault.recovery ? (
        <form method="post" action="/security/vault/unlock">
          <Hidden />
          <p class="small">{t('vault.lockedOr')}</p>
          <label for="recovery-key">{t('vault.recoveryInput')}</label>
          <input
            id="recovery-key"
            type="text"
            name="recoveryKey"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck={false}
            required
          />
          <div class="actions start">
            <button type="submit">{t('vault.recoveryUse')}</button>
          </div>
        </form>
      ) : (
        <p class="small muted">{t('vault.lockedNoRecovery')}</p>
      )}
    </div>
  </div>
);

/** One recommended protection step: done or not, and where on the page to set it up. */
interface ProtectionStep {
  id: string;
  icon: IconName;
  title: string;
  why: string;
  done: boolean;
}

function protectionSteps(t: Translate, view: SecurityView): ProtectionStep[] {
  const steps: ProtectionStep[] = [
    {
      id: 'totp',
      icon: 'clock',
      title: t('security.step.totp'),
      why: t('security.step.totpWhy'),
      done: view.totp.enabled,
    },
    {
      id: 'passkeys',
      icon: 'key',
      title: t('security.step.passkey'),
      why: t('security.step.passkeyWhy'),
      done: view.passkeys.length > 0,
    },
    {
      id: 'recovery',
      icon: 'hash',
      title: t('security.step.codes'),
      why: t('security.step.codesWhy'),
      done: view.hasFactor && view.recoveryCodes > 0,
    },
  ];
  if (view.vault) {
    steps.push({
      id: 'vault',
      icon: 'lock',
      title: t('security.step.vaultKey'),
      why: t('security.step.vaultKeyWhy'),
      done: view.vault.recovery,
    });
  }
  return steps;
}

/**
 * The top of the page: how well the account is protected, as a checklist that links to each card,
 * plus requests to paste into the AI (it can check these settings, not change them).
 */
const ProtectionCard: FC<{ t: Translate; view: SecurityView }> = ({ t, view }) => {
  const steps = protectionSteps(t, view);
  const done = steps.filter((s) => s.done).length;
  const level = done === steps.length ? 'strong' : view.hasFactor ? 'good' : 'basic';
  /** The one step to do next gets the call to action; the rest stay quiet. */
  const next = steps.find((s) => !s.done)?.id;
  return (
    <div class="card" id="protection">
      <div class="protect-head">
        <div class="grow">
          <h2>
            {t('security.score.title')}: <span class={`level-${level}`}>{t(`security.score.${level}`)}</span>
          </h2>
          <p class="muted">{t(`security.score.lead.${level}`)}</p>
        </div>
        <span class="small muted">{t('security.score.done', { done, total: steps.length })}</span>
      </div>
      <div class="seg-bar" aria-hidden="true">
        {steps.map((s) => (
          <span class={s.done ? 'seg on' : 'seg'} />
        ))}
      </div>
      <ol class="step-list">
        {steps.map((s) => (
          <li>
            <a class={s.done ? 'step-item done' : 'step-item'} href={`#${s.id}`}>
              <span class="step-mark">
                <Icon name={s.done ? 'check' : s.icon} />
              </span>
              {/* A done step is just its name and a tick: the reason only matters while it is to do. */}
              <span class="grow">
                <strong>{s.title}</strong>
                {s.done ? null : <span class="small muted">{s.why}</span>}
              </span>
              {s.done ? (
                <span class="badge ok">{t('security.step.done')}</span>
              ) : s.id === next ? (
                <span class="step-next">
                  {t('security.step.next')} <Icon name="arrow" />
                </span>
              ) : (
                <span class="badge">{t('security.step.todo')}</span>
              )}
            </a>
          </li>
        ))}
      </ol>
      <AskAi
        t={t}
        id="ask-security"
        title={t('security.ask.title')}
        hint={t('security.ask.hint')}
        prompts={[t('security.ask.1'), t('security.ask.2')]}
      />
    </div>
  );
};

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

      {view.flash ? (
        <div class={`notice ${view.flash.kind}`} role="status">
          {view.flash.text}
        </div>
      ) : null}

      <ProtectionCard t={t} view={view} />

      {/* Until the sign-in is confirmed, every control here is visibly off rather than failing on click. */}
      <fieldset class="lock-group" disabled={!view.recent}>
        {view.vault ? <VaultCard t={t} lang={lang} vault={view.vault} Hidden={Hidden} /> : null}

        <div class="card" id="totp">
          <SectionHead
            icon="clock"
            title={t('security.totp')}
            hint={t('security.totpHint')}
            aside={
              <span class={view.totp.enabled ? 'badge ok' : 'badge'}>
                {view.totp.enabled ? t('security.on') : t('security.off')}
              </span>
            }
          />
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
          <SectionHead
            icon="key"
            title={t('security.passkeys')}
            hint={t('security.passkeysHint')}
            aside={
              view.passkeys.length > 0 ? (
                <span class="badge ok">{t('security.on')}</span>
              ) : (
                <span class="badge">{t('security.off')}</span>
              )
            }
          />
          {view.passkeys.length === 0 ? (
            <p class="muted">{t('security.passkeysNone')}</p>
          ) : (
            <div class="acc-list pk-list">
              {view.passkeys.map((p) => (
                <PasskeyRow t={t} lang={lang} p={p} Hidden={Hidden} />
              ))}
            </div>
          )}
          <p class="small muted" data-role="passkey-unsupported">
            {t('security.passkeyUnsupported')}
          </p>
          {/* No name to fill in: the hub names the passkey after where it is kept; rename it later. */}
          <PasskeyForm
            mode="register"
            options="/security/passkeys/options"
            action="/security/passkeys"
            error={t('passkey.failed')}
            hidden={hidden}
          >
            <button class={view.passkeys.length === 0 ? 'primary' : undefined} type="submit">
              <Icon name="plus" /> {t('security.passkeyAdd')}
            </button>
          </PasskeyForm>
        </div>

        <div class="card" id="recovery">
          <SectionHead icon="hash" title={t('security.recovery')} hint={t('security.recoveryHint')} />
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
        <SectionHead icon="eye" title={t('security.more')} />
        <ul class="plain">
          <li>
            <span class="row-icon">
              <Icon name="globe" />
            </span>
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
              <span class="row-icon">
                <Icon name="bell" />
              </span>
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
      </div>
    </Layout>
  );
};

/** A freshly created vault recovery key: shown exactly once. */
export const RecoveryKeyPage: FC<{ t: Translate; lang: string; recoveryKey: string; continueTo: string }> = ({
  t,
  lang,
  recoveryKey,
  continueTo,
}) => (
  <Layout title={t('vault.keyTitle')} narrow lang={lang}>
    <div class="card">
      <h1>{t('vault.keyTitle')}</h1>
      <p class="muted">{t('vault.keyHint')}</p>
      <p>
        <code class="recovery-key">{recoveryKey}</code>
      </p>
      <p>
        <a href={continueTo}>{t('vault.keyDone')} →</a>
      </p>
    </div>
  </Layout>
);

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
