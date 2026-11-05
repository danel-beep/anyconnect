import type { FC } from 'hono/jsx';
import { PLANS } from '../billing/plans.js';
import { serviceMeta } from './catalog.js';
import { CLIENT_GUIDES, type ClientGuide, clientName } from './clients.js';
import type { Locale, Translate } from './i18n.js';
import type { PageCtx } from './page-context.js';
import { ARTICLES } from './seo/articles.js';
import { CLIENT_PAGES, type ClientPage } from './seo/client-pages.js';
import { planVars } from './seo/facts.js';
import { PERSONAS } from './seo/personas.js';
import { breadcrumbs, type JsonLd } from './seo/structured-data.js';
import type { QA } from './seo/types.js';
import { localizedPath } from './seo/urls.js';
import { USE_CASES, type UseCase } from './seo/use-cases.js';
import type { PublicService } from './site.js';
import { CodeBlock, Icon, ServiceLogo } from './ui.js';

/**
 * Pieces shared by the docs and search pages (`seo-pages.tsx`, `content-pages.tsx`): addresses,
 * breadcrumbs, grids of clients and services, FAQ lists, the docs sidebar and the blocks that link
 * pages to their neighbours (workflows for a service or client, audiences for a workflow).
 */

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** Clients that get their own pages (the generic "other clients" entry has a guide but no combos). */
export const PAGE_CLIENTS: ClientGuide[] = CLIENT_GUIDES.filter((g) => CLIENT_PAGES[g.id]);
export const COMBO_CLIENTS: ClientGuide[] = PAGE_CLIENTS.filter((g) => g.id !== 'other');

export const clientPage = (guide: ClientGuide): ClientPage => CLIENT_PAGES[guide.id]!;
export const clientPath = (guide: ClientGuide) => `/docs/${clientPage(guide).slug}`;
export const comboPath = (serviceId: string, guide: ClientGuide) =>
  `/services/${serviceId}/${clientPage(guide).slug}`;

/** Service names for titles: the best-known services that connect here, in a fixed order. */
const TITLE_SERVICES = ['gmail', 'slack', 'notion', 'github', 'gcal'];
export function titleServices(services: PublicService[], lang: Locale, count = 3): string {
  const ready = new Map(services.filter((s) => s.ready).map((s) => [s.id, s.name]));
  const names = TITLE_SERVICES.flatMap((id) => (ready.has(id) ? [ready.get(id)!] : [])).slice(0, count);
  return new Intl.ListFormat(lang, { type: 'conjunction' }).format(names);
}

export const blurb = (lang: Locale, service: PublicService) => {
  const meta = serviceMeta(service.id);
  return meta ? meta.blurb[lang] : service.description;
};

export interface Crumb {
  name: string;
  path: string;
}

export const Crumbs: FC<{ ctx: PageCtx; items: Crumb[] }> = ({ ctx, items }) => (
  <nav class="crumbs" aria-label="Breadcrumbs">
    {items.map((item, i) =>
      i === items.length - 1 ? (
        <span aria-current="page">{item.name}</span>
      ) : (
        <>
          <a href={localizedPath(item.path, ctx.lang)}>{item.name}</a>
          {' / '}
        </>
      ),
    )}
  </nav>
);

export const crumbsLd = (ctx: PageCtx, items: Crumb[]): JsonLd =>
  breadcrumbs(
    ctx.publicUrl,
    items.map((i) => ({ name: i.name, path: localizedPath(i.path, ctx.lang) })),
  );

export const home = (ctx: PageCtx): Crumb => ({ name: ctx.t('crumb.home'), path: '/' });

export const FaqList: FC<{ items: QA[] }> = ({ items }) => (
  <div>
    {items.map((item) => (
      <details>
        <summary>{item.q}</summary>
        <div>{item.a}</div>
      </details>
    ))}
  </div>
);

/** "Try it" band at the end of a page. */
export const CtaBand: FC<{ ctx: PageCtx; title?: string; text?: string }> = ({ ctx, title, text }) => (
  <section class="section tight">
    <div class="wrap">
      <div class="cta-band">
        <div>
          <h2>{title ?? ctx.t('cta.title')}</h2>
          <p>{text ?? ctx.t('cta.text')}</p>
        </div>
        <div class="hero-actions">
          <a class="btn primary lg" href={ctx.user ? '/app' : '/signup'}>
            {ctx.user ? ctx.t('site.cta.dashboard') : ctx.t('site.cta.start')} <Icon name="arrow" />
          </a>
        </div>
      </div>
    </div>
  </section>
);

/** A grid of AI apps linking to their pages (`href` decides where each goes). */
export const ClientGrid: FC<{ ctx: PageCtx; clients: ClientGuide[]; href: (g: ClientGuide) => string }> = ({
  ctx,
  clients,
  href,
}) => (
  <div class="svc-grid">
    {clients.map((g) => (
      <a class="svc" href={localizedPath(href(g), ctx.lang)}>
        <ServiceLogo icon={g.icon} glyph={g.glyph} name={g.name} />
        <span class="grow">
          <span class="name">{clientName(g, ctx.lang)}</span>
        </span>
      </a>
    ))}
  </div>
);

/** A grid of services linking to their pages (`href` decides where each goes). */
export const ServiceGrid: FC<{
  ctx: PageCtx;
  services: PublicService[];
  href: (s: PublicService) => string;
}> = ({ ctx, services, href }) => (
  <div class="svc-grid">
    {services.map((s) => {
      const meta = serviceMeta(s.id);
      return (
        <a class="svc" href={localizedPath(href(s), ctx.lang)}>
          <ServiceLogo icon={meta?.icon} glyph={meta?.glyph} name={s.name} />
          <span class="grow">
            <span class="name">{s.name}</span>
            <span class="meta">{blurb(ctx.lang, s)}</span>
          </span>
        </a>
      );
    })}
  </div>
);

/** A client's own steps with its button, command or config right under the first one. */
export const ClientSteps: FC<{ ctx: PageCtx; guide: ClientGuide; idPrefix: string }> = ({
  ctx,
  guide,
  idPrefix,
}) => {
  const install = guide.install?.(ctx.mcpUrl);
  return (
    <ol>
      {guide.steps[ctx.lang].map((step, i) => (
        <li id={`${idPrefix}step-${i + 1}`}>
          {step}
          {i === 0 && (install || guide.code) ? (
            <div class="guide-do">
              {install ? (
                <p>
                  <a class="btn primary" href={install.href}>
                    {install.label[ctx.lang]}
                  </a>
                </p>
              ) : null}
              {guide.code ? (
                <CodeBlock t={ctx.t} id={`${idPrefix}code`} code={guide.code(ctx.mcpUrl)} />
              ) : null}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
};

/** Questions every client page answers, with the plan's real numbers. */
export function sharedFaq(t: Translate, client: string): QA[] {
  const vars = { client, ...planVars((id) => t(`plan.${id}.name` as 'plan.free.name')) };
  return (['free', 'accounts', 'safety', 'keys'] as const).map((k) => ({
    q: t(`seo.faq.${k}.q`, vars),
    a: t(`seo.faq.${k}.a`, vars),
  }));
}

export const ISO_MINUTES = (minutes: number) => `PT${minutes}M`;

export const formatDate = (lang: Locale, iso: string) =>
  new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`),
  );

/** The docs sidebar of the guide pages: every AI app, then the explainers. */
export const GuideNav: FC<{ ctx: PageCtx; current?: string }> = ({ ctx, current }) => (
  <nav class="doc-nav" aria-label={ctx.t('docs.nav')}>
    <span class="group">{ctx.t('docs.clients')}</span>
    {PAGE_CLIENTS.map((g) => (
      <a
        href={localizedPath(clientPath(g), ctx.lang)}
        aria-current={clientPage(g).slug === current ? 'page' : undefined}
      >
        {clientName(g, ctx.lang)}
      </a>
    ))}
    <span class="group">{ctx.t('site.nav.guides')}</span>
    {ARTICLES.map((a) => (
      <a
        href={localizedPath(`/guides/${a.slug}`, ctx.lang)}
        aria-current={a.slug === current ? 'page' : undefined}
      >
        {a.body[ctx.lang].h1}
      </a>
    ))}
    <a href={localizedPath('/use-cases', ctx.lang)}>{ctx.t('site.nav.useCases')}</a>
    <a href={localizedPath('/blog', ctx.lang)}>{ctx.t('site.nav.blog')}</a>
    <a href={localizedPath('/faq', ctx.lang)}>{ctx.t('site.nav.faq')}</a>
    <a href={localizedPath('/compare', ctx.lang)}>{ctx.t('site.nav.compare')}</a>
  </nav>
);

// ---------------------------------------------------------------------------
// Workflows, audiences and posts
// ---------------------------------------------------------------------------

export const useCasePath = (u: UseCase) => `/use-cases/${u.slug}`;
export const personaPath = (slug: string) => `/for/${slug}`;
export const blogPath = (slug: string) => `/blog/${slug}`;

/** Whether a workflow works on this server: its services (all, or at least one) can connect. */
export function useCaseReady(u: UseCase, services: PublicService[]): boolean {
  const ready = new Set(services.filter((s) => s.ready).map((s) => s.id));
  return u.needs === 'all' ? u.services.every((id) => ready.has(id)) : u.services.some((id) => ready.has(id));
}

/** Workflows that work here, optionally only those that use one service. */
export const readyUseCases = (services: PublicService[], serviceId?: string) =>
  USE_CASES.filter((u) => useCaseReady(u, services) && (!serviceId || u.services.includes(serviceId)));

/** Audiences whose page lists this workflow. */
export const personasFor = (slug: string) => PERSONAS.filter((p) => p.useCases.includes(slug));

/** Our own numbers inside article, comparison and workflow texts. */
export const contentVars = (services: PublicService[]) => ({
  count: services.filter((s) => s.ready && serviceMeta(s.id)?.category !== 'custom').length,
  freeAccounts: PLANS.find((p) => p.id === 'free')?.limits.accounts ?? 0,
  ...planVars(),
});

/** Cards linking to workflows: the heading and the one-line description of each. */
export const UseCaseCards: FC<{ ctx: PageCtx; items: UseCase[] }> = ({ ctx, items }) => (
  <div class="svc-grid wide-cards">
    {items.map((u) => (
      <a class="svc" href={localizedPath(useCasePath(u), ctx.lang)}>
        <span class="grow">
          <span class="name">{u.body[ctx.lang].h1}</span>
          <span class="meta">{u.body[ctx.lang].description}</span>
        </span>
      </a>
    ))}
  </div>
);

/** "What people do with Gmail": the workflows that use a service, on its pages. */
export const RelatedUseCases: FC<{
  ctx: PageCtx;
  services: PublicService[];
  serviceId?: string;
  title: string;
}> = ({ ctx, services, serviceId, title }) => {
  const items = readyUseCases(services, serviceId).slice(0, 6);
  if (!items.length) return null;
  return (
    <div class="card">
      <h2 class="h3">{title}</h2>
      <UseCaseCards ctx={ctx} items={items} />
    </div>
  );
};
