import type { FC } from 'hono/jsx';
import { conversion, type RevenueView } from '../admin/revenue.js';
import { AppShell, PageHead, type ShellInfo } from './app.js';
import type { PageCtx } from './page-context.js';
import { fmtAgo, fmtNumber } from './ui.js';

export interface AdminRevenuePageView extends RevenueView {
  events: { type: string; status: string | null; planId: string | null; outcome: string; at: Date }[];
  provider: string | null;
}

const planName = (ctx: PageCtx, id: string) => ctx.t(`plan.${id}.name` as 'plan.free.name');

/** Revenue and conversion: MRR, paying workspaces, trial and sign-up conversion, invites. */
export const AdminRevenuePage: FC<{ ctx: PageCtx; shell: ShellInfo; view: AdminRevenuePageView }> = ({
  ctx,
  shell,
  view,
}) => {
  const { t, lang } = ctx;
  const usd = (n: number) =>
    new Intl.NumberFormat(lang === 'ru' ? 'ru-RU' : 'en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: n % 1 ? 2 : 0,
    }).format(n);
  const rate = (part: number, whole: number) =>
    t('admin.revenue.rate', {
      part: fmtNumber(lang, part),
      whole: fmtNumber(lang, whole),
      pct: conversion(part, whole),
    });
  return (
    <AppShell ctx={ctx} shell={shell} section="admin-revenue" title={t('admin.nav.revenue')}>
      <PageHead
        title={t('admin.revenue.title')}
        sub={view.provider ? t('admin.revenue.sub', { provider: view.provider }) : t('admin.revenue.subOff')}
      />
      <div class="stats">
        <div class="stat">
          <span class="label">{t('admin.revenue.mrr')}</span>
          <div class="value">{usd(view.mrr)}</div>
          <div class="sub">{t('admin.revenue.arr', { n: usd(view.arr) })}</div>
        </div>
        <div class="stat">
          <span class="label">{t('admin.revenue.paying')}</span>
          <div class="value">{fmtNumber(lang, view.paying)}</div>
          <div class="sub">{t('admin.revenue.cancelling', { n: view.cancelling })}</div>
        </div>
        <div class="stat">
          <span class="label">{t('admin.revenue.atRisk')}</span>
          <div class="value">{usd(view.atRisk)}</div>
          <div class="sub">{t('admin.revenue.canceled30', { n: view.canceled30 })}</div>
        </div>
        <div class="stat">
          <span class="label">{t('admin.revenue.inTrial')}</span>
          <div class="value">{fmtNumber(lang, view.inTrial)}</div>
          <div class="sub">{t('admin.revenue.gifted', { n: view.gifted })}</div>
        </div>
      </div>
      <div class="grid-2">
        <div class="card">
          <h2>{t('admin.revenue.conversion')}</h2>
          <ul class="plain">
            <li>
              <span class="grow">{t('admin.revenue.trialCohort')}</span>
              <span>{rate(view.trialCohort.paying, view.trialCohort.ended)}</span>
            </li>
            <li>
              <span class="grow">{t('admin.revenue.signups30')}</span>
              <span>{rate(view.signups30.paying, view.signups30.total)}</span>
            </li>
            <li>
              <span class="grow">{t('admin.revenue.overall')}</span>
              <span>{rate(view.overall.paying, view.overall.users)}</span>
            </li>
            <li>
              <span class="grow">{t('admin.revenue.referrals')}</span>
              <span>{rate(view.referrals.paying, view.referrals.invited)}</span>
            </li>
          </ul>
          <p class="hint">{t('admin.revenue.hint')}</p>
        </div>
        <div class="card">
          <h2>{t('admin.revenue.byPlan')}</h2>
          {view.byPlan.length ? (
            <ul class="plain">
              {view.byPlan.map((r) => (
                <li>
                  <span class="grow">
                    {planName(ctx, r.planId)}{' '}
                    <span class="muted">
                      · {t(r.interval === 'year' ? 'admin.requests.year' : 'admin.requests.month')}
                    </span>
                  </span>
                  <span>
                    {fmtNumber(lang, r.n)} · {usd(r.mrr)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p class="muted">{t('admin.revenue.none')}</p>
          )}
        </div>
      </div>
      <div class="card">
        <h2>{t('admin.revenue.events')}</h2>
        {view.events.length ? (
          <ul class="plain small billing-events">
            {view.events.map((e) => (
              <li>
                <span>
                  <code>{e.type}</code> · {e.status ?? '—'}
                  {e.planId ? ` · ${planName(ctx, e.planId)}` : ''}
                </span>
                <span class="muted">
                  {e.outcome} · {fmtAgo(lang, e.at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted">{t('admin.revenue.noEvents')}</p>
        )}
      </div>
    </AppShell>
  );
};
