import type { FC } from 'hono/jsx';
import { METRICS, type Metric, PLANS } from '../billing/plans.js';
import { AppShell, Flash, PageHead, type ShellInfo } from './app.js';
import { serviceMeta } from './catalog.js';
import type { Key, Locale, Translate } from './i18n.js';
import type { PageCtx } from './page-context.js';
import { fmtAgo, fmtDate, fmtNumber, Hidden, Icon, initials, Meter, pctClass, ServiceLogo } from './ui.js';

type Flashing = { flash?: { kind: 'ok' | 'bad'; text: string } | undefined };

const planName = (ctx: PageCtx, id: string) => ctx.t(`plan.${id}.name` as 'plan.free.name');

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface AdminOverviewView {
  users: { total: number; new7: number; active7: number; suspended: number; admins: number };
  accounts: number;
  apps: number;
  plans: { planId: string; n: number }[];
  days: { day: string; calls: number; errors: number; signups: number }[];
  calls24h: number;
  calls30d: number;
  errors30d: number;
  byConnector: { connectorId: string; name: string; n: number }[];
  recentUsers: { id: string; email: string; name: string | null; createdAt: Date; planId: string }[];
  /** Open "switch me to this plan" requests (manual payments). */
  planRequests: { userId: string | null; email: string; planId: string; interval: string; at: Date }[];
}

export const AdminOverviewPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: AdminOverviewView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t, lang } = ctx;
  const maxCalls = Math.max(1, ...view.days.map((d) => d.calls));
  const maxSignups = Math.max(1, ...view.days.map((d) => d.signups));
  const maxConn = Math.max(1, ...view.byConnector.map((c) => c.n));
  const errRate = view.calls30d ? Math.round((view.errors30d / view.calls30d) * 1000) / 10 : 0;
  return (
    <AppShell ctx={ctx} shell={shell} section="admin" title={t('admin.nav.overview')}>
      <PageHead title={t('admin.overview.title')} sub={t('admin.overview.sub')} />
      {view.planRequests.length ? (
        <div class="card">
          <h2>
            {t('admin.requests.title')} <span class="badge accent">{view.planRequests.length}</span>
          </h2>
          <p class="hint">{t('admin.requests.hint')}</p>
          <ul class="plain">
            {view.planRequests.map((r) => (
              <li>
                <span class="grow">
                  {r.userId ? <a href={`/admin/users/${r.userId}#plan-card`}>{r.email}</a> : r.email}{' '}
                  <span class="muted">
                    → {planName(ctx, r.planId)} ·{' '}
                    {t(r.interval === 'year' ? 'admin.requests.year' : 'admin.requests.month')} ·{' '}
                    {fmtAgo(lang, r.at)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div class="stats">
        <div class="stat">
          <span class="label">{t('admin.stat.users')}</span>
          <div class="value">{fmtNumber(lang, view.users.total)}</div>
          <div class="sub">{t('admin.stat.new7', { n: view.users.new7 })}</div>
        </div>
        <div class="stat">
          <span class="label">{t('admin.stat.active7')}</span>
          <div class="value">{fmtNumber(lang, view.users.active7)}</div>
          <div class="sub">{t('admin.stat.suspended', { n: view.users.suspended })}</div>
        </div>
        <div class="stat">
          <span class="label">{t('admin.stat.calls')}</span>
          <div class="value">{fmtNumber(lang, view.calls30d)}</div>
          <div class="sub">
            {t('admin.stat.calls24h', { n: fmtNumber(lang, view.calls24h), rate: errRate })}
          </div>
        </div>
        <div class="stat">
          <span class="label">{t('admin.stat.accounts')}</span>
          <div class="value">{fmtNumber(lang, view.accounts)}</div>
          <div class="sub">{t('admin.stat.apps', { n: fmtNumber(lang, view.apps) })}</div>
        </div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head">
            <h2>{t('admin.chart.calls')}</h2>
            <span class="small muted">30 {t('admin.days')}</span>
          </div>
          <div class="chart" role="img" aria-label={t('admin.chart.calls')}>
            {view.days.map((d) => (
              <div class={`col${d.calls === 0 ? ' zero' : ''}`} title={`${d.day}: ${d.calls} / ${d.errors}`}>
                <span class={pctClass('h', d.calls, maxCalls)} />
              </div>
            ))}
          </div>
          <div class="chart-axis">
            <span>{view.days[0]?.day.slice(5)}</span>
            <span>{view.days.at(-1)?.day.slice(5)}</span>
          </div>
        </div>
        <div class="card">
          <div class="card-head">
            <h2>{t('admin.chart.signups')}</h2>
            <span class="small muted">30 {t('admin.days')}</span>
          </div>
          <div class="chart" role="img" aria-label={t('admin.chart.signups')}>
            {view.days.map((d) => (
              <div class={`col${d.signups === 0 ? ' zero' : ''}`} title={`${d.day}: ${d.signups}`}>
                <span class={pctClass('h', d.signups, maxSignups)} />
              </div>
            ))}
          </div>
          <div class="chart-axis">
            <span>{view.days[0]?.day.slice(5)}</span>
            <span>{view.days.at(-1)?.day.slice(5)}</span>
          </div>
        </div>
      </div>
      <div class="grid-3">
        <div class="card">
          <h2>{t('admin.plans')}</h2>
          <div class="top-list">
            {view.plans.map((p) => (
              <div class="bar">
                <span class="name">{planName(ctx, p.planId)}</span>
                <div class="meter">
                  <span class={pctClass('w', p.n, Math.max(1, view.users.total))} />
                </div>
                <span class="num small">{p.n}</span>
              </div>
            ))}
          </div>
        </div>
        <div class="card">
          <h2>{t('admin.connectors')}</h2>
          {view.byConnector.length === 0 ? (
            <p class="muted">—</p>
          ) : (
            <div class="top-list">
              {view.byConnector.map((c) => (
                <div class="bar">
                  <span class="name">{c.name}</span>
                  <div class="meter">
                    <span class={pctClass('w', c.n, maxConn)} />
                  </div>
                  <span class="num small">{c.n}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div class="card">
          <div class="card-head">
            <h2>{t('admin.recentUsers')}</h2>
            <a class="btn sm ghost" href="/admin/users">
              {t('admin.allUsers')}
            </a>
          </div>
          <ul class="plain">
            {view.recentUsers.map((u) => (
              <li>
                <span class="user-cell">
                  <span class="avatar">{initials(u.name ?? u.email)}</span>
                  <a href={`/admin/users/${u.id}`}>{u.email}</a>
                </span>
                <span class="small muted nowrap">{fmtAgo(lang, u.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </AppShell>
  );
};

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface AdminUsersView {
  q: string;
  status: string;
  role: string;
  page: number;
  pages: number;
  total: number;
  items: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    status: string;
    planId: string;
    accounts: number;
    actions: number;
    createdAt: Date;
    lastLoginAt: Date | null;
  }[];
}

export const AdminUsersPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: AdminUsersView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t, lang } = ctx;
  const qs = (page: number) =>
    `/admin/users?${new URLSearchParams({ q: view.q, status: view.status, role: view.role, page: String(page) })}`;
  return (
    <AppShell ctx={ctx} shell={shell} section="admin-users" title={t('admin.nav.users')}>
      <PageHead title={t('admin.nav.users')} sub={t('admin.users.sub', { n: fmtNumber(lang, view.total) })} />
      <form method="get" action="/admin/users" class="filters">
        <label class="sr-only" for="uq">
          {t('admin.users.search')}
        </label>
        <input id="uq" type="search" name="q" value={view.q} placeholder={t('admin.users.search')} />
        <select name="status" aria-label={t('admin.users.status')}>
          <option value="">{t('admin.users.anyStatus')}</option>
          <option value="active" selected={view.status === 'active'}>
            {t('admin.status.active')}
          </option>
          <option value="suspended" selected={view.status === 'suspended'}>
            {t('admin.status.suspended')}
          </option>
        </select>
        <select name="role" aria-label={t('admin.users.role')}>
          <option value="">{t('admin.users.anyRole')}</option>
          <option value="admin" selected={view.role === 'admin'}>
            {t('admin.role.admin')}
          </option>
          <option value="user" selected={view.role === 'user'}>
            {t('admin.role.user')}
          </option>
        </select>
        <button type="submit">
          <Icon name="search" /> {t('admin.users.find')}
        </button>
      </form>
      <div class="card flush">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('admin.users.user')}</th>
                <th>{t('admin.users.plan')}</th>
                <th class="right">{t('admin.users.actions')}</th>
                <th class="right">{t('admin.users.accounts')}</th>
                <th>{t('admin.users.lastLogin')}</th>
                <th>{t('admin.users.created')}</th>
              </tr>
            </thead>
            <tbody>
              {view.items.length === 0 ? (
                <tr>
                  <td colspan={6} class="muted">
                    {t('admin.users.none')}
                  </td>
                </tr>
              ) : (
                view.items.map((u) => (
                  <tr>
                    <td>
                      <span class="user-cell">
                        <span class="avatar">{initials(u.name ?? u.email)}</span>
                        <span>
                          <a href={`/admin/users/${u.id}`}>{u.email}</a>
                          {u.role === 'admin' ? <span class="admin-tag">{t('app.adminTag')}</span> : null}
                          {u.status === 'suspended' ? (
                            <span class="badge bad">{t('admin.status.suspended')}</span>
                          ) : null}
                          {u.name ? <div class="small muted">{u.name}</div> : null}
                        </span>
                      </span>
                    </td>
                    <td>
                      <span class={`badge ${u.planId === 'free' ? '' : 'accent'}`}>
                        {planName(ctx, u.planId)}
                      </span>
                    </td>
                    <td class="right num">{fmtNumber(lang, u.actions)}</td>
                    <td class="right num">{u.accounts}</td>
                    <td class="small muted nowrap">{u.lastLoginAt ? fmtAgo(lang, u.lastLoginAt) : '—'}</td>
                    <td class="small muted nowrap">{fmtDate(lang, u.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div class="pager">
          <span>{t('admin.page', { page: view.page, pages: view.pages })}</span>
          <span class="row">
            {view.page > 1 ? (
              <a class="btn sm" href={qs(view.page - 1)}>
                ← {t('admin.prev')}
              </a>
            ) : null}
            {view.page < view.pages ? (
              <a class="btn sm" href={qs(view.page + 1)}>
                {t('admin.next')} →
              </a>
            ) : null}
          </span>
        </div>
      </div>
    </AppShell>
  );
};

export interface AdminUserView extends Flashing {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    status: string;
    statusReason: string | null;
    createdAt: Date;
    lastLoginAt: Date | null;
    hasPassword: boolean;
  };
  self: boolean;
  identities: { provider: string; email: string | null; lastUsedAt: Date | null }[];
  secondFactor: boolean;
  sessions: number;
  apps: number;
  workspaceId: string | null;
  plan: { id: string; until: Date | null; provider: string | null; note: string | null };
  usage: {
    actions: number;
    actionsLimit: number | null;
    accounts: number;
    accountsLimit: number | null;
    resetsAt: Date;
  } | null;
  limits: Record<Metric, number | null> | null;
  grants: {
    id: string;
    metric: string;
    amount: number | null;
    reason: string | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
    active: boolean;
  }[];
  accounts: { connectorId: string; label: string; name: string; status: string; enabled: boolean }[];
  audit: { action: string; actorEmail: string; details: Record<string, unknown>; createdAt: Date }[];
}

const metricLabel = (ctx: PageCtx, m: string) =>
  (METRICS as readonly string[]).includes(m) ? ctx.t(`pricing.row.${m as Metric}`) : m;

export const AdminUserPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: AdminUserView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t, lang } = ctx;
  const u = view.user;
  const base = `/admin/users/${u.id}`;
  const csrf = { csrf: ctx.csrf };
  const manageable = !view.self && u.role !== 'admin';
  return (
    <AppShell ctx={ctx} shell={shell} section="admin-users" title={u.email}>
      <PageHead
        crumbs={<a href="/admin/users">{t('admin.nav.users')}</a>}
        title={u.email}
        sub={
          <>
            {u.name ? `${u.name} · ` : ''}
            {t('admin.user.since', { date: fmtDate(lang, u.createdAt) })} ·{' '}
            {u.lastLoginAt
              ? t('admin.user.lastLogin', { ago: fmtAgo(lang, u.lastLoginAt) })
              : t('admin.user.neverLogin')}
          </>
        }
        actions={
          <>
            {u.role === 'admin' ? <span class="admin-tag">{t('app.adminTag')}</span> : null}
            <span class={`badge ${u.status === 'active' ? 'ok' : 'bad'}`}>
              {t(`admin.status.${u.status as 'active'}`)}
            </span>
          </>
        }
      />
      <Flash flash={view.flash} />
      {u.status === 'suspended' && u.statusReason ? (
        <div class="notice bad">{t('admin.user.reason', { reason: u.statusReason })}</div>
      ) : null}
      {view.usage ? (
        <div class="stats">
          <div class="stat">
            <span class="label">{t('app.usage.actions')}</span>
            <div class="value">
              {fmtNumber(lang, view.usage.actions)}{' '}
              <span class="muted small">
                / {view.usage.actionsLimit === null ? '∞' : fmtNumber(lang, view.usage.actionsLimit)}
              </span>
            </div>
            <Meter used={view.usage.actions} limit={view.usage.actionsLimit} label={t('app.usage.actions')} />
            <div class="sub">{t('app.usage.resets', { date: fmtDate(lang, view.usage.resetsAt) })}</div>
          </div>
          <div class="stat">
            <span class="label">{t('app.usage.accounts')}</span>
            <div class="value">
              {view.usage.accounts}{' '}
              <span class="muted small">
                / {view.usage.accountsLimit === null ? '∞' : view.usage.accountsLimit}
              </span>
            </div>
            <Meter
              used={view.usage.accounts}
              limit={view.usage.accountsLimit}
              label={t('app.usage.accounts')}
            />
          </div>
          <div class="stat">
            <span class="label">{t('admin.users.plan')}</span>
            <div class="value">{planName(ctx, view.plan.id)}</div>
            <div class="sub">
              {view.plan.until
                ? t('app.billing.until', { date: fmtDate(lang, view.plan.until) })
                : t('admin.user.noEnd')}
            </div>
          </div>
          <div class="stat">
            <span class="label">{t('admin.user.security')}</span>
            <div class="value small-value">
              {view.secondFactor ? t('admin.user.2fa') : t('admin.user.no2fa')}
            </div>
            <div class="sub">{t('admin.user.sessionsApps', { s: view.sessions, a: view.apps })}</div>
          </div>
        </div>
      ) : null}

      <div class="grid-2">
        <div class="card" id="plan-card">
          <h2>{t('admin.user.plan')}</h2>
          <form method="post" action={`${base}/plan`}>
            <Hidden values={csrf} />
            <div class="field-row">
              <div>
                <label for="plan">{t('admin.users.plan')}</label>
                <select id="plan" name="plan">
                  {PLANS.map((p) => (
                    <option value={p.id} selected={p.id === view.plan.id}>
                      {planName(ctx, p.id)}
                      {p.priceMonthly ? ` · $${p.priceMonthly}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="until">{t('admin.user.until')}</label>
                <input id="until" type="date" name="until" />
              </div>
            </div>
            <label for="note">{t('admin.user.note')}</label>
            <input id="note" type="text" name="note" maxlength={200} placeholder={t('admin.user.notePh')} />
            <div class="actions start">
              <button type="submit" class="primary">
                {t('admin.user.setPlan')}
              </button>
            </div>
          </form>
        </div>
        <div class="card">
          <h2>{t('admin.user.grant')}</h2>
          <p class="hint">{t('admin.user.grantHint')}</p>
          <form method="post" action={`${base}/limits`}>
            <Hidden values={csrf} />
            <div class="field-row">
              <div>
                <label for="metric">{t('admin.user.metric')}</label>
                <select id="metric" name="metric">
                  {METRICS.filter((m) => m !== 'historyDays').map((m) => (
                    <option value={m}>{metricLabel(ctx, m)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label for="amount">{t('admin.user.amount')}</label>
                <input
                  id="amount"
                  type="number"
                  name="amount"
                  min={1}
                  max={1000000000}
                  step={1}
                  placeholder="1000"
                />
              </div>
            </div>
            <label class="check">
              <input type="checkbox" name="unlimited" value="1" /> {t('admin.user.unlimited')}
            </label>
            <div class="field-row">
              <div>
                <label for="duration">{t('admin.user.duration')}</label>
                <select id="duration" name="duration">
                  <option value="month">{t('admin.user.dur.month')}</option>
                  <option value="30">{t('admin.user.dur.30')}</option>
                  <option value="90">{t('admin.user.dur.90')}</option>
                  <option value="365">{t('admin.user.dur.365')}</option>
                  <option value="forever">{t('admin.user.dur.forever')}</option>
                </select>
              </div>
              <div>
                <label for="reason">{t('admin.user.reasonLabel')}</label>
                <input
                  id="reason"
                  type="text"
                  name="reason"
                  maxlength={200}
                  placeholder={t('admin.user.reasonPh')}
                />
              </div>
            </div>
            <div class="actions start">
              <button type="submit" class="primary">
                <Icon name="plus" /> {t('admin.user.grantCta')}
              </button>
            </div>
          </form>
        </div>
      </div>

      <div class="card flush">
        <div class="card-head pad">
          <h2>{t('admin.user.grants')}</h2>
        </div>
        {view.grants.length === 0 ? (
          <p class="muted pad-x">{t('admin.user.noGrants')}</p>
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('admin.user.metric')}</th>
                  <th>{t('admin.user.amountCol')}</th>
                  <th>{t('admin.user.untilCol')}</th>
                  <th>{t('admin.user.reasonLabel')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {view.grants.map((g) => (
                  <tr>
                    <td>{metricLabel(ctx, g.metric)}</td>
                    <td class="num">
                      {g.amount === null ? t('pricing.unlimited') : `+${fmtNumber(lang, g.amount)}`}
                    </td>
                    <td class="small">
                      {g.expiresAt ? fmtDate(lang, g.expiresAt) : t('app.billing.forever')}
                    </td>
                    <td class="small muted">{g.reason ?? '—'}</td>
                    <td class="right">
                      {g.active ? (
                        <form
                          method="post"
                          action={`${base}/limits/${g.id}/revoke`}
                          data-confirm={t('admin.user.revokeConfirm')}
                        >
                          <Hidden values={csrf} />
                          <button type="submit" class="sm danger">
                            {t('admin.user.cancelGrant')}
                          </button>
                        </form>
                      ) : (
                        <span class="badge">
                          {g.revokedAt ? t('admin.user.revoked') : t('admin.user.expired')}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div class="grid-2">
        <div class="card flush">
          <div class="card-head pad">
            <h2>{t('app.services.connected')}</h2>
          </div>
          {view.accounts.length === 0 ? (
            <p class="muted pad-x">{t('admin.user.noAccounts')}</p>
          ) : (
            <div class="acc-list">
              {view.accounts.map((a) => {
                const meta = serviceMeta(a.connectorId);
                return (
                  <div class="acc">
                    <ServiceLogo icon={meta?.icon} glyph={meta?.glyph} name={a.connectorId} size="sm" />
                    <div class="grow">
                      <div class="title">{a.label}</div>
                      <div class="sub">
                        <code>{`${a.connectorId}:${a.name}`}</code>
                      </div>
                    </div>
                    <span class={`badge ${a.enabled && a.status === 'active' ? 'ok' : ''}`}>
                      {a.enabled ? a.status : t('app.acc.off')}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <p class="hint pad-x">{t('admin.user.noSecrets')}</p>
        </div>
        <div class="card">
          <h2>{t('admin.user.signin')}</h2>
          <ul class="plain">
            {view.identities.map((i) => (
              <li>
                <span>{i.provider === 'google' ? 'Google' : i.provider}</span>
                <span class="small muted">{i.email}</span>
              </li>
            ))}
            {u.hasPassword ? (
              <li>
                <span>{t('app.settings.password')}</span>
                <span class="small muted">{t('security.on')}</span>
              </li>
            ) : null}
          </ul>
          <h3 class="mt">{t('admin.user.history')}</h3>
          {view.audit.length === 0 ? (
            <p class="muted small">—</p>
          ) : (
            <ul class="plain small">
              {view.audit.map((a) => (
                <li>
                  <span>
                    <code>{a.action}</code> <span class="muted">{a.actorEmail}</span>
                  </span>
                  <span class="muted nowrap">{fmtAgo(lang, a.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {manageable ? (
        <div class="card danger-zone">
          <h2>{t('admin.user.danger')}</h2>
          <div class="grid-3">
            <form method="post" action={`${base}/sign-out`} data-confirm={t('admin.user.signOutConfirm')}>
              <Hidden values={csrf} />
              <h3>{t('admin.user.signOut')}</h3>
              <p class="small muted">{t('admin.user.signOutText')}</p>
              <button type="submit">{t('admin.user.signOut')}</button>
            </form>
            {u.status === 'active' ? (
              <form method="post" action={`${base}/suspend`} data-confirm={t('admin.user.suspendConfirm')}>
                <Hidden values={csrf} />
                <h3>{t('admin.user.suspend')}</h3>
                <label for="sreason" class="small">
                  {t('admin.user.reasonLabel')}
                </label>
                <input id="sreason" type="text" name="reason" maxlength={200} />
                <div class="actions start">
                  <button type="submit" class="danger">
                    {t('admin.user.suspend')}
                  </button>
                </div>
              </form>
            ) : (
              <form method="post" action={`${base}/reactivate`}>
                <Hidden values={csrf} />
                <h3>{t('admin.user.reactivate')}</h3>
                <p class="small muted">{t('admin.user.reactivateText')}</p>
                <button type="submit" class="primary">
                  {t('admin.user.reactivate')}
                </button>
              </form>
            )}
            <form method="post" action={`${base}/delete`} data-confirm={t('admin.user.deleteConfirm')}>
              <Hidden values={csrf} />
              <h3>{t('admin.user.delete')}</h3>
              <label for="demail" class="small">
                {t('app.settings.deleteType', { email: u.email })}
              </label>
              <input id="demail" type="email" name="email" required autocomplete="off" />
              <div class="actions start">
                <button type="submit" class="danger">
                  {t('admin.user.delete')}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : (
        <p class="hint">{view.self ? t('admin.user.selfNote') : t('admin.user.adminNote')}</p>
      )}
    </AppShell>
  );
};

// ---------------------------------------------------------------------------
// Audit log and system
// ---------------------------------------------------------------------------

export interface AdminAuditView {
  page: number;
  pages: number;
  rows: {
    action: string;
    actorEmail: string;
    targetUserId: string | null;
    targetEmail: string | null;
    details: Record<string, unknown>;
    ip: string | null;
    createdAt: Date;
  }[];
}

const AUDIT_ACTIONS: Record<string, Key> = {
  'plan.set': 'admin.action.plan.set',
  'limit.grant': 'admin.action.limit.grant',
  'limit.revoke': 'admin.action.limit.revoke',
  'user.suspend': 'admin.action.user.suspend',
  'user.reactivate': 'admin.action.user.reactivate',
  'user.sign_out': 'admin.action.user.sign_out',
  'user.delete': 'admin.action.user.delete',
};

/** One readable line for an admin log entry ("Free → Personal until Dec 31, 2026"). */
function auditDetails(t: Translate, lang: Locale, action: string, d: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const date = (v: unknown) => (typeof v === 'string' && v ? fmtDate(lang, new Date(v)) : '');
  const plan = (v: unknown) => {
    const id = str(v);
    return PLANS.some((p) => p.id === id) ? t(`plan.${id}.name` as 'plan.free.name') : id;
  };
  const metric = (v: unknown) => {
    const m = str(v);
    return (METRICS as readonly string[]).includes(m) ? t(`pricing.row.${m}` as 'pricing.row.actions') : m;
  };
  const parts: string[] = [];
  switch (action) {
    case 'plan.set':
      parts.push(`${plan(d.from)} → ${plan(d.to)}`);
      if (d.until) parts.push(t('admin.audit.until', { date: date(d.until) }));
      break;
    case 'limit.grant':
      parts.push(
        `${metric(d.metric)}: ${d.amount === null ? t('admin.audit.unlimited') : `+${String(d.amount)}`}`,
      );
      if (d.until) parts.push(t('admin.audit.until', { date: date(d.until) }));
      break;
    case 'limit.revoke':
      parts.push(metric(d.metric));
      break;
    case 'user.sign_out':
      parts.push(
        t('admin.audit.signedOut', {
          sessions: String(d.sessions ?? 0),
          apps: String(d.apps ?? 0),
          tokens: String(d.tokens ?? 0),
        }),
      );
      break;
  }
  const note = str(d.note) || str(d.reason);
  if (note) parts.push(`«${note}»`);
  return parts.join(' · ');
}

export const AdminAuditPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: AdminAuditView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t, lang } = ctx;
  return (
    <AppShell ctx={ctx} shell={shell} section="admin-audit" title={t('admin.nav.audit')}>
      <PageHead title={t('admin.nav.audit')} sub={t('admin.audit.sub')} />
      <div class="card flush">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('admin.audit.when')}</th>
                <th>{t('admin.audit.who')}</th>
                <th>{t('admin.audit.what')}</th>
                <th>{t('admin.audit.target')}</th>
                <th>{t('admin.audit.details')}</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.length === 0 ? (
                <tr>
                  <td colspan={5} class="muted">
                    {t('admin.audit.none')}
                  </td>
                </tr>
              ) : (
                view.rows.map((r) => (
                  <tr>
                    <td class="small nowrap" title={r.createdAt.toISOString()}>
                      {fmtDate(lang, r.createdAt, true)}
                    </td>
                    <td class="small">
                      {r.actorEmail}
                      {r.ip ? <div class="muted tiny">{r.ip}</div> : null}
                    </td>
                    <td>{AUDIT_ACTIONS[r.action] ? t(AUDIT_ACTIONS[r.action]!) : r.action}</td>
                    <td class="small">
                      {r.targetUserId && r.action !== 'user.delete' ? (
                        <a href={`/admin/users/${r.targetUserId}`}>{r.targetEmail ?? r.targetUserId}</a>
                      ) : (
                        (r.targetEmail ?? '—')
                      )}
                    </td>
                    <td class="small muted">{auditDetails(t, lang, r.action, r.details)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div class="pager">
          <span>{t('admin.page', { page: view.page, pages: view.pages })}</span>
          <span class="row">
            {view.page > 1 ? (
              <a class="btn sm" href={`/admin/audit?page=${view.page - 1}`}>
                ← {t('admin.prev')}
              </a>
            ) : null}
            {view.page < view.pages ? (
              <a class="btn sm" href={`/admin/audit?page=${view.page + 1}`}>
                {t('admin.next')} →
              </a>
            ) : null}
          </span>
        </div>
      </div>
    </AppShell>
  );
};

export interface AdminSystemView {
  version: string;
  env: string;
  publicUrl: string;
  database: boolean;
  checks: { label: string; ok: boolean; detail: string }[];
}

export const AdminSystemPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: AdminSystemView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t } = ctx;
  return (
    <AppShell ctx={ctx} shell={shell} section="admin-system" title={t('admin.nav.system')}>
      <PageHead title={t('admin.nav.system')} sub={t('admin.system.sub')} />
      <div class="stats">
        <div class="stat">
          <span class="label">{t('admin.system.version')}</span>
          <div class="value">{view.version}</div>
          <div class="sub">{view.env}</div>
        </div>
        <div class="stat">
          <span class="label">{t('admin.system.db')}</span>
          <div class="value">{view.database ? 'OK' : '—'}</div>
          <div class="sub">PostgreSQL</div>
        </div>
      </div>
      <div class="card flush">
        <div class="card-head pad">
          <h2>{t('admin.system.config')}</h2>
        </div>
        <ul class="plain pad-x">
          {view.checks.map((c) => (
            <li>
              <span class="row">
                <span class={`dot ${c.ok ? 'ok' : 'bad'}`} />
                <strong>{c.label}</strong>
              </span>
              <span class="small muted">{c.detail}</span>
            </li>
          ))}
        </ul>
        <p class="hint pad-x">{t('admin.system.hint')}</p>
      </div>
    </AppShell>
  );
};
