import type { Child, FC } from 'hono/jsx';
import { BRAND } from '../brand.js';
import { arrangeCatalog, serviceMeta } from './catalog.js';
import { CLIENT_GUIDES } from './clients.js';
import type { Translate } from './i18n.js';
import type { PageCtx } from './page-context.js';
import { clientGuidePath } from './seo/client-pages.js';
import { faqPage, organization, website } from './seo/structured-data.js';
import { localizedPath } from './seo/urls.js';
import {
  Faq,
  type FaqKey,
  faqItems,
  PlansGrid,
  type PublicService,
  productLd,
  SiteLayout,
  StartButton,
} from './site.js';
import { BrandIcon, BrandMark, Icon, type IconName, ServiceLogo } from './ui.js';

/**
 * The landing page. Sections, top to bottom: hero with a chat that plays one request, the AI apps
 * it works with, the hub diagram, three steps, features, services, security, pricing, questions.
 *
 * Motion is CSS only (`styles/landing.ts`): blocks marked `data-reveal` rise in as they scroll into
 * view and `data-live` blocks animate only while visible (`site.js` adds the classes). Without
 * JavaScript, or with reduced motion, everything is simply shown in its final state.
 */

const LANDING_FAQ: FaqKey[] = ['mcp', 'why', 'compare', 'secrets', 'action', 'limit', 'delete'];

/** Service tiles on the landing page (the last one links to the full list). */
const SERVICE_TILES = 17;

/** "45+" for a count shown in copy: rounded down to a multiple of five, so it never overstates. */
export const roughCount = (n: number): string => {
  if (n < 10) return String(n);
  const base = Math.floor(n / 5) * 5;
  return base < n ? `${base}+` : String(base);
};

export const LandingPage: FC<{ ctx: PageCtx; services: PublicService[] }> = ({ ctx, services }) => {
  const { t } = ctx;
  const ready = services.filter((s) => s.ready);
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
      <Hero ctx={ctx} more={roughCount(Math.max(ready.length - 3, 0))} />
      <WorksWith ctx={ctx} />
      <HubMap ctx={ctx} />
      <Steps ctx={ctx} />
      <Features t={t} />
      <Services ctx={ctx} ready={ready} />
      <Security t={t} />
      <section class="section border" id="pricing">
        <div class="wrap">
          <SectionHead eyebrow={t('landing.pricing.eyebrow')} title={t('landing.pricing.title')}>
            {t('landing.pricing.lead')}
          </SectionHead>
          <div data-reveal>
            <PlansGrid ctx={ctx} />
          </div>
        </div>
      </section>
      <section class="section border" id="faq">
        <div class="wrap faq-layout">
          <div>
            <SectionHead eyebrow={t('landing.faq.eyebrow')} title={t('landing.faq.title')} />
            <p class="muted faq-more" data-reveal>
              {t('landing.faq.more')}{' '}
              {ctx.supportEmail ? (
                <a href={`mailto:${ctx.supportEmail}`}>{t('landing.faq.write')}</a>
              ) : (
                <a href="/support">{t('landing.faq.support')}</a>
              )}
            </p>
          </div>
          <div class="faq-list" data-reveal>
            <Faq t={t} keys={LANDING_FAQ} />
          </div>
        </div>
      </section>
      <section class="section tight">
        <div class="wrap">
          <div class="cta-band glow" data-reveal>
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

const SectionHead: FC<{ eyebrow: string; title: string; children?: Child; id?: string }> = ({
  eyebrow,
  title,
  children,
  id,
}) => (
  <div class="section-head" data-reveal>
    <p class="eyebrow">{eyebrow}</p>
    <h2 id={id}>{title}</h2>
    {children ? <p>{children}</p> : null}
  </div>
);

// --- Hero --------------------------------------------------------------------

const Hero: FC<{ ctx: PageCtx; more: string }> = ({ ctx, more }) => {
  const { t } = ctx;
  return (
    <section class="hero">
      <div class="wrap">
        <div class="hero-copy">
          <p class="eyebrow">{t('landing.eyebrow')}</p>
          <h1>
            {t('landing.h1a')} <span class="mark">{t('landing.h1b')}</span>
          </h1>
          <p class="lead">{t('landing.lead', { n: more })}</p>
          <div class="hero-actions">
            <StartButton ctx={ctx} size="lg" />
            <a class="btn lg" href="#how">
              {t('landing.how')}
            </a>
          </div>
          <ul class="hero-note">
            <li>
              <Icon name="check" /> {t('landing.note.free')}
            </li>
            <li>
              <Icon name="check" /> {t('landing.note.card')}
            </li>
            <li>
              <Icon name="check" /> {t('landing.note.encrypted')}
            </li>
          </ul>
        </div>
        <DemoChat t={t} />
      </div>
    </section>
  );
};

/** A chat that plays one request: two searches, a question to the user, the send, the answer. */
const DemoChat: FC<{ t: Translate }> = ({ t }) => (
  <div class="demo" role="img" aria-label={t('landing.demo.label')} data-reveal="play">
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
        <Icon name="check" />
        <span class="args">
          <b>mail_search</b> "ACME invoice"
        </span>
        <span class="res">{t('landing.demo.found')}</span>
      </div>
      <div class="call step s3">
        <Icon name="check" />
        <span class="args">
          <b>mail_read</b> gmail:work
        </span>
        <span class="res">{t('landing.demo.read')}</span>
      </div>
      <div class="approve step s4">
        <div class="who">
          <BrandMark /> {t('landing.demo.approveWho')}
        </div>
        <p>{t('landing.demo.approveText')}</p>
        <div class="btns">
          <span>{t('landing.demo.deny')}</span>
          <span class="yes">{t('landing.demo.allow')}</span>
        </div>
      </div>
      <div class="call step s5">
        <Icon name="check" />
        <span class="args">
          <b>messages_send</b> slack:team → @alex
        </span>
        <span class="res">{t('landing.demo.sent')}</span>
      </div>
      <div class="msg ai step s6">
        <span class="typing" />
        <span class="text">{t('landing.demo.answer')}</span>
      </div>
    </div>
    <div class="demo-input">
      <span class="grow">{t('landing.demo.input')}</span>
      <Icon name="arrow" />
    </div>
  </div>
);

/** The AI apps with a setup guide, each linking to it. */
const WorksWith: FC<{ ctx: PageCtx }> = ({ ctx }) => {
  const clients = CLIENT_GUIDES.filter((c) => c.id !== 'other' && clientGuidePath(c.id));
  return (
    <section class="works" aria-labelledby="works-title">
      <div class="wrap">
        <p id="works-title">{ctx.t('landing.works')}</p>
        <ul data-reveal="kids">
          {clients.map((c) => (
            <li>
              <a href={localizedPath(clientGuidePath(c.id)!, ctx.lang)}>
                <ServiceLogo icon={c.icon} glyph={c.glyph} name={c.name} size="sm" />
                {c.name}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
};

// --- Hub diagram ---------------------------------------------------------------

const MAP_CLIENTS: { name: string; icon?: string; glyph?: IconName }[] = [
  { name: 'Claude', icon: 'claude' },
  { name: 'ChatGPT', glyph: 'zap' },
  { name: 'Cursor', icon: 'cursor' },
  { name: 'Claude Code', glyph: 'terminal' },
];

const MAP_SERVICES: { name: string; icon?: string; glyph?: IconName; accounts?: string[] }[] = [
  { name: 'Gmail', icon: 'gmail', accounts: ['work', 'personal'] },
  { name: 'Slack', glyph: 'hash', accounts: ['team', 'client'] },
  { name: 'Notion', icon: 'notion', accounts: ['wiki'] },
  { name: 'GitHub', icon: 'github' },
];

/**
 * The wires between a column of `count` nodes and the hub: the SVG has the pixel size of its grid
 * cell (`--map-h` × `--wire-w` in the CSS), so each curve starts exactly at a node's middle and
 * ends at the middle of the hub's side.
 */
const WIRE_W = 120;
const MAP_H = 320;

const Wires: FC<{ count: number; side: 'in' | 'out' }> = ({ count, side }) => (
  <svg class={`wires w-${side}`} viewBox={`0 0 ${WIRE_W} ${MAP_H}`} aria-hidden="true">
    {Array.from({ length: count }, (_, i) => {
      const y = ((i + 0.5) * MAP_H) / count;
      const mid = MAP_H / 2;
      const half = WIRE_W / 2;
      const d =
        side === 'in'
          ? `M0 ${y} C${half} ${y} ${half} ${mid} ${WIRE_W} ${mid}`
          : `M0 ${mid} C${half} ${mid} ${half} ${y} ${WIRE_W} ${y}`;
      return (
        <>
          <path class="wire" d={d} />
          <path class={`pulse p${i + 1}`} d={d} pathLength="100" />
        </>
      );
    })}
  </svg>
);

const HubMap: FC<{ ctx: PageCtx }> = ({ ctx }) => {
  const { t } = ctx;
  const services = [...MAP_SERVICES, { name: t('landing.map.api'), glyph: 'braces' as IconName }];
  return (
    <section class="section ink" aria-labelledby="map-title">
      <div class="wrap">
        <SectionHead id="map-title" eyebrow={t('landing.map.eyebrow')} title={t('landing.map.title')}>
          {t('landing.map.lead')}
        </SectionHead>
        <div class="hubmap" data-reveal data-live>
          <ul class="hubmap-col clients">
            {MAP_CLIENTS.map((c) => (
              <li>
                <span class="node">
                  {c.icon ? <BrandIcon slug={c.icon} /> : <Icon name={c.glyph ?? 'zap'} />}
                  {c.name}
                </span>
              </li>
            ))}
          </ul>
          <Wires count={MAP_CLIENTS.length} side="in" />
          <div class="hub-core">
            <BrandMark />
            <strong>{BRAND.name}</strong>
            <span class="mono">{t('landing.map.core')}</span>
          </div>
          <Wires count={services.length} side="out" />
          <ul class="hubmap-col services">
            {services.map((s) => (
              <li>
                <span class="node">
                  {s.icon ? <BrandIcon slug={s.icon} /> : <Icon name={s.glyph ?? 'plug'} />}
                  {s.name}
                  {'accounts' in s && s.accounts ? (
                    <span class="accs">
                      {s.accounts.map((a) => (
                        <span class="acc">{a}</span>
                      ))}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div class="versus" data-reveal="kids">
          <div class="vs-card before">
            <h3>
              <Icon name="x" /> {t('landing.map.before')}
            </h3>
            <p class="vs-stat mono">{t('landing.map.beforeStat')}</p>
            <p>{t('landing.map.beforeText')}</p>
          </div>
          <div class="vs-card after">
            <h3>
              <Icon name="check" /> {t('landing.map.after')}
            </h3>
            <p class="vs-stat mono">{t('landing.map.afterStat')}</p>
            <p>{t('landing.map.afterText')}</p>
          </div>
        </div>
        <p class="map-compare" data-reveal>
          <a href={localizedPath('/compare', ctx.lang)}>
            {t('landing.map.compare')} <Icon name="arrow" />
          </a>
        </p>
      </div>
    </section>
  );
};

// --- Steps -------------------------------------------------------------------

const Steps: FC<{ ctx: PageCtx }> = ({ ctx }) => {
  const { t } = ctx;
  return (
    <section class="section" id="how">
      <div class="wrap">
        <SectionHead eyebrow={t('landing.how.eyebrow')} title={t('landing.how.title')}>
          {t('landing.how.lead')}
        </SectionHead>
        <ol class="steps" data-reveal="kids">
          <li class="step-card">
            <span class="n">01</span>
            <h3>{t('landing.step1.title')}</h3>
            <p>{t('landing.step1.text')}</p>
            <div class="visual">
              <span class="signed">
                <Icon name="check" /> {t('landing.step1.visual')}
              </span>
            </div>
          </li>
          <li class="step-card">
            <span class="n">02</span>
            <h3>{t('landing.step2.title')}</h3>
            <p>{t('landing.step2.text')}</p>
            <div class="visual chips">
              <span class="chip on">
                <BrandIcon slug="gmail" /> gmail:work
              </span>
              <span class="chip on">
                <BrandIcon slug="gmail" /> gmail:personal
              </span>
              <span class="chip on">
                <BrandIcon slug="notion" /> notion:wiki
              </span>
            </div>
          </li>
          <li class="step-card">
            <span class="n">03</span>
            <h3>{t('landing.step3.title')}</h3>
            <p>{t('landing.step3.text')}</p>
            <div class="visual stack">
              <div class="url-pill">
                <span class="dot accent" /> {ctx.mcpUrl}
              </div>
              <div class="prompt-pill">{t('landing.step3.prompt')}</div>
            </div>
          </li>
        </ol>
      </div>
    </section>
  );
};

// --- Features ----------------------------------------------------------------

const Features: FC<{ t: Translate }> = ({ t }) => (
  <section class="section border" id="features">
    <div class="wrap">
      <SectionHead eyebrow={t('landing.features.eyebrow')} title={t('landing.features.title')}>
        {t('landing.features.lead')}
      </SectionHead>
      <div class="bento" data-reveal="kids">
        <article class="tile c4">
          <h3>{t('landing.f.accounts.title')}</h3>
          <p>{t('landing.f.accounts.text')}</p>
          <div class="visual stack">
            <div class="chips light-up">
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
                <BrandIcon slug="notion" /> notion:client
              </span>
              <span class="chip">
                <BrandIcon slug="github" /> github:company
              </span>
            </div>
            <div class="codebox">
              <b>mail_search</b>(account: <i>"all"</i>) → {t('landing.f.accounts.result')}
            </div>
          </div>
        </article>
        <article class="tile c2">
          <h3>{t('landing.f.confirm.title')}</h3>
          <p>{t('landing.f.confirm.text')}</p>
          <div class="visual ask">
            <div class="who">
              <Icon name="bell" /> {BRAND.name}
            </div>
            {t('landing.f.confirm.message')}
            <div class="btns">
              <span>{t('landing.demo.deny')}</span>
              <span class="yes">{t('landing.demo.allow')}</span>
            </div>
          </div>
        </article>
        <article class="tile c3">
          <h3>{t('landing.f.chat.title')}</h3>
          <p>{t('landing.f.chat.text')}</p>
          <div class="visual mini-chat">
            <span class="bubble me">{t('landing.f.chat.prompt')}</span>
            <span class="bubble ai">{t('landing.f.chat.reply')}</span>
          </div>
        </article>
        <article class="tile c3">
          <h3>{t('landing.f.personas.title')}</h3>
          <p>{t('landing.f.personas.text')}</p>
          <div class="visual routes">
            <div class="route">
              <code>/mcp/work</code>
              <Icon name="arrow" />
              <span>gmail:work · gcal:team</span>
              <span class="rule">{t('landing.f.personas.work')}</span>
            </div>
            <div class="route">
              <code>/mcp/personal</code>
              <Icon name="arrow" />
              <span>gmail:personal</span>
              <span class="rule">{t('landing.f.personas.personal')}</span>
            </div>
          </div>
        </article>
        <article class="tile c3">
          <h3>{t('landing.f.api.title')}</h3>
          <p>{t('landing.f.api.text')}</p>
          <div class="visual codebox own-server">
            <span>
              <b>"url"</b>: <i>"https://crm.example/mcp"</i>
            </span>
            <span class="ok-pill">
              <span class="dot ok" /> {t('landing.f.api.status')}
            </span>
          </div>
        </article>
        <article class="tile c3">
          <h3>{t('landing.f.context.title')}</h3>
          <p>{t('landing.f.context.text')}</p>
          <div class="visual bars">
            <span class="bars-label">{t('landing.f.context.label')}</span>
            <div class="bar">
              <span>{t('landing.f.context.few')}</span>
              <span class="track">
                <span class="fill" />
              </span>
              <span class="mono tiny">{t('landing.f.context.tokens')}</span>
            </div>
            <div class="bar">
              <span>{t('landing.f.context.many')}</span>
              <span class="track">
                <span class="fill" />
              </span>
              <span class="mono tiny">{t('landing.f.context.tokens')}</span>
            </div>
          </div>
        </article>
      </div>
    </div>
  </section>
);

// --- Services ----------------------------------------------------------------

const Services: FC<{ ctx: PageCtx; ready: PublicService[] }> = ({ ctx, ready }) => {
  const { t } = ctx;
  const { popular } = arrangeCatalog(
    ready.map((s) => ({ ...s, service: s.id })),
    SERVICE_TILES,
  );
  const count = roughCount(ready.length);
  return (
    <section class="section border" id="services">
      <div class="wrap">
        <SectionHead
          eyebrow={t('landing.services.eyebrow')}
          title={t('landing.services.title', { n: count })}
        >
          {t('landing.services.lead')}
        </SectionHead>
        <ul class="logo-grid" data-reveal="kids">
          {popular.map((s) => {
            const meta = serviceMeta(s.id);
            return (
              <li>
                <a href={`/services/${s.id}`}>
                  <ServiceLogo icon={meta?.icon} glyph={meta?.glyph} name={s.name} />
                  <span>{s.name}</span>
                </a>
              </li>
            );
          })}
          <li class="more">
            <a href={localizedPath('/services', ctx.lang)}>
              <span class="logo-tile">
                <Icon name="grid" />
              </span>
              <span>
                {t('landing.services.all', { n: ready.length })} <Icon name="arrow" />
              </span>
            </a>
          </li>
        </ul>
      </div>
    </section>
  );
};

// --- Security ----------------------------------------------------------------

const SECURITY: [IconName, string][] = [
  ['lock', 'encryption'],
  ['key', 'secrets'],
  ['shield', 'injection'],
  ['activity', 'audit'],
  ['plug', 'disconnect'],
  ['trash', 'delete'],
];

const LOG: {
  time: string;
  app: string;
  icon?: string;
  glyph?: IconName;
  tool: string;
  account: string;
  status: 'ok' | 'approved' | 'blocked';
}[] = [
  { time: '10:42', app: 'Claude', icon: 'claude', tool: 'mail_search', account: 'gmail:work', status: 'ok' },
  {
    time: '10:43',
    app: 'Claude',
    icon: 'claude',
    tool: 'messages_send',
    account: 'slack:team',
    status: 'approved',
  },
  {
    time: '10:51',
    app: 'Cursor',
    icon: 'cursor',
    tool: 'github_create_issue',
    account: 'github:company',
    status: 'ok',
  },
  {
    time: '11:05',
    app: 'ChatGPT',
    glyph: 'zap',
    tool: 'gmail_send',
    account: 'gmail:personal',
    status: 'blocked',
  },
];

const Security: FC<{ t: Translate }> = ({ t }) => (
  <section class="section border subtle" id="security">
    <div class="wrap">
      <SectionHead eyebrow={t('landing.security.eyebrow')} title={t('landing.security.title')}>
        {t('landing.security.lead')}
      </SectionHead>
      <div class="sec-layout">
        <ul class="sec-list" data-reveal="kids">
          {SECURITY.map(([icon, key]) => (
            <li>
              <span class="sec-icon">
                <Icon name={icon} />
              </span>
              <div>
                <h3>{t(`landing.sec.${key}.title` as 'landing.sec.encryption.title')}</h3>
                <p>{t(`landing.sec.${key}.text` as 'landing.sec.encryption.text')}</p>
              </div>
            </li>
          ))}
        </ul>
        <div class="log-card" role="img" aria-label={t('landing.sec.audit.text')} data-reveal>
          <div class="log-head">
            <Icon name="activity" /> {t('landing.log.title')}
          </div>
          <ol>
            {LOG.map((row) => (
              <li class={`log-row s-${row.status}`}>
                <span class="time mono">{row.time}</span>
                <span class="app">
                  {row.icon ? <BrandIcon slug={row.icon} /> : <Icon name={row.glyph ?? 'zap'} />}
                  {row.app}
                </span>
                <span class="what mono">
                  <b>{row.tool}</b> {row.account}
                </span>
                <span class="status">
                  {t(
                    row.status === 'ok'
                      ? 'landing.log.ok'
                      : row.status === 'approved'
                        ? 'landing.log.approved'
                        : 'landing.log.blocked',
                  )}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  </section>
);
