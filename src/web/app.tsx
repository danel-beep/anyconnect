import type { Child, FC } from 'hono/jsx';
import { type Metric, PLANS, type Plan } from '../billing/plans.js';
import { BRAND } from '../brand.js';
import { arrangeCatalog, SAMPLE_SERVICES, searchText, serviceMeta } from './catalog.js';
import { CLIENT_GUIDES, clientName } from './clients.js';
import { Doc } from './document.js';
import type { Translate } from './i18n.js';
import type { PageCtx } from './page-context.js';
import { callReason, classifyProblem, needsReconnect, ProblemText, problemText } from './problems.js';
import { PlanCard } from './site.js';
import {
  Brand,
  CodeBlock,
  CopyField,
  fmtAgo,
  fmtDate,
  fmtDay,
  fmtNumber,
  Hidden,
  Icon,
  type IconName,
  initials,
  Meter,
  Prefs,
  pctClass,
  ServiceLogo,
  Tabs,
} from './ui.js';

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export type AppSection =
  | 'overview'
  | 'services'
  | 'apps'
  | 'activity'
  | 'confirm'
  | 'rules'
  | 'teams'
  | 'billing'
  | 'security'
  | 'settings'
  | 'admin'
  | 'admin-users'
  | 'admin-revenue'
  | 'admin-analytics'
  | 'admin-audit'
  | 'admin-errors'
  | 'admin-system';

export interface ShellInfo {
  planId: string;
  pendingConfirmations: number;
  /** Turned-on accounts that stopped working (shown on Services, so they get fixed). */
  brokenAccounts: number;
  /** Admins only: plan requests waiting for an answer. */
  planRequests?: number | undefined;
}

const NAV: {
  id: AppSection;
  href: string;
  icon: IconName;
  key: string;
  group: 'main' | 'account' | 'admin';
}[] = [
  { id: 'overview', href: '/app', icon: 'home', key: 'app.nav.overview', group: 'main' },
  { id: 'services', href: '/app/services', icon: 'plug', key: 'app.nav.services', group: 'main' },
  { id: 'apps', href: '/app/apps', icon: 'zap', key: 'app.nav.apps', group: 'main' },
  { id: 'activity', href: '/app/activity', icon: 'activity', key: 'app.nav.activity', group: 'main' },
  { id: 'confirm', href: '/confirm', icon: 'bell', key: 'app.nav.confirm', group: 'main' },
  { id: 'rules', href: '/app/rules', icon: 'shield', key: 'app.nav.rules', group: 'main' },
  { id: 'teams', href: '/app/teams', icon: 'users', key: 'app.nav.teams', group: 'main' },
  { id: 'billing', href: '/app/billing', icon: 'card', key: 'app.nav.billing', group: 'account' },
  { id: 'security', href: '/security', icon: 'lock', key: 'app.nav.security', group: 'account' },
  { id: 'settings', href: '/app/settings', icon: 'settings', key: 'app.nav.settings', group: 'account' },
  { id: 'admin', href: '/admin', icon: 'chart', key: 'admin.nav.overview', group: 'admin' },
  {
    id: 'admin-analytics',
    href: '/admin/analytics',
    icon: 'activity',
    key: 'admin.nav.analytics',
    group: 'admin',
  },
  { id: 'admin-users', href: '/admin/users', icon: 'users', key: 'admin.nav.users', group: 'admin' },
  { id: 'admin-revenue', href: '/admin/revenue', icon: 'card', key: 'admin.nav.revenue', group: 'admin' },
  { id: 'admin-audit', href: '/admin/audit', icon: 'book', key: 'admin.nav.audit', group: 'admin' },
  { id: 'admin-errors', href: '/admin/errors', icon: 'alert', key: 'admin.nav.errors', group: 'admin' },
  { id: 'admin-system', href: '/admin/system', icon: 'layers', key: 'admin.nav.system', group: 'admin' },
];

export const AppShell: FC<{
  ctx: PageCtx;
  shell: ShellInfo;
  section: AppSection;
  title: string;
  passkeys?: boolean;
  refreshSeconds?: number;
  children?: Child;
}> = ({ ctx, shell, section, title, passkeys, refreshSeconds, children }) => {
  const { t } = ctx;
  const user = ctx.user!;
  const groups: ['main' | 'account' | 'admin', string | null][] = [
    ['main', null],
    ['account', t('app.nav.account')],
    ...(user.isAdmin ? ([['admin', t('admin.nav.group')]] as ['admin', string][]) : []),
  ];
  return (
    <Doc
      title={`${title} · ${BRAND.name}`}
      lang={ctx.lang}
      noindex
      passkeys={passkeys}
      {...(refreshSeconds ? { refreshSeconds } : {})}
    >
      <a class="skip" href="#main">
        {t('ui.skip')}
      </a>
      <div class="mobile-bar">
        <Brand href="/app" />
        <button
          type="button"
          class="icon-btn"
          data-nav-toggle
          aria-controls="app-nav"
          aria-expanded="false"
          aria-label={t('ui.menu')}
        >
          <Icon name="menu" />
        </button>
      </div>
      <div class="shell">
        <aside class="sidebar" id="app-nav" aria-label={t('app.nav.label')}>
          <Brand href="/app" />
          {groups.map(([group, label]) => (
            <>
              {label ? <span class="side-group">{label}</span> : null}
              {NAV.filter((n) => n.group === group).map((n) => (
                <a class="side-link" href={n.href} aria-current={n.id === section ? 'page' : undefined}>
                  <Icon name={n.icon} />
                  <span>{t(n.key as 'app.nav.overview')}</span>
                  {n.id === 'confirm' && shell.pendingConfirmations > 0 ? (
                    <span class="count">
                      <span aria-hidden="true">{shell.pendingConfirmations}</span>
                      <span class="sr-only">{t('app.nav.pending', { n: shell.pendingConfirmations })}</span>
                    </span>
                  ) : null}
                  {n.id === 'admin' && shell.planRequests ? (
                    <span class="count" title={t('admin.nav.requests', { n: shell.planRequests })}>
                      <span aria-hidden="true">{shell.planRequests}</span>
                      <span class="sr-only">{t('admin.nav.requests', { n: shell.planRequests })}</span>
                    </span>
                  ) : null}
                  {n.id === 'services' && shell.brokenAccounts > 0 ? (
                    <span class="count bad" title={t('app.nav.broken', { n: shell.brokenAccounts })}>
                      <span aria-hidden="true">{shell.brokenAccounts}</span>
                      <span class="sr-only">{t('app.nav.broken', { n: shell.brokenAccounts })}</span>
                    </span>
                  ) : null}
                </a>
              ))}
            </>
          ))}
          <div class="side-foot">
            <div class="who">
              <span class="avatar" aria-hidden="true">
                {initials(user.name ?? user.email)}
              </span>
              <span class="grow">
                <span class="email" title={user.email}>
                  {user.name ?? user.email}
                </span>
                <span class="plan-name">
                  {t(`plan.${shell.planId}.name` as 'plan.free.name')}
                  {user.isAdmin ? <span class="admin-tag">{t('app.adminTag')}</span> : null}
                </span>
              </span>
            </div>
            <div class="side-tools">
              <Prefs t={t} lang={ctx.lang} path={ctx.path} />
              <a class="icon-btn" href="/" title={t('app.toSite')} aria-label={t('app.toSite')}>
                <Icon name="external" />
              </a>
              <form method="post" action="/logout" class="inline">
                <input type="hidden" name="csrf" value={ctx.csrf} />
                <button
                  type="submit"
                  class="icon-btn"
                  title={t('home.signOut')}
                  aria-label={t('home.signOut')}
                >
                  <Icon name="logout" />
                </button>
              </form>
            </div>
          </div>
        </aside>
        <main class="content" id="main">
          {children}
        </main>
      </div>
    </Doc>
  );
};

export const PageHead: FC<{ title: string; sub?: Child; crumbs?: Child; actions?: Child }> = ({
  title,
  sub,
  crumbs,
  actions,
}) => (
  <div class="page-head">
    <div>
      {crumbs ? <p class="crumbs">{crumbs}</p> : null}
      <h1>{title}</h1>
      {sub ? <p>{sub}</p> : null}
    </div>
    {actions ? <div class="row">{actions}</div> : null}
  </div>
);

/** One-line result of the last action ("Account renamed"), from the `?done=` / `?error=` query. */
export const Flash: FC<{ flash?: { kind: 'ok' | 'bad'; text: string } | undefined }> = ({ flash }) =>
  flash ? (
    <div class={`notice ${flash.kind}`} role="status">
      {flash.text}
    </div>
  ) : null;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface AccountView {
  id: string;
  connectorId: string;
  service: string;
  name: string;
  label: string;
  status: string;
  statusMessage: string | null;
  enabled: boolean;
  identity: string | null;
  oauth: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface CallView {
  toolName: string;
  connectorId: string;
  status: string;
  outcome: string | null;
  createdAt: Date;
  durationMs: number;
  client: string | null;
  /** The action as people read it ("Search mail"); the tool name when the action is unknown. */
  title: string;
  /** Label of the account the call used, when it used one. */
  account: string | null;
  /** What the AI was told when the call failed (user-safe text from the connector or the hub). */
  error: string | null;
}

export interface UsageView {
  planId: string;
  actions: { used: number; limit: number | null };
  accounts: { used: number; limit: number | null };
  resetsAt: Date;
  /** The start in force: a trial of another plan or a step down (see `Plan.start`). */
  phase?: { kind: 'trial' | 'step'; asPlan?: string | undefined; until: Date } | undefined;
  /** The whole published start: dates and the actions limit of each phase, then the plan's own. */
  schedule?: {
    kind: 'trial' | 'step';
    from: Date;
    until: Date;
    actions: number | null;
    asPlan?: string | undefined;
  }[];
  /** The plan's own actions limit, after the start. */
  planLimitActions?: number | null;
}

export const AccountStatus: FC<{
  t: Translate;
  a: Pick<AccountView, 'enabled' | 'status'> & { statusMessage?: string | null | undefined };
}> = ({ t, a }) =>
  !a.enabled ? (
    <span class="badge">{t('app.acc.off')}</span>
  ) : a.status === 'active' ? (
    <span class="badge ok">
      <span class="dot ok" /> {t('app.acc.active')}
    </span>
  ) : (
    <span
      class="badge bad"
      title={problemText(t, classifyProblem(a.statusMessage, a.status), a.statusMessage)}
    >
      <span class="dot bad" />{' '}
      {t(needsReconnect(classifyProblem(a.statusMessage, a.status)) ? 'app.acc.reauth' : 'app.acc.error')}
    </span>
  );

const CallStatus: FC<{ t: Translate; call: CallView }> = ({ t, call }) => {
  if (call.status === 'ok') return <span class="badge ok">{t('app.call.ok')}</span>;
  if (call.outcome === 'denied') return <span class="badge">{t('app.call.denied')}</span>;
  if (call.outcome === 'quota_exceeded') return <span class="badge warn">{t('app.call.quota')}</span>;
  if (call.outcome === 'pending' || call.status === 'pending')
    return <span class="badge accent">{t('app.call.pending')}</span>;
  return <span class="badge bad">{t('app.call.error')}</span>;
};

export const CallsTable: FC<{
  ctx: PageCtx;
  calls: CallView[];
  empty: string;
  withClient?: boolean;
  /** All rows are of one account (its own page): its name under each row would only repeat. */
  oneAccount?: boolean;
}> = ({ ctx, calls, empty, withClient: wantClient, oneAccount }) => {
  // The app column only when some row has an app (calls from the dashboard or old tokens have none).
  const withClient = wantClient && calls.some((call) => call.client);
  return calls.length === 0 ? (
    <p class="muted pad-x">{empty}</p>
  ) : (
    <div class="table-wrap">
      <table class="calls">
        <thead>
          <tr>
            <th>{ctx.t('app.call.tool')}</th>
            {withClient ? <th>{ctx.t('app.call.client')}</th> : null}
            <th>{ctx.t('app.call.result')}</th>
            <th class="right">{ctx.t('app.call.time')}</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((call) => {
            const meta = serviceMeta(call.connectorId);
            return (
              <tr>
                <td>
                  <span class="user-cell">
                    <ServiceLogo icon={meta?.icon} glyph={meta?.glyph} name={call.connectorId} size="sm" />
                    <span class="call-what">
                      <span title={call.toolName}>{call.title}</span>
                      {call.account && !oneAccount ? <span class="small muted">{call.account}</span> : null}
                      {call.status === 'error' ? (
                        <span class="small call-why" title={call.error ?? undefined}>
                          {callReason(ctx.t, call.outcome, call.error)}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </td>
                {withClient ? (
                  <td class={`small client${call.client ? '' : ' empty'}`}>{call.client ?? '—'}</td>
                ) : null}
                <td class="status">
                  <CallStatus t={ctx.t} call={call} />
                </td>
                <td class="right small muted nowrap when" title={fmtDate(ctx.lang, call.createdAt, true)}>
                  {fmtAgo(ctx.lang, call.createdAt)}
                  <span class="took">
                    {ctx.t('app.call.took', { ms: fmtNumber(ctx.lang, call.durationMs) })}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const UsageStats: FC<{ ctx: PageCtx; usage: UsageView; extra?: Child }> = ({ ctx, usage, extra }) => {
  const { t, lang } = ctx;
  const limitText = (v: number | null) => (v === null ? '∞' : fmtNumber(lang, v));
  const exhausted = usage.actions.limit !== null && usage.actions.used >= usage.actions.limit;
  return (
    <>
      {exhausted ? (
        <div class="notice bad">
          {t('app.usage.exhausted', { date: fmtDate(lang, usage.resetsAt) })}{' '}
          <a href="/app/billing">{t('app.billing.upgrade')}</a>
        </div>
      ) : null}
      <div class="stats">
        <div class="stat">
          <span class="label">{t('app.usage.actions')}</span>
          <div class="value">
            {fmtNumber(lang, usage.actions.used)}{' '}
            <span class="muted small">/ {limitText(usage.actions.limit)}</span>
          </div>
          <Meter used={usage.actions.used} limit={usage.actions.limit} label={t('app.usage.actions')} />
          <div class="sub">
            <a href="/app/billing">
              {t('app.usage.plan', { plan: t(`plan.${usage.planId}.name` as 'plan.free.name') })}
            </a>
            {' · '}
            {usage.actions.limit === null
              ? t('app.usage.noLimit')
              : t('app.usage.resets', { date: fmtDate(lang, usage.resetsAt) })}
          </div>
        </div>
        <div class="stat">
          <span class="label">{t('app.usage.accounts')}</span>
          <div class="value">
            {usage.accounts.used} <span class="muted small">/ {limitText(usage.accounts.limit)}</span>
          </div>
          <Meter used={usage.accounts.used} limit={usage.accounts.limit} label={t('app.usage.accounts')} />
          <div class="sub">
            {usage.phase?.kind === 'trial'
              ? t('app.usage.trial', {
                  plan: t(`plan.${usage.phase.asPlan ?? 'pro'}.name` as 'plan.free.name'),
                  date: fmtDate(lang, usage.phase.until),
                })
              : usage.phase
                ? t('app.usage.step', { date: fmtDate(lang, usage.phase.until) })
                : t('app.usage.accountsHint')}
          </div>
        </div>
        {extra}
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/** How many accounts the overview lists before "View all". */
const OVERVIEW_ACCOUNTS = 6;

const needsFix = (a: AccountView) => a.enabled && a.status !== 'active';

/** Accounts that need a fix come first, so they are never hidden below the fold. */
export const brokenFirst = (accounts: AccountView[]) =>
  [...accounts].sort((a, b) => Number(needsFix(b)) - Number(needsFix(a)));

/** Accounts by service: services with a broken account first, then by name; broken accounts first inside. */
export const groupByService = (accounts: AccountView[]): [string, AccountView[]][] => {
  const groups = new Map<string, AccountView[]>();
  for (const a of brokenFirst(accounts)) groups.set(a.service, [...(groups.get(a.service) ?? []), a]);
  return [...groups.entries()].sort(
    ([an, a], [bn, b]) => Number(b.some(needsFix)) - Number(a.some(needsFix)) || an.localeCompare(bn),
  );
};

/**
 * The one button that fixes a failing account: signing in again when the service stopped accepting
 * the saved sign-in, otherwise checking again (a server that was down, a hiccup on its side).
 */
export const FixButton: FC<{ ctx: PageCtx; a: AccountView; returnTo: string; primary?: boolean }> = ({
  ctx,
  a,
  returnTo,
  primary,
}) => {
  const { t } = ctx;
  const cls = `btn sm${primary ? ' primary' : ''}`;
  if (needsReconnect(classifyProblem(a.statusMessage, a.status)))
    return (
      <a
        class={cls}
        href={`/connect/${encodeURIComponent(a.connectorId)}?account=${encodeURIComponent(a.id)}&returnTo=${encodeURIComponent(returnTo)}`}
      >
        <Icon name="refresh" /> {t('app.acc.reconnect')}
      </a>
    );
  return (
    <form method="post" action={`/app/accounts/${encodeURIComponent(a.id)}/test`} class="inline">
      <Hidden values={{ csrf: ctx.csrf, ...(ACCOUNT_BACK.test(returnTo) ? { back: returnTo } : {}) }} />
      <button type="submit" class={primary ? 'sm primary' : 'sm'}>
        <Icon name="refresh" /> {t('problem.checkAgain')}
      </button>
    </form>
  );
};

/**
 * Where account and rule forms may send the browser back to (`back`): the overview, an account's
 * or an AI app's own page. Anything else falls back to the form's usual page, so a form can never
 * redirect elsewhere.
 */
export const ACCOUNT_BACK = /^\/app(?:\/(?:accounts|apps)\/[\w-]{1,64})?$/;

/** Where revoking a sign-in or a token may go back to: an access profile's or AI app's own page. */
export const CONNECTION_BACK = /^\/app\/(?:profiles|apps)\/[\w-]{1,64}$/;

/** A banner over the page when connected accounts stopped working, with a fix for each. */
export const BrokenAccounts: FC<{ ctx: PageCtx; accounts: AccountView[] }> = ({ ctx, accounts }) => {
  const { t } = ctx;
  const broken = accounts.filter(needsFix);
  if (!broken.length) return null;
  return (
    <div class="notice bad attention" role="status">
      <strong>{t('app.attention.title', { n: broken.length })}</strong>
      <ul>
        {broken.slice(0, 5).map((a) => (
          <li>
            <span class="grow">
              <span>
                <a href={`/app/accounts/${encodeURIComponent(a.id)}`}>{a.label}</a>
                <span class="muted"> · {a.service}</span>
              </span>
              <span class="small">
                <ProblemText t={t} message={a.statusMessage} status={a.status} />
              </span>
            </span>
            <FixButton ctx={ctx} a={a} returnTo="/app" />
          </li>
        ))}
      </ul>
    </div>
  );
};

export interface OverviewView {
  firstName: string | null;
  welcome: boolean;
  steps: { ai: boolean; service: boolean; call: boolean };
  usage: UsageView;
  apps: number;
  calls7d: number;
  /** Actions waiting for the user's OK, and when the first of them expires. */
  waiting: { count: number; soonest: Date | null };
  accounts: AccountView[];
  recent: CallView[];
}

export const OverviewPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: OverviewView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t } = ctx;
  const allDone = view.steps.ai && view.steps.service && view.steps.call;
  // Same order as on the website: services first, then the address for the AI, then a first request.
  const steps: { done: boolean; title: string; text: string; href: string }[] = [
    {
      done: view.steps.service,
      title: t('app.onb.service'),
      text: t('app.onb.serviceText'),
      href: '/app/services',
    },
    { done: view.steps.ai, title: t('app.onb.ai'), text: t('app.onb.aiText'), href: '#connect-ai' },
    { done: view.steps.call, title: t('app.onb.call'), text: t('app.onb.callText'), href: '/docs#services' },
  ];
  return (
    <AppShell ctx={ctx} shell={shell} section="overview" title={t('app.nav.overview')}>
      <PageHead
        title={view.firstName ? t('app.hello', { name: view.firstName }) : t('app.helloAnon')}
        sub={allDone ? t('app.overview.sub') : t('app.overview.subNew')}
      />
      {view.welcome ? <div class="notice ok">{t('app.welcome')}</div> : null}
      {view.waiting.count ? (
        <div class="notice info waiting" role="status">
          <span class="grow">
            <strong>{t('app.waiting.title', { n: view.waiting.count })}</strong>{' '}
            {view.waiting.soonest
              ? t('app.waiting.expires', { when: fmtAgo(ctx.lang, view.waiting.soonest) })
              : null}
          </span>
          <a class="btn sm primary" href="/confirm">
            {t('app.waiting.review')}
          </a>
        </div>
      ) : null}
      <BrokenAccounts ctx={ctx} accounts={view.accounts} />
      {allDone ? null : (
        <div class="onboard">
          {steps.map((s, i) => (
            <a class={`onboard-step${s.done ? ' done' : ''}`} href={s.href}>
              <span class="tick">{s.done ? <Icon name="check" /> : i + 1}</span>
              <span>
                <strong>{s.title}</strong>
                <span>{s.text}</span>
              </span>
            </a>
          ))}
        </div>
      )}
      {/* Until an AI app is connected, its address is the main thing on this page. */}
      {view.steps.ai ? null : <ConnectAiCard ctx={ctx} />}
      <UsageStats
        ctx={ctx}
        usage={view.usage}
        extra={
          <>
            <div class="stat">
              <span class="label">{t('app.nav.apps')}</span>
              <div class="value">{view.apps}</div>
              <div class="sub">
                <a href="/app/apps">{t('app.apps.manage')}</a>
              </div>
            </div>
            <div class="stat">
              <span class="label">{t('app.usage.calls7d')}</span>
              <div class="value">{fmtNumber(ctx.lang, view.calls7d)}</div>
              <div class="sub">
                <a href="/app/activity">{t('app.activity.open')}</a>
              </div>
            </div>
          </>
        }
      />
      {view.steps.ai ? <ConnectAiCard ctx={ctx} compact /> : null}
      <div class="grid-2">
        <div class="card flush">
          <div class="card-head pad">
            <h2>{t('app.services.connected')}</h2>
            <a class="btn sm" href="/app/services">
              <Icon name="plus" /> {t('app.services.add')}
            </a>
          </div>
          {view.accounts.length === 0 ? (
            <p class="muted pad-x">{t('app.services.none')}</p>
          ) : (
            <div class="acc-list">
              {brokenFirst(view.accounts)
                .slice(0, OVERVIEW_ACCOUNTS)
                .map((a) => {
                  const meta = serviceMeta(a.connectorId);
                  return (
                    <div class="acc">
                      <ServiceLogo icon={meta?.icon} glyph={meta?.glyph} name={a.service} size="sm" />
                      <div class="grow">
                        <div class="title">
                          <a class="acc-link" href={`/app/accounts/${encodeURIComponent(a.id)}`}>
                            {a.label}
                          </a>
                        </div>
                        <div class="sub">
                          {a.service} · {a.identity ?? a.name}
                        </div>
                      </div>
                      <div class="ops inline">
                        <AccountStatus t={t} a={a} />
                      </div>
                    </div>
                  );
                })}
              {view.accounts.length > OVERVIEW_ACCOUNTS ? (
                <a class="acc acc-more" href="/app/services">
                  {t('app.services.viewAll', { n: view.accounts.length })}
                </a>
              ) : null}
            </div>
          )}
        </div>
        <div class="card flush">
          <div class="card-head pad">
            <h2>{t('app.activity.recent')}</h2>
            <a class="btn sm" href="/app/activity">
              {t('app.activity.all')}
            </a>
          </div>
          <CallsTable ctx={ctx} calls={view.recent} empty={t('app.activity.none')} />
        </div>
      </div>
    </AppShell>
  );
};

/** The MCP URL with per-client instructions; compact once an app is connected. */
/**
 * The MCP address with steps for each AI app. `profile` shows a profile's own address instead of
 * the main one (the steps are the same).
 */
export const ConnectAiCard: FC<{
  ctx: PageCtx;
  compact?: boolean;
  profile?: { url: string; title: string; hint: string };
}> = ({ ctx, compact, profile }) => {
  const { t, lang } = ctx;
  const url = profile?.url ?? ctx.mcpUrl;
  return (
    <div class="card" id="connect-ai">
      <div class="card-head">
        <h2>{profile ? profile.title : compact ? t('app.ai.urlTitle') : t('app.ai.title')}</h2>
        <a class="btn sm" href="/docs">
          <Icon name="book" /> {t('app.ai.docs')}
        </a>
      </div>
      <CopyField t={t} id="mcp-url" value={url} label={t('home.mcpUrl')} />
      <p class="hint">{profile ? profile.hint : t('app.ai.hint')}</p>
      {compact ? null : (
        <div class="stack">
          <Tabs
            id="clients"
            remember="client"
            tabs={CLIENT_GUIDES.filter((g) => g.id !== 'other').map((g) => ({
              id: g.id,
              label: clientName(g, lang),
              panel: (
                <div class="guide-compact">
                  <ol class="bullets">
                    {(lang === 'ru' ? g.steps.ru : g.steps.en).map((s) => (
                      <li>{s}</li>
                    ))}
                  </ol>
                  {g.install ? (
                    <p>
                      <a class="btn sm primary" href={g.install(url).href}>
                        {lang === 'ru' ? g.install(url).label.ru : g.install(url).label.en}
                      </a>
                    </p>
                  ) : null}
                  {g.code ? <CodeBlock t={t} id={`client-code-${g.id}`} code={g.code(url)} /> : null}
                </div>
              ),
            }))}
          />
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export interface CatalogEntryView {
  service: string;
  name: string;
  description: string;
  connect: 'oauth' | 'form' | 'none';
  ready: boolean;
  custom: boolean;
  accounts: number;
  /** Another way to connect the same data while this service is not set up (e.g. Gmail over IMAP). */
  alternative?: { service: string; url: string } | undefined;
}

export interface CustomServiceView {
  connectorId: string;
  name: string;
  kind: 'mcp' | 'manifest';
  url: string | null;
  tools: number;
  lastError: string | null;
}

export interface ServicesView {
  accounts: AccountView[];
  catalog: CatalogEntryView[];
  custom: CustomServiceView[];
  usage: UsageView;
  flash?: { kind: 'ok' | 'bad'; text: string } | undefined;
  /** What the user typed into the "own MCP server" form when adding it failed. */
  customDraft?: { name: string; url: string } | undefined;
}

const AccountRow: FC<{ ctx: PageCtx; a: AccountView }> = ({ ctx, a }) => {
  const { t } = ctx;
  const meta = serviceMeta(a.connectorId);
  const base = `/app/accounts/${a.id}`;
  const broken = needsFix(a);
  return (
    <div class="acc" id={`acc-${a.id}`}>
      <ServiceLogo icon={meta?.icon} glyph={meta?.glyph} name={a.service} />
      <div class="grow">
        <div class="title">
          <a class="acc-link" href={base}>
            {a.label}
          </a>{' '}
          <AccountStatus t={t} a={a} />
        </div>
        <div class="sub">{a.identity ?? a.name}</div>
        {broken ? (
          <div class="sub error">
            <ProblemText t={t} message={a.statusMessage} status={a.status} />
          </div>
        ) : null}
      </div>
      <div class="ops">
        {broken ? (
          <FixButton ctx={ctx} a={a} returnTo="/app/services" primary />
        ) : (
          <form method="post" action={`${base}/test`} class="inline">
            <input type="hidden" name="csrf" value={ctx.csrf} />
            <button type="submit" class="sm">
              {t('app.acc.test')}
            </button>
          </form>
        )}
        <details class="menu" data-menu>
          <summary aria-label={t('app.acc.more')} title={t('app.acc.more')}>
            <Icon name="more" />
            <span class="menu-label">{t('app.acc.moreShort')}</span>
          </summary>
          <div class="menu-pop">
            <a href={base}>
              <Icon name="settings" /> {t('app.acc.open')}
            </a>
            {broken ? (
              <form method="post" action={`${base}/test`}>
                <input type="hidden" name="csrf" value={ctx.csrf} />
                <button type="submit">
                  <Icon name="refresh" /> {t('app.acc.test')}
                </button>
              </form>
            ) : null}
            <form method="post" action={`${base}/rename`} class="rename">
              <input type="hidden" name="csrf" value={ctx.csrf} />
              <label class="sr-only" for={`label-${a.id}`}>
                {t('app.acc.label')}
              </label>
              <input id={`label-${a.id}`} type="text" name="label" value={a.label} maxlength={100} required />
              <button type="submit" class="sm">
                {t('app.acc.rename')}
              </button>
            </form>
            <a href={`/connect/${a.connectorId}?account=${a.id}&returnTo=%2Fapp%2Fservices`}>
              <Icon name="refresh" /> {t('app.acc.reconnect')}
            </a>
            <form method="post" action={`${base}/toggle`}>
              <input type="hidden" name="csrf" value={ctx.csrf} />
              <button type="submit">
                <Icon name={a.enabled ? 'pause' : 'play'} />{' '}
                {a.enabled ? t('app.acc.disable') : t('app.acc.enable')}
              </button>
            </form>
            <form
              method="post"
              action={`${base}/delete`}
              data-confirm={t('app.acc.deleteConfirm', { label: a.label })}
            >
              <input type="hidden" name="csrf" value={ctx.csrf} />
              <button type="submit" class="danger">
                <Icon name="trash" /> {t('app.acc.delete')}
              </button>
            </form>
          </div>
        </details>
      </div>
    </div>
  );
};

const connectHref = (s: CatalogEntryView) => `/connect/${s.service}?returnTo=%2Fapp%2Fservices`;

/**
 * One service in the "Add a service" card. A service that can be connected is one big link (the name
 * stretches over the tile); one that cannot yet shows why and the other way in, if there is one.
 */
const ServiceTile: FC<{ ctx: PageCtx; s: CatalogEntryView; full: boolean; anchor?: boolean }> = ({
  ctx,
  s,
  full,
  anchor,
}) => {
  const { t, lang } = ctx;
  const meta = serviceMeta(s.service);
  const desc = meta ? (lang === 'ru' ? meta.blurb.ru : meta.blurb.en) : s.description;
  const action = full
    ? t('app.billing.upgrade')
    : s.accounts > 0
      ? t('app.services.addAnother')
      : t('app.services.connect');
  return (
    <div
      class={`svc-tile${s.ready ? '' : ' off'}`}
      id={anchor ? `add-${s.service}` : undefined}
      data-search={anchor ? searchText(s.service, s.name, desc) : undefined}
    >
      <ServiceLogo icon={meta?.icon} glyph={meta?.glyph} name={s.name} />
      <div class="grow">
        <div class="svc-name">
          {s.ready ? (
            <a class="stretch" href={full ? '/app/billing' : connectHref(s)}>
              {s.name}
              <span class="sr-only">: {action}</span>
            </a>
          ) : (
            <strong>{s.name}</strong>
          )}
          {s.accounts > 0 ? (
            <span class="badge ok tiny-badge">{t('app.services.nConnected', { n: s.accounts })}</span>
          ) : null}
        </div>
        <p>{desc}</p>
        {s.ready ? null : (
          <span class="cat-unavailable small muted">
            <span class="badge">{t('app.services.notReady')}</span>
            {s.alternative ? (
              <a
                href={`${s.alternative.url}${s.alternative.url.includes('?') ? '&' : '?'}returnTo=%2Fapp%2Fservices`}
              >
                {t('app.services.useAlt', { alternative: s.alternative.service })}
              </a>
            ) : null}
            {ctx.user?.isAdmin ? <a href="/admin/system#apps">{t('app.services.setUp')}</a> : null}
          </span>
        )}
      </div>
      {s.ready ? (
        <span class="svc-go" aria-hidden="true">
          <Icon name="plus" />
        </span>
      ) : null}
    </div>
  );
};

/** Sample accounts (the Demo service) folded into one row, with one button that removes them. */
const SampleAccounts: FC<{ ctx: PageCtx; accounts: AccountView[] }> = ({ ctx, accounts }) => {
  const { t } = ctx;
  const first = accounts[0];
  if (!first) return null;
  const meta = serviceMeta(first.connectorId);
  return (
    <div class="acc acc-sample">
      <ServiceLogo icon={meta?.icon} glyph={meta?.glyph} name={first.service} />
      <div class="grow">
        <div class="title">
          {t('app.samples.title')} <span class="badge">{accounts.length}</span>
        </div>
        <div class="sub sub-wrap">{t('app.samples.text', { service: first.service })}</div>
      </div>
      <div class="ops">
        <form
          method="post"
          action="/app/samples/remove"
          class="inline"
          data-confirm={t('app.samples.confirm', { n: accounts.length })}
        >
          <input type="hidden" name="csrf" value={ctx.csrf} />
          <button type="submit" class="sm">
            <Icon name="trash" /> {t('app.samples.remove')}
          </button>
        </form>
      </div>
    </div>
  );
};

export const ServicesAppPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: ServicesView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t } = ctx;
  const full = view.usage.accounts.limit !== null && view.usage.accounts.used >= view.usage.accounts.limit;
  const samples = view.accounts.filter((a) => SAMPLE_SERVICES.has(a.connectorId));
  const real = view.accounts.filter((a) => !SAMPLE_SERVICES.has(a.connectorId));
  const layout = arrangeCatalog(view.catalog);
  const total = view.catalog.length;
  return (
    <AppShell ctx={ctx} shell={shell} section="services" title={t('app.nav.services')}>
      <PageHead title={t('app.nav.services')} sub={t('app.services.sub')} />
      {view.customDraft ? null : <Flash flash={view.flash} />}
      <div class="card flush">
        <div class="card-head pad">
          <h2>
            {t('app.services.connected')}{' '}
            <span class="badge">
              {view.usage.accounts.used}
              {view.usage.accounts.limit === null ? '' : ` / ${view.usage.accounts.limit}`}
            </span>
          </h2>
          {real.length ? (
            <a class="btn sm ghost add-jump" href="#add" aria-label={t('app.services.addService')}>
              <Icon name="plus" /> <span class="btn-label">{t('app.services.addService')}</span>
            </a>
          ) : null}
        </div>
        {real.length === 0 ? <p class="muted pad-x">{t('app.services.none')}</p> : null}
        {real.length || samples.length ? (
          <div class="acc-list">
            {groupByService(real).map(([service, accounts]) => (
              <>
                <div class="acc-group">
                  {service} <span class="muted">· {accounts.length}</span>
                </div>
                {accounts.map((a) => (
                  <AccountRow ctx={ctx} a={a} />
                ))}
              </>
            ))}
            <SampleAccounts ctx={ctx} accounts={samples} />
          </div>
        ) : null}
      </div>
      {full ? (
        <div class="notice">
          {t('app.services.full', { n: view.usage.accounts.limit ?? 0 })}{' '}
          <a href="/app/billing">{t('app.billing.upgrade')}</a>
        </div>
      ) : null}
      <div class="card add-card" id="add">
        <div class="card-head add-head">
          <h2>{t('app.services.addService')}</h2>
          <p class="muted small">{t('app.services.addHint')}</p>
        </div>
        <div class="svc-bar">
          <div class="svc-bar-row">
            <div class="search-box">
              <Icon name="search" />
              <input
                type="search"
                id="svc-q"
                placeholder={t('services.search')}
                aria-label={t('services.search')}
                data-filter="#svc-all-list"
                data-filter-empty="#catalog-none"
                data-filter-empty-chip="#catalog-none-chip"
                data-filter-expand="#all-services"
                data-filter-hide="#popular"
                data-filter-count="#svc-count"
                data-filter-clear="#svc-clear"
                data-filter-enter=""
                autocomplete="off"
              />
              <button
                type="button"
                class="search-clear"
                id="svc-clear"
                aria-label={t('app.services.clear')}
                title={t('app.services.clear')}
                hidden
              >
                <Icon name="x" />
              </button>
            </div>
            <button
              type="button"
              class="sm svc-fewer"
              data-collapse="#all-services"
              aria-label={t('app.services.showFewer')}
              title={t('app.services.showFewer')}
              hidden
            >
              <span class="label-long">{t('app.services.showFewer')}</span>
              <span class="label-short">{t('app.services.less')}</span> <Icon name="chevron" class="up" />
            </button>
          </div>
          <div class="svc-chips-wrap">
            <fieldset class="svc-chips" data-chips="#svc-all-list" hidden>
              <legend class="sr-only">{t('app.services.categories')}</legend>
              <button type="button" data-chip="" aria-pressed="true">
                {t('app.services.allCategories')}
              </button>
              {layout.groups.map(([category]) => (
                <button type="button" data-chip={category} aria-pressed="false">
                  {t(`category.${category}`)}
                </button>
              ))}
              {layout.unavailable.length ? (
                <button type="button" data-chip="unavailable" aria-pressed="false">
                  {t('app.services.notReady')}
                </button>
              ) : null}
            </fieldset>
            <span class="chips-arrow prev" data-chips-prev aria-hidden="true" hidden>
              <Icon name="chevron" />
            </span>
            <span class="chips-arrow next" data-chips-next aria-hidden="true" hidden>
              <Icon name="chevron" />
            </span>
          </div>
        </div>
        <p class="sr-only" id="svc-count" aria-live="polite" data-template={t('app.services.found')} />
        <section id="popular" aria-labelledby="popular-title">
          <h3 class="svc-section" id="popular-title">
            {t('app.services.popular')}
          </h3>
          <div class="svc-grid popular">
            {layout.popular.map((s) => (
              <ServiceTile ctx={ctx} s={s} full={full} />
            ))}
          </div>
        </section>
        <p class="muted svc-none" id="catalog-none" hidden>
          {t('app.services.noMatch')} <a href="#custom">{t('app.services.noMatchCustom')}</a>
        </p>
        <p class="muted svc-none" id="catalog-none-chip" hidden>
          {t('app.services.noMatchInCategory')}{' '}
          <button type="button" class="link-btn" data-chips-reset="#svc-all-list" data-focus-after="#svc-q">
            {t('app.services.searchAll')}
          </button>
        </p>
        <details class="svc-all" id="all-services" data-focus-on-open="#svc-q" data-scroll-on-open="#add">
          <summary>
            <span class="when-closed">
              {t('app.services.showAll', { n: total })} <Icon name="chevron" />
            </span>
            <span class="when-open">
              {t('app.services.showFewer')} <Icon name="chevron" class="up" />
            </span>
          </summary>
          <div id="svc-all-list">
            {layout.groups.map(([category, entries]) => (
              <section
                data-filter-group
                data-group={category}
                class="svc-cat"
                aria-labelledby={`cat-${category}`}
              >
                <h3 class="svc-section" id={`cat-${category}`}>
                  {t(`category.${category}`)}{' '}
                  <span class="muted">· {entries.length + (category === 'custom' ? 1 : 0)}</span>
                </h3>
                <div class="svc-grid">
                  {entries.map((s) => (
                    <ServiceTile ctx={ctx} s={s} full={full} anchor />
                  ))}
                  {category === 'custom' ? (
                    <div
                      class="svc-tile"
                      data-search={searchText(
                        'mcp',
                        'MCP',
                        `${t('app.custom.tile')} ${t('app.custom.text')}`,
                      )}
                    >
                      <ServiceLogo glyph="layers" name="MCP" />
                      <div class="grow">
                        <div class="svc-name">
                          <a class="stretch" href="#custom">
                            {t('app.custom.tile')}
                          </a>
                        </div>
                        <p>{t('app.custom.tileText')}</p>
                      </div>
                      <span class="svc-go" aria-hidden="true">
                        <Icon name="arrow" />
                      </span>
                    </div>
                  ) : null}
                </div>
              </section>
            ))}
            {layout.unavailable.length ? (
              <section
                data-filter-group
                data-group="unavailable"
                class="svc-cat"
                aria-labelledby="cat-unavailable"
              >
                <h3 class="svc-section" id="cat-unavailable">
                  {t('app.services.notReady')} <span class="muted">· {layout.unavailable.length}</span>
                </h3>
                <div class="svc-grid">
                  {layout.unavailable.map((s) => (
                    <ServiceTile ctx={ctx} s={s} full={full} anchor />
                  ))}
                </div>
              </section>
            ) : null}
            <button type="button" class="ghost sm block svc-collapse" data-collapse="#all-services" hidden>
              <Icon name="chevron" class="up" /> {t('app.services.showFewer')}
            </button>
          </div>
        </details>
      </div>
      <details class="card fold" id="custom" open={Boolean(view.customDraft) || view.custom.length > 0}>
        <summary>
          <span class="grow">
            <span class="fold-title">
              {t('app.custom.title')}
              {view.custom.length ? <span class="badge tiny-badge">{view.custom.length}</span> : null}
            </span>
            <span class="muted small fold-sub">{t('app.custom.text')}</span>
          </span>
        </summary>
        <div class="fold-body">
          {view.custom.length ? (
            <ul class="plain">
              {view.custom.map((c) => (
                <li>
                  <span class="grow">
                    <strong>{c.name}</strong>{' '}
                    <span class="small muted">
                      {c.kind === 'mcp' ? 'MCP' : 'HTTP'} · {t('app.custom.tools', { n: c.tools })}
                      {c.url ? ` · ${c.url}` : ''}
                    </span>
                    {c.lastError ? <div class="small error">{c.lastError}</div> : null}
                  </span>
                  <form
                    method="post"
                    action={`/app/custom/${c.connectorId}/delete`}
                    data-confirm={t('app.custom.deleteConfirm', { name: c.name })}
                  >
                    <input type="hidden" name="csrf" value={ctx.csrf} />
                    <button type="submit" class="sm danger">
                      {t('app.acc.delete')}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          ) : null}
          {view.customDraft ? <Flash flash={view.flash} /> : null}
          <form method="post" action="/app/custom" class="inline-form">
            <input type="hidden" name="csrf" value={ctx.csrf} />
            <div>
              <label for="mcp-name">{t('app.custom.name')}</label>
              <input
                id="mcp-name"
                type="text"
                name="name"
                required
                maxlength={60}
                placeholder="CRM"
                value={view.customDraft?.name ?? ''}
              />
            </div>
            <div class="wide-2">
              <label for="mcp-url-in">{t('app.custom.url')}</label>
              <input
                id="mcp-url-in"
                type="url"
                name="url"
                required
                placeholder="https://example.com/mcp"
                value={view.customDraft?.url ?? ''}
              />
            </div>
            <div class="wide">
              <label for="mcp-token">{t('app.custom.token')}</label>
              <input id="mcp-token" type="password" name="token" autocomplete="off" maxlength={4000} />
              <p class="hint">{t('app.custom.tokenHint')}</p>
            </div>
            <div>
              <button type="submit" class="block">
                <Icon name="plus" /> {t('app.custom.add')}
              </button>
            </div>
          </form>
          <p class="hint">{t('app.custom.hint')}</p>
        </div>
      </details>
    </AppShell>
  );
};

// ---------------------------------------------------------------------------
// AI apps
// ---------------------------------------------------------------------------

export interface AppsView {
  grants: {
    id: string;
    name: string;
    client: string | null;
    /** The AI app it belongs to (its page is `/app/apps/:id`). */
    appId: string | null;
    /** The access profile it connected through, if any. */
    profile: string | null;
    createdAt: Date;
    lastUsedAt: Date | null;
  }[];
  tokens: {
    id: string;
    name: string;
    appId: string | null;
    profile: string | null;
    /** Also allowed to use the management API (not just MCP). */
    api: boolean;
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
  }[];
  /** Access profiles (personas): own MCP addresses with some accounts (`/app/profiles`). */
  profiles: { id: string; name: string; slug: string; accounts: number; apps: number }[];
  /** A token just created: shown once. */
  newToken?: string | undefined;
  flash?: { kind: 'ok' | 'bad'; text: string } | undefined;
}

/** An app's or token's name, linking to the AI app's own page when it has one. */
const AppName: FC<{ id: string | null; name: string }> = ({ id, name }) =>
  id ? (
    <a class="acc-link" href={`/app/apps/${encodeURIComponent(id)}`}>
      <strong>{name}</strong>
    </a>
  ) : (
    <strong>{name}</strong>
  );

export const AppsPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: AppsView }> = ({ ctx, shell, view }) => {
  const { t, lang } = ctx;
  return (
    <AppShell ctx={ctx} shell={shell} section="apps" title={t('app.nav.apps')}>
      <PageHead title={t('app.nav.apps')} sub={t('app.apps.sub')} />
      <Flash flash={view.flash} />
      <ConnectAiCard ctx={ctx} />
      <div class="card flush">
        <div class="card-head pad">
          <h2>{t('app.apps.connected')}</h2>
        </div>
        {view.grants.length === 0 ? (
          <p class="muted pad-x">{t(view.tokens.length ? 'aiapp.noSignIns' : 'home.noApps')}</p>
        ) : (
          <ul class="plain pad-x">
            {view.grants.map((g) => (
              <li>
                <span class="grow">
                  <AppName id={g.appId} name={g.name} />
                  {g.client && g.client !== g.name ? <span class="badge">{g.client}</span> : null}
                  {g.profile ? (
                    <span class="badge accent">{t('profiles.badge', { name: g.profile })}</span>
                  ) : null}
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
                  <input type="hidden" name="csrf" value={ctx.csrf} />
                  <button class="sm danger" type="submit">
                    {t('home.revoke')}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div class="card" id="profiles">
        <div class="card-head">
          <h2>{t('profiles.title')}</h2>
          <a class={view.profiles.length ? 'btn sm' : 'btn sm primary'} href="/app/profiles">
            {view.profiles.length ? t('profiles.manage') : t('profiles.createFirst')}
          </a>
        </div>
        <p class="muted">{t('profiles.appsText')}</p>
        {view.profiles.length ? (
          <ul class="plain">
            {view.profiles.map((p) => (
              <li>
                <span class="grow">
                  <a class="acc-link" href={`/app/profiles/${encodeURIComponent(p.id)}`}>
                    <strong>{p.name}</strong>
                  </a>{' '}
                  <code class="small">/mcp/{p.slug}</code>
                </span>
                <span class="small muted">
                  {t('profiles.accountsN', { n: p.accounts })} ·{' '}
                  {p.apps ? t('profiles.appsN', { n: p.apps }) : t('profiles.noApps')}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div class="card" id="tokens">
        <h2>{t('app.tokens.title')}</h2>
        <p class="muted">{t('app.tokens.text')}</p>
        {view.newToken ? (
          <div class="notice ok" data-replace-url="/app/apps">
            <p>
              <strong>{t('app.tokens.created')}</strong> {t('app.tokens.once')}
            </p>
            <CopyField t={t} id="new-token" value={view.newToken} label={t('app.tokens.title')} />
          </div>
        ) : null}
        {view.tokens.length ? (
          <ul class="plain">
            {view.tokens.map((tok) => (
              <li>
                <span class="grow">
                  <AppName id={tok.appId} name={tok.name} />
                  {tok.profile ? (
                    <span class="badge accent">{t('profiles.badge', { name: tok.profile })}</span>
                  ) : null}
                  <span class={tok.api ? 'badge warn' : 'badge'}>
                    {t(tok.api ? 'app.tokens.scopeApi' : 'app.tokens.scopeMcp')}
                  </span>
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
                  <input type="hidden" name="csrf" value={ctx.csrf} />
                  <button class="sm danger" type="submit">
                    {t('home.revoke')}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : null}
        <form method="post" action="/app/tokens" class="inline-form">
          <input type="hidden" name="csrf" value={ctx.csrf} />
          <div class="wide-2">
            <label for="tok-name">{t('app.tokens.name')}</label>
            <input
              id="tok-name"
              type="text"
              name="name"
              required
              maxlength={80}
              placeholder={t('app.tokens.placeholder')}
            />
          </div>
          {view.profiles.length ? (
            <div>
              <label for="tok-profile">{t('profiles.tokenFor')}</label>
              <select id="tok-profile" name="profile">
                <option value="">{t('profiles.tokenMain')}</option>
                {view.profiles.map((p) => (
                  <option value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          ) : null}
          <div>
            <label for="tok-exp">{t('app.tokens.expiry')}</label>
            <select id="tok-exp" name="days">
              <option value="30">{t('app.tokens.days', { n: 30 })}</option>
              <option value="90" selected>
                {t('app.tokens.days', { n: 90 })}
              </option>
              <option value="365">{t('app.tokens.days', { n: 365 })}</option>
              <option value="0">{t('app.tokens.never')}</option>
            </select>
          </div>
          {/* The API switch and its explanation get their own line under the fields. */}
          <div class="wide">
            <label class="check">
              <input type="checkbox" name="api" value="1" /> {t('app.tokens.api')}
            </label>
            <p class="hint">{t('app.tokens.apiHint')}</p>
          </div>
          <div class="wide">
            <button type="submit" class="primary">
              {t('app.tokens.create')}
            </button>
          </div>
        </form>
        {view.profiles.length ? <p class="hint">{t('profiles.tokenHint')}</p> : null}
      </div>
    </AppShell>
  );
};

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export interface ActivityView {
  calls: CallView[];
  /** Calls per day for the last 30 days, oldest first. */
  daily: { day: string; calls: number; errors: number }[];
  byService: { connectorId: string; name: string; calls: number }[];
  total: number;
  errors: number;
  historyDays: number | null;
  /** Link to the next page of the log, when there is one. */
  more?: string | undefined;
  /** Link back to the newest rows with the same filters. */
  newest?: string | undefined;
  /** This page continues the log (not its newest rows). */
  paged?: boolean;
  /** What the log can be narrowed to, and what it is narrowed to now. */
  filters: {
    accounts: { id: string; label: string; service: string; detail?: string | undefined }[];
    services: { id: string; name: string }[];
    account?: string | undefined;
    service?: string | undefined;
    errors: boolean;
  };
}

export const ActivityPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: ActivityView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t, lang } = ctx;
  const max = Math.max(1, ...view.daily.map((d) => d.calls));
  const maxSvc = Math.max(1, ...view.byService.map((s) => s.calls));
  return (
    <AppShell ctx={ctx} shell={shell} section="activity" title={t('app.nav.activity')}>
      <PageHead title={t('app.nav.activity')} sub={t('app.activity.sub')} />
      <div class="grid-2">
        <div class="card">
          <div class="card-head">
            <h2>{t('app.activity.chart')}</h2>
            <span class="small muted">
              {t('app.activity.total', { n: fmtNumber(lang, view.total) })} ·{' '}
              {t('app.activity.errors', { n: fmtNumber(lang, view.errors) })}
            </span>
          </div>
          <div class="chart" role="img" aria-label={t('app.activity.chart')}>
            {view.daily.map((d) => (
              <div
                class={`col${d.calls === 0 ? ' zero' : ''}`}
                title={`${d.day}: ${t('app.activity.dayTitle', { n: d.calls, errors: d.errors })}`}
              >
                {/* Failed calls sit on top of the bar in red, so a bad day stands out. */}
                {d.errors ? <span class={`err ${pctClass('h', d.errors, max)}`} /> : null}
                <span class={pctClass('h', d.calls - d.errors, max)} />
              </div>
            ))}
          </div>
          <div class="chart-axis">
            <span>{view.daily[0] ? fmtDay(ctx.lang, view.daily[0].day) : null}</span>
            <span>{view.daily.length ? fmtDay(ctx.lang, view.daily.at(-1)!.day) : null}</span>
          </div>
        </div>
        <div class="card">
          <h2>{t('app.activity.byService')}</h2>
          {view.byService.length === 0 ? (
            <p class="muted">{t('app.activity.none')}</p>
          ) : (
            <div class="top-list">
              {view.byService.map((s) => (
                <div class="bar">
                  <span class="name">{s.name}</span>
                  <div class="meter">
                    <span class={pctClass('w', s.calls, maxSvc)} />
                  </div>
                  <span class="num small">{fmtNumber(lang, s.calls)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div class="card flush" id="log">
        <div class="card-head pad">
          <h2>{t('app.activity.log')}</h2>
          <span class="small muted">
            {view.historyDays ? t('app.activity.kept', { n: view.historyDays }) : null}
          </span>
        </div>
        <form method="get" action="/app/activity#log" class="log-filters pad-x" data-autosubmit>
          <label class="sr-only" for="f-account">
            {t('app.activity.filterAccount')}
          </label>
          <select id="f-account" name="account">
            <option value="">{t('app.activity.allAccounts')}</option>
            {view.filters.accounts.map((a) => (
              <option value={a.id} selected={view.filters.account === a.id}>
                {a.label === a.service ? a.service : `${a.label} · ${a.service}`}
                {a.detail ? ` · ${a.detail}` : ''}
              </option>
            ))}
          </select>
          <label class="sr-only" for="f-service">
            {t('app.activity.filterService')}
          </label>
          <select id="f-service" name="service">
            <option value="">{t('app.activity.allServices')}</option>
            {view.filters.services.map((x) => (
              <option value={x.id} selected={view.filters.service === x.id}>
                {x.name}
              </option>
            ))}
          </select>
          <label class="check log-errors">
            <input type="checkbox" name="status" value="error" checked={view.filters.errors} />{' '}
            {t('app.activity.errorsOnly')}
          </label>
          <button type="submit" class="sm">
            {t('app.activity.apply')}
          </button>
          {view.filters.account || view.filters.service || view.filters.errors ? (
            <a class="small" href="/app/activity#log">
              {t('app.activity.reset')}
            </a>
          ) : null}
        </form>
        <CallsTable
          ctx={ctx}
          calls={view.calls}
          empty={t(
            view.filters.account || view.filters.service || view.filters.errors
              ? 'app.activity.noneFiltered'
              : 'app.activity.none',
          )}
          withClient
        />
        {view.more || view.paged ? (
          <div class="actions start pad-x">
            {view.paged ? (
              <a class="btn sm" href={view.newest ?? '/app/activity#log'}>
                {t('app.activity.newest')}
              </a>
            ) : null}
            {view.more ? (
              <a class="btn sm" href={view.more}>
                {t('app.activity.more')}
              </a>
            ) : null}
          </div>
        ) : null}
        <p class="hint pad-x">{t('app.activity.privacy')}</p>
      </div>
    </AppShell>
  );
};

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export interface BillingView {
  usage: UsageView;
  plan: Plan;
  subscription?: { provider: string; periodEnd: Date | null; status: string } | undefined;
  /** A subscription the payment provider charges for (managed in its portal). */
  paid?:
    | {
        provider: string;
        status: string;
        interval: 'month' | 'year' | null;
        periodEnd: Date | null;
        cancelAtPeriodEnd: boolean;
      }
    | undefined;
  /** `plan:interval` pairs that can be bought right now. */
  buyable: string[];
  /** The provider runs in sandbox / test mode: no real charges. */
  testMode: boolean;
  /** Back from the provider's checkout. */
  justPaid: boolean;
  /** A plan the AI assistant sent the user here to buy (`?plan=pro&interval=year`). */
  focus?: { planId: string; interval: 'month' | 'year' } | undefined;
  grants: { metric: Metric; amount: number | null; expiresAt: Date | null; reason: string | null }[];
  /** An open "switch me to this plan" request (manual payments). */
  requested?: { planId: string; at: Date } | undefined;
  flash?: { kind: 'ok' | 'bad'; text: string } | undefined;
  /** The plan is a gift (a month of Pro for an invite), not bought: it can still be bought. */
  gift: boolean;
  /** The user's invite link and what it brought. */
  invite?: { link: string; invited: number; rewarded: number; days: number } | undefined;
}

const planLabel = (ctx: PageCtx, id: string) => ctx.t(`plan.${id}.name` as 'plan.free.name');

/** The buy (or switch) button of a plan, posting the interval the page switch shows. */
const BuyForm: FC<{
  ctx: PageCtx;
  plan: Plan;
  interval: 'month' | 'year' | 'switch';
  switching: boolean;
  primary?: boolean;
}> = ({ ctx, plan, interval, switching, primary }) => (
  <form method="post" action="/app/billing/checkout">
    <Hidden values={{ csrf: ctx.csrf, plan: plan.id }} />
    {interval === 'switch' ? (
      <input type="hidden" name="interval" value="month" data-interval-input />
    ) : (
      <input type="hidden" name="interval" value={interval} />
    )}
    <button
      type="submit"
      class={`block ${primary ? 'primary' : ''}`}
      {...(switching
        ? { 'data-confirm': ctx.t('app.billing.switchConfirm', { plan: planLabel(ctx, plan.id) }) }
        : {})}
    >
      {ctx.t(switching ? 'app.billing.switch' : 'pricing.choose', { plan: planLabel(ctx, plan.id) })}
    </button>
  </form>
);

/** Status, renewal and the buttons of a subscription paid through the provider. */
const PaidSubscription: FC<{ ctx: PageCtx; paid: NonNullable<BillingView['paid']> }> = ({ ctx, paid }) => {
  const { t, lang } = ctx;
  const date = paid.periodEnd ? fmtDate(lang, paid.periodEnd) : '';
  return (
    <div class="paid-sub">
      {paid.status === 'past_due' ? <div class="notice bad">{t('app.billing.pastDue')}</div> : null}
      <p>
        {t(paid.interval === 'year' ? 'app.billing.paidYearly' : 'app.billing.paidMonthly', {
          provider: paid.provider,
        })}{' '}
        {date
          ? paid.cancelAtPeriodEnd
            ? t('app.billing.endsOn', { date })
            : t('app.billing.renewsOn', { date })
          : null}
      </p>
      <div class="actions start">
        <form method="post" action="/app/billing/portal">
          <Hidden values={{ csrf: ctx.csrf }} />
          <button type="submit">{t('app.billing.manage')}</button>
        </form>
        <form
          method="post"
          action="/app/billing/cancel"
          {...(paid.cancelAtPeriodEnd ? {} : { 'data-confirm': t('app.billing.cancelConfirm', { date }) })}
        >
          <Hidden values={{ csrf: ctx.csrf, ...(paid.cancelAtPeriodEnd ? { undo: '1' } : {}) }} />
          <button type="submit" class={paid.cancelAtPeriodEnd ? 'primary' : 'ghost'}>
            {t(paid.cancelAtPeriodEnd ? 'app.billing.resume' : 'app.billing.cancel')}
          </button>
        </form>
      </div>
      <p class="hint">{t('app.billing.manageHint')}</p>
    </div>
  );
};

/** The published start of a free workspace: trial, steps down, then the plan's own limit. */
const StartSchedule: FC<{ ctx: PageCtx; usage: UsageView }> = ({ ctx, usage }) => {
  const { t, lang } = ctx;
  const schedule = usage.schedule ?? [];
  const now = Date.now();
  const actions = (n: number | null) =>
    n === null ? t('plan.metric.actions.unlimited') : t('plan.metric.actions', { n: fmtNumber(lang, n) });
  const last = schedule[schedule.length - 1];
  return (
    <div class="start-schedule">
      <h3>{t('app.billing.start')}</h3>
      <ol class="plain">
        {schedule.map((p) => {
          const current = p.from.getTime() <= now && now < p.until.getTime();
          return (
            <li class={current ? 'current' : p.until.getTime() <= now ? 'past' : undefined}>
              <span>
                {p.kind === 'trial'
                  ? t('app.billing.startTrial', {
                      plan: t(`plan.${p.asPlan ?? 'pro'}.name` as 'plan.free.name'),
                    })
                  : actions(p.actions)}
                {current ? <span class="badge accent">{t('app.billing.startNow')}</span> : null}
              </span>
              <span class="small muted">
                {t('app.billing.startDates', {
                  from: fmtDate(lang, p.from),
                  until: fmtDate(lang, new Date(p.until.getTime() - 86_400_000)),
                })}
              </span>
            </li>
          );
        })}
        {last ? (
          <li class={last.until.getTime() <= now ? 'current' : undefined}>
            <span>{actions(usage.planLimitActions ?? null)}</span>
            <span class="small muted">
              {t('app.billing.startAfter', { date: fmtDate(lang, last.until) })}
            </span>
          </li>
        ) : null}
      </ol>
      <p class="hint">{t('app.billing.startHint')}</p>
    </div>
  );
};

/** "Invite friends": the link, the reward and how many joined. */
const InviteCard: FC<{ ctx: PageCtx; invite: NonNullable<BillingView['invite']> }> = ({ ctx, invite }) => {
  const { t } = ctx;
  return (
    <div class="card" id="invite">
      <h2>{t('app.invite.title')}</h2>
      <p class="muted">{t('app.invite.text', { days: invite.days })}</p>
      <CopyField t={t} id="invite-link" value={invite.link} label={t('app.invite.link')} />
      <p class="small muted">
        {t('app.invite.stats', { invited: invite.invited, rewarded: invite.rewarded })}
      </p>
    </div>
  );
};

export const BillingPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: BillingView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t, lang } = ctx;
  const canBuy = (id: string, interval: 'month' | 'year') => view.buyable.includes(`${id}:${interval}`);
  const focusPlan = view.focus ? PLANS.find((p) => p.id === view.focus!.planId) : undefined;
  return (
    <AppShell ctx={ctx} shell={shell} section="billing" title={t('app.nav.billing')}>
      <PageHead title={t('app.nav.billing')} sub={t('app.billing.sub')} />
      <Flash flash={view.flash} />
      {view.justPaid && !view.flash ? (
        <div class="notice ok">
          {view.paid
            ? t('app.billing.thanks', { plan: planLabel(ctx, view.plan.id) })
            : t('app.billing.processing')}
        </div>
      ) : null}
      {ctx.billing && view.testMode ? <div class="notice info">{t('app.billing.testMode')}</div> : null}
      {focusPlan && view.focus && view.plan.public && canBuy(focusPlan.id, view.focus.interval) ? (
        <div class="card focus-plan">
          <h2>
            {t(view.paid ? 'app.billing.focusSwitch' : 'app.billing.focusBuy', {
              plan: planLabel(ctx, focusPlan.id),
            })}
          </h2>
          <p class="muted">
            {view.focus.interval === 'year'
              ? t('app.billing.focusYear', { price: `$${focusPlan.priceYearly}` })
              : t('app.billing.focusMonth', { price: `$${focusPlan.priceMonthly}` })}
            {view.paid ? ` ${t('app.billing.prorated')}` : ''}
          </p>
          <BuyForm
            ctx={ctx}
            plan={focusPlan}
            interval={view.focus.interval}
            switching={Boolean(view.paid)}
            primary
          />
        </div>
      ) : null}
      <UsageStats ctx={ctx} usage={view.usage} />
      <div class="card">
        <div class="card-head">
          <h2>{t('app.billing.current', { plan: planLabel(ctx, view.plan.id) })}</h2>
          {view.subscription?.periodEnd && !view.paid ? (
            <span class="badge">
              {t('app.billing.until', { date: fmtDate(lang, view.subscription.periodEnd) })}
            </span>
          ) : null}
        </div>
        <p class="muted">
          {view.plan.id === 'unlimited' && ctx.user?.isAdmin
            ? t('app.billing.ownerPlan')
            : t(`plan.${view.plan.id}.for` as 'plan.free.for')}
        </p>
        {view.paid ? <PaidSubscription ctx={ctx} paid={view.paid} /> : null}
        {!view.paid && view.usage.schedule?.length ? <StartSchedule ctx={ctx} usage={view.usage} /> : null}
        <p class="hint">{t('app.usage.actionsHint')}</p>
        {view.grants.length ? (
          <>
            <h3>{t('app.billing.bonuses')}</h3>
            <ul class="plain">
              {view.grants.map((g) => (
                <li>
                  <span>
                    <strong>
                      {g.amount === null
                        ? t('app.billing.bonusUnlimited', { metric: t(`pricing.row.${g.metric}`) })
                        : t('app.billing.bonus', {
                            n: fmtNumber(lang, g.amount),
                            metric: t(`pricing.row.${g.metric}`),
                          })}
                    </strong>
                    {g.reason ? <span class="small muted"> · {g.reason}</span> : null}
                  </span>
                  <span class="small muted">
                    {g.expiresAt
                      ? t('app.billing.until', { date: fmtDate(lang, g.expiresAt) })
                      : t('app.billing.forever')}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
      {view.invite ? <InviteCard ctx={ctx} invite={view.invite} /> : null}
      {!view.plan.public ? null : ctx.billing ? null : view.requested ? (
        <div class="notice info">
          {t('app.billing.requested', {
            plan: planLabel(ctx, view.requested.planId),
            date: fmtDate(lang, view.requested.at),
          })}
        </div>
      ) : (
        <div class="notice info">
          {ctx.supportEmail
            ? t('app.billing.manualEmail', { email: ctx.supportEmail })
            : t('app.billing.manual')}
        </div>
      )}
      {/* A special plan from the admin (e.g. unlimited) has nothing to switch to. */}
      <div data-interval="month" data-interval-root hidden={!view.plan.public}>
        <div class="row between">
          <h2>{t('app.billing.plans')}</h2>
          <fieldset class="billing-switch">
            <legend class="sr-only">{t('pricing.interval')}</legend>
            <button type="button" aria-pressed="true" data-interval-set="month">
              {t('pricing.monthly')}
            </button>
            <button type="button" aria-pressed="false" data-interval-set="year">
              {t('pricing.yearly')} <span class="save">{t('pricing.save')}</span>
            </button>
          </fieldset>
        </div>
        <div class="plan-mini">
          {PLANS.filter((p) => p.public).map((plan) => (
            <PlanCard
              ctx={ctx}
              plan={plan}
              current={plan.id === view.plan.id}
              action={
                plan.id === view.plan.id && !view.gift ? (
                  <span class="btn block" aria-disabled="true">
                    {t('app.billing.yours')}
                  </span>
                ) : plan.audience === 'team' ? (
                  <a class="btn block" href="/app/teams">
                    {t('app.billing.forTeams')}
                  </a>
                ) : plan.priceMonthly === 0 ? (
                  view.paid ? (
                    <span class="small muted">{t('app.billing.freeByCancel')}</span>
                  ) : null
                ) : ctx.billing && (canBuy(plan.id, 'month') || canBuy(plan.id, 'year')) ? (
                  <BuyForm
                    ctx={ctx}
                    plan={plan}
                    interval={
                      canBuy(plan.id, 'month') && canBuy(plan.id, 'year')
                        ? 'switch'
                        : canBuy(plan.id, 'month')
                          ? 'month'
                          : 'year'
                    }
                    switching={Boolean(view.paid)}
                    primary={plan.featured === true}
                  />
                ) : view.requested?.planId === plan.id ? (
                  <span class="btn block" aria-disabled="true">
                    {t('app.billing.requestSent')}
                  </span>
                ) : (
                  <form method="post" action="/app/billing/request">
                    <Hidden values={{ csrf: ctx.csrf, plan: plan.id }} />
                    <input type="hidden" name="interval" value="month" data-interval-input />
                    <button type="submit" class={`block ${plan.featured ? 'primary' : ''}`}>
                      {t('app.billing.request', { plan: planLabel(ctx, plan.id) })}
                    </button>
                  </form>
                )
              }
            />
          ))}
        </div>
        {ctx.billing ? <p class="hint">{t('app.billing.taxHint')}</p> : null}
      </div>
    </AppShell>
  );
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingsView {
  name: string | null;
  email: string;
  locale: string | null;
  toolListing: 'auto' | 'direct' | 'discovery';
  toolExposure: 'grouped' | 'per_account';
  identities: { provider: string; email: string | null }[];
  hasPassword: boolean;
  sessions: { current: boolean; ip: string | null; userAgent: string | null; lastSeenAt: Date }[];
  recentAuth: boolean;
  flash?: { kind: 'ok' | 'bad'; text: string } | undefined;
}

const agentName = (ua: string | null): string | null => {
  if (!ua) return null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
      ? /iPhone|iPad/.test(ua)
        ? 'iOS'
        : 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Linux/.test(ua)
          ? 'Linux'
          : '';
  return os ? `${browser} · ${os}` : browser;
};

export const SettingsPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: SettingsView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t, lang } = ctx;
  return (
    <AppShell ctx={ctx} shell={shell} section="settings" title={t('app.nav.settings')}>
      <PageHead title={t('app.nav.settings')} />
      <Flash flash={view.flash} />
      <div class="grid-2">
        <div class="card">
          <h2>{t('app.settings.profile')}</h2>
          <form method="post" action="/app/settings/profile">
            <input type="hidden" name="csrf" value={ctx.csrf} />
            <label for="name">{t('app.settings.name')}</label>
            <input
              id="name"
              type="text"
              name="name"
              value={view.name ?? ''}
              maxlength={100}
              autocomplete="name"
            />
            <label for="email">{t('login.email')}</label>
            <input id="email" type="email" value={view.email} readonly aria-describedby="email-hint" />
            <p class="hint" id="email-hint">
              {t('app.settings.emailHint')}
            </p>
            <label for="locale">{t('app.settings.language')}</label>
            <select id="locale" name="locale">
              <option value="" selected={!view.locale}>
                {t('app.settings.langAuto')}
              </option>
              <option value="ru" selected={view.locale === 'ru'}>
                Русский
              </option>
              <option value="en" selected={view.locale === 'en'}>
                English
              </option>
            </select>
            <div class="actions start">
              <button type="submit" class="primary">
                {t('app.settings.save')}
              </button>
            </div>
          </form>
          <hr />
          <h3>{t('app.settings.signin')}</h3>
          <ul class="plain">
            {view.identities.map((i) => (
              <li>
                <span>{i.provider === 'google' ? 'Google' : i.provider}</span>
                <span class="small muted">{i.email}</span>
              </li>
            ))}
            {view.hasPassword ? (
              <li>
                <span>{t('app.settings.password')}</span>
                <span class="small muted">{t('app.settings.passwordHint')}</span>
              </li>
            ) : null}
          </ul>
          <p class="hint">
            <a href="/security">{t('app.settings.securityLink')}</a>
          </p>
        </div>
        <div class="card">
          <h2>{t('app.settings.ai')}</h2>
          <p class="muted small">{t('app.settings.aiText')}</p>
          <form method="post" action="/app/settings/tools">
            <input type="hidden" name="csrf" value={ctx.csrf} />
            <label for="listing">{t('app.settings.listing')}</label>
            <select id="listing" name="toolListing">
              {(['auto', 'direct', 'discovery'] as const).map((v) => (
                <option value={v} selected={view.toolListing === v}>
                  {t(`app.settings.listing.${v}`)}
                </option>
              ))}
            </select>
            <p class="hint">{t('app.settings.listingHint')}</p>
            <label for="exposure">{t('app.settings.exposure')}</label>
            <select id="exposure" name="toolExposure">
              {(['grouped', 'per_account'] as const).map((v) => (
                <option value={v} selected={view.toolExposure === v}>
                  {t(`app.settings.exposure.${v}`)}
                </option>
              ))}
            </select>
            <p class="hint">{t('app.settings.exposureHint')}</p>
            <div class="actions start">
              <button type="submit" class="primary">
                {t('app.settings.save')}
              </button>
            </div>
          </form>
        </div>
      </div>
      <div class="card flush" id="sessions">
        <div class="card-head pad">
          <h2>{t('app.settings.sessions')}</h2>
          {view.sessions.length > 1 ? (
            <form method="post" action="/app/settings/sessions/others">
              <input type="hidden" name="csrf" value={ctx.csrf} />
              <button type="submit" class="sm">
                {t('app.settings.signOutOthers')}
              </button>
            </form>
          ) : null}
        </div>
        <ul class="plain pad-x">
          {view.sessions.map((s) => (
            <li>
              <span>
                {agentName(s.userAgent) ?? t('app.settings.unknownDevice')}
                {s.current ? ' ' : null}
                {s.current ? <span class="badge ok">{t('app.settings.thisDevice')}</span> : null}
              </span>
              <span class="small muted">
                {s.ip ? `${s.ip} · ` : ''}
                {fmtAgo(lang, s.lastSeenAt)}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div class="card danger-zone">
        <h2>{t('app.settings.delete')}</h2>
        <p class="muted">{t('app.settings.deleteText')}</p>
        {ctx.user?.isAdmin ? <p class="small muted">{t('app.settings.adminNote')}</p> : null}
        {view.recentAuth ? (
          <form method="post" action="/app/settings/delete" data-confirm={t('app.settings.deleteConfirm')}>
            <input type="hidden" name="csrf" value={ctx.csrf} />
            <label for="confirm-email">{t('app.settings.deleteType', { email: view.email })}</label>
            <input id="confirm-email" type="email" name="email" required autocomplete="off" />
            <div class="actions start">
              <button type="submit" class="danger">
                {t('app.settings.deleteCta')}
              </button>
            </div>
          </form>
        ) : (
          <div class="reauth-row">
            <a class="btn" href={`/login?reauth=1&next=${encodeURIComponent('/app/settings')}`}>
              {t('security.reauth')}
            </a>
            <span class="small muted">{t('app.settings.deleteReauth')}</span>
          </div>
        )}
      </div>
    </AppShell>
  );
};
