import type { FC } from 'hono/jsx';
import { BRAND } from '../brand.js';
import type { PageCtx } from './page-context.js';
import { fill } from './seo/facts.js';
import { PERSONAS, type Persona } from './seo/personas.js';
import { article as articleLd, faqPage, howTo } from './seo/structured-data.js';
import { localizedPath } from './seo/urls.js';
import { USE_CASES, type UseCase } from './seo/use-cases.js';
import {
  ClientGrid,
  COMBO_CLIENTS,
  Crumbs,
  CtaBand,
  clientPath,
  contentVars,
  crumbsLd,
  FaqList,
  home,
  personaPath,
  personasFor,
  ServiceGrid,
  UseCaseCards,
  useCasePath,
  useCaseReady,
} from './seo-parts.js';
import { PromptList } from './setup-guide.js';
import { type PublicService, SiteLayout } from './site.js';

/**
 * Workflow and audience pages: `/use-cases` (every workflow and audience), `/use-cases/<slug>`
 * ("Summarize your inbox with AI": requests to copy, what happens behind them, how to set it up)
 * and `/for/<slug>` (freelancers, agencies…). Texts live in `seo/use-cases.ts` and
 * `seo/personas.ts`; services come from the live catalogue, so a page only shows services that
 * exist and marks a workflow `noindex` when they cannot connect here.
 */

const useCasesCrumb = (ctx: PageCtx) => ({ name: ctx.t('site.nav.useCases'), path: '/use-cases' });

/** Services of a workflow or audience that exist in the catalogue, in the order the text lists them. */
const pickServices = (ids: string[], services: PublicService[], readyOnly: boolean) =>
  ids.flatMap((id) => services.filter((s) => s.id === id && (!readyOnly || s.ready)));

// ---------------------------------------------------------------------------
// /use-cases
// ---------------------------------------------------------------------------

export const UseCaseIndexPage: FC<{ ctx: PageCtx; services: PublicService[] }> = ({ ctx, services }) => {
  const { t, lang } = ctx;
  const crumbs = [home(ctx), useCasesCrumb(ctx)];
  const items = USE_CASES.filter((u) => useCaseReady(u, services));
  return (
    <SiteLayout
      ctx={ctx}
      title={t('useCase.index.title')}
      description={t('useCase.index.description')}
      current="docs"
      canonicalPath="/use-cases"
      jsonLd={[crumbsLd(ctx, crumbs)]}
    >
      <section class="section">
        <div class="wrap">
          <Crumbs ctx={ctx} items={crumbs} />
          <div class="section-head">
            <h1>{t('useCase.index.h1')}</h1>
            <p>{t('useCase.index.lead')}</p>
          </div>
          <UseCaseCards ctx={ctx} items={items} />
          <h2 class="h3 section-sub">{t('persona.index.h2')}</h2>
          <div class="svc-grid wide-cards">
            {PERSONAS.map((p) => (
              <a class="svc" href={localizedPath(personaPath(p.slug), lang)}>
                <span class="grow">
                  <span class="name">{p.body[lang].h1}</span>
                  <span class="meta">{p.body[lang].description}</span>
                </span>
              </a>
            ))}
          </div>
        </div>
      </section>
      <CtaBand ctx={ctx} />
    </SiteLayout>
  );
};

// ---------------------------------------------------------------------------
// /use-cases/<slug>
// ---------------------------------------------------------------------------

export const UseCaseView: FC<{ ctx: PageCtx; useCase: UseCase; services: PublicService[] }> = ({
  ctx,
  useCase,
  services,
}) => {
  const { t, lang } = ctx;
  const body = useCase.body[lang];
  const vars = contentVars(services);
  const path = useCasePath(useCase);
  const url = `${ctx.publicUrl}${localizedPath(path, lang)}`;
  const crumbs = [home(ctx), useCasesCrumb(ctx), { name: body.h1, path }];
  const ready = useCaseReady(useCase, services);
  const own = pickServices([...useCase.services, ...(useCase.extras ?? [])], services, true);
  const audiences = personasFor(useCase.slug);
  const others = USE_CASES.filter((u) => u !== useCase && useCaseReady(u, services)).slice(0, 4);
  const step1 = t(useCase.needs === 'all' ? 'useCase.step1.all' : 'useCase.step1.any');
  return (
    <SiteLayout
      ctx={ctx}
      title={`${body.title} · ${BRAND.name}`}
      description={body.description}
      current="docs"
      canonicalPath={path}
      ogType="article"
      noindex={!ready}
      jsonLd={[
        crumbsLd(ctx, crumbs),
        howTo({
          name: body.h1,
          description: body.answer,
          url,
          lang,
          totalTime: 'PT5M',
          steps: [
            { name: t('useCase.step1'), text: step1 },
            { name: t('useCase.step2'), text: t('useCase.step2.text') },
            { name: t('useCase.step3'), text: body.prompts[0] ?? '' },
          ],
        }),
        articleLd({
          publicUrl: ctx.publicUrl,
          headline: body.h1,
          description: body.description,
          url,
          updated: useCase.updated,
          lang,
        }),
        faqPage(body.faq),
      ]}
    >
      <div class="wrap">
        <article class="prose">
          <Crumbs ctx={ctx} items={crumbs} />
          <h1>{body.h1}</h1>
          <p class="lead">{fill(body.answer, vars)}</p>
          {ready ? null : <div class="notice info">{t('useCase.notReady')}</div>}
          <h2>{t('useCase.ask')}</h2>
          <PromptList t={t} prompts={body.prompts} idPrefix="uc" />
          <h2>{t('useCase.how')}</h2>
          <ol>
            {body.how.map((x) => (
              <li>{fill(x, vars)}</li>
            ))}
          </ol>
          <h2>{t('useCase.setup')}</h2>
          <ol>
            <li>
              <strong>{t('useCase.step1')}.</strong> {step1}
            </li>
            <li>
              <strong>{t('useCase.step2')}.</strong> {t('useCase.step2.text')}
            </li>
            <li>
              <strong>{t('useCase.step3')}.</strong> {t('useCase.step3.text')}
            </li>
          </ol>
          {own.length ? (
            <>
              <h2>{t('useCase.services')}</h2>
              <ServiceGrid ctx={ctx} services={own} href={(s) => `/services/${s.id}`} />
            </>
          ) : null}
          <h2>{t('useCase.clients')}</h2>
          <ClientGrid ctx={ctx} clients={COMBO_CLIENTS} href={clientPath} />
          <h2>{t('useCase.tips')}</h2>
          <ul>
            {body.tips.map((x) => (
              <li>{fill(x, vars)}</li>
            ))}
          </ul>
          <h2>{t('article.faq')}</h2>
          <FaqList items={body.faq} />
          {audiences.length ? (
            <>
              <h2>{t('useCase.for')}</h2>
              <ul>
                {audiences.map((p) => (
                  <li>
                    <a href={localizedPath(personaPath(p.slug), lang)}>{p.body[lang].h1}</a>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {others.length ? (
            <>
              <h2>{t('useCase.others')}</h2>
              <UseCaseCards ctx={ctx} items={others} />
            </>
          ) : null}
        </article>
      </div>
      <CtaBand ctx={ctx} />
    </SiteLayout>
  );
};

// ---------------------------------------------------------------------------
// /for/<slug>
// ---------------------------------------------------------------------------

export const PersonaView: FC<{ ctx: PageCtx; persona: Persona; services: PublicService[] }> = ({
  ctx,
  persona,
  services,
}) => {
  const { t, lang } = ctx;
  const body = persona.body[lang];
  const path = personaPath(persona.slug);
  const url = `${ctx.publicUrl}${localizedPath(path, lang)}`;
  const crumbs = [home(ctx), useCasesCrumb(ctx), { name: body.h1, path }];
  const jobs = persona.useCases.flatMap((slug) =>
    USE_CASES.filter((u) => u.slug === slug && useCaseReady(u, services)),
  );
  const own = pickServices(persona.services, services, true);
  const others = PERSONAS.filter((p) => p !== persona);
  return (
    <SiteLayout
      ctx={ctx}
      title={body.title}
      description={body.description}
      current="docs"
      canonicalPath={path}
      ogType="article"
      jsonLd={[
        crumbsLd(ctx, crumbs),
        articleLd({
          publicUrl: ctx.publicUrl,
          headline: body.h1,
          description: body.description,
          url,
          updated: persona.updated,
          lang,
        }),
        faqPage(body.faq),
      ]}
    >
      <section class="section">
        <div class="wrap">
          <Crumbs ctx={ctx} items={crumbs} />
          <div class="section-head">
            <h1>{body.h1}</h1>
            <p>{body.answer}</p>
          </div>
          <div class="feature-grid persona-points">
            {body.points.map((x) => (
              <div class="card">
                <h2 class="h3">{x.h}</h2>
                <p class="muted">{x.p}</p>
              </div>
            ))}
          </div>
          {jobs.length ? (
            <>
              <h2 class="h3 section-sub">{t('persona.jobs')}</h2>
              <UseCaseCards ctx={ctx} items={jobs} />
            </>
          ) : null}
          {own.length ? (
            <>
              <h2 class="h3 section-sub">{t('persona.services')}</h2>
              <ServiceGrid ctx={ctx} services={own} href={(s) => `/services/${s.id}`} />
            </>
          ) : null}
          <h2 class="h3 section-sub">{t('useCase.clients')}</h2>
          <ClientGrid ctx={ctx} clients={COMBO_CLIENTS} href={clientPath} />
          <h2 class="h3 section-sub">{t('article.faq')}</h2>
          <FaqList items={body.faq} />
          <h2 class="h3 section-sub">{t('persona.others')}</h2>
          <ul class="link-list">
            {others.map((p) => (
              <li>
                <a href={localizedPath(personaPath(p.slug), lang)}>{p.body[lang].h1}</a>
              </li>
            ))}
          </ul>
        </div>
      </section>
      <CtaBand ctx={ctx} />
    </SiteLayout>
  );
};
