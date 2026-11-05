import type { FC } from 'hono/jsx';
import { METRICS, type Metric, PLANS } from '../billing/plans.js';
import { AccountStatus, AppShell, Flash, PageHead, type ShellInfo } from './app.js';
import { serviceMeta } from './catalog.js';
import type { Key, Locale, Translate } from './i18n.js';
import type { PageCtx } from './page-context.js';
import {
  CopyField,
  fmtAgo,
  fmtDate,
  fmtDay,
  fmtNumber,
  Hidden,
  Icon,
  initials,
  pctClass,
  ServiceLogo,
  UsageStat,
} from './ui.js';

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
  /** Connected accounts across the hub that stopped working, and setup gaps on the System page. */
  failingAccounts: number;
  warnings: number;
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
      {view.warnings || view.failingAccounts ? (
        <div class="notice warn attention" role="status">
          <strong>{t('admin.attention.title')}</strong>
          <ul>
            {view.warnings ? (
              <li>
                <span class="grow">{t('admin.attention.warnings', { n: view.warnings })}</span>
                <a class="btn sm" href="/admin/system">
                  {t('admin.attention.open')}
                </a>
              </li>
            ) : null}
            {view.failingAccounts ? (
              <li>
                <span class="grow">{t('admin.attention.failing', { n: view.failingAccounts })}</span>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
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
                {r.userId ? (
                  <a class="btn sm primary" href={`/admin/users/${r.userId}#plan-card`}>
                    {t('admin.requests.review')}
                  </a>
                ) : null}
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
            {view.calls30d === 0 ? <span class="chart-empty">{t('admin.chart.none')}</span> : null}
            {view.days.map((d) => (
              <div class={`col${d.calls === 0 ? ' zero' : ''}`} title={`${d.day}: ${d.calls} / ${d.errors}`}>
                <span class={pctClass('h', d.calls, maxCalls)} />
              </div>
            ))}
          </div>
          <div class="chart-axis">
            <span>{view.days[0] ? fmtDay(ctx.lang, view.days[0].day) : null}</span>
            <span>{view.days.length ? fmtDay(ctx.lang, view.days.at(-1)!.day) : null}</span>
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
            <span>{view.days[0] ? fmtDay(ctx.lang, view.days[0].day) : null}</span>
            <span>{view.days.length ? fmtDay(ctx.lang, view.days.at(-1)!.day) : null}</span>
          </div>
        </div>
      </div>
      <div class="grid-2">
        {/* The two short lists stack, so they line up with the longer list of new users. */}
        <div class="stack-cards">
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
        </div>
        <div class="card">
          <div class="card-head">
            <h2>{t('admin.recentUsers')}</h2>
            <a class="btn sm" href="/admin/users">
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
  plan: {
    id: string;
    until: Date | null;
    provider: string | null;
    note: string | null;
    /** Paid through a payment provider: the plan is changed there, not here. */
    paid?:
      | {
          provider: string;
          status: string;
          externalId: string;
          interval: 'month' | 'year' | null;
          cancelAtPeriodEnd: boolean;
        }
      | undefined;
  };
  /** The workspace's latest payment provider events. */
  billingEvents: {
    type: string;
    outcome: string;
    detail: string | null;
    planId: string | null;
    status: string | null;
    at: Date;
  }[];
  /** The user's open "switch me to this plan" request: the plan form is filled in for it. */
  request?: { planId: string; interval: string; at: Date } | undefined;
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

/** End of a paid period that starts today: one month or one year from now (YYYY-MM-DD, UTC). */
const requestEnd = (interval: string, now = new Date()) => {
  const end = new Date(now);
  if (interval === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return end.toISOString().slice(0, 10);
};

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
          <UsageStat
            lang={lang}
            label={t('app.usage.actions')}
            used={view.usage.actions}
            limit={view.usage.actionsLimit}
            lines={[t('app.usage.resets', { date: fmtDate(lang, view.usage.resetsAt) })]}
          />
          <UsageStat
            lang={lang}
            label={t('app.usage.accounts')}
            used={view.usage.accounts}
            limit={view.usage.accountsLimit}
          />
          <div class="stat">
            <span class="label">{t('admin.users.plan')}</span>
            <div class="value small-value">{planName(ctx, view.plan.id)}</div>
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
          {view.request ? (
            <div class="notice plan-request">
              <p>
                <strong>
                  {t('admin.requests.asked', {
                    plan: planName(ctx, view.request.planId),
                    interval: t(
                      view.request.interval === 'year' ? 'admin.requests.year' : 'admin.requests.month',
                    ),
                    when: fmtAgo(lang, view.request.at),
                  })}
                </strong>{' '}
                {t('admin.requests.prefilled')}
              </p>
              <form method="post" action={`${base}/request/decline`} class="inline">
                <Hidden values={csrf} />
                <button type="submit" class="sm">
                  {t('admin.requests.decline')}
                </button>
              </form>
            </div>
          ) : null}
          {view.plan.paid ? (
            <div class="notice info">
              <p>
                <strong>
                  {t('admin.user.paidVia', {
                    provider: view.plan.paid.provider,
                    status: view.plan.paid.status,
                    interval: t(
                      view.plan.paid.interval === 'year' ? 'admin.requests.year' : 'admin.requests.month',
                    ),
                  })}
                </strong>
                {view.plan.paid.cancelAtPeriodEnd ? ` ${t('admin.user.paidCancels')}` : ''}
              </p>
              <p class="small muted">
                <code>{view.plan.paid.externalId}</code> · {t('admin.user.paidHint')}
              </p>
            </div>
          ) : null}
          {view.billingEvents.length ? (
            <details class="billing-events">
              <summary>{t('admin.user.billingEvents', { n: view.billingEvents.length })}</summary>
              <ul class="plain small">
                {view.billingEvents.map((e) => (
                  <li>
                    <span>
                      <code>{e.type}</code> · {e.status ?? '—'}
                      {e.planId ? ` · ${planName(ctx, e.planId)}` : ''}
                    </span>
                    <span class="muted">
                      {e.outcome}
                      {e.detail ? ` (${e.detail})` : ''} · {fmtAgo(lang, e.at)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <form method="post" action={`${base}/plan`} hidden={Boolean(view.plan.paid)}>
            <Hidden values={csrf} />
            <div class="field-row">
              <div>
                <label for="plan">{t('admin.users.plan')}</label>
                <select id="plan" name="plan">
                  {PLANS.map((p) => (
                    <option value={p.id} selected={p.id === (view.request?.planId ?? view.plan.id)}>
                      {planName(ctx, p.id)}
                      {p.priceMonthly ? ` · $${p.priceMonthly}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="until">{t('admin.user.until')}</label>
                <input
                  id="until"
                  type="date"
                  name="until"
                  value={view.request ? requestEnd(view.request.interval) : ''}
                  aria-describedby="until-hint"
                />
                <p class="hint" id="until-hint">
                  {t('admin.user.untilHint')}
                </p>
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
                    <AccountStatus t={t} a={a} />
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
  'plan.request.decline': 'admin.action.plan.request.decline',
  'limit.grant': 'admin.action.limit.grant',
  'limit.revoke': 'admin.action.limit.revoke',
  'user.suspend': 'admin.action.user.suspend',
  'user.reactivate': 'admin.action.user.reactivate',
  'user.sign_out': 'admin.action.user.sign_out',
  'user.delete': 'admin.action.user.delete',
  'error.resolve': 'admin.action.error.resolve',
  'error.reopen': 'admin.action.error.reopen',
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
    case 'plan.request.decline':
      parts.push(plan(d.plan));
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

/** `warn`: should be fixed; `off`: an optional feature that is not turned on. */
export interface SystemCheck {
  label: string;
  level: 'ok' | 'warn' | 'off';
  detail: string;
}

/** One provider's OAuth app (Google, Microsoft, Slack…) and the services it opens. */
export interface OAuthAppView {
  provider: string;
  name: string;
  services: string[];
  configured: boolean;
  /** Variable prefix: `<envVar>_CLIENT_ID` and `<envVar>_CLIENT_SECRET`. */
  envVar: string;
  /** Every service of this provider also connects with an API key while the app is missing. */
  formFallback: boolean;
}

/** One health check, as on /readyz and the status page. */
export interface HealthCheckView {
  name: string;
  status: 'ok' | 'degraded' | 'down';
  critical: boolean;
  detail?: string | undefined;
  ms: number;
}

/** A background job and its latest runs. */
export interface JobView {
  name: string;
  description: string;
  cron?: string | undefined;
  lastSucceededAt: Date | null;
  lastFailedAt: Date | null;
  lastError: string | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  runs: number;
  failures: number;
}

export interface AdminSystemView {
  version: string;
  env: string;
  publicUrl: string;
  database: boolean;
  /** Health checks of the hub itself (database, migrations, jobs, event loop…). */
  health: HealthCheckView[];
  jobs: JobView[];
  /** Whether this process runs the job queue (JOBS_ENABLED). */
  jobsHere: boolean;
  errors: { open: number; recent: number };
  checks: SystemCheck[];
  /** The address to register in every provider's OAuth app. */
  redirectUri: string;
  apps: OAuthAppView[];
}

const LEVEL_DOT = { ok: 'ok', warn: 'warn', off: 'off' } as const;
const HEALTH_DOT = { ok: 'ok', degraded: 'warn', down: 'bad' } as const;

export const AdminSystemPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: AdminSystemView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t, lang } = ctx;
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
        <a class="stat" href="/admin/errors">
          <span class="label">{t('admin.nav.errors')}</span>
          <div class="value">{fmtNumber(lang, view.errors.open)}</div>
          <div class="sub">{t('admin.system.errorsRecent', { n: view.errors.recent })}</div>
        </a>
      </div>
      <div class="card flush" id="health">
        <div class="card-head pad">
          <div>
            <h2>{t('admin.system.health')}</h2>
            <p class="small muted">{t('admin.system.healthSub')}</p>
          </div>
        </div>
        <ul class="plain pad-x">
          {view.health.map((h) => (
            <li>
              <span class="check-label">
                <span class={`dot ${HEALTH_DOT[h.status]}`} />
                <strong>{t(`admin.health.${h.name}` as 'admin.health.database')}</strong>
                {h.critical ? <span class="small muted">{t('admin.system.critical')}</span> : null}
              </span>
              <span class="small muted">
                {t(`admin.health.status.${h.status}`)}
                {h.detail ? ` · ${h.detail}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div class="card flush" id="jobs">
        <div class="card-head pad">
          <div>
            <h2>{t('admin.system.jobs')}</h2>
            <p class="small muted">
              {view.jobsHere ? t('admin.system.jobsHere') : t('admin.system.jobsElsewhere')}
            </p>
          </div>
        </div>
        <div class="table-wrap">
          <table class="jobs-table">
            <thead>
              <tr>
                <th>{t('admin.jobs.job')}</th>
                <th>{t('admin.jobs.lastOk')}</th>
                <th>{t('admin.jobs.lastFail')}</th>
                <th class="right">{t('admin.jobs.runs')}</th>
              </tr>
            </thead>
            <tbody>
              {view.jobs.map((j) => (
                <tr>
                  <td>
                    <code class="small">{j.name}</code>
                    <div class="tiny muted">
                      {j.description}
                      {j.cron ? ` · ${j.cron} UTC` : ''}
                    </div>
                  </td>
                  <td class="small nowrap">
                    {j.lastSucceededAt ? fmtAgo(lang, j.lastSucceededAt) : '—'}
                    {j.lastDurationMs !== null && j.lastSucceededAt ? (
                      <div class="tiny muted">{`${fmtNumber(lang, j.lastDurationMs)} ms`}</div>
                    ) : null}
                  </td>
                  <td class="small">
                    {j.lastFailedAt ? (
                      <>
                        <span class={j.consecutiveFailures > 0 ? 'badge bad' : 'muted'}>
                          {fmtAgo(lang, j.lastFailedAt)}
                        </span>
                        {j.consecutiveFailures > 0 && j.lastError ? (
                          <div class="tiny muted">{j.lastError}</div>
                        ) : null}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td class="small right nowrap">
                    {fmtNumber(lang, j.runs)}
                    {j.failures ? (
                      <div class="tiny muted">{t('admin.jobs.failures', { n: j.failures })}</div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card flush">
        <div class="card-head pad">
          <h2>{t('admin.system.config')}</h2>
        </div>
        <ul class="plain pad-x">
          {view.checks.map((c) => (
            <li>
              <span class="check-label">
                <span class={`dot ${LEVEL_DOT[c.level]}`} />
                <strong>{c.label}</strong>
              </span>
              <span class="small muted">{c.detail}</span>
            </li>
          ))}
        </ul>
        <p class="hint pad-x">{t('admin.system.hint')}</p>
      </div>
      <div class="card flush" id="apps">
        <div class="card-head pad">
          <div>
            <h2>{t('admin.apps.title')}</h2>
            <p class="small muted">{t('admin.apps.sub')}</p>
          </div>
        </div>
        <div class="pad-x">
          <CopyField t={t} id="redirect-uri" value={view.redirectUri} label={t('admin.apps.redirect')} />
          <p class="hint">{t('admin.apps.redirectHint')}</p>
        </div>
        <ul class="plain pad-x">
          {view.apps.map((a) => (
            <li>
              <span class="check-label">
                {/* Not set up is a choice (those services just stay unavailable), not an error. */}
                <span class={`dot ${a.configured ? 'ok' : 'off'}`} />
                <span>
                  <strong>{a.name}</strong>
                  {a.services.join() !== a.name ? (
                    <span class="small muted d-block">{a.services.join(', ')}</span>
                  ) : null}
                </span>
              </span>
              <span class="small muted right">
                {a.configured ? (
                  t('admin.sys.on')
                ) : (
                  <>
                    {t('admin.apps.set')} <code>{`${a.envVar}_CLIENT_ID`}</code>,{' '}
                    <code>{`${a.envVar}_CLIENT_SECRET`}</code>
                    {a.formFallback ? <span class="d-block">{t('admin.apps.fallback')}</span> : null}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </AppShell>
  );
};

// ---------------------------------------------------------------------------
// Errors (the hub's own error tracker)
// ---------------------------------------------------------------------------

export interface AdminErrorRow {
  id: string;
  source: string;
  type: string;
  message: string;
  stack: string | null;
  context: Record<string, unknown>;
  count: number;
  lastRef: string | null;
  lastRequestId: string | null;
  release: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
}

export interface AdminErrorsView {
  status: 'open' | 'resolved';
  rows: AdminErrorRow[];
  /** Whether errors are also sent to Sentry (SENTRY_DSN). */
  sentry: boolean;
  retentionDays: number;
}

/** Where the error happened, in a few words: `GET /app/services`, `gmail_search`, job name. */
function errorWhere(row: AdminErrorRow): string {
  const c = row.context;
  if (typeof c.path === 'string') return `${typeof c.method === 'string' ? `${c.method} ` : ''}${c.path}`;
  if (typeof c.tool === 'string') return c.tool;
  if (typeof c.job === 'string') return c.job;
  if (typeof c.kind === 'string') return c.kind;
  return '—';
}

export const AdminErrorsPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: AdminErrorsView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t, lang } = ctx;
  const csrf = { csrf: ctx.csrf };
  return (
    <AppShell ctx={ctx} shell={shell} section="admin-errors" title={t('admin.nav.errors')}>
      <PageHead title={t('admin.nav.errors')} sub={t('admin.errors.sub', { days: view.retentionDays })} />
      <div class="row filter-links">
        <a class="btn sm" href="/admin/errors" aria-current={view.status === 'open' ? 'page' : undefined}>
          {t('admin.errors.open')}
        </a>
        <a
          class="btn sm"
          href="/admin/errors?status=resolved"
          aria-current={view.status === 'resolved' ? 'page' : undefined}
        >
          {t('admin.errors.resolved')}
        </a>
        <span class="small muted">
          {view.sentry ? t('admin.errors.sentryOn') : t('admin.errors.sentryOff')}
        </span>
      </div>
      {view.rows.length === 0 ? (
        <div class="card">
          <p class="muted">
            {view.status === 'open' ? t('admin.errors.noneOpen') : t('admin.errors.noneResolved')}
          </p>
        </div>
      ) : (
        <div class="card flush">
          <ul class="plain error-list">
            {view.rows.map((r) => (
              <li class="pad" id={r.id}>
                <div class="error-head">
                  <div>
                    <strong>{r.type}</strong> <span class="badge">{r.source}</span>{' '}
                    <code class="small">{errorWhere(r)}</code>
                    <p class="error-message">{r.message}</p>
                    <p class="small muted">
                      {t('admin.errors.seen', {
                        n: r.count,
                        last: fmtAgo(lang, r.lastSeenAt),
                        first: fmtDate(lang, r.firstSeenAt, true),
                      })}
                      {r.lastRef ? ` · ref ${r.lastRef}` : ''}
                      {r.lastRequestId ? ` · ${t('admin.errors.request')} ${r.lastRequestId}` : ''}
                      {r.release ? ` · ${r.release}` : ''}
                    </p>
                  </div>
                  <form method="post" action={`/admin/errors/${r.id}/${r.resolvedAt ? 'reopen' : 'resolve'}`}>
                    <Hidden values={csrf} />
                    <button type="submit" class="sm">
                      {r.resolvedAt ? t('admin.errors.reopen') : t('admin.errors.resolve')}
                    </button>
                  </form>
                </div>
                {r.stack ? (
                  <details class="problem-raw">
                    <summary>{t('admin.errors.stack')}</summary>
                    <code>{r.stack}</code>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </AppShell>
  );
};
