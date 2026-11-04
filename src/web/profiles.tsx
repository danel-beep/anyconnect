import type { FC } from 'hono/jsx';
import type { AccessLevel } from '../db/schema.js';
import { AppShell, ConnectAiCard, Flash, PageHead, type ShellInfo } from './app.js';
import { serviceMeta } from './catalog.js';
import type { Key } from './i18n.js';
import type { PageCtx } from './page-context.js';
import { fmtAgo, fmtDate, Hidden, Icon, ServiceLogo } from './ui.js';

/**
 * "Access profiles" in the dashboard (personas in the code): a separate MCP address that shows an
 * AI app only some accounts, with at most some access. The list with the form for a new profile
 * (`/app/profiles`) and one profile with its address, settings and apps (`/app/profiles/:id`).
 */

/** Forms on a profile's page (revoking an app or a token) come back to it. */
export const PROFILE_BACK = /^\/app\/profiles\/[\w-]{1,64}$/;

/** The most a profile may allow, from least to most ('none' makes no sense for a profile). */
export const PROFILE_ACCESS = ['read', 'write', 'full'] as const satisfies readonly AccessLevel[];

export interface ProfileAccountOption {
  id: string;
  label: string;
  /** "service:name", as the AI names the account. */
  ref: string;
  connectorId: string;
  service: string;
}

export interface ProfileSummary {
  id: string;
  name: string;
  slug: string;
  url: string;
  accounts: number;
  maxAccess: AccessLevel;
  apps: number;
}

export interface ProfileDraft {
  name: string;
  slug: string;
  note: string;
  accountIds: string[];
  maxAccess: AccessLevel;
}

export interface ProfilesView {
  profiles: ProfileSummary[];
  accounts: ProfileAccountOption[];
  /** The form as posted, when creating failed. */
  draft?: ProfileDraft | undefined;
  /** Profiles a workspace can have; the form hides at the limit. */
  max: number;
  flash?: { kind: 'ok' | 'bad'; text: string } | undefined;
}

export interface ProfileView {
  profile: {
    id: string;
    name: string;
    slug: string;
    url: string;
    description: string | null;
    accountIds: string[];
    maxAccess: AccessLevel;
    createdAt: Date;
  };
  accounts: ProfileAccountOption[];
  apps: { id: string; name: string; createdAt: Date; lastUsedAt: Date | null }[];
  tokens: { id: string; name: string; createdAt: Date; lastUsedAt: Date | null; expiresAt: Date | null }[];
  /** Just created: lead with how to connect an app. */
  created: boolean;
  flash?: { kind: 'ok' | 'bad'; text: string } | undefined;
}

const Crumbs: FC<{ ctx: PageCtx; profile?: string }> = ({ ctx, profile }) => (
  <>
    <a href="/app/apps">{ctx.t('app.nav.apps')}</a> /{' '}
    {profile ? <a href="/app/profiles">{ctx.t('profiles.title')}</a> : ctx.t('profiles.title')}
    {profile ? ` / ${profile}` : ''}
  </>
);

/** Account checkboxes, grouped by service. */
const AccountPicker: FC<{ ctx: PageCtx; accounts: ProfileAccountOption[]; checked: string[] }> = ({
  ctx,
  accounts,
  checked,
}) => {
  const { t } = ctx;
  if (!accounts.length) {
    return (
      <div class="notice">
        {t('profiles.noAccounts')}{' '}
        <a href="/app/services">
          <strong>{t('profiles.connectAccount')}</strong>
        </a>
      </div>
    );
  }
  const on = new Set(checked);
  return (
    <fieldset class="pick-fieldset">
      <legend>{t('profiles.accounts')}</legend>
      <p class="hint">{t('profiles.accountsHint')}</p>
      {accounts.map((a, i) => (
        <>
          {a.service !== accounts[i - 1]?.service ? <div class="pick-group">{a.service}</div> : null}
          <label class="pick" for={`acc-${a.id}`}>
            <input id={`acc-${a.id}`} type="checkbox" name={`account.${a.id}`} checked={on.has(a.id)} />
            <ServiceLogo
              icon={serviceMeta(a.connectorId)?.icon}
              glyph={serviceMeta(a.connectorId)?.glyph}
              name={a.service}
              size="sm"
            />
            <span>
              <strong>{a.label}</strong>
              <code class="small muted">{a.ref}</code>
            </span>
          </label>
        </>
      ))}
    </fieldset>
  );
};

const AccessPicker: FC<{ ctx: PageCtx; value: AccessLevel }> = ({ ctx, value }) => {
  const { t } = ctx;
  return (
    <fieldset class="choice-list">
      <legend>{t('profiles.max')}</legend>
      {PROFILE_ACCESS.map((level) => (
        <label class="choice">
          <input type="radio" name="maxAccess" value={level} checked={value === level} />
          <span>
            <strong>{t(`app.rules.access.${level}` as Key)}</strong>
            <span class="small muted">{t(`profiles.max.${level}Hint` as Key)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
};

export const ProfilesPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: ProfilesView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t } = ctx;
  const draft = view.draft;
  const full = view.profiles.length >= view.max;
  return (
    <AppShell ctx={ctx} shell={shell} section="apps" title={t('profiles.title')}>
      <PageHead crumbs={<Crumbs ctx={ctx} />} title={t('profiles.title')} sub={t('profiles.sub')} />
      <Flash flash={view.flash} />
      <div class="card">
        <h2 class="h3">{t('profiles.how')}</h2>
        <p class="muted">{t('profiles.howText')}</p>
        {view.profiles.length ? null : <p class="muted">{t('profiles.none')}</p>}
        <p class="hint">{t('profiles.chat')}</p>
      </div>
      {view.profiles.length ? (
        <div class="card flush">
          <div class="card-head pad">
            <h2>{t('profiles.list')}</h2>
          </div>
          <ul class="plain pad-x">
            {view.profiles.map((p) => (
              <li>
                <span class="grow">
                  <a class="acc-link" href={`/app/profiles/${encodeURIComponent(p.id)}`}>
                    <strong>{p.name}</strong>
                  </a>{' '}
                  <code class="small">/mcp/{p.slug}</code>
                  <div class="small muted">
                    {t('profiles.accountsN', { n: p.accounts })} ·{' '}
                    {t(`app.rules.access.${p.maxAccess}` as Key)} ·{' '}
                    {p.apps ? t('profiles.appsN', { n: p.apps }) : t('profiles.noApps')}
                  </div>
                </span>
                <a class="btn sm" href={`/app/profiles/${encodeURIComponent(p.id)}`}>
                  {t('app.apps.manage')}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {full ? (
        <p class="hint">{t('profiles.flash.limit', { n: view.max })}</p>
      ) : (
        <div class="card" id="new">
          <h2>{t('profiles.new')}</h2>
          <form method="post" action="/app/profiles" class="profile-form">
            <Hidden values={{ csrf: ctx.csrf }} />
            <div class="grid-2 tight">
              <div>
                <label for="p-name">{t('profiles.name')}</label>
                <input
                  id="p-name"
                  type="text"
                  name="name"
                  required
                  maxlength={100}
                  placeholder={t('profiles.namePlaceholder')}
                  value={draft?.name ?? ''}
                  data-slug-target="#p-slug"
                />
              </div>
              <div>
                <label for="p-slug">{t('profiles.address')}</label>
                <div class="prefixed">
                  <span class="prefix">{ctx.mcpUrl.replace(/^https?:\/\//, '')}/</span>
                  <input
                    id="p-slug"
                    type="text"
                    name="slug"
                    maxlength={32}
                    pattern="[a-z0-9][a-z0-9\-]{0,31}"
                    autocomplete="off"
                    spellcheck={false}
                    placeholder="work"
                    value={draft?.slug ?? ''}
                  />
                </div>
              </div>
            </div>
            <p class="hint">{t('profiles.addressHint')}</p>
            <AccountPicker ctx={ctx} accounts={view.accounts} checked={draft?.accountIds ?? []} />
            <AccessPicker ctx={ctx} value={draft?.maxAccess ?? 'full'} />
            <label for="p-note">{t('profiles.note')}</label>
            <input
              id="p-note"
              type="text"
              name="note"
              maxlength={500}
              placeholder={t('profiles.notePlaceholder')}
              value={draft?.note ?? ''}
            />
            <div class="actions start">
              <button type="submit" class="primary" disabled={!view.accounts.length}>
                <Icon name="plus" /> {t('profiles.create')}
              </button>
            </div>
          </form>
        </div>
      )}
    </AppShell>
  );
};

export const ProfilePage: FC<{ ctx: PageCtx; shell: ShellInfo; view: ProfileView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t, lang } = ctx;
  const p = view.profile;
  const base = `/app/profiles/${encodeURIComponent(p.id)}`;
  const known = new Set(view.accounts.map((a) => a.id));
  const accounts = p.accountIds.filter((id) => known.has(id)).length;
  const connected = view.apps.length + view.tokens.length;
  return (
    <AppShell ctx={ctx} shell={shell} section="apps" title={p.name}>
      <PageHead
        crumbs={<Crumbs ctx={ctx} profile={p.name} />}
        title={p.name}
        sub={
          <>
            {t('profiles.accountsN', { n: accounts })} · {t(`app.rules.access.${p.maxAccess}` as Key)} ·{' '}
            {connected ? t('profiles.appsN', { n: connected }) : t('profiles.noApps')}
            {p.description ? ` · ${p.description}` : ''}
          </>
        }
      />
      <Flash flash={view.flash} />
      {view.created ? (
        <div class="notice ok" role="status">
          <strong>{t('profiles.createdTitle')}</strong> {t('profiles.createdText')}
        </div>
      ) : null}
      <ConnectAiCard
        ctx={ctx}
        profile={{
          url: p.url,
          title: t('profiles.connect'),
          hint: t('profiles.connectHint', { name: p.name }),
        }}
      />
      <div class="card flush">
        <div class="card-head pad">
          <h2>{t('profiles.appsTitle')}</h2>
        </div>
        {connected === 0 ? (
          <p class="muted pad-x">{t('profiles.appsNone')}</p>
        ) : (
          <ul class="plain pad-x">
            {view.apps.map((g) => (
              <li>
                <span class="grow">
                  <strong>{g.name}</strong>
                  <div class="small muted">
                    {t('app.apps.since', { date: fmtDate(lang, g.createdAt) })} ·{' '}
                    {g.lastUsedAt ? t('app.apps.used', { ago: fmtAgo(lang, g.lastUsedAt) }) : t('home.never')}
                  </div>
                </span>
                <form
                  method="post"
                  action={`/grants/${g.id}/revoke`}
                  data-confirm={t('app.apps.revokeConfirm', { name: g.name })}
                >
                  <Hidden values={{ csrf: ctx.csrf, back: base }} />
                  <button class="sm danger" type="submit">
                    {t('home.revoke')}
                  </button>
                </form>
              </li>
            ))}
            {view.tokens.map((tok) => (
              <li>
                <span class="grow">
                  <strong>{tok.name}</strong> <span class="badge">{t('profiles.tokenTitle')}</span>
                  <div class="small muted">
                    {t('app.apps.since', { date: fmtDate(lang, tok.createdAt) })} ·{' '}
                    {tok.lastUsedAt
                      ? t('app.apps.used', { ago: fmtAgo(lang, tok.lastUsedAt) })
                      : t('home.never')}
                    {tok.expiresAt
                      ? ` · ${t('app.tokens.expires', { date: fmtDate(lang, tok.expiresAt) })}`
                      : ''}
                  </div>
                </span>
                <form
                  method="post"
                  action={`/app/tokens/${tok.id}/revoke`}
                  data-confirm={t('app.tokens.revokeConfirm', { name: tok.name })}
                >
                  <Hidden values={{ csrf: ctx.csrf, back: base }} />
                  <button class="sm danger" type="submit">
                    {t('home.revoke')}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div class="card">
        <h2>{t('profiles.settings')}</h2>
        <form method="post" action={base} class="profile-form">
          <Hidden values={{ csrf: ctx.csrf }} />
          <div class="grid-2 tight">
            <div>
              <label for="p-name">{t('profiles.name')}</label>
              <input id="p-name" type="text" name="name" required maxlength={100} value={p.name} />
            </div>
            <div>
              <label for="p-note">{t('profiles.note')}</label>
              <input
                id="p-note"
                type="text"
                name="note"
                maxlength={500}
                placeholder={t('profiles.notePlaceholder')}
                value={p.description ?? ''}
              />
            </div>
          </div>
          <AccountPicker ctx={ctx} accounts={view.accounts} checked={p.accountIds} />
          <AccessPicker ctx={ctx} value={p.maxAccess} />
          <p class="hint">
            {t('profiles.address')}: <code>{p.url}</code>. {t('profiles.addressFixed')}
          </p>
          <div class="actions start">
            <button type="submit" class="primary">
              {t('profiles.save')}
            </button>
          </div>
        </form>
      </div>
      <div class="card danger-zone">
        <h2 class="h3">{t('profiles.delete')}</h2>
        <p class="muted">{t('profiles.deleteText')}</p>
        <form
          method="post"
          action={`${base}/delete`}
          data-confirm={t('profiles.deleteConfirm', { name: p.name })}
        >
          <Hidden values={{ csrf: ctx.csrf }} />
          <button type="submit" class="danger">
            <Icon name="trash" /> {t('profiles.delete')}
          </button>
        </form>
      </div>
    </AppShell>
  );
};
