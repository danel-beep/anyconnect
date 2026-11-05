import type { Child, FC } from 'hono/jsx';
import { type Metric, PLANS, type Plan } from '../billing/plans.js';
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
import type { Translate } from './i18n.js';
import type { PageCtx } from './page-context.js';
import { ARTICLES } from './seo/articles.js';
import { clientGuidePath } from './seo/client-pages.js';
import { OG_IMAGE_PATH } from './seo/og-image.js';
import {
  breadcrumbs,
  faqPage,
  type JsonLd,
  organization,
  softwareApplication,
  website,
} from './seo/structured-data.js';
import { alternates, localizedPath, OG_LOCALE, SITE_LOCALES } from './seo/urls.js';
import { PromptList, RiskBadge, SetupGuideView } from './setup-guide.js';
import {
  Brand,
  BrandIcon,
  CodeBlock,
  CopyField,
  fmtNumber,
  GoogleG,
  Icon,
  Prefs,
  ServiceLogo,
} from './ui.js';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type Section = 'home' | 'services' | 'pricing' | 'docs' | 'legal' | 'status';

const SiteHeader: FC<{ ctx: PageCtx; current: Section }> = ({ ctx, current }) => {
  const { t } = ctx;
  const nav: [Section | 'features', string, string][] = [
    ['features', '/#features', t('site.nav.features')],
    ['services', '/services', t('site.nav.services')],
    ['pricing', '/pricing', t('site.nav.pricing')],
    ['docs', '/docs', t('site.nav.docs')],
  ];
  return (
    <header class="site-header" data-site-header>
      <div class="wrap">
        <Brand />
        <nav class="site-nav" id="site-nav" aria-label={t('site.nav.label')}>
          {nav.map(([id, href, label]) => (
            <a href={localizedPath(href, ctx.lang)} aria-current={id === current ? 'page' : undefined}>
              {label}
            </a>
          ))}
          {/* Phones: the header has room only for the logo and the menu, so the buttons live here. */}
          <div class="nav-extra">
            {ctx.user ? (
              <a class="btn primary" href="/app">
                {t('site.cta.dashboard')}
              </a>
            ) : (
              <>
                <a class="btn" href="/login">
                  {t('site.cta.signIn')}
                </a>
                <a class="btn primary" href="/signup">
                  {t('site.cta.start')}
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
                {t('site.cta.start')}
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
            <h4>{t('site.footer.product')}</h4>
            <a href={localizedPath('/#features', ctx.lang)}>{t('site.nav.features')}</a>
            <a href={localizedPath('/services', ctx.lang)}>{t('site.nav.services')}</a>
            <a href={localizedPath('/pricing', ctx.lang)}>{t('site.nav.pricing')}</a>
            <a href={localizedPath('/docs', ctx.lang)}>{t('site.nav.docs')}</a>
          </div>
          <div>
            <h4>{t('site.footer.resources')}</h4>
            <a href={localizedPath('/guides/what-is-mcp', ctx.lang)}>{t('site.nav.whatIsMcp')}</a>
            <a href={localizedPath('/faq', ctx.lang)}>{t('site.nav.faq')}</a>
            <a href={localizedPath('/use-cases', ctx.lang)}>{t('site.nav.useCases')}</a>
            <a href={localizedPath('/blog', ctx.lang)}>{t('site.nav.blog')}</a>
            <a href={localizedPath('/compare', ctx.lang)}>{t('site.nav.compare')}</a>
          </div>
          <div>
            <h4>{t('site.footer.account')}</h4>
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
            <h4>{t('site.footer.company')}</h4>
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
const StartButton: FC<{ ctx: PageCtx; size?: 'lg' }> = ({ ctx, size }) =>
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
  return t(`plan.metric.${metric}`, { n: fmtNumber(lang, value) });
};

/** A plan's start in short: trial length and plan, and the steps down ("500 → 300"). */
function startText(lang: string, plan: Plan): { days: number; plan: string; steps: string } {
  const start = plan.start!;
  const steps = start.steps
    .map((s) => s.limits.actions)
    .filter((n): n is number => typeof n === 'number')
    .map((n) => fmtNumber(lang, n))
    .join(' → ');
  return { days: start.trial.days, plan: start.trial.plan, steps };
}

export const PlanCard: FC<{
  ctx: PageCtx;
  plan: Plan;
  current?: boolean;
  action?: Child;
}> = ({ ctx, plan, current, action }) => {
  const { t, lang } = ctx;
  const start = plan.start ? startText(lang, plan) : undefined;
  // What every plan gives today; features still being built are listed apart in the compare table.
  const features: Metric[] = ['actions', 'accounts', 'historyDays'];
  const featureText = (metric: Metric): string => {
    if (metric === 'actions' && start)
      return t('plan.metric.actionsSteps', {
        n: fmtNumber(lang, plan.limits.actions ?? 0),
        steps: start.steps,
      });
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
          <span class="per">{t('pricing.perMonth')}</span>
        </div>
        <div class="price-year">
          {plan.priceMonthly === 0 ? (
            t('pricing.forever')
          ) : (
            <>
              <span class="when-month">{t('pricing.orYear', { price: `$${plan.priceYearly}` })}</span>
              <span class="when-year">{t('pricing.billedYear', { price: `$${plan.priceYearly}` })}</span>
            </>
          )}
        </div>
      </div>
      <ul>
        {start ? (
          <li>
            <Check />
            <span>
              {t('plan.metric.trial', {
                days: start.days,
                plan: t(`plan.${start.plan}.name` as 'plan.free.name'),
              })}
            </span>
          </li>
        ) : null}
        {features.map((metric) => (
          <li>
            <Check />
            <span>{featureText(metric)}</span>
          </li>
        ))}
        <li>
          <Check />
          <span>{t('plan.feature.teams')}</span>
        </li>
        <li>
          <Check />
          <span>{t('plan.feature.everything')}</span>
        </li>
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
        {ctx.t('pricing.yearly')} <span class="save">{ctx.t('pricing.save')}</span>
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
  // Paid plans: after signing up the user lands on the billing page to request (or buy) the plan.
  // A plan is always a person's own; a team runs on the plan of whoever pays for it.
  const target = '/app/billing';
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

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

const DemoWindow: FC<{ t: Translate }> = ({ t }) => (
  <div class="demo" aria-label={t('landing.demo.label')} role="img">
    <div class="demo-bar">
      <span class="demo-avatar">
        <BrandIcon slug="claude" />
      </span>
      <strong class="grow">{t('landing.demo.title')}</strong>
      <span class="demo-status">
        <span class="dot ok" /> {t('landing.demo.connected')}
      </span>
    </div>
    <div class="demo-body">
      <div class="msg user step s1">{t('landing.demo.ask')}</div>
      <div class="call step s2">
        <span class="dot ok" />
        <span class="args">
          <b>mail_search</b> account: "all", query: "ACME invoice"
        </span>
        <span class="res">{t('landing.demo.found')}</span>
      </div>
      <div class="call step s3">
        <span class="dot ok" />
        <span class="args">
          <b>mail_read</b> gmail:work · INV-2041
        </span>
        <span class="res">{t('landing.demo.read')}</span>
      </div>
      <div class="call step s4">
        <span class="dot accent" />
        <span class="args">
          <b>messages_send</b> slack:team → @alex
        </span>
        <span class="res wait">{t('landing.demo.confirmed')}</span>
      </div>
      <div class="msg ai step s5">{t('landing.demo.answer')}</div>
    </div>
    <div class="demo-input" aria-hidden="true">
      <span class="grow">{t('landing.demo.input')}</span>
      <Icon name="arrow" />
    </div>
  </div>
);

const WORKS_WITH: { name: string; icon?: string }[] = [
  { name: 'Claude', icon: 'claude' },
  { name: 'ChatGPT' },
  { name: 'Claude Code', icon: 'anthropic' },
  { name: 'Cursor', icon: 'cursor' },
  { name: 'VS Code' },
  { name: 'Gemini CLI', icon: 'googlegemini' },
  { name: 'Windsurf', icon: 'windsurf' },
];

export const LandingPage: FC<{ ctx: PageCtx; services: PublicService[] }> = ({ ctx, services }) => {
  const { t } = ctx;
  return (
    <SiteLayout
      ctx={ctx}
      title={t('landing.title')}
      description={t('landing.description')}
      current="home"
      canonicalPath="/"
      jsonLd={[
        organization(ctx.publicUrl, ctx.supportEmail),
        website(ctx.publicUrl, t('landing.description'), ctx.lang),
        productLd(ctx, t('landing.description')),
        faqPage(faqItems(t, LANDING_FAQ)),
      ]}
    >
      <section class="hero">
        <div class="wrap">
          <div>
            <h1>
              {t('landing.h1a')} <span class="mark">{t('landing.h1b')}</span> {t('landing.h1c')}
            </h1>
            <p class="lead">{t('landing.lead')}</p>
            <div class="hero-actions">
              <StartButton ctx={ctx} size="lg" />
              <a class="btn lg ghost" href="#how">
                {t('landing.how')}
              </a>
            </div>
            <p class="hero-note">
              <span>
                <Icon name="check" /> {t('landing.note.free')}
              </span>
              <span>
                <Icon name="check" /> {t('landing.note.card')}
              </span>
              <span>
                <Icon name="check" /> {t('landing.note.encrypted')}
              </span>
            </p>
          </div>
          <DemoWindow t={t} />
        </div>
      </section>

      <section class="section" id="how">
        <div class="wrap">
          <div class="section-head">
            <h2>{t('landing.how.title')}</h2>
            <p>{t('landing.how.lead')}</p>
          </div>
          <div class="steps">
            <div class="step-card">
              <span class="n">01</span>
              <h3>{t('landing.step1.title')}</h3>
              <p>{t('landing.step1.text')}</p>
              <div class="visual">
                <span class="btn block btn-google" aria-hidden="true">
                  <GoogleG /> {t('login.google')}
                </span>
              </div>
            </div>
            <div class="step-card">
              <span class="n">02</span>
              <h3>{t('landing.step2.title')}</h3>
              <p>{t('landing.step2.text')}</p>
              <div class="visual">
                <div class="chips">
                  <span class="chip on">
                    <BrandIcon slug="gmail" /> gmail:work
                  </span>
                  <span class="chip on">
                    <BrandIcon slug="gmail" /> gmail:personal
                  </span>
                  <span class="chip">
                    <BrandIcon slug="notion" /> notion:wiki
                  </span>
                </div>
              </div>
            </div>
            <div class="step-card">
              <span class="n">03</span>
              <h3>{t('landing.step3.title')}</h3>
              <p>{t('landing.step3.text')}</p>
              <div class="visual stack">
                <div class="url-pill">
                  <span class="dot accent" /> {ctx.mcpUrl}
                </div>
                <div class="prompt-pill">{t('landing.step3.prompt')}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="section border">
        <div class="wrap">
          <div class="section-head">
            <h2>{t('landing.map.title')}</h2>
            <p>{t('landing.map.lead')}</p>
          </div>
          <div class="hubmap">
            <div class="hubmap-col left">
              {WORKS_WITH.slice(0, 4).map((c) => (
                <div class="node">
                  {c.icon ? <BrandIcon slug={c.icon} /> : <Icon name="zap" />}
                  {c.name}
                </div>
              ))}
            </div>
            <div class="hub-core">
              <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
                <rect class="bm-bg" width="32" height="32" rx="8" />
                <path
                  class="bm-fg"
                  d="M16 7a9 9 0 1 1-9 9"
                  fill="none"
                  stroke-width="2.8"
                  stroke-linecap="round"
                />
                <circle class="bm-dot" cx="16" cy="16" r="3.4" />
                <circle class="bm-dot" cx="7" cy="9.6" r="2" />
              </svg>
              <strong>Manyplug</strong>
              <code>/mcp</code>
            </div>
            <div class="hubmap-col right">
              <div class="node">
                <BrandIcon slug="gmail" /> Gmail
                <span class="accs">
                  <span class="acc">work</span>
                  <span class="acc">personal</span>
                </span>
              </div>
              <div class="node">
                <Icon name="mail" /> {t('landing.map.imap')}
                <span class="accs">
                  <span class="acc">fastmail</span>
                </span>
              </div>
              <div class="node">
                <BrandIcon slug="googlecalendar" />{' '}
                {ctx.lang === 'ru' ? 'Google Календарь' : 'Google Calendar'}
                <span class="accs">
                  <span class="acc">team</span>
                </span>
              </div>
              <div class="node">
                <BrandIcon slug="notion" /> Notion
              </div>
              <div class="node">
                <Icon name="braces" /> {t('landing.map.api')}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="section border" id="features">
        <div class="wrap">
          <div class="section-head">
            <h2>{t('landing.features.title')}</h2>
          </div>
          <div class="bento">
            <div class="tile c4">
              <h3>{t('landing.f.accounts.title')}</h3>
              <p>{t('landing.f.accounts.text')}</p>
              <div class="visual stack">
                <div class="chips">
                  <span class="chip on">
                    <BrandIcon slug="gmail" /> gmail:work
                  </span>
                  <span class="chip on">
                    <BrandIcon slug="gmail" /> gmail:personal
                  </span>
                  <span class="chip on">
                    <Icon name="mail" /> imap:fastmail
                  </span>
                  <span class="chip">
                    <BrandIcon slug="googlecalendar" /> gcal:team
                  </span>
                  <span class="chip">
                    <BrandIcon slug="notion" /> notion:wiki
                  </span>
                  <span class="chip">
                    <BrandIcon slug="github" /> github:company
                  </span>
                </div>
                <div class="codebox">
                  <b>mail_search</b>({'{'} account: <i>"all"</i>, query:{' '}
                  <i>"{t('landing.f.accounts.query')}"</i> {'}'}) → 3 {t('landing.f.accounts.inboxes')}
                </div>
              </div>
            </div>
            <div class="tile c2">
              <h3>{t('landing.f.confirm.title')}</h3>
              <p>{t('landing.f.confirm.text')}</p>
              {/* An approval as the dashboard shows it (Telegram is optional, so it is not the picture). */}
              <div class="visual ask">
                <div class="who">
                  <Icon name="bell" /> {BRAND.name}
                </div>
                {t('landing.f.confirm.message')}
                <div class="btns">
                  <span>{t('landing.f.confirm.no')}</span>
                  <span class="yes">{t('landing.f.confirm.yes')}</span>
                </div>
              </div>
            </div>
            <div class="tile c2">
              <h3>{t('landing.f.context.title')}</h3>
              <p>{t('landing.f.context.text')}</p>
              <div class="visual bars">
                <div class="bar">
                  <span>{t('landing.f.context.few')}</span>
                  <div class="meter ok">
                    <span class="w-35" />
                  </div>
                  <span class="mono tiny">{t('landing.f.context.tokens')}</span>
                </div>
                <div class="bar">
                  <span>{t('landing.f.context.many')}</span>
                  <div class="meter ok">
                    <span class="w-40" />
                  </div>
                  <span class="mono tiny">{t('landing.f.context.tokens')}</span>
                </div>
              </div>
            </div>
            <div class="tile c2">
              <h3>{t('landing.f.unified.title')}</h3>
              <p>{t('landing.f.unified.text')}</p>
              <div class="visual chips">
                <span class="chip on">mail_search</span>
                <span class="chip on">messages_send</span>
                <span class="chip on">calendar_list_events</span>
                <span class="chip">tasks_create</span>
              </div>
            </div>
            <div class="tile c2">
              <h3>{t('landing.f.api.title')}</h3>
              <p>{t('landing.f.api.text')}</p>
              <div class="visual codebox">
                {'{ '}
                <b>"kind"</b>: <i>"mcp"</i>,{'\n  '}
                <b>"url"</b>: <i>"https://crm.example/mcp"</i>
                {' }'}
              </div>
            </div>
            <div class="tile c3">
              <h3>{t('landing.f.chat.title')}</h3>
              <p>{t('landing.f.chat.text')}</p>
              <div class="visual">
                <div class="prompt-pill">{t('landing.f.chat.prompt')}</div>
              </div>
            </div>
            <div class="tile c3">
              <h3>{t('landing.f.personas.title')}</h3>
              <p>{t('landing.f.personas.text')}</p>
              <div class="visual chips">
                <span class="chip on">/mcp/work</span>
                <span class="chip">/mcp/personal</span>
                <span class="chip">{t('landing.f.personas.read')}</span>
                <span class="chip">{t('landing.f.personas.confirm')}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="section border">
        <div class="wrap">
          <div class="section-head row between">
            <div>
              <h2>{t('landing.services.title')}</h2>
              <p>{t('landing.services.lead')}</p>
            </div>
          </div>
          <div class="svc-grid">
            {services
              .filter((s) => s.ready)
              .map((s) => (
                <ServiceCard ctx={ctx} service={s} />
              ))}
          </div>
          <Roadmap ctx={ctx} services={services} limit={8} />
          <p class="actions start">
            <a class="btn" href="/services">
              {t('landing.services.all')} <Icon name="arrow" />
            </a>
          </p>
        </div>
      </section>

      <section class="section border" id="security">
        <div class="wrap">
          <div class="section-head">
            <h2>{t('landing.security.title')}</h2>
            <p>{t('landing.security.lead')}</p>
          </div>
          <div class="sec-grid">
            {(
              [
                ['lock', 'encryption'],
                ['key', 'secrets'],
                ['bell', 'confirm'],
                ['users', 'rules'],
                ['shield', 'injection'],
                ['activity', 'audit'],
              ] as const
            ).map(([icon, key]) => (
              <div class="sec-item">
                <h3>
                  <Icon name={icon} /> {t(`landing.sec.${key}.title`)}
                </h3>
                <p>{t(`landing.sec.${key}.text`)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section class="section border" id="pricing">
        <div class="wrap">
          <div class="section-head">
            <h2>{t('landing.pricing.title')}</h2>
            <p>{t('landing.pricing.lead')}</p>
          </div>
          <PlansGrid ctx={ctx} />
        </div>
      </section>

      <section class="section border" id="faq">
        <div class="wrap">
          <div class="section-head">
            <h2>{t('landing.faq.title')}</h2>
          </div>
          <Faq t={t} keys={LANDING_FAQ} />
        </div>
      </section>

      <section class="section tight">
        <div class="wrap">
          <div class="cta-band">
            <div>
              <h2>{t('landing.cta.title')}</h2>
              <p>{t('landing.cta.text')}</p>
            </div>
            <div class="hero-actions">
              <StartButton ctx={ctx} size="lg" />
            </div>
          </div>
        </div>
      </section>
    </SiteLayout>
  );
};

type FaqKey =
  | 'mcp'
  | 'why'
  | 'secrets'
  | 'action'
  | 'limit'
  | 'custom'
  | 'delete'
  | 'reset'
  | 'upgrade'
  | 'many'
  | 'jobs'
  | 'teams';

const LANDING_FAQ: FaqKey[] = ['mcp', 'why', 'secrets', 'action', 'limit', 'custom', 'delete'];
const PRICING_FAQ: FaqKey[] = ['action', 'reset', 'limit', 'upgrade', 'teams', 'many', 'jobs'];

const faqItems = (t: Translate, keys: FaqKey[]) =>
  keys.map((key) => ({ q: t(`faq.${key}.q`), a: t(`faq.${key}.a`) }));

/** schema.org data of the product with its plans (landing and pricing pages). */
const productLd = (ctx: PageCtx, description: string): JsonLd =>
  softwareApplication(ctx.publicUrl, {
    description,
    plans: PLANS,
    planName: (plan) => ctx.t(`plan.${plan.id}.name` as 'plan.free.name'),
  });

const Faq: FC<{ t: Translate; keys: FaqKey[] }> = ({ t, keys }) => (
  <div>
    {keys.map((key) => (
      <details>
        <summary>{t(`faq.${key}.q`)}</summary>
        <div>{t(`faq.${key}.a`)}</div>
      </details>
    ))}
  </div>
);

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

const COMPARE: Metric[] = ['actions', 'accounts', 'historyDays'];
/** Limits for features still being built: shown once, under their own heading. */
const COMPARE_SOON: Metric[] = ['messengers', 'backgroundJobs'];

const cell = (t: Translate, lang: string, metric: Metric, plan: Plan) => {
  const v = plan.limits[metric];
  if (v === null) return t('pricing.unlimited');
  if (v === 0) return '—';
  if (metric === 'historyDays') return t('pricing.days', { n: v });
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
                    <td class="num">{p.priceMonthly === 0 ? t('pricing.free') : `$${p.priceMonthly}`}</td>
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
                              steps: startText(lang, p).steps,
                            })}
                          </div>
                        ) : null}
                      </td>
                    ))}
                  </tr>
                ))}
                {(['teams', 'security', 'unified', 'custom', 'personas'] as const).map((f) => (
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
          <Faq t={t} keys={PRICING_FAQ} />
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
