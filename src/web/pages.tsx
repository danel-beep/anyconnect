import type { Child, FC } from 'hono/jsx';
import { useContext } from 'hono/jsx';
import { Doc } from './document.js';
import { PageFrame } from './frame.js';
import { type Translate, translator } from './i18n.js';
import { Brand, GoogleG, Icon, Prefs } from './ui.js';

/**
 * Shell of the hub's own pages (sign-in, consent, connect forms, confirmations). Inside the
 * dashboard a route can supply a frame (`PageFrame`), and the same page renders inside the
 * dashboard's sidebar layout instead of the centered card layout.
 */
export const Layout: FC<{
  title: string;
  /** Narrow centered card (sign-in, consent). Otherwise a wider column. */
  narrow?: boolean;
  lang: string;
  /** Adds /assets/webauthn.js (passkeys); pages work without it. */
  script?: boolean;
  children?: Child;
}> = ({ title, narrow, lang, script, children }) => {
  const frame = useContext(PageFrame);
  if (frame) return <>{frame({ title, passkeys: Boolean(script), children })}</>;
  const t = translator(lang === 'ru' ? 'ru' : 'en');
  return (
    <Doc title={`${title} · AnyConnect`} lang={lang} noindex passkeys={script} bodyClass="auth">
      <div class="auth-top">
        <Brand />
        <Prefs t={t} lang={lang} />
      </div>
      <main id="main" class={narrow ? undefined : 'wide'}>
        {children}
      </main>
      <footer class="auth-foot">
        <a href="/privacy">{t('site.footer.privacy')}</a> · <a href="/terms">{t('site.footer.terms')}</a>
      </footer>
    </Doc>
  );
};

/**
 * A passkey ceremony button, revealed by /assets/webauthn.js when the browser supports passkeys
 * (see `webauthn-client.ts` for the contract). Hidden fields are sent along as JSON.
 */
export const PasskeyForm: FC<{
  mode: 'register' | 'authenticate';
  options: string;
  action: string;
  error: string;
  hidden: Record<string, string>;
  /** Rendered below the error line, e.g. an "or" divider before the next sign-in option. */
  after?: Child;
  children?: Child;
}> = ({ mode, options, action, error, hidden, after, children }) => (
  <form method="post" action={action} data-passkey={mode} data-options={options} data-error={error} hidden>
    {Object.entries(hidden).map(([name, value]) => (
      <input type="hidden" name={name} value={value} />
    ))}
    {children}
    <p class="error" data-role="passkey-error" hidden />
    {after}
  </form>
);

export type LoginMode = 'login' | 'signup' | 'reauth';

export const LoginPage: FC<{
  t: Translate;
  lang: string;
  csrf: string;
  next: string;
  /** login, signup (same Google button, other wording) or reauth (confirm a session again). */
  mode?: LoginMode;
  /** "Continue with Google" is configured. */
  google?: boolean;
  signupsOpen?: boolean;
  email?: string;
  error?: string;
  /** Show the email + password form open (after a password error, or when Google is off). */
  passwordOpen?: boolean;
  /** Opened by an AI app's OAuth request: say why the user is here. */
  fromApp?: boolean;
  /** Back-compat with callers that only know about re-authentication. */
  reauth?: boolean;
}> = ({
  t,
  lang,
  csrf,
  next,
  mode: modeProp,
  google,
  signupsOpen,
  email,
  error,
  passwordOpen,
  fromApp,
  reauth,
}) => {
  const mode: LoginMode = modeProp ?? (reauth ? 'reauth' : 'login');
  const title =
    mode === 'reauth' ? t('login.reauthTitle') : mode === 'signup' ? t('signup.title') : t('login.title');
  const subtitle =
    mode === 'reauth'
      ? t('login.reauthSubtitle')
      : mode === 'signup'
        ? t('signup.subtitle')
        : t('login.subtitle');
  const googleHref = `/auth/google?next=${encodeURIComponent(next)}${mode === 'reauth' ? '&reauth=1' : ''}`;
  const showPassword = passwordOpen || !google || Boolean(error && !google);
  // With sign-ups closed the sign-up page only says so; existing users sign in on /login.
  const signupClosed = mode === 'signup' && !signupsOpen;
  const passwordForm = (
    <form method="post" action="/login">
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="next" value={next} />
      {mode === 'reauth' ? <input type="hidden" name="reauth" value="1" /> : null}
      <label for="email">{t('login.email')}</label>
      <input id="email" type="email" name="email" autocomplete="username" required value={email ?? ''} />
      <label for="password">{t('login.password')}</label>
      <input id="password" type="password" name="password" autocomplete="current-password" required />
      <div class="actions">
        <button class={google ? 'block' : 'primary block'} type="submit">
          {t('login.submit')}
        </button>
      </div>
    </form>
  );
  return (
    <Layout title={title} narrow lang={lang} script>
      <div class="card">
        <h1>{title}</h1>
        {signupClosed ? null : <p class="muted">{subtitle}</p>}
        {fromApp && mode !== 'reauth' ? (
          <div class="notice info small">
            <Icon name="zap" /> {t('login.fromApp')}
          </div>
        ) : null}
        {error ? (
          <p class="error" role="alert">
            {error}
          </p>
        ) : null}
        {google && !signupClosed ? (
          <>
            <a class="btn block btn-google" href={googleHref}>
              <GoogleG /> {t('login.google')}
            </a>
            {mode === 'signup' ? (
              <p class="small muted center">
                {t('signup.termsA')} <a href="/terms">{t('signup.termsLink')}</a> {t('signup.and')}{' '}
                <a href="/privacy">{t('signup.privacyLink')}</a>.
              </p>
            ) : null}
          </>
        ) : null}
        {signupClosed ? <div class="notice small">{t('signup.closed')}</div> : null}
        {mode === 'signup' && !signupClosed && !google ? (
          <div class="notice small">{t('signup.noGoogle')}</div>
        ) : null}
        {mode !== 'signup' ? (
          <>
            {google ? (
              <details class="more-ways" open={showPassword}>
                <summary>{t('login.withEmail')}</summary>
                {passwordForm}
              </details>
            ) : (
              passwordForm
            )}
            <PasskeyForm
              mode="authenticate"
              options="/login/passkey/options"
              action="/login/passkey"
              error={t('passkey.failed')}
              hidden={{ csrf, next, flow: 'passwordless' }}
            >
              <div class="actions">
                <button class="block ghost" type="submit">
                  <Icon name="key" /> {t('login.passkey')}
                </button>
              </div>
            </PasskeyForm>
          </>
        ) : null}
      </div>
      {mode === 'login' && google && signupsOpen ? (
        <p class="center small muted switch-auth">
          {t('login.noAccount')}{' '}
          <a href={`/signup?next=${encodeURIComponent(next)}`}>{t('login.signupLink')}</a>
        </p>
      ) : null}
      {mode === 'signup' ? (
        <p class="center small muted switch-auth">
          {t('signup.haveAccount')}{' '}
          <a href={`/login?next=${encodeURIComponent(next)}`}>{t('signup.signInLink')}</a>
        </p>
      ) : null}
    </Layout>
  );
};

export const ErrorPage: FC<{
  t: Translate;
  lang: string;
  message: string;
  detail?: string;
  title?: string;
  /** Where the main button leads (default: home). */
  back?: { href: string; label: string };
}> = ({ t, lang, message, detail, title, back }) => (
  <Layout title={title ?? t('error.title')} narrow lang={lang}>
    <div class="card">
      <h1>{title ?? t('error.title')}</h1>
      <p>{message}</p>
      {detail ? <p class="muted small">{detail}</p> : null}
      <div class="actions start">
        <a class="btn primary" href={back?.href ?? '/'}>
          {back?.label ?? t('error.back')}
        </a>
      </div>
    </div>
  </Layout>
);

export interface ConsentView {
  clientName: string;
  /** Host that proves the client identity (Client ID Metadata Document), if any. */
  verifiedDomain?: string;
  redirectHost: string;
  knownApp?: string;
  loopback: boolean;
  workspaceName: string;
  activeAccounts: number;
  /** Set when the app connects to a persona's MCP URL. */
  persona?: { name: string; slug: string };
  /** Which AI client entity the app will be linked to (policies apply to it). */
  clientChoice: { selected: string; options: { value: string; label: string }[] };
  email: string;
  csrf: string;
  hidden: Record<string, string>;
}

export const ConsentPage: FC<{ t: Translate; lang: string; view: ConsentView }> = ({ t, lang, view }) => (
  <Layout title={t('consent.title', { client: view.clientName })} narrow lang={lang}>
    <div class="card">
      <h1>{t('consent.title', { client: view.clientName })}</h1>
      <p>{t('consent.wants', { client: view.clientName })}</p>
      <p class="small muted">
        {view.verifiedDomain ? (
          <>
            {t('consent.verifiedDomain')}: <strong>{view.verifiedDomain}</strong>
          </>
        ) : (
          t('consent.selfDeclared')
        )}
      </p>
      <p class="small">
        {t('consent.redirect')} <strong>{view.redirectHost}</strong>{' '}
        {view.knownApp ? <span class="badge ok">{t('consent.known')}</span> : null}
      </p>
      {view.loopback ? <div class="warning small">{t('consent.loopback')}</div> : null}
      {!view.loopback && !view.knownApp ? <div class="warning small">{t('consent.unknown')}</div> : null}
      <p>
        <strong>{t('consent.access')}</strong>
      </p>
      <ul class="bullets">
        <li>{t('consent.access.mcp', { count: view.activeAccounts })}</li>
        <li>{t('consent.access.offline')}</li>
      </ul>
      {view.persona ? (
        <p class="small">
          {t('consent.persona')}: <strong>{view.persona.name}</strong> ({view.persona.slug}) ·{' '}
          {t('consent.personaHint')}
        </p>
      ) : null}
      <p class="small muted">
        {t('consent.workspace')}: {view.workspaceName} · {t('consent.signedInAs', { email: view.email })}
      </p>
      <form method="post" action="/oauth/authorize">
        <input type="hidden" name="csrf" value={view.csrf} />
        {Object.entries(view.hidden).map(([name, value]) => (
          <input type="hidden" name={name} value={value} />
        ))}
        <label for="ai_client">{t('consent.clientAs')}</label>
        <select id="ai_client" name="ai_client">
          {view.clientChoice.options.map((option) => (
            <option value={option.value} selected={option.value === view.clientChoice.selected}>
              {option.label}
            </option>
          ))}
        </select>
        <p class="small muted">{t('consent.clientHint')}</p>
        <div class="actions">
          <button type="submit" name="decision" value="deny">
            {t('consent.deny')}
          </button>
          <button class="primary" type="submit" name="decision" value="approve">
            {t('consent.approve')}
          </button>
        </div>
      </form>
      <p class="small muted">{t('consent.revokeHint')}</p>
    </div>
  </Layout>
);

export const fmt = (date: Date) => date.toISOString().replace('T', ' ').slice(0, 16);

export interface ConnectedView {
  service: string;
  label: string;
  created: boolean;
  identity?: string | undefined;
  /** Set when the connection test failed. */
  problem?: string | undefined;
  returnTo: string;
}

export const ConnectedPage: FC<{ t: Translate; lang: string; view: ConnectedView }> = ({ t, lang, view }) => (
  <Layout title={t('connect.doneTitle')} narrow lang={lang}>
    <div class="card">
      <div class={`result-icon ${view.problem ? 'warn' : 'ok'}`}>
        <Icon name={view.problem ? 'alert' : 'check'} />
      </div>
      <h1>{t('connect.doneTitle')}</h1>
      <p>
        {t(view.created ? 'connect.created' : 'connect.reconnected', {
          service: view.service,
          label: view.label,
        })}
      </p>
      {view.identity ? <p class="muted">{t('connect.identity', { identity: view.identity })}</p> : null}
      {view.problem ? <div class="notice">{t('connect.testFailed', { message: view.problem })}</div> : null}
      <p class="muted small">{t('connect.aiHint')}</p>
      <div class="actions start">
        <a class="btn primary" href={view.returnTo}>
          {t('connect.continue')}
        </a>
        <a class="btn ghost" href="/app/services">
          {t('connect.addMore')}
        </a>
      </div>
    </div>
  </Layout>
);
