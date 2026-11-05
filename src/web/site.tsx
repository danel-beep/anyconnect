import type { Child, FC } from 'hono/jsx';
import { type Metric, PLANS, type Plan, yearlyFreeMonths } from '../billing/plans.js';
import { BRAND } from '../brand.js';
import type { ResolvedSetupGuide, RiskLevel } from '../connectors/sdk.js';
import {
  CATEGORY_ORDER,
  PLANNED_SERVICES,
  type ServiceCategory,
  searchText,
  serviceMeta,
} from './catalog.js';
import { CLIENT_GUIDES, clientName } from './clients.js';
import { Doc } from './document.js';
import type { Locale, Translate } from './i18n.js';
import type { PageCtx } from './page-context.js';
import { ARTICLES } from './seo/articles.js';
import { clientGuidePath } from './seo/client-pages.js';
import { OG_IMAGE_PATH } from './seo/og-image.js';
import { breadcrumbs, faqPage, type JsonLd, softwareApplication } from './seo/structured-data.js';
import { alternates, localizedPath, OG_LOCALE, SITE_LOCALES } from './seo/urls.js';
import { PromptList, RiskBadge, SetupGuideView } from './setup-guide.js';
import { Brand, CodeBlock, CopyField, fmtNumber, GoogleG, Icon, Prefs, ServiceLogo } from './ui.js';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type Section = 'home' | 'services' | 'pricing' | 'docs' | 'legal' | 'status';

const SiteHeader: FC<{ ctx: PageCtx; current: Section }> = ({ ctx, current }) => {
  const { t } = ctx;
  // On the landing page the links jump to its sections; elsewhere they open the full pages.
  const home = current === 'home';
  const nav: [Section | 'features' | 'security', string, string][] = [
    ['services', home ? '#services' : '/services', t('site.nav.services')],
    ['features', home ? '#features' : '/#features', t('site.nav.features')],
    ['security', home ? '#security' : '/#security', t('site.nav.security')],
    ['pricing', home ? '#pricing' : '/pricing', t('site.nav.pricing')],
    ['docs', '/docs', t('site.nav.docs')],
  ];
  return (
    <header class="site-header" data-site-header>
      <div class="wrap">
        <Brand />
        <nav class="site-nav" id="site-nav" aria-label={t('site.nav.label')}>
          {nav.map(([id, href, label]) => (
            <a
              href={href.startsWith('#') ? href : localizedPath(href, ctx.lang)}
              aria-current={id === current ? 'page' : undefined}
            >
              {label}
            </a>
          ))}
          {/* Phones: the header keeps the logo, the main button and the menu; the rest lives here. */}
          <div class="nav-extra">
            <Prefs t={t} lang={ctx.lang} path={ctx.path} />
            {ctx.user ? null : (
              <>
                <StartButton ctx={ctx} size="lg" />
                <a class="btn lg" href="/login">
                  {t('site.cta.signIn')}
                </a>
              </>
            )}
          </div>
        </nav>
        <div class="site-cta">
          <Prefs t={t} lang={ctx.lang} path={ctx.path} />
          {ctx.user ? (
            <a class="btn primary cta-main" href="/app">
              {t('site.cta.dashboard')}
            </a>
          ) : (
            <>
              <a class="btn ghost hide-sm" href="/login">
                {t('site.cta.signIn')}
              </a>
              <a class="btn primary cta-main" href="/signup">
                <span class="long">{t('site.cta.start')}</span>
                <span class="short">{t('site.cta.startShort')}</span>
              </a>
            </>
          )}
          <button
            type="button"
            class="icon-btn menu-btn"
            data-nav-toggle
            aria-controls="site-nav"
            aria-expanded="false"
            aria-label={t('ui.menu')}
          >
            <Icon name="menu" />
            <Icon name="x" />
          </button>
        </div>
      </div>
    </header>
  );
};

const SiteFooter: FC<{ ctx: PageCtx }> = ({ ctx }) => {
  const { t } = ctx;
  return (
    <footer class="site-footer">
      <div class="wrap">
        <div class="footer-grid">
          <div>
            <Brand />
            <p class="muted small">{t('site.footer.tagline')}</p>
          </div>
          <div>
            <h2>{t('site.footer.product')}</h2>
            <a href={localizedPath('/#features', ctx.lang)}>{t('site.nav.features')}</a>
            <a href={localizedPath('/services', ctx.lang)}>{t('site.nav.services')}</a>
            <a href={localizedPath('/pricing', ctx.lang)}>{t('site.nav.pricing')}</a>
            <a href={localizedPath('/docs', ctx.lang)}>{t('site.nav.docs')}</a>
          </div>
          <div>
            <h2>{t('site.footer.resources')}</h2>
            <a href={localizedPath('/guides/what-is-mcp', ctx.lang)}>{t('site.nav.whatIsMcp')}</a>
            <a href={localizedPath('/faq', ctx.lang)}>{t('site.nav.faq')}</a>
            <a href={localizedPath('/use-cases', ctx.lang)}>{t('site.nav.useCases')}</a>
            <a href={localizedPath('/blog', ctx.lang)}>{t('site.nav.blog')}</a>
            <a href={localizedPath('/compare', ctx.lang)}>{t('site.nav.compare')}</a>
          </div>
          <div>
            <h2>{t('site.footer.account')}</h2>
            {ctx.user ? (
              <a href="/app">{t('site.cta.dashboard')}</a>
            ) : (
              <>
                <a href="/signup">{t('site.cta.start')}</a>
                <a href="/login">{t('site.cta.signIn')}</a>
              </>
            )}
            <a href={ctx.user ? '/security' : '/#security'}>{t('site.footer.security')}</a>
          </div>
          <div>
            <h2>{t('site.footer.company')}</h2>
            <a href="/support">{t('site.footer.support')}</a>
            {ctx.supportEmail ? <a href={`mailto:${ctx.supportEmail}`}>{t('site.footer.contact')}</a> : null}
            <a href="/status">{t('site.footer.status')}</a>
            <a href="/privacy">{t('site.footer.privacy')}</a>
            <a href="/terms">{t('site.footer.terms')}</a>
            <a href="/refunds">{t('site.footer.refunds')}</a>
          </div>
        </div>
        <div class="footer-bottom">
          <span>
            © {new Date().getUTCFullYear()} {BRAND.name}
          </span>
          <span>{t('site.footer.mcp')}</span>
        </div>
      </div>
    </footer>
  );
};

export const SiteLayout: FC<{
  ctx: PageCtx;
  title: string;
  description: string;
  current: Section;
  /** The page's path without the language parameter; canonical and hreflang links derive from it. */
  canonicalPath: string;
  /** schema.org data describing the page. */
  jsonLd?: JsonLd[];
  ogType?: 'website' | 'article';
  /** Kept out of search results (e.g. a service that cannot be connected on this server). */
  noindex?: boolean;
  /** Reloads the page every this many seconds (the status page). */
  refreshSeconds?: number;
  children?: Child;
}> = ({
  ctx,
  title,
  description,
  current,
  canonicalPath,
  jsonLd,
  ogType,
  noindex,
  refreshSeconds,
  children,
}) => (
  <Doc
    title={title}
    lang={ctx.lang}
    description={description}
    canonical={`${ctx.publicUrl}${localizedPath(canonicalPath, ctx.lang)}`}
    noindex={noindex}
    meta={{
      alternates: noindex ? [] : alternates(ctx.publicUrl, canonicalPath),
      ogLocale: OG_LOCALE[ctx.lang],
      ogLocaleAlternates: SITE_LOCALES.filter((l) => l !== ctx.lang).map((l) => OG_LOCALE[l]),
      ogType: ogType ?? 'website',
      image: `${ctx.publicUrl}${OG_IMAGE_PATH}`,
      imageAlt: ctx.t('site.footer.tagline'),
      jsonLd: jsonLd ?? [],
      verification: ctx.verification,
      feed: { href: `${ctx.publicUrl}/blog/feed.xml`, title: `${BRAND.name} ${ctx.t('site.nav.blog')}` },
    }}
    {...(refreshSeconds ? { refreshSeconds } : {})}
  >
    <a class="skip" href="#main">
      {ctx.t('ui.skip')}
    </a>
    <SiteHeader ctx={ctx} current={current} />
    <main id="main">{children}</main>
    <SiteFooter ctx={ctx} />
  </Doc>
);

/** "Start with Google" (or the sign-up page when Google is not configured). */
export const StartButton: FC<{ ctx: PageCtx; size?: 'lg' }> = ({ ctx, size }) =>
  ctx.user ? (
    <a class={`btn primary ${size ?? ''}`} href="/app">
      {ctx.t('site.cta.dashboard')}
      <Icon name="arrow" />
    </a>
  ) : ctx.google ? (
    <a class={`btn primary ${size ?? ''}`} href="/auth/google?next=%2Fapp">
      <span class="logo-g">
        <GoogleG />
      </span>
      {ctx.t('site.cta.google')}
    </a>
  ) : (
    <a class={`btn primary ${size ?? ''}`} href="/signup">
      {ctx.t('site.cta.start')}
      <Icon name="arrow" />
    </a>
  );

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

export interface PublicService {
  id: string;
  name: string;
  description: string;
  connect: 'oauth' | 'form' | 'none';
  /** False while the hub owner has not set up the service's OAuth app: shown as "coming soon". */
  ready: boolean;
}

const blurb = (lang: string, service: PublicService) => {
  const meta = serviceMeta(service.id);
  return meta ? (lang === 'ru' ? meta.blurb.ru : meta.blurb.en) : service.description;
};

const ServiceCard: FC<{ ctx: PageCtx; service: PublicService }> = ({ ctx, service }) => {
  const meta = serviceMeta(service.id);
  return (
    <a
      class="svc"
      href={`/services/${service.id}`}
      data-search={searchText(service.id, service.name, blurb(ctx.lang, service))}
    >
      <ServiceLogo icon={meta?.icon} glyph={meta?.glyph} name={service.name} />
      <span class="grow">
        <span class="name">
          {service.name}
          {service.ready ? null : <span class="badge tiny-badge">{ctx.t('site.services.soonShort')}</span>}
        </span>
        <span class="meta">{blurb(ctx.lang, service)}</span>
      </span>
    </a>
  );
};

/**
 * What is not connectable here yet, in one quiet row: services waiting for their sign-in app on
 * this server (linking to their page, which explains) and services we plan to build.
 */
const Roadmap: FC<{ ctx: PageCtx; services: PublicService[]; limit?: number }> = ({
  ctx,
  services,
  limit,
}) => {
  const items = [
    ...services
      .filter((x) => !x.ready)
      .map((x) => ({
        name: x.name,
        icon: serviceMeta(x.id)?.icon,
        glyph: serviceMeta(x.id)?.glyph,
        href: `/services/${x.id}`,
      })),
    ...PLANNED_SERVICES.map((p) => ({ name: p.name, icon: p.icon, glyph: undefined, href: undefined })),
  ].slice(0, limit ?? Number.POSITIVE_INFINITY);
  if (!items.length) return null;
  return (
    <div class="roadmap" data-filter-group>
      <h3 class="cat-title">{ctx.t('services.roadmap')}</h3>
      <ul class="roadmap-list">
        {items.map((x) => (
          <li data-search={x.name}>
            {x.href ? (
              <a class="road" href={x.href}>
                <ServiceLogo icon={x.icon} glyph={x.glyph} name={x.name} size="sm" />
                <span>{x.name}</span>
              </a>
            ) : (
              <span class="road">
                <ServiceLogo icon={x.icon} name={x.name} size="sm" />
                <span>{x.name}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};

/** Any remote MCP server connects by its address (dashboard → Services → Your own MCP servers). */
const McpCard: FC<{ ctx: PageCtx }> = ({ ctx }) => (
  <a class="svc" href="/docs#custom" data-search={`mcp ${ctx.t('services.mcp.name')}`}>
    <ServiceLogo glyph="plug" name="MCP" />
    <span class="grow">
      <span class="name">{ctx.t('services.mcp.name')}</span>
      <span class="meta">{ctx.t('services.mcp.text')}</span>
    </span>
  </a>
);

const Check: FC = () => <Icon name="check" />;

/** A dollar price: whole dollars as they are, anything else to the cent ($9.58, not $9.6). */
const usd = (n: number) => `$${Number.isInteger(n) ? n : (Math.round(n * 100) / 100).toFixed(2)}`;

const limitText = (t: Translate, lang: string, metric: Metric, value: number | null): string => {
  if (value === null) return t(`plan.metric.${metric}.unlimited`);
  if (metric === 'messengers' && value === 0) return t('plan.metric.messengers.none');
  if (metric === 'seats' && value === 1) return t('plan.metric.seats.solo');
  return t(`plan.metric.${metric}`, { n: fmtNumber(lang, value) });
};

/**
 * A plan's start in short: trial length and plan, the steps down ("500 → 300") and how many months
 * from sign-up they last.
 */
/** The Free plan's start: the trial, then a monthly allowance that steps down to the plan's own. */
function startText(
  t: Translate,
  lang: string,
  plan: Plan,
): { days: number; plan: string; steps: string; months: number } {
  const start = plan.start!;
  const steps = start.steps.flatMap((s) =>
    typeof s.limits.actions === 'number' ? [{ n: s.limits.actions, untilDay: s.untilDay }] : [],
  );
  return {
    days: start.trial.days,
    plan: start.trial.plan,
    steps: steps
      .map((s) => t('plan.metric.stepMonth', { n: fmtNumber(lang, s.n), m: Math.ceil(s.untilDay / 30) }))
      .join(', '),
    months: Math.ceil(Math.max(0, ...steps.map((s) => s.untilDay)) / 30),
  };
}

export const PlanCard: FC<{
  ctx: PageCtx;
  plan: Plan;
  current?: boolean;
  action?: Child;
}> = ({ ctx, plan, current, action }) => {
  const { t, lang } = ctx;
  const start = plan.start ? startText(t, lang, plan) : undefined;
  // What every plan gives today; features still being built are listed apart in the compare table.
  // Every plan has every service and safety feature, which the pricing intro says once for all.
  const features: Metric[] = [
    'actions',
    'accounts',
    'historyDays',
    ...(plan.perSeat === undefined && (plan.limits.seats ?? 1) > 1 ? (['seats'] as const) : []),
  ];
  const perSeat = plan.perSeat;
  const featureText = (metric: Metric): string => {
    if (metric === 'actions' && start)
      return t('plan.metric.actionsSteps', {
        n: fmtNumber(lang, plan.limits.actions ?? 0),
        months: start.months,
      });
    if (perSeat && metric === 'actions' && plan.limits.actions !== null)
      return t('plan.metric.actionsPerSeat', { n: fmtNumber(lang, plan.limits.actions) });
    return limitText(t, lang, metric, plan.limits[metric]);
  };
  return (
    <div class={`plan${plan.featured ? ' featured' : ''}${current ? ' current' : ''}`}>
      {plan.featured ? <span class="tag">{t('pricing.popular')}</span> : null}
      <div>
        <h3>{t(`plan.${plan.id}.name` as 'plan.free.name')}</h3>
        <p class="for">{t(`plan.${plan.id}.for` as 'plan.free.for')}</p>
      </div>
      <div>
        <div class="price">
          <span class="amount when-month">${plan.priceMonthly}</span>
          <span class="amount when-year">{usd(plan.priceYearly / 12)}</span>
          <span class="per">{t(perSeat ? 'pricing.perSeat' : 'pricing.perMonth')}</span>
        </div>
        <div class="price-year">
          {plan.priceMonthly === 0 ? (
            start ? (
              t('plan.metric.trial', {
                days: start.days,
                plan: t(`plan.${start.plan}.name` as 'plan.free.name'),
              })
            ) : (
              t('pricing.forever')
            )
          ) : (
            <>
              <span class="when-month">
                {t(perSeat ? 'pricing.orYearPerSeat' : 'pricing.orYear', { price: `$${plan.priceYearly}` })}
              </span>
              <span class="when-year">
                {t(perSeat ? 'pricing.billedYearPerSeat' : 'pricing.billedYear', {
                  price: `$${plan.priceYearly}`,
                })}
              </span>
            </>
          )}
        </div>
        {perSeat ? (
          // A per-person price next to personal plans: say what the smallest team pays.
          <div class="price-year">
            <span class="when-month">
              {t('pricing.teamSize', {
                min: perSeat.min,
                max: perSeat.max,
                price: usd(perSeat.min * plan.priceMonthly),
              })}
            </span>
            <span class="when-year">
              {t('pricing.teamSize', {
                min: perSeat.min,
                max: perSeat.max,
                price: usd((perSeat.min * plan.priceYearly) / 12),
              })}
            </span>
          </div>
        ) : null}
      </div>
      <ul>
        {features.map((metric) => (
          <li>
            <Check />
            <span>{featureText(metric)}</span>
          </li>
        ))}
      </ul>
      {action}
    </div>
  );
};

export const PlansGrid: FC<{ ctx: PageCtx; currentPlan?: string; actions?: (plan: Plan) => Child }> = ({
  ctx,
  currentPlan,
  actions,
}) => (
  <div data-interval="month" data-interval-root>
    <fieldset class="billing-switch">
      <legend class="sr-only">{ctx.t('pricing.interval')}</legend>
      <button type="button" aria-pressed="true" data-interval-set="month">
        {ctx.t('pricing.monthly')}
      </button>
      <button type="button" aria-pressed="false" data-interval-set="year">
        {ctx.t('pricing.yearly')}{' '}
        {yearlyFreeMonths() ? (
          <span class="save">{ctx.t('pricing.save', { n: yearlyFreeMonths() })}</span>
        ) : null}
      </button>
    </fieldset>
    <div class="plans">
      {PLANS.filter((p) => p.public).map((plan) => (
        <PlanCard
          ctx={ctx}
          plan={plan}
          current={plan.id === currentPlan}
          action={actions ? actions(plan) : <PlanCta ctx={ctx} plan={plan} />}
        />
      ))}
    </div>
  </div>
);

const PlanCta: FC<{ ctx: PageCtx; plan: Plan }> = ({ ctx, plan }) => {
  // Paid plans: after signing up the user lands on the billing page to request (or buy) the plan;
  // a team plan is bought on the team's page, so it starts with creating the team.
  const target = plan.audience === 'team' ? '/app/teams' : '/app/billing';
  const href =
    plan.priceMonthly === 0
      ? ctx.user
        ? '/app'
        : '/signup'
      : ctx.user
        ? target
        : `/signup?next=${encodeURIComponent(target)}`;
  return (
    <a class={`btn block ${plan.featured ? 'primary' : ''}`} href={href}>
      {plan.priceMonthly === 0
        ? ctx.t('pricing.startFree')
        : ctx.t('pricing.choose', { plan: ctx.t(`plan.${plan.id}.name` as 'plan.free.name') })}
    </a>
  );
};

export type FaqKey =
  | 'mcp'
  | 'why'
  | 'compare'
  | 'clients'
  | 'secrets'
  | 'action'
  | 'limit'
  | 'custom'
  | 'delete'
  | 'reset'
  | 'upgrade'
  | 'many'
  | 'jobs';

const PRICING_FAQ: FaqKey[] = ['action', 'reset', 'limit', 'upgrade', 'many', 'jobs'];

export const faqItems = (t: Translate, keys: FaqKey[]) =>
  keys.map((key) => ({ q: t(`faq.${key}.q`), a: t(`faq.${key}.a`) }));

/** schema.org data of the product with its plans (landing and pricing pages). */
export const productLd = (ctx: PageCtx, description: string): JsonLd =>
  softwareApplication(ctx.publicUrl, {
    description,
    plans: PLANS,
    planName: (plan) => ctx.t(`plan.${plan.id}.name` as 'plan.free.name'),
  });

/** Answers that point to a page with more: the link goes after the answer's text. */
const FAQ_LINKS: Partial<Record<FaqKey, { path: string; label: 'faq.compare.link' | 'faq.clients.link' }>> = {
  compare: { path: '/compare', label: 'faq.compare.link' },
  clients: { path: '/docs', label: 'faq.clients.link' },
};

export const Faq: FC<{ t: Translate; lang: Locale; keys: FaqKey[] }> = ({ t, lang, keys }) => (
  <div>
    {keys.map((key) => {
      const more = FAQ_LINKS[key];
      return (
        <details>
          <summary>{t(`faq.${key}.q`)}</summary>
          <div>
            {t(`faq.${key}.a`)}
            {more ? (
              <>
                {' '}
                <a href={localizedPath(more.path, lang)}>{t(more.label)}</a>
              </>
            ) : null}
          </div>
        </details>
      );
    })}
  </div>
);

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

const COMPARE: Metric[] = ['actions', 'accounts', 'historyDays', 'seats'];
/** Limits for features still being built: shown once, under their own heading. */
const COMPARE_SOON: Metric[] = ['messengers', 'backgroundJobs'];

const cell = (t: Translate, lang: string, metric: Metric, plan: Plan) => {
  const v = plan.limits[metric];
  if (plan.perSeat && metric === 'seats') return `${plan.perSeat.min}–${plan.perSeat.max}`;
  if (v === null) return t('pricing.unlimited');
  if (v === 0) return '—';
  if (metric === 'historyDays') return t('pricing.days', { n: v });
  if (plan.perSeat?.scaled.includes(metric)) return t('pricing.perSeatCell', { n: fmtNumber(lang, v) });
  return fmtNumber(lang, v);
};

export const PricingPage: FC<{ ctx: PageCtx }> = ({ ctx }) => {
  const { t, lang } = ctx;
  const plans = PLANS.filter((p) => p.public);
  return (
    <SiteLayout
      ctx={ctx}
      title={t('pricing.title')}
      description={t('pricing.description')}
      current="pricing"
      canonicalPath="/pricing"
      jsonLd={[
        breadcrumbs(ctx.publicUrl, [
          { name: t('crumb.home'), path: localizedPath('/', ctx.lang) },
          { name: t('site.nav.pricing'), path: localizedPath('/pricing', ctx.lang) },
        ]),
        productLd(ctx, t('pricing.description')),
        faqPage(faqItems(t, PRICING_FAQ)),
      ]}
    >
      <section class="section">
        <div class="wrap">
          <div class="section-head">
            <h1>{t('pricing.h1')}</h1>
            <p>{t('pricing.lead')}</p>
          </div>
          {ctx.billing ? null : (
            <div class="notice info">
              {t('pricing.paymentsSoon')}{' '}
              {ctx.supportEmail ? (
                <a href={`mailto:${ctx.supportEmail}`}>
                  {t('pricing.paymentsAsk', { email: ctx.supportEmail })}
                </a>
              ) : null}
            </div>
          )}
          <PlansGrid ctx={ctx} />
          <p class="hint plans-hint">{t('pricing.actionHint')}</p>
        </div>
      </section>
      <section class="section border">
        <div class="wrap">
          <div class="section-head">
            <h2>{t('pricing.compare')}</h2>
          </div>
          <div class="card flush table-wrap">
            <table class="compare">
              <thead>
                <tr>
                  <th />
                  {plans.map((p) => (
                    <th>{t(`plan.${p.id}.name` as 'plan.free.name')}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{t('pricing.price')}</td>
                  {plans.map((p) => (
                    <td class="num">
                      {p.priceMonthly === 0
                        ? t('pricing.free')
                        : p.perSeat
                          ? t('pricing.perSeatCell', { n: `$${p.priceMonthly}` })
                          : `$${p.priceMonthly}`}
                    </td>
                  ))}
                </tr>
                {COMPARE.map((metric) => (
                  <tr>
                    <td>{t(`pricing.row.${metric}`)}</td>
                    {plans.map((p) => (
                      <td class="num">
                        {cell(t, lang, metric, p)}
                        {metric === 'actions' && p.start ? (
                          <div class="tiny muted">
                            {t('pricing.startCell', {
                              days: p.start.trial.days,
                              plan: t(`plan.${p.start.trial.plan}.name` as 'plan.free.name'),
                              steps: startText(t, lang, p).steps,
                            })}
                          </div>
                        ) : null}
                      </td>
                    ))}
                  </tr>
                ))}
                {(['security', 'unified', 'custom', 'personas'] as const).map((f) => (
                  <tr>
                    <td>{t(`pricing.row.${f}`)}</td>
                    {plans.map(() => (
                      <td>
                        <Icon name="check" label={t('pricing.included')} />
                      </td>
                    ))}
                  </tr>
                ))}
                <tr class="group">
                  <th scope="colgroup" colspan={plans.length + 1}>
                    {t('pricing.soon')}
                  </th>
                </tr>
                {COMPARE_SOON.map((metric) => (
                  <tr>
                    <td>{t(`pricing.row.${metric}`)}</td>
                    {plans.map((p) => (
                      <td class="num">{cell(t, lang, metric, p)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      <section class="section border">
        <div class="wrap">
          <div class="section-head">
            <h2>{t('pricing.faq')}</h2>
          </div>
          <Faq t={t} lang={ctx.lang} keys={PRICING_FAQ} />
        </div>
      </section>
    </SiteLayout>
  );
};

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const categoryOf = (id: string): ServiceCategory => serviceMeta(id)?.category ?? 'other';

export const ServicesPage: FC<{ ctx: PageCtx; services: PublicService[] }> = ({ ctx, services }) => {
  const { t } = ctx;
  return (
    <SiteLayout
      ctx={ctx}
      title={t('services.title')}
      description={t('services.description')}
      current="services"
      canonicalPath="/services"
    >
      <section class="section">
        <div class="wrap">
          <div class="section-head">
            <h1>{t('services.h1')}</h1>
            <p>{t('services.lead')}</p>
          </div>
          <div class="svc-filter">
            <label class="sr-only" for="svc-q">
              {t('services.search')}
            </label>
            <input
              id="svc-q"
              type="search"
              placeholder={t('services.search')}
              data-filter="#svc-all"
              data-filter-empty="#svc-none"
              autocomplete="off"
            />
          </div>
          <p class="muted" id="svc-none" hidden>
            {t('services.none')}
          </p>
          <div id="svc-all">
            {/* What connects here today, categories side by side; everything else waits in the roadmap row. */}
            <div class="svc-cats">
              {CATEGORY_ORDER.map((cat) => {
                const inCat = services.filter((s) => s.ready && categoryOf(s.id) === cat);
                if (!inCat.length && cat !== 'custom') return null;
                return (
                  <div data-filter-group>
                    <h3 class="cat-title">{t(`category.${cat}`)}</h3>
                    <div class="svc-grid">
                      {inCat.map((s) => (
                        <ServiceCard ctx={ctx} service={s} />
                      ))}
                      {cat === 'custom' ? <McpCard ctx={ctx} /> : null}
                    </div>
                  </div>
                );
              })}
            </div>
            <Roadmap ctx={ctx} services={services} />
          </div>
          <div class="card svc-missing">
            <div class="row between">
              <div class="grow">
                <h3>{t('services.missing.title')}</h3>
                <p class="muted">{t('services.missing.text')}</p>
              </div>
              <a class="btn" href="/docs#custom">
                {t('services.missing.cta')}
              </a>
            </div>
          </div>
        </div>
      </section>
    </SiteLayout>
  );
};

export interface ServiceDetail extends PublicService {
  actions: { name: string; title: string; description: string; risk: RiskLevel }[];
  /** Setup steps for the way this service connects here (provider sign-in or the form). */
  guide?: ResolvedSetupGuide | undefined;
  /** Requests to try with the AI. */
  prompts: string[];
  /** Another way in while the service cannot be connected here (e.g. Gmail over IMAP). */
  alternative?: { service: string; url: string } | undefined;
}

/** Where the "Connect" button leads: the connect page, through sign-up for visitors. */
const connectHref = (ctx: PageCtx, path: string) =>
  ctx.user ? path : `/signup?next=${encodeURIComponent(path)}`;

export const ServiceDetailPage: FC<{
  ctx: PageCtx;
  service: ServiceDetail;
  /** Links to the service's page per AI app ("Use Gmail with Claude, ChatGPT, …"). */
  useWith?: Child;
}> = ({ ctx, service, useWith }) => {
  const { t } = ctx;
  const meta = serviceMeta(service.id);
  const reads = service.actions.filter((a) => a.risk === 'read').length;
  const target = service.ready
    ? {
        url: `/connect/${encodeURIComponent(service.id)}`,
        label: t('service.connectCta', { service: service.name }),
      }
    : service.alternative
      ? {
          url: service.alternative.url,
          label: t('service.altCta', { alternative: service.alternative.service }),
        }
      : undefined;
  return (
    <SiteLayout
      ctx={ctx}
      title={t('service.title', { service: service.name })}
      description={blurb(ctx.lang, service)}
      current="services"
      canonicalPath={`/services/${service.id}`}
      jsonLd={[
        breadcrumbs(ctx.publicUrl, [
          { name: t('crumb.home'), path: localizedPath('/', ctx.lang) },
          { name: t('site.nav.services'), path: localizedPath('/services', ctx.lang) },
          { name: service.name, path: localizedPath(`/services/${service.id}`, ctx.lang) },
        ]),
      ]}
    >
      <section class="section svc-page">
        <div class="wrap">
          <p class="crumbs">
            <a href="/services">{t('site.nav.services')}</a> / {service.name}
          </p>
          <div class="svc-hero">
            <ServiceLogo icon={meta?.icon} glyph={meta?.glyph} name={service.name} size="lg" />
            <div class="grow">
              <h1 class="section-title">{t('service.h1', { service: service.name })}</h1>
              <p class="lead">{blurb(ctx.lang, service)}</p>
              <ul class="svc-facts">
                <li>
                  <Icon name={service.connect === 'oauth' ? 'lock' : 'key'} />
                  {t(`service.fact.${service.connect}`, { service: service.name })}
                </li>
                <li>
                  <Icon name="check" />
                  {t('service.fact.tools', { n: service.actions.length, read: reads })}
                </li>
                <li>
                  <Icon name="users" />
                  {t('service.fact.accounts')}
                </li>
              </ul>
            </div>
            {target ? (
              <div class="svc-cta">
                <a class="btn primary lg" href={connectHref(ctx, target.url)}>
                  {target.label} <Icon name="arrow" />
                </a>
                {ctx.user ? null : <span class="small muted">{t('service.ctaNote')}</span>}
              </div>
            ) : null}
          </div>
          {service.ready ? null : (
            <div class="notice info">
              {t('service.notReady', { service: service.name })}{' '}
              {service.alternative
                ? t('service.notReadyAlt', {
                    service: service.name,
                    alternative: service.alternative.service,
                  })
                : null}
            </div>
          )}
          <div class="svc-detail-grid">
            <div class="card">
              <h2 class="h3">{t('service.how')}</h2>
              {service.guide ? (
                <SetupGuideView t={t} guide={service.guide} />
              ) : (
                <p class="muted">{t(`service.connect.${service.connect}`)}</p>
              )}
            </div>
            <div class="card">
              <h2 class="h3">{t('service.prompts')}</h2>
              {service.prompts.length ? (
                <PromptList t={t} prompts={service.prompts} idPrefix="ask" />
              ) : (
                <p class="muted">{t('service.promptsNone', { service: service.name })}</p>
              )}
              <p class="small muted">{t('service.multi')}</p>
            </div>
          </div>
          <div class="card flush">
            <div class="card-head pad">
              <h2 class="h3">{t('service.tools', { n: service.actions.length })}</h2>
              <p class="small muted">{t('service.toolsNote')}</p>
            </div>
            <div class="table-wrap">
              <table class="tools-table stack-sm">
                <thead>
                  <tr>
                    <th>{t('service.does')}</th>
                    <th>{t('service.risk')}</th>
                  </tr>
                </thead>
                <tbody>
                  {service.actions.map((a) => (
                    <tr>
                      <td>
                        <strong>{a.title}</strong>
                        <div class="small muted">{a.description}</div>
                        <code class="tool-id">{`${service.id}_${a.name}`}</code>
                      </td>
                      <td class="nowrap">
                        <RiskBadge t={t} risk={a.risk} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {useWith}
        </div>
      </section>
    </SiteLayout>
  );
};

// ---------------------------------------------------------------------------
// Docs: connecting AI clients
// ---------------------------------------------------------------------------

export const ClientGuides: FC<{
  ctx: PageCtx;
  mcpUrl: string;
  idPrefix: string;
  headingLevel?: 2 | 3;
  /** Link each client to its own guide page (the public docs). */
  guideLinks?: boolean;
}> = ({ ctx, mcpUrl, idPrefix, guideLinks }) => {
  const { t, lang } = ctx;
  return (
    <>
      {CLIENT_GUIDES.map((g) => {
        const install = g.install?.(mcpUrl);
        const guidePath = guideLinks ? clientGuidePath(g.id) : undefined;
        return (
          <section class="guide" id={g.id}>
            <h2>
              <ServiceLogo icon={g.icon} glyph={g.glyph} name={g.name} size="sm" />
              {clientName(g, lang)}
            </h2>
            <p class="muted small">{lang === 'ru' ? g.note.ru : g.note.en}</p>
            <ol>
              {(lang === 'ru' ? g.steps.ru : g.steps.en).map((step, i) => (
                <li>
                  {step}
                  {/* The first step puts the button, command or config in place: it sits right under it. */}
                  {i === 0 && (install || g.code) ? (
                    <div class="guide-do">
                      {install ? (
                        <p>
                          <a class="btn primary" href={install.href}>
                            {lang === 'ru' ? install.label.ru : install.label.en}
                          </a>
                        </p>
                      ) : null}
                      {g.code ? <CodeBlock t={t} id={`${idPrefix}-${g.id}`} code={g.code(mcpUrl)} /> : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
            {guidePath ? (
              <p class="small">
                <a href={localizedPath(guidePath, lang)}>
                  {t('guide.full')}: {clientName(g, lang)} <Icon name="arrow" />
                </a>
              </p>
            ) : null}
          </section>
        );
      })}
    </>
  );
};

/** Names of the services that connect here today in one way, as the reader's language lists them. */
const namesBy = (ctx: PageCtx, services: PublicService[], connect: PublicService['connect']) =>
  new Intl.ListFormat(ctx.lang, { type: 'conjunction' }).format(
    services
      .filter((s) => s.ready && s.connect === connect && serviceMeta(s.id)?.category !== 'custom')
      .map((s) => s.name),
  );

export const DocsPage: FC<{
  ctx: PageCtx;
  services: PublicService[];
  /** The Telegram bot is set up on this server, so approvals can go there too. */
  telegram: boolean;
}> = ({ ctx, services, telegram }) => {
  const { t, lang } = ctx;
  // The lists name what this server can connect now, so the page never promises a missing app.
  const oauth = namesBy(ctx, services, 'oauth');
  const form = namesBy(ctx, services, 'form');
  return (
    <SiteLayout
      ctx={ctx}
      title={t('docs.title')}
      description={t('docs.description')}
      current="docs"
      canonicalPath="/docs"
    >
      <div class="wrap">
        <div class="doc-layout">
          <nav class="doc-nav" aria-label={t('docs.nav')}>
            <span class="group">{t('docs.start')}</span>
            <a href="#url">{t('docs.url')}</a>
            <span class="group">{t('docs.clients')}</span>
            {CLIENT_GUIDES.map((g) => (
              <a href={`#${g.id}`}>{clientName(g, lang)}</a>
            ))}
            <span class="group">{t('docs.more')}</span>
            <a href="#check">{t('docs.check')}</a>
            <a href="#services">{t('docs.services')}</a>
            <a href="#custom">{t('docs.custom')}</a>
            <a href="#safety">{t('docs.safety')}</a>
            <a href="#api">{t('docs.api')}</a>
            <span class="group">{t('site.nav.guides')}</span>
            {ARTICLES.map((a) => (
              <a href={localizedPath(`/guides/${a.slug}`, lang)}>{a.body[lang].h1}</a>
            ))}
            <a href={localizedPath('/faq', lang)}>{t('site.nav.faq')}</a>
            <a href={localizedPath('/compare', lang)}>{t('site.nav.compare')}</a>
          </nav>
          <div>
            <section class="guide" id="url">
              <p class="eyebrow">{t('docs.eyebrow')}</p>
              <h1>{t('docs.h1')}</h1>
              <p class="lead">{t('docs.lead')}</p>
              <CopyField t={t} id="docs-mcp-url" value={ctx.mcpUrl} label={t('home.mcpUrl')} />
              <p class="hint">{t('docs.urlHint')}</p>
            </section>
            <ClientGuides ctx={ctx} mcpUrl={ctx.mcpUrl} idPrefix="docs" guideLinks />
            <section class="guide" id="check">
              <h2>{t('docs.check')}</h2>
              <p>{t('docs.check.text')}</p>
              <ul class="bullets">
                <li>{t('docs.check.signin')}</li>
                <li>{t('docs.check.tools')}</li>
                <li>{t('docs.check.accounts')}</li>
                <li>
                  {t('docs.check.blocked')} <a href="/app/rules">{t('docs.safety.rules')}</a>
                </li>
              </ul>
            </section>
            <section class="guide" id="services">
              <h2>{t('docs.services')}</h2>
              <p>{t('docs.services.text')}</p>
              <ul class="bullets">
                {oauth ? <li>{t('docs.services.oauth', { services: oauth })}</li> : null}
                {form ? <li>{t('docs.services.form', { services: form })}</li> : null}
                <li>{t('docs.services.chat')}</li>
              </ul>
            </section>
            <section class="guide" id="custom">
              <h2>{t('docs.custom')}</h2>
              <p>{t('docs.custom.text')}</p>
              <ul class="bullets">
                <li>{t('docs.custom.mcp')}</li>
                <li>{t('docs.custom.http')}</li>
              </ul>
            </section>
            <section class="guide" id="safety">
              <h2>{t('docs.safety')}</h2>
              <p>
                {t('docs.safety.text')} {telegram ? t('docs.safety.telegram') : null}
              </p>
              <p>
                <a href="/app/rules">{t('docs.safety.rules')}</a> ·{' '}
                <a href="/security">{t('docs.safety.link')}</a>
              </p>
            </section>
            <section class="guide" id="api">
              <h2>{t('docs.api')}</h2>
              <p>{t('docs.api.text')}</p>
              <ul class="bullets">
                <li>{t('docs.api.token')}</li>
                <li>{t('docs.api.rules')}</li>
              </ul>
              <div class="codebox">
                curl -H "Authorization: Bearer <i>ac_pat_…</i>" {ctx.publicUrl}/api/v1/rules
              </div>
            </section>
          </div>
        </div>
      </div>
    </SiteLayout>
  );
};

// ---------------------------------------------------------------------------
// Legal
// ---------------------------------------------------------------------------

export interface LegalDoc {
  title: string;
  updated: string;
  intro: string;
  sections: { title: string; paragraphs: string[] }[];
}

export const LegalPage: FC<{ ctx: PageCtx; doc: LegalDoc; path: string }> = ({ ctx, doc, path }) => (
  <SiteLayout
    ctx={ctx}
    title={`${doc.title} · ${BRAND.name}`}
    description={doc.intro}
    current="legal"
    canonicalPath={path}
  >
    <div class="wrap">
      <article class="prose">
        <h1>{doc.title}</h1>
        <p class="muted">{doc.updated}</p>
        <p>{doc.intro}</p>
        {doc.sections.map((s) => (
          <>
            <h2>{s.title}</h2>
            {s.paragraphs.map((p) => (
              <p>{p}</p>
            ))}
          </>
        ))}
      </article>
    </div>
  </SiteLayout>
);
