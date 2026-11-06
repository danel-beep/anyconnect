import type { FC } from 'hono/jsx';
import type { AccessLevel, ConfirmLevel } from '../db/schema.js';
import { AppShell, CallsTable, type CallView, Flash, PageHead, type ShellInfo } from './app.js';
import type { Key } from './i18n.js';
import type { PageCtx } from './page-context.js';
import { fmtAgo, fmtDate, Hidden, Icon } from './ui.js';

/**
 * One AI app (`/app/apps/:id`): how it connects now (each sign-in and token, through which
 * profile), what it may do, its name, its recent actions, and disconnecting it.
 */

export interface AiAppPageView {
  app: {
    id: string;
    name: string;
    kind: 'oauth' | 'api_token' | 'automation';
    createdAt: Date;
    lastUsedAt: Date | null;
  };
  connections: {
    id: string;
    kind: 'oauth' | 'token';
    name: string;
    profile: { id: string; name: string } | null;
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
  }[];
  /** The app's own rule (null: the default applies). */
  rule: { access: AccessLevel | null; confirm: ConfirmLevel | null };
  defaults: { access: AccessLevel; confirm: ConfirmLevel };
  calls: CallView[];
  flash?: { kind: 'ok' | 'bad'; text: string } | undefined;
}

const ACCESSES: AccessLevel[] = ['full', 'write', 'read', 'none'];
const CONFIRMS: ConfirmLevel[] = ['never', 'dangerous', 'write', 'always'];

export const AiAppPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: AiAppPageView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t, lang } = ctx;
  const a = view.app;
  const base = `/app/apps/${encodeURIComponent(a.id)}`;
  const connected = view.connections.length > 0;
  return (
    <AppShell ctx={ctx} shell={shell} section="apps" title={a.name}>
      <PageHead
        crumbs={
          <>
            <a href="/app/apps">{t('app.nav.apps')}</a> / {a.name}
          </>
        }
        title={a.name}
        sub={
          <>
            {t(`aiapp.kind.${a.kind}` as Key)} · {t('aiapp.firstSeen', { date: fmtDate(lang, a.createdAt) })}{' '}
            · {a.lastUsedAt ? t('app.apps.used', { ago: fmtAgo(lang, a.lastUsedAt) }) : t('aiapp.neverUsed')}
          </>
        }
      />
      <Flash flash={view.flash} />
      <div class="account-grid">
        <div class="account-side">
          <div class="card flush">
            <div class="card-head pad">
              <div>
                <h2>{t('aiapp.connections')}</h2>
                <p class="small muted">{t('aiapp.connectionsSub')}</p>
              </div>
            </div>
            {connected ? (
              <ul class="plain pad-x">
                {view.connections.map((c) => (
                  <li>
                    <span class="grow">
                      <strong>{c.name}</strong>{' '}
                      <span class="badge">{t(c.kind === 'oauth' ? 'aiapp.signIn' : 'aiapp.token')}</span>{' '}
                      {c.profile ? (
                        <a class="badge accent" href={`/app/profiles/${encodeURIComponent(c.profile.id)}`}>
                          {t('profiles.badge', { name: c.profile.name })}
                        </a>
                      ) : (
                        <span class="badge">{t('aiapp.main')}</span>
                      )}
                      <div class="small muted">
                        {t('app.apps.since', { date: fmtDate(lang, c.createdAt) })} ·{' '}
                        {c.lastUsedAt
                          ? t('app.apps.used', { ago: fmtAgo(lang, c.lastUsedAt) })
                          : t('home.never')}
                        {c.expiresAt
                          ? ` · ${t('app.tokens.expires', { date: fmtDate(lang, c.expiresAt) })}`
                          : ''}
                      </div>
                    </span>
                    <form
                      method="post"
                      action={c.kind === 'oauth' ? `/grants/${c.id}/revoke` : `/app/tokens/${c.id}/revoke`}
                      data-confirm={
                        c.kind === 'oauth'
                          ? t('app.apps.revokeConfirm', { name: c.name })
                          : t('app.tokens.revokeConfirm', { name: c.name })
                      }
                    >
                      <Hidden values={{ csrf: ctx.csrf, back: base }} />
                      <button class="sm danger" type="submit">
                        {t('home.revoke')}
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="muted pad-x">{t('aiapp.notConnected')}</p>
            )}
          </div>
          <div class="card flush">
            <div class="card-head pad">
              <h2>{t('aiapp.calls')}</h2>
            </div>
            <CallsTable ctx={ctx} calls={view.calls} empty={t('aiapp.noCalls')} />
          </div>
        </div>
        <div class="account-side">
          <div class="card">
            <h2>{t('aiapp.rules')}</h2>
            <p class="small muted">{t('aiapp.rulesSub')}</p>
            <form method="post" action="/app/rules/scoped">
              <Hidden values={{ csrf: ctx.csrf, back: base, kind: 'app', id: a.id }} />
              <label for="app-access">{t('app.rules.access')}</label>
              <select id="app-access" name="access">
                <option value="" selected={view.rule.access === null}>
                  {t('app.rules.inheritAs', { value: t(`app.rules.access.${view.defaults.access}` as Key) })}
                </option>
                {ACCESSES.map((x) => (
                  <option value={x} selected={view.rule.access === x}>
                    {t(`app.rules.access.${x}` as Key)}
                  </option>
                ))}
              </select>
              <label for="app-confirm">{t('app.rules.confirm')}</label>
              <select id="app-confirm" name="confirm">
                <option value="" selected={view.rule.confirm === null}>
                  {t('app.rules.inheritAs', {
                    value: t(`app.rules.confirmShort.${view.defaults.confirm}` as Key),
                  })}
                </option>
                {CONFIRMS.map((x) => (
                  <option value={x} selected={view.rule.confirm === x}>
                    {t(`app.rules.confirmShort.${x}` as Key)}
                  </option>
                ))}
              </select>
              <div class="actions start">
                <button type="submit">{t('app.rules.save')}</button>
                <a class="btn ghost" href="/app/rules">
                  {t('aiapp.allRules')}
                </a>
              </div>
            </form>
          </div>
          <div class="card">
            <h2>{t('aiapp.name')}</h2>
            <form method="post" action={`${base}/rename`} class="copy">
              <Hidden values={{ csrf: ctx.csrf }} />
              <label class="sr-only" for="app-name">
                {t('aiapp.name')}
              </label>
              <input id="app-name" type="text" name="name" value={a.name} maxlength={100} required />
              <button type="submit">{t('aiapp.rename')}</button>
            </form>
            <p class="hint">{t('aiapp.nameHint')}</p>
          </div>
          <p class="hint">{t('aiapp.chat')}</p>
        </div>
      </div>
      <div class="card danger-zone">
        {connected ? (
          <>
            <h2>{t('aiapp.disconnect')}</h2>
            <p class="muted">{t('aiapp.disconnectText')}</p>
            <form
              method="post"
              action={`${base}/disconnect`}
              data-confirm={t('aiapp.disconnectConfirm', { name: a.name })}
            >
              <Hidden values={{ csrf: ctx.csrf }} />
              <button type="submit" class="danger">
                <Icon name="x" /> {t('aiapp.disconnect')}
              </button>
            </form>
          </>
        ) : (
          <>
            <h2>{t('aiapp.forget')}</h2>
            <p class="muted">{t('aiapp.forgetText')}</p>
            <form
              method="post"
              action={`${base}/forget`}
              data-confirm={t('aiapp.forgetConfirm', { name: a.name })}
            >
              <Hidden values={{ csrf: ctx.csrf }} />
              <button type="submit" class="danger">
                <Icon name="trash" /> {t('aiapp.forget')}
              </button>
            </form>
          </>
        )}
      </div>
    </AppShell>
  );
};
