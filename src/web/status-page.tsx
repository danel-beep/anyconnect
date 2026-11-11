import type { FC } from 'hono/jsx';
import { BRAND } from '../brand.js';
import type { HealthStatus } from '../ops/checks.js';
import type { ComponentStatus, StatusIncident, StatusPageData } from '../ops/status.js';
import type { Key } from './i18n.js';
import type { PageCtx } from './page-context.js';
import { SiteLayout } from './site.js';
import { fmtAgo, fmtDate } from './ui.js';

const OVERALL: Record<HealthStatus, Key> = {
  ok: 'status.overall.ok',
  degraded: 'status.overall.degraded',
  down: 'status.overall.down',
};

const STATE: Record<HealthStatus, Key> = {
  ok: 'status.state.ok',
  degraded: 'status.state.degraded',
  down: 'status.state.down',
};

const pct = (lang: string, value: number) =>
  new Intl.NumberFormat(lang === 'ru' ? 'ru-RU' : 'en-GB', {
    style: 'percent',
    // 99.95 % reads better than 100 % for a day with a short blip.
    maximumFractionDigits: value >= 0.9995 && value < 1 ? 3 : 2,
  }).format(value);

function duration(lang: string, ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const unit = minutes < 120 ? 'minute' : minutes < 48 * 60 ? 'hour' : 'day';
  const value =
    unit === 'minute' ? minutes : unit === 'hour' ? Math.round(minutes / 60) : Math.round(minutes / 1440);
  return new Intl.NumberFormat(lang === 'ru' ? 'ru-RU' : 'en-GB', {
    style: 'unit',
    unit,
    unitDisplay: 'long',
  }).format(value);
}

const Bars: FC<{ ctx: PageCtx; component: ComponentStatus }> = ({ ctx, component }) => {
  const { t, lang } = ctx;
  return (
    <div class="status-bars" role="img" aria-label={t('status.barsLabel', { n: component.days.length })}>
      {component.days.map((d) => (
        <span
          class={`status-bar s-${d.status}`}
          title={`${fmtDate(lang, new Date(`${d.day}T12:00:00Z`))}: ${
            d.uptime === null
              ? t('status.noData')
              : `${pct(lang, d.uptime)} · ${t(`status.day.${d.status}` as Key)}`
          }`}
        />
      ))}
    </div>
  );
};

const IncidentRow: FC<{ ctx: PageCtx; incident: StatusIncident }> = ({ ctx, incident }) => {
  const { t, lang } = ctx;
  const end = incident.endedAt ?? new Date();
  return (
    <li>
      <span class={`dot ${incident.status === 'degraded' ? 'warn' : 'bad'}`} />
      <div>
        <strong>
          {incident.component === 'all'
            ? t('status.incident.unreachable')
            : t(`status.incident.${incident.status === 'down' ? 'down' : 'degraded'}`, {
                component: t(`status.component.${incident.component}` as Key),
              })}
        </strong>
        <div class="small muted">
          {fmtDate(lang, incident.startedAt, true)} UTC ·{' '}
          {incident.endedAt
            ? t('status.incident.lasted', {
                duration: duration(lang, end.getTime() - incident.startedAt.getTime()),
              })
            : t('status.incident.ongoing')}
        </div>
      </div>
    </li>
  );
};

export const StatusPage: FC<{ ctx: PageCtx; data: StatusPageData }> = ({ ctx, data }) => {
  const { t, lang } = ctx;
  const overall = data.updatedAt ? data.overall : 'ok';
  return (
    <SiteLayout
      ctx={ctx}
      title={`${t('status.title')} · ${BRAND.name}`}
      description={t('status.description')}
      current="status"
      canonicalPath="/status"
    >
      {/* Refreshes in place every minute (data-poll), not with a page reload that moves focus and
          the screen-reader cursor back to the top. */}
      <div class="wrap status-wrap" id="status-live" data-poll="60">
        <h1>{t('status.title')}</h1>
        {data.updatedAt === null ? (
          <div class="status-banner s-none">
            <strong>{t('status.overall.none')}</strong>
          </div>
        ) : (
          <div class={`status-banner s-${overall}`}>
            <strong>{t(OVERALL[overall])}</strong>
            <span class="small">
              {data.stale
                ? t('status.stale', { when: fmtAgo(lang, data.updatedAt) })
                : t('status.updated', { when: fmtAgo(lang, data.updatedAt) })}
            </span>
          </div>
        )}

        {data.components.length ? (
          <div class="card flush">
            {data.components.map((c) => (
              <section class="status-component">
                <div class="status-head">
                  <div>
                    <h2>{t(`status.component.${c.id}` as Key)}</h2>
                    <p class="small muted">{t(`status.componentHint.${c.id}` as Key)}</p>
                  </div>
                  <span class={`status-state s-${c.status}`}>
                    {t(STATE[c.status])}
                    {c.status !== 'ok' ? (
                      <span class="small muted d-block">
                        {t('status.since', { when: fmtAgo(lang, c.since) })}
                      </span>
                    ) : null}
                  </span>
                </div>
                {c.note ? <p class="small">{t('status.affected', { list: c.note })}</p> : null}
                <Bars ctx={ctx} component={c} />
                <div class="status-scale small muted">
                  <span>{t('status.daysAgo', { n: c.days.length })}</span>
                  <span>
                    {c.uptime === null
                      ? t('status.noData')
                      : t('status.uptime', { value: pct(lang, c.uptime) })}
                  </span>
                  <span>{t('status.today')}</span>
                </div>
              </section>
            ))}
          </div>
        ) : null}

        <h2 class="status-section">{t('status.incidents')}</h2>
        {data.incidents.length === 0 ? (
          <p class="muted">{t('status.noIncidents')}</p>
        ) : (
          <ul class="plain status-incidents">
            {data.incidents.map((i) => (
              <IncidentRow ctx={ctx} incident={i} />
            ))}
          </ul>
        )}
        <p class="small muted status-foot">
          {t('status.foot')} <a href="/status.json">/status.json</a>
        </p>
      </div>
    </SiteLayout>
  );
};
