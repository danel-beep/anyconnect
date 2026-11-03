import type { Child, FC } from 'hono/jsx';
import type { Translate } from './i18n.js';

const Layout: FC<{ title: string; narrow?: boolean; lang: string; children?: Child }> = ({
  title,
  narrow,
  lang,
  children,
}) => (
  <html lang={lang}>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="referrer" content="no-referrer" />
      <title>{title}</title>
      <link rel="stylesheet" href="/assets/app.css" />
    </head>
    <body>
      <main class={narrow ? 'narrow' : undefined}>{children}</main>
    </body>
  </html>
);

export const LoginPage: FC<{
  t: Translate;
  lang: string;
  csrf: string;
  next: string;
  email?: string;
  error?: string;
}> = ({ t, lang, csrf, next, email, error }) => (
  <Layout title={t('login.title')} narrow lang={lang}>
    <div class="card">
      <h1>{t('login.title')}</h1>
      <p class="muted">{t('login.subtitle')}</p>
      <form method="post" action="/login">
        <input type="hidden" name="csrf" value={csrf} />
        <input type="hidden" name="next" value={next} />
        <label for="email">{t('login.email')}</label>
        <input id="email" type="email" name="email" autocomplete="username" required value={email ?? ''} />
        <label for="password">{t('login.password')}</label>
        <input id="password" type="password" name="password" autocomplete="current-password" required />
        {error ? <p class="error">{error}</p> : null}
        <div class="actions">
          <button class="primary" type="submit">
            {t('login.submit')}
          </button>
        </div>
      </form>
    </div>
  </Layout>
);

export const ErrorPage: FC<{ t: Translate; lang: string; message: string; detail?: string }> = ({
  t,
  lang,
  message,
  detail,
}) => (
  <Layout title={t('error.title')} narrow lang={lang}>
    <div class="card">
      <h1>{t('error.title')}</h1>
      <p>{message}</p>
      {detail ? <p class="muted small">{detail}</p> : null}
      <p>
        <a href="/">{t('error.back')}</a>
      </p>
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
      <p class="small muted">
        {t('consent.workspace')}: {view.workspaceName} · {t('consent.signedInAs', { email: view.email })}
      </p>
      <form method="post" action="/oauth/authorize">
        <input type="hidden" name="csrf" value={view.csrf} />
        {Object.entries(view.hidden).map(([name, value]) => (
          <input type="hidden" name={name} value={value} />
        ))}
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

export interface HomeView {
  email: string;
  mcpUrl: string;
  csrf: string;
  accounts: {
    connector: string;
    name: string;
    label: string;
    status: string;
    enabled: boolean;
    identity: string | null;
  }[];
  grants: { id: string; name: string; createdAt: Date; lastUsedAt: Date | null }[];
  calls: { toolName: string; status: string; createdAt: Date; durationMs: number }[];
}

const fmt = (date: Date) => date.toISOString().replace('T', ' ').slice(0, 16);

export const HomePage: FC<{ t: Translate; lang: string; view: HomeView }> = ({ t, lang, view }) => (
  <Layout title={t('home.title')} lang={lang}>
    <header class="top">
      <span class="brand">AnyConnect</span>
      <form class="inline" method="post" action="/logout">
        <input type="hidden" name="csrf" value={view.csrf} />
        <span class="small muted">{view.email} · </span>
        <button class="link" type="submit">
          {t('home.signOut')}
        </button>
      </form>
    </header>
    <div class="card">
      <h2>{t('home.mcpUrl')}</h2>
      <input type="text" readonly value={view.mcpUrl} aria-label={t('home.mcpUrl')} />
      <p class="small muted">{t('home.mcpUrlHint')}</p>
      <ul class="bullets small">
        <li>{t('home.howClaude')}</li>
        <li>{t('home.howChatgpt')}</li>
        <li>{t('home.howOther')}</li>
      </ul>
    </div>
    <div class="card">
      <h2>{t('home.accounts')}</h2>
      {view.accounts.length === 0 ? (
        <p class="muted">{t('home.noAccounts')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('home.service')}</th>
              <th>{t('home.account')}</th>
              <th>{t('home.status')}</th>
            </tr>
          </thead>
          <tbody>
            {view.accounts.map((a) => (
              <tr>
                <td>
                  <code>{a.connector}</code>
                </td>
                <td>
                  {a.label} <span class="muted">({a.name})</span>
                  {a.identity ? <div class="small muted">{a.identity}</div> : null}
                </td>
                <td>
                  {a.enabled ? (
                    <span class={`badge ${a.status === 'active' ? 'ok' : 'bad'}`}>{a.status}</span>
                  ) : (
                    <span class="badge">{t('home.disabled')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p class="small muted">{t('home.manageHint')}</p>
    </div>
    <div class="card">
      <h2>{t('home.apps')}</h2>
      {view.grants.length === 0 ? (
        <p class="muted">{t('home.noApps')}</p>
      ) : (
        <ul class="plain">
          {view.grants.map((g) => (
            <li>
              <span>
                <strong>{g.name}</strong>
                <span class="small muted">
                  {' '}
                  · {fmt(g.createdAt)} · {t('home.lastUsed')}:{' '}
                  {g.lastUsedAt ? fmt(g.lastUsedAt) : t('home.never')}
                </span>
              </span>
              <form class="inline" method="post" action={`/grants/${g.id}/revoke`}>
                <input type="hidden" name="csrf" value={view.csrf} />
                <button class="danger" type="submit">
                  {t('home.revoke')}
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
    <div class="card">
      <h2>{t('home.calls')}</h2>
      {view.calls.length === 0 ? (
        <p class="muted">{t('home.noCalls')}</p>
      ) : (
        <table>
          <tbody>
            {view.calls.map((call) => (
              <tr>
                <td class="small muted">{fmt(call.createdAt)}</td>
                <td>
                  <code>{call.toolName}</code>
                </td>
                <td>
                  <span class={`badge ${call.status === 'ok' ? 'ok' : 'bad'}`}>{call.status}</span>
                </td>
                <td class="small muted">{call.durationMs} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  </Layout>
);
