import type { FC } from 'hono/jsx';
import type {
  Count,
  Dimension,
  Filter,
  FunnelRow,
  PlanKind,
  PlansReport,
  ProductReport,
  RetentionReport,
  TrafficReport,
} from '../analytics/reports.js';
import { NONE } from '../analytics/reports.js';
import { AppShell, PageHead, type ShellInfo } from './app.js';
import type { Key } from './i18n.js';
import type { PageCtx } from './page-context.js';
import { fmtDay, fmtNumber, Icon, pctClass } from './ui.js';

export const ANALYTICS_TABS = ['traffic', 'funnel', 'product', 'plans', 'retention'] as const;
export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];
export const RANGES = [7, 30, 90, 365] as const;
/** Dimensions the funnel can be split by, in the order of the switch. */
export const FUNNEL_BY: readonly Dimension[] = [
  'source',
  'campaign',
  'medium',
  'country',
  'language',
  'device',
  'landing',
  'referrer',
];

export interface AnalyticsView {
  tab: AnalyticsTab;
  days: number;
  range: { from: string; to: string };
  filter: Filter;
  by: Dimension;
  /** Display names of services by connector id. */
  services: Record<string, string>;
  traffic?: TrafficReport;
  funnel?: FunnelRow[];
  product?: ProductReport;
  plans?: PlansReport;
  retention?: RetentionReport;
}

/** The page's own address with some parameters changed (`null` removes one). */
function href(view: AnalyticsView, change: Record<string, string | number | null>): string {
  const params = new URLSearchParams();
  const base: Record<string, string> = { tab: view.tab, days: String(view.days) };
  if (view.tab === 'funnel') base.by = view.by;
  for (const [dim, value] of Object.entries(view.filter)) base[`f.${dim}`] = value;
  for (const [key, value] of Object.entries({ ...base, ...change })) {
    if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
  }
  if (params.get('tab') === 'traffic') params.delete('tab');
  if (params.get('days') === '30') params.delete('days');
  const qs = params.toString();
  return `/admin/analytics${qs ? `?${qs}` : ''}`;
}

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : '—');

function money(lang: string, usd: number): string {
  return new Intl.NumberFormat(lang === 'ru' ? 'ru-RU' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: usd >= 1000 ? 0 : 2,
  }).format(usd);
}

/** A readable name for a dimension value: countries and languages by name, the rest as stored. */
function label(
  ctx: PageCtx,
  dim: Dimension | 'connector',
  value: string,
  services: Record<string, string>,
): string {
  const { t, lang } = ctx;
  if (value === NONE) return t('an.none');
  if (dim === 'connector') return services[value] ?? value;
  if (dim === 'source' && value === 'direct') return t('an.direct');
  if (dim === 'source' && value === 'unknown') return t('an.unknown');
  if (dim === 'medium' && (value === 'none' || value === 'unknown'))
    return value === 'none' ? t('an.direct') : t('an.unknown');
  try {
    if (dim === 'country') return new Intl.DisplayNames([lang], { type: 'region' }).of(value) ?? value;
    if (dim === 'language') return new Intl.DisplayNames([lang], { type: 'language' }).of(value) ?? value;
  } catch {
    return value;
  }
  if (dim === 'device') return t(`an.device.${value}` as Key) ?? value;
  if (dim === 'medium') return t(`an.medium.${value}` as Key) ?? value;
  if (dim === 'browser' || dim === 'os') return PRETTY[value] ?? value;
  return value;
}

/** How browsers and systems are spelled (the stored value is a lower-case family). */
const PRETTY: Record<string, string> = {
  chrome: 'Chrome',
  safari: 'Safari',
  firefox: 'Firefox',
  edge: 'Edge',
  opera: 'Opera',
  yandex: 'Yandex Browser',
  samsung: 'Samsung Internet',
  vivaldi: 'Vivaldi',
  telegram: 'Telegram',
  in_app: 'In-app browser',
  other: 'Other',
  macos: 'macOS',
  ios: 'iOS',
  android: 'Android',
  windows: 'Windows',
  linux: 'Linux',
  chromeos: 'ChromeOS',
};

const DIM_KEY: Record<Dimension, Key> = {
  source: 'an.dim.source',
  medium: 'an.dim.medium',
  campaign: 'an.dim.campaign',
  referrer: 'an.dim.referrer',
  landing: 'an.dim.landing',
  country: 'an.dim.country',
  language: 'an.dim.language',
  device: 'an.dim.device',
  browser: 'an.dim.browser',
  os: 'an.dim.os',
};

const TAB_KEY: Record<AnalyticsTab, Key> = {
  traffic: 'an.tab.traffic',
  funnel: 'an.tab.funnel',
  product: 'an.tab.product',
  plans: 'an.tab.plans',
  retention: 'an.tab.retention',
};

export const AdminAnalyticsPage: FC<{ ctx: PageCtx; shell: ShellInfo; view: AnalyticsView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t, lang } = ctx;
  const filters = Object.entries(view.filter) as [Dimension, string][];
  return (
    <AppShell ctx={ctx} shell={shell} section="admin-analytics" title={t('admin.nav.analytics')}>
      <PageHead
        title={t('an.title')}
        sub={t('an.sub', { from: fmtDay(lang, view.range.from), to: fmtDay(lang, view.range.to) })}
      />
      <nav class="nav-tabs" aria-label={t('an.title')}>
        {ANALYTICS_TABS.map((tab) => (
          <a
            class="tab"
            href={href(view, { tab, by: null })}
            aria-current={tab === view.tab ? 'page' : undefined}
          >
            {t(TAB_KEY[tab])}
          </a>
        ))}
      </nav>
      <div class="row filter-links an-controls">
        {view.tab === 'retention' ? null : (
          <span class="seg" title={t('an.range')}>
            {RANGES.map((d) => (
              <a
                class="btn sm"
                href={href(view, { days: d })}
                aria-current={d === view.days ? 'page' : undefined}
              >
                {d === 365 ? t('an.range.year') : t('an.range.days', { n: d })}
              </a>
            ))}
          </span>
        )}
        {filters.map(([dim, value]) => (
          <a
            class="badge accent an-filter"
            href={href(view, { [`f.${dim}`]: null })}
            title={t('an.filter.remove')}
          >
            {t(DIM_KEY[dim])}: {label(ctx, dim, value, view.services)} <Icon name="x" />
          </a>
        ))}
      </div>
      {view.tab === 'traffic' && view.traffic ? (
        <Traffic ctx={ctx} view={view} report={view.traffic} />
      ) : null}
      {view.tab === 'funnel' && view.funnel ? <Funnel ctx={ctx} view={view} rows={view.funnel} /> : null}
      {view.tab === 'product' && view.product ? (
        <Product ctx={ctx} view={view} report={view.product} />
      ) : null}
      {view.tab === 'plans' && view.plans ? <Plans ctx={ctx} report={view.plans} /> : null}
      {view.tab === 'retention' && view.retention ? <Retention ctx={ctx} report={view.retention} /> : null}
      <p class="small muted an-note">{t('an.privacy')}</p>
    </AppShell>
  );
};

const Stat: FC<{ label: string; value: string; sub?: string | undefined }> = ({
  label: name,
  value,
  sub,
}) => (
  <div class="stat">
    <span class="label">{name}</span>
    <div class="value">{value}</div>
    {sub ? <div class="sub">{sub}</div> : null}
  </div>
);

/** Daily bars (CSP allows no inline styles, so heights are classes in 5% steps). */
const DayChart: FC<{ ctx: PageCtx; title: string; days: { day: string; n: number }[]; unit?: string }> = ({
  ctx,
  title,
  days,
}) => {
  const max = Math.max(1, ...days.map((d) => d.n));
  const total = days.reduce((a, d) => a + d.n, 0);
  return (
    <div class="card">
      <div class="card-head">
        <h2>{title}</h2>
        <span class="small muted num">{fmtNumber(ctx.lang, total)}</span>
      </div>
      <div class="chart" role="img" aria-label={title}>
        {total === 0 ? <span class="chart-empty">{ctx.t('an.noData')}</span> : null}
        {days.map((d) => (
          <div class={`col${d.n === 0 ? ' zero' : ''}`} title={`${fmtDay(ctx.lang, d.day)}: ${d.n}`}>
            <span class={pctClass('h', d.n, max)} />
          </div>
        ))}
      </div>
      <div class="chart-axis">
        <span>{days[0] ? fmtDay(ctx.lang, days[0].day) : null}</span>
        <span>{days.length ? fmtDay(ctx.lang, days.at(-1)!.day) : null}</span>
      </div>
    </div>
  );
};

const Breakdown: FC<{ ctx: PageCtx; view: AnalyticsView; dim: Dimension; rows: Count[] }> = ({
  ctx,
  view,
  dim,
  rows,
}) => {
  const { t, lang } = ctx;
  const max = Math.max(1, ...rows.map((r) => r.visits));
  const filtered = view.filter[dim] !== undefined;
  return (
    <div class="card">
      <div class="card-head">
        <h2>{t(DIM_KEY[dim])}</h2>
        <span class="small muted">
          {t('an.col.visits')} · {t('an.col.signups')}
        </span>
      </div>
      {rows.length === 0 ? (
        <p class="muted">{t('an.noData')}</p>
      ) : (
        <div class="top-list an-list">
          {rows.map((r) => (
            <div class="bar">
              <span class="name" title={r.value}>
                {filtered ? (
                  label(ctx, dim, r.value, view.services)
                ) : (
                  <a href={href(view, { [`f.${dim}`]: r.value })}>
                    {label(ctx, dim, r.value, view.services)}
                  </a>
                )}
              </span>
              <div class="meter">
                <span class={pctClass('w', r.visits, max)} />
              </div>
              <span class="num small">{fmtNumber(lang, r.visits)}</span>
              <span class={`num small${r.signups ? ' an-strong' : ' muted'}`}>
                {fmtNumber(lang, r.signups)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const Traffic: FC<{ ctx: PageCtx; view: AnalyticsView; report: TrafficReport }> = ({ ctx, view, report }) => {
  const { t, lang } = ctx;
  const { totals } = report;
  const crawlerMax = Math.max(1, ...report.crawlers.map((c) => c.count));
  const pageMax = Math.max(1, ...report.pages.map((p) => p.views));
  const pairs: [Dimension, Dimension][] = [
    ['source', 'campaign'],
    ['medium', 'referrer'],
    ['country', 'language'],
    ['landing', 'device'],
    ['browser', 'os'],
  ];
  return (
    <>
      <div class="stats">
        <Stat
          label={t('an.stat.visits')}
          value={fmtNumber(lang, totals.visits)}
          sub={t('an.stat.perVisit', {
            n: totals.visits ? Math.round((totals.pageviews / totals.visits) * 10) / 10 : 0,
          })}
        />
        <Stat
          label={t('an.stat.pageviews')}
          value={fmtNumber(lang, totals.pageviews)}
          sub={t('an.stat.bounce', { pct: pct(totals.bounces, totals.visits) })}
        />
        <Stat
          label={t('an.stat.signups')}
          value={fmtNumber(lang, totals.signups)}
          sub={t('an.stat.conversion', { pct: pct(totals.signups, totals.visits) })}
        />
        <Stat
          label={t('an.stat.returning')}
          value={fmtNumber(lang, totals.knownVisits)}
          sub={t('an.stat.returningSub', { n: fmtNumber(lang, totals.knownPageviews) })}
        />
      </div>
      <div class="grid-2">
        <DayChart
          ctx={ctx}
          title={t('an.chart.visits')}
          days={report.days.map((d) => ({ day: d.day, n: d.visits }))}
        />
        <DayChart
          ctx={ctx}
          title={t('an.chart.signups')}
          days={report.days.map((d) => ({ day: d.day, n: d.signups }))}
        />
      </div>
      {pairs.map(([a, b]) => (
        <div class="grid-2">
          <Breakdown ctx={ctx} view={view} dim={a} rows={report.breakdown[a]} />
          <Breakdown ctx={ctx} view={view} dim={b} rows={report.breakdown[b]} />
        </div>
      ))}
      <div class="grid-2">
        <div class="card">
          <div class="card-head">
            <h2>{t('an.pages')}</h2>
            <span class="small muted">{t('an.pagesHint')}</span>
          </div>
          {report.pages.length === 0 ? (
            <p class="muted">{t('an.noData')}</p>
          ) : (
            <div class="top-list">
              {report.pages.map((p) => (
                <div class="bar">
                  <span class="name mono" title={p.path}>
                    {p.path}
                  </span>
                  <div class="meter">
                    <span class={pctClass('w', p.views, pageMax)} />
                  </div>
                  <span class="num small">{fmtNumber(lang, p.views)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div class="card">
          <div class="card-head">
            <h2>{t('an.crawlers')}</h2>
          </div>
          <p class="hint">{t('an.crawlersHint')}</p>
          {report.crawlers.length === 0 ? (
            <p class="muted">{t('an.noData')}</p>
          ) : (
            <div class="top-list">
              {report.crawlers.map((c) => (
                <div class="bar">
                  <span class="name">{t(`an.crawler.${c.key}` as Key) || c.key}</span>
                  <div class="meter">
                    <span class={pctClass('w', c.count, crawlerMax)} />
                  </div>
                  <span class="num small">{fmtNumber(lang, c.count)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
};

const STEPS: { key: keyof Omit<FunnelRow, 'value' | 'mrr' | 'botStarts'>; label: Key }[] = [
  { key: 'visits', label: 'an.step.visits' },
  { key: 'signups', label: 'an.step.signups' },
  { key: 'ai', label: 'an.step.ai' },
  { key: 'services', label: 'an.step.services' },
  { key: 'active', label: 'an.step.active' },
  { key: 'paid', label: 'an.step.paid' },
];

const Funnel: FC<{ ctx: PageCtx; view: AnalyticsView; rows: FunnelRow[] }> = ({ ctx, view, rows }) => {
  const { t, lang } = ctx;
  const total = rows.reduce(
    (a, r) => {
      for (const s of STEPS) a[s.key] += r[s.key];
      a.mrr += r.mrr;
      return a;
    },
    { visits: 0, signups: 0, ai: 0, services: 0, active: 0, paid: 0, mrr: 0 },
  );
  const top = Math.max(1, total.visits, total.signups);
  const withStarts = rows.some((r) => r.botStarts !== undefined);
  return (
    <>
      <div class="card">
        <h2>{t('an.funnel.title')}</h2>
        <p class="hint">{t('an.funnel.hint')}</p>
        <div class="an-funnel">
          {STEPS.map((s, i) => {
            // Sign-ups compare with visits; later steps with sign-ups (they need not happen in order).
            const prev = i === 0 ? undefined : i === 1 ? total.visits : total.signups;
            return (
              <div class="bar">
                <span class="name">{t(s.label)}</span>
                <div class="meter">
                  <span class={pctClass('w', total[s.key], top)} />
                </div>
                <span class="num">{fmtNumber(lang, total[s.key])}</span>
                <span class="num small muted">{prev === undefined ? '' : pct(total[s.key], prev)}</span>
              </div>
            );
          })}
        </div>
        {total.mrr ? <p class="small">{t('an.funnel.mrr', { mrr: money(lang, total.mrr) })}</p> : null}
      </div>
      <div class="row filter-links">
        <span class="small muted">{t('an.funnel.by')}</span>
        {FUNNEL_BY.map((d) => (
          <a class="btn sm" href={href(view, { by: d })} aria-current={d === view.by ? 'page' : undefined}>
            {t(DIM_KEY[d])}
          </a>
        ))}
      </div>
      <div class="card flush">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t(DIM_KEY[view.by])}</th>
                {withStarts ? <th class="right">{t('an.col.botStarts')}</th> : null}
                <th class="right">{t('an.col.visits')}</th>
                <th class="right">{t('an.col.signups')}</th>
                <th class="right">{t('an.col.conversion')}</th>
                <th class="right">{t('an.col.ai')}</th>
                <th class="right">{t('an.col.services')}</th>
                <th class="right">{t('an.col.active')}</th>
                <th class="right">{t('an.col.paid')}</th>
                <th class="right">{t('an.col.mrr')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colspan={withStarts ? 10 : 9} class="muted">
                    {t('an.noData')}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr>
                    <td>
                      <a href={href(view, { tab: 'traffic', by: null, [`f.${view.by}`]: r.value })}>
                        {label(ctx, view.by, r.value, view.services)}
                      </a>
                    </td>
                    {withStarts ? <td class="right num">{fmtNumber(lang, r.botStarts ?? 0)}</td> : null}
                    <td class="right num">{fmtNumber(lang, r.visits)}</td>
                    <td class="right num">{fmtNumber(lang, r.signups)}</td>
                    <td class="right num">{r.visits ? pct(r.signups, r.visits) : '—'}</td>
                    <td class="right num">{cell(lang, r.ai, r.signups)}</td>
                    <td class="right num">{cell(lang, r.services, r.signups)}</td>
                    <td class="right num">{cell(lang, r.active, r.signups)}</td>
                    <td class="right num">{cell(lang, r.paid, r.signups)}</td>
                    <td class="right num">{r.mrr ? money(lang, r.mrr) : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

/** "12 · 40%": a count and its share of the group's sign-ups. */
const cell = (lang: string, n: number, of: number) =>
  of ? `${fmtNumber(lang, n)} · ${pct(n, of)}` : fmtNumber(lang, n);

const Product: FC<{ ctx: PageCtx; view: AnalyticsView; report: ProductReport }> = ({ ctx, view, report }) => {
  const { t, lang } = ctx;
  const calls = report.connectors.reduce((a, c) => a + c.calls, 0);
  const maxConn = Math.max(1, ...report.connectors.map((c) => c.calls));
  const maxAct = Math.max(1, ...report.actions.map((c) => c.calls));
  const maxApp = Math.max(1, ...report.aiApps.map((c) => c.workspaces));
  const maxDash = Math.max(1, ...report.dashboard.map((c) => c.views));
  const name = (id: string) => label(ctx, 'connector', id, view.services);
  return (
    <>
      <div class="stats">
        <Stat label={t('an.stat.calls')} value={fmtNumber(lang, calls)} />
        <Stat label={t('an.stat.wau')} value={fmtNumber(lang, report.wau)} sub={t('an.stat.wauSub')} />
        <Stat label={t('an.stat.mau')} value={fmtNumber(lang, report.mau)} sub={t('an.stat.mauSub')} />
        <Stat
          label={t('an.stat.stickiness')}
          value={pct(report.wau, report.mau)}
          sub={t('an.stat.stickinessSub')}
        />
      </div>
      <div class="grid-2">
        <DayChart
          ctx={ctx}
          title={t('an.chart.active')}
          days={report.activeDays.map((d) => ({ day: d.day, n: d.workspaces }))}
        />
        <div class="card">
          <div class="card-head">
            <h2>{t('an.aiApps')}</h2>
            <span class="small muted">{t('an.col.workspaces')}</span>
          </div>
          {report.aiApps.length === 0 ? (
            <p class="muted">{t('an.noData')}</p>
          ) : (
            <div class="top-list">
              {report.aiApps.map((a) => (
                <div class="bar">
                  <span class="name">{a.name}</span>
                  <div class="meter">
                    <span class={pctClass('w', a.workspaces, maxApp)} />
                  </div>
                  <span class="num small">{fmtNumber(lang, a.workspaces)}</span>
                </div>
              ))}
            </div>
          )}
          <p class="small muted">{t('an.tokens', { n: fmtNumber(lang, report.tokenWorkspaces) })}</p>
        </div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head">
            <h2>{t('an.services')}</h2>
            <span class="small muted">
              {t('an.col.calls')} · {t('an.col.workspaces')}
            </span>
          </div>
          {report.connectors.length === 0 ? (
            <p class="muted">{t('an.noData')}</p>
          ) : (
            <div class="top-list an-list">
              {report.connectors.map((c) => (
                <div class="bar" title={t('an.errors', { pct: pct(c.errors, c.calls) })}>
                  <span class="name">{name(c.connectorId)}</span>
                  <div class="meter">
                    <span class={pctClass('w', c.calls, maxConn)} />
                  </div>
                  <span class="num small">{fmtNumber(lang, c.calls)}</span>
                  <span class="num small muted">{fmtNumber(lang, c.workspaces)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div class="card">
          <div class="card-head">
            <h2>{t('an.actions')}</h2>
            <span class="small muted">
              {t('an.col.calls')} · {t('an.col.errors')}
            </span>
          </div>
          {report.actions.length === 0 ? (
            <p class="muted">{t('an.noData')}</p>
          ) : (
            <div class="top-list an-list">
              {report.actions.map((a) => (
                <div class="bar">
                  <span class="name mono" title={`${name(a.connectorId)} · ${a.action}`}>
                    {a.connectorId}_{a.action}
                  </span>
                  <div class="meter">
                    <span class={pctClass('w', a.calls, maxAct)} />
                  </div>
                  <span class="num small">{fmtNumber(lang, a.calls)}</span>
                  <span class={`num small${a.errors ? ' an-bad' : ' muted'}`}>{pct(a.errors, a.calls)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div class="card flush">
        <div class="card-head pad">
          <h2>{t('an.accounts')}</h2>
          <span class="small muted">{t('an.accountsHint')}</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('an.col.service')}</th>
                <th class="right">{t('an.col.accounts')}</th>
                <th class="right">{t('an.col.added')}</th>
                <th class="right">{t('an.col.starts')}</th>
                <th class="right">{t('an.col.completion')}</th>
              </tr>
            </thead>
            <tbody>
              {report.accounts.length === 0 ? (
                <tr>
                  <td colspan={5} class="muted">
                    {t('an.noData')}
                  </td>
                </tr>
              ) : (
                report.accounts.map((a) => (
                  <tr>
                    <td>{name(a.connectorId)}</td>
                    <td class="right num">{fmtNumber(lang, a.total)}</td>
                    <td class="right num">{fmtNumber(lang, a.added)}</td>
                    <td class="right num">{fmtNumber(lang, a.starts)}</td>
                    <td class="right num">{a.starts ? pct(Math.min(a.added, a.starts), a.starts) : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div class="grid-2">
        <div class="card">
          <h2>{t('an.dashboard')}</h2>
          {report.dashboard.length === 0 ? (
            <p class="muted">{t('an.noData')}</p>
          ) : (
            <div class="top-list">
              {report.dashboard.map((p) => (
                <div class="bar">
                  <span class="name mono" title={p.path}>
                    {p.path}
                  </span>
                  <div class="meter">
                    <span class={pctClass('w', p.views, maxDash)} />
                  </div>
                  <span class="num small">{fmtNumber(lang, p.views)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div class="card">
          <h2>{t('an.events')}</h2>
          <p class="hint">{t('an.eventsHint')}</p>
          {report.events.length === 0 ? (
            <p class="muted">{t('an.noData')}</p>
          ) : (
            <ul class="plain">
              {report.events.map((e) => (
                <li>
                  <span class="grow">
                    {t(`an.event.${e.name}` as Key) || e.name} <span class="small muted mono">{e.name}</span>
                  </span>
                  <span class="num">{fmtNumber(lang, e.count)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
};

const KIND_KEY: Record<PlanKind, Key> = {
  paid: 'an.kind.paid',
  trial: 'an.kind.trial',
  free: 'an.kind.free',
  gift: 'an.kind.gift',
};

/** Which plans are in force and how much each is used; money in depth is on the revenue page. */
const Plans: FC<{ ctx: PageCtx; report: PlansReport }> = ({ ctx, report }) => {
  const { t, lang } = ctx;
  const planName = (id: string) => t(`plan.${id}.name` as Key) || id;
  return (
    <>
      <div class="stats">
        <Stat
          label={t('an.stat.mrr')}
          value={money(lang, report.mrr)}
          sub={t('an.stat.arr', { arr: money(lang, report.mrr * 12) })}
        />
        <Stat
          label={t('an.stat.paying')}
          value={fmtNumber(lang, report.paying)}
          sub={t('an.stat.arpa', { arpa: report.paying ? money(lang, report.mrr / report.paying) : '—' })}
        />
        <Stat
          label={t('an.stat.workspaces')}
          value={fmtNumber(lang, report.workspaces)}
          sub={t('an.stat.activeShare', { n: report.active, pct: pct(report.active, report.workspaces) })}
        />
      </div>
      <div class="card flush">
        <div class="card-head pad">
          <h2>{t('an.plans')}</h2>
          <a class="small" href="/admin/revenue">
            {t('an.plansMore')}
          </a>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('an.col.plan')}</th>
                <th>{t('an.col.kind')}</th>
                <th>{t('an.col.interval')}</th>
                <th class="right">{t('an.col.spaces')}</th>
                <th class="right">{t('an.col.activeWs')}</th>
                <th class="right">{t('an.col.calls')}</th>
                <th class="right">{t('an.col.mrr')}</th>
              </tr>
            </thead>
            <tbody>
              {report.plans.length === 0 ? (
                <tr>
                  <td colspan={7} class="muted">
                    {t('an.noData')}
                  </td>
                </tr>
              ) : (
                report.plans.map((p) => (
                  <tr>
                    <td>{planName(p.planId)}</td>
                    <td>{t(KIND_KEY[p.kind])}</td>
                    <td>{p.interval ? t(`an.interval.${p.interval}` as Key) || p.interval : '—'}</td>
                    <td class="right num">{fmtNumber(lang, p.workspaces)}</td>
                    <td class="right num">{cell(lang, p.active, p.workspaces)}</td>
                    <td class="right num">{fmtNumber(lang, p.calls)}</td>
                    <td class="right num">{p.kind === 'paid' ? money(lang, p.mrr) : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <h2>{t('an.bySource')}</h2>
        {report.bySource.length === 0 ? (
          <p class="muted">{t('an.noData')}</p>
        ) : (
          <ul class="plain">
            {report.bySource.map((s) => (
              <li>
                <span class="grow">{label(ctx, 'source', s.source, {})}</span>
                <span class="small muted">{t('an.payingN', { n: s.paying })}</span>
                <span class="num">{money(lang, s.mrr)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
};

/** Background step of a retention cell: 0–10 by tens of percent. */
const heat = (n: number, of: number) =>
  of > 0 && n > 0 ? Math.max(1, Math.min(10, Math.round((n / of) * 10))) : 0;

const Retention: FC<{ ctx: PageCtx; report: RetentionReport }> = ({ ctx, report }) => {
  const { t, lang } = ctx;
  return (
    <div class="card flush">
      <div class="card-head pad">
        <h2>{t('an.retention.title')}</h2>
        <span class="small muted">{t('an.retention.hint')}</span>
      </div>
      <div class="table-wrap">
        <table class="an-cohorts">
          <thead>
            <tr>
              <th>{t('an.col.week')}</th>
              <th class="right">{t('an.col.signups')}</th>
              {Array.from({ length: report.weeks }, (_, k) => (
                <th class="right">{t('an.col.weekN', { n: k })}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...report.cohorts].reverse().map((c) => (
              <tr>
                <td class="nowrap">{fmtDay(lang, c.week)}</td>
                <td class="right num">{fmtNumber(lang, c.size)}</td>
                {Array.from({ length: report.weeks }, (_, k) =>
                  k < c.active.length ? (
                    <td
                      class={`right num heat-${heat(c.active[k]!, c.size)}`}
                      title={`${c.active[k]} / ${c.size}`}
                    >
                      {c.size ? pct(c.active[k]!, c.size) : '—'}
                    </td>
                  ) : (
                    <td />
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
