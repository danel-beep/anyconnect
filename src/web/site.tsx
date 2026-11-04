import type { Child, FC } from 'hono/jsx';
import { type Limits, type Metric, PLANS, type Plan } from '../billing/plans.js';
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

type Section = 'home' | 'services' | 'pricing' | 'docs' | 'legal';

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
            <a href={href} aria-current={id === current ? 'page' : undefined}>
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
            <a href="/#features">{t('site.nav.features')}</a>
            <a href="/services">{t('site.nav.services')}</a>
            <a href="/pricing">{t('site.nav.pricing')}</a>
            <a href="/docs">{t('site.nav.docs')}</a>
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
            {ctx.supportEmail ? <a href={`mailto:${ctx.supportEmail}`}>{t('site.footer.contact')}</a> : null}
            <a href="/privacy">{t('site.footer.privacy')}</a>
            <a href="/terms">{t('site.footer.terms')}</a>
          </div>
        </div>
        <div class="footer-bottom">
          <span>© {new Date().getUTCFullYear()} AnyConnect</span>
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
  canonicalPath: string;
  children?: Child;
}> = ({ ctx, title, description, current, canonicalPath, children }) => (
  <Doc title={title} lang={ctx.lang} description={description} canonical={`${ctx.publicUrl}${canonicalPath}`}>
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
        <span class="name">{service.name}</span>
        <span class="meta">{blurb(ctx.lang, service)}</span>
      </span>
    </a>
  );
};

const PlannedCard: FC<{
  ctx: PageCtx;
  name: string;
  icon?: string | undefined;
  glyph?: string | undefined;
}> = ({ ctx, name, icon }) => (
  <div class="svc soon" data-search={name}>
    <ServiceLogo icon={icon} name={name} />
    <span class="grow">
      <span class="name">{name}</span>
      <span class="meta">{ctx.t('site.services.soon')}</span>
    </span>
  </div>
);

const Check: FC = () => <Icon name="check" />;

const limitText = (t: Translate, lang: string, metric: Metric, value: number | null): string => {
  if (value === null) return t(`plan.metric.${metric}.unlimited`);
  if (metric === 'messengers' && value === 0) return t('plan.metric.messengers.none');
  if (metric === 'seats' && value === 1) return t('plan.metric.seats.solo');
  return t(`plan.metric.${metric}`, { n: fmtNumber(lang, value) });
};

export const PlanCard: FC<{
  ctx: PageCtx;
  plan: Plan;
  current?: boolean;
  action?: Child;
}> = ({ ctx, plan, current, action }) => {
  const { t, lang } = ctx;
  const intro = plan.intro?.limits.actions;
  const features: [Metric, boolean][] = [
    ['actions', true],
    ['accounts', true],
    ['messengers', (plan.limits.messengers ?? 1) > 0],
    ['backgroundJobs', true],
    ['historyDays', true],
    ['seats', (plan.limits.seats ?? 2) > 1],
  ];
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
          <span class="amount when-year">
            ${plan.priceYearly === 0 ? 0 : Math.round((plan.priceYearly / 12) * 10) / 10}
          </span>
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
        {features.map(([metric, on]) => (
          <li class={on ? undefined : 'off'}>
            <Check />
            <span>
              {metric === 'actions' && intro
                ? t('plan.metric.actionsIntro', {
                    n: fmtNumber(lang, plan.limits.actions ?? 0),
                    intro: fmtNumber(lang, intro),
                    days: plan.intro!.days,
                  })
                : limitText(t, lang, metric, plan.limits[metric])}
            </span>
          </li>
        ))}
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
  const href =
    plan.priceMonthly === 0
      ? ctx.user
        ? '/app'
        : '/signup'
      : ctx.user
        ? '/app/billing'
        : `/signup?next=${encodeURIComponent('/app/billing')}`;
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
          <b>messages_send</b> slack:team → @ivan
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
              <strong>AnyConnect</strong>
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
                  <span class="acc">yandex</span>
                </span>
              </div>
              <div class="node">
                <BrandIcon slug="googlecalendar" /> Google Calendar
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
                    <Icon name="mail" /> imap:yandex
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
              <div class="visual tg">
                <div class="who">
                  <BrandIcon slug="telegram" /> AnyConnect
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
                  <span class="mono tiny">≤ 3k</span>
                </div>
                <div class="bar">
                  <span>{t('landing.f.context.many')}</span>
                  <div class="meter ok">
                    <span class="w-40" />
                  </div>
                  <span class="mono tiny">≤ 3k</span>
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
            {services.map((s) => (
              <ServiceCard ctx={ctx} service={s} />
            ))}
            {PLANNED_SERVICES.slice(0, 4).map((p) => (
              <PlannedCard ctx={ctx} name={p.name} icon={p.icon} />
            ))}
          </div>
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
          <Faq t={t} keys={['mcp', 'why', 'secrets', 'action', 'limit', 'custom', 'delete']} />
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
  | 'many';

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

const COMPARE: Metric[] = ['actions', 'accounts', 'messengers', 'backgroundJobs', 'historyDays', 'seats'];

const cell = (t: Translate, lang: string, metric: Metric, limits: Limits) => {
  const v = limits[metric];
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
    >
      <section class="section">
        <div class="wrap">
          <div class="section-head">
            <h2>{t('pricing.h1')}</h2>
            <p>{t('pricing.lead')}</p>
          </div>
          {ctx.billing ? null : <div class="notice info">{t('pricing.paymentsSoon')}</div>}
          <PlansGrid ctx={ctx} />
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
                        {cell(t, lang, metric, p.limits)}
                        {metric === 'actions' && p.intro?.limits.actions ? (
                          <div class="tiny muted">
                            {t('pricing.introCell', {
                              n: fmtNumber(lang, p.intro.limits.actions),
                              days: p.intro.days,
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
          <Faq t={t} keys={['action', 'reset', 'limit', 'upgrade', 'many']} />
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
            <h2>{t('services.h1')}</h2>
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
            {CATEGORY_ORDER.map((cat) => {
              const inCat = services.filter((s) => categoryOf(s.id) === cat);
              const planned = PLANNED_SERVICES.filter((p) => p.category === cat);
              if (!inCat.length && !planned.length) return null;
              return (
                <div data-filter-group>
                  <h3 class="cat-title">{t(`category.${cat}`)}</h3>
                  <div class="svc-grid">
                    {inCat.map((s) => (
                      <ServiceCard ctx={ctx} service={s} />
                    ))}
                    {planned.map((p) => (
                      <PlannedCard ctx={ctx} name={p.name} icon={p.icon} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div class="card">
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
  homepage?: string | undefined;
  actions: { name: string; title: string; description: string; risk: 'read' | 'write' | 'dangerous' }[];
}

export const ServiceDetailPage: FC<{ ctx: PageCtx; service: ServiceDetail }> = ({ ctx, service }) => {
  const { t } = ctx;
  const meta = serviceMeta(service.id);
  return (
    <SiteLayout
      ctx={ctx}
      title={t('service.title', { service: service.name })}
      description={blurb(ctx.lang, service)}
      current="services"
      canonicalPath={`/services/${service.id}`}
    >
      <section class="section">
        <div class="wrap">
          <p class="crumbs">
            <a href="/services">{t('site.nav.services')}</a> / {service.name}
          </p>
          <div class="svc-hero">
            <ServiceLogo icon={meta?.icon} glyph={meta?.glyph} name={service.name} size="lg" />
            <div class="grow">
              <h2 class="section-title">{service.name}</h2>
              <p class="lead">{blurb(ctx.lang, service)}</p>
            </div>
          </div>
          <div class="grid-2">
            <div class="card">
              <h3>{t('service.how')}</h3>
              <p class="muted">{t(`service.connect.${service.connect}`)}</p>
              <ol class="bullets">
                <li>{t('service.step1')}</li>
                <li>{t('service.step2', { service: service.name })}</li>
                <li>{t('service.step3')}</li>
              </ol>
              <div class="actions start">
                <a
                  class="btn primary"
                  href={
                    ctx.user
                      ? `/app/services#add-${service.id}`
                      : `/signup?next=${encodeURIComponent('/app/services')}`
                  }
                >
                  {t('service.connectCta', { service: service.name })}
                </a>
                {service.homepage ? (
                  <a class="btn ghost" href={service.homepage} rel="noopener noreferrer" target="_blank">
                    {t('service.homepage')} <Icon name="external" />
                  </a>
                ) : null}
              </div>
            </div>
            <div class="card">
              <h3>{t('service.prompts')}</h3>
              <ul class="bullets muted">
                <li>{t('service.prompt1', { service: service.name })}</li>
                <li>{t('service.prompt2', { service: service.name })}</li>
              </ul>
              <p class="small muted">{t('service.multi')}</p>
            </div>
          </div>
          <div class="card flush">
            <div class="card-head pad">
              <h3>{t('service.tools', { n: service.actions.length })}</h3>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('service.tool')}</th>
                    <th>{t('service.does')}</th>
                    <th>{t('service.risk')}</th>
                  </tr>
                </thead>
                <tbody>
                  {service.actions.map((a) => (
                    <tr>
                      <td class="nowrap">
                        <code>{`${service.id}_${a.name}`}</code>
                      </td>
                      <td>
                        <strong>{a.title}</strong>
                        <div class="small muted">{a.description}</div>
                      </td>
                      <td>
                        <span
                          class={`badge ${a.risk === 'dangerous' ? 'bad' : a.risk === 'write' ? 'accent' : ''}`}
                        >
                          {t(`risk.${a.risk}`)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </SiteLayout>
  );
};

// ---------------------------------------------------------------------------
// Docs: connecting AI clients
// ---------------------------------------------------------------------------

export const ClientGuides: FC<{ ctx: PageCtx; mcpUrl: string; idPrefix: string; headingLevel?: 2 | 3 }> = ({
  ctx,
  mcpUrl,
  idPrefix,
}) => {
  const { t, lang } = ctx;
  return (
    <>
      {CLIENT_GUIDES.map((g) => {
        const install = g.install?.(mcpUrl);
        return (
          <section class="guide" id={g.id}>
            <h2>
              <ServiceLogo icon={g.icon} glyph={g.glyph} name={g.name} size="sm" />
              {clientName(g, lang)}
            </h2>
            <p class="muted small">{lang === 'ru' ? g.note.ru : g.note.en}</p>
            <ol>
              {(lang === 'ru' ? g.steps.ru : g.steps.en).map((step) => (
                <li>{step}</li>
              ))}
            </ol>
            {install ? (
              <p>
                <a class="btn primary" href={install.href}>
                  {lang === 'ru' ? install.label.ru : install.label.en}
                </a>
              </p>
            ) : null}
            {g.code ? <CodeBlock t={t} id={`${idPrefix}-${g.id}`} code={g.code(mcpUrl)} /> : null}
          </section>
        );
      })}
    </>
  );
};

export const DocsPage: FC<{ ctx: PageCtx }> = ({ ctx }) => {
  const { t, lang } = ctx;
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
            <a href="#services">{t('docs.services')}</a>
            <a href="#custom">{t('docs.custom')}</a>
            <a href="#safety">{t('docs.safety')}</a>
          </nav>
          <div>
            <section class="guide" id="url">
              <p class="eyebrow">{t('docs.eyebrow')}</p>
              <h1>{t('docs.h1')}</h1>
              <p class="lead">{t('docs.lead')}</p>
              <CopyField t={t} id="docs-mcp-url" value={ctx.mcpUrl} label={t('home.mcpUrl')} />
              <p class="hint">{t('docs.urlHint')}</p>
            </section>
            <ClientGuides ctx={ctx} mcpUrl={ctx.mcpUrl} idPrefix="docs" />
            <section class="guide" id="services">
              <h2>{t('docs.services')}</h2>
              <p>{t('docs.services.text')}</p>
              <ul class="bullets">
                <li>{t('docs.services.oauth')}</li>
                <li>{t('docs.services.form')}</li>
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
              <p>{t('docs.safety.text')}</p>
              <p>
                <a href="/security">{t('docs.safety.link')}</a>
              </p>
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
    title={`${doc.title} · AnyConnect`}
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
