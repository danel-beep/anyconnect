import type { FC } from 'hono/jsx';
import { BRAND } from '../brand.js';
import { serviceMeta } from './catalog.js';
import { type ClientGuide, clientName } from './clients.js';
import type { Locale, Translate } from './i18n.js';
import type { PageCtx } from './page-context.js';
import { ARTICLES, type Article } from './seo/articles.js';
import { BLOG_POSTS, type BlogPost } from './seo/blog.js';
import { CLIENT_PAGES_CHECKED } from './seo/client-pages.js';
import { COMPARE_PAGES, type ComparePage } from './seo/compare-pages.js';
import { fill } from './seo/facts.js';
import { article as articleLd, faqPage, howTo } from './seo/structured-data.js';
import type { QA } from './seo/types.js';
import { localizedPath } from './seo/urls.js';
import {
  blogPath,
  blurb,
  ClientGrid,
  ClientSteps,
  COMBO_CLIENTS,
  type Crumb,
  Crumbs,
  CtaBand,
  clientPage,
  clientPath,
  comboPath,
  contentVars,
  crumbsLd,
  FaqList,
  formatDate,
  GuideNav,
  home,
  ISO_MINUTES,
  PAGE_CLIENTS,
  RelatedUseCases,
  readyUseCases,
  ServiceGrid,
  sharedFaq,
  titleServices,
  UseCaseCards,
} from './seo-parts.js';
import { PromptList, RiskBadge, SetupGuideView } from './setup-guide.js';
import { type PublicService, type ServiceDetail, SiteLayout } from './site.js';
import { CopyField, Icon, ServiceLogo } from './ui.js';

/**
 * The docs and search pages: one guide per AI client, one page per service and client ("Connect
 * Gmail to ChatGPT"), the FAQ, comparisons and explainers. Every page opens with a direct answer,
 * carries schema.org data that matches what it shows, and links to its neighbours so search
 * engines and AI crawlers can reach the whole set.
 */

// ---------------------------------------------------------------------------
// Client guide: /docs/<client>
// ---------------------------------------------------------------------------

export const ClientGuidePage: FC<{ ctx: PageCtx; guide: ClientGuide; services: PublicService[] }> = ({
  ctx,
  guide,
  services,
}) => {
  const { t, lang } = ctx;
  const page = clientPage(guide);
  const client = clientName(guide, lang);
  const path = clientPath(guide);
  const url = `${ctx.publicUrl}${localizedPath(path, lang)}`;
  const names = titleServices(services, lang);
  const title = t('guide.title', { client, services: names });
  const description = t('guide.description', { client, services: names, minutes: page.minutes });
  const faq = [...page.faq[lang], ...sharedFaq(t, client)];
  const crumbs = [home(ctx), { name: t('site.nav.docs'), path: '/docs' }, { name: client, path }];
  const ready = services.filter((s) => s.ready);
  const hasCombos = COMBO_CLIENTS.includes(guide);
  const useCases = readyUseCases(services).slice(0, 6);
  return (
    <SiteLayout
      ctx={ctx}
      title={title}
      description={description}
      current="docs"
      canonicalPath={path}
      ogType="article"
      jsonLd={[
        crumbsLd(ctx, crumbs),
        howTo({
          name: t('guide.h1', { client }),
          description: page.intro[lang],
          url,
          lang,
          totalTime: ISO_MINUTES(page.minutes),
          steps: guide.steps[lang].map((text, i) => ({ name: `${i + 1}`, text })),
        }),
        faqPage(faq),
      ]}
    >
      <div class="wrap">
        <div class="doc-layout">
          <GuideNav ctx={ctx} current={page.slug} />
          <div>
            <section class="guide">
              <Crumbs ctx={ctx} items={crumbs} />
              <p class="eyebrow">{t('guide.eyebrow', { minutes: page.minutes })}</p>
              <h1>
                <ServiceLogo icon={guide.icon} glyph={guide.glyph} name={guide.name} />{' '}
                {t('guide.h1', { client })}
              </h1>
              <p class="lead">{fill(page.intro[lang], { url: ctx.mcpUrl })}</p>
            </section>
            <section class="guide" id="requirements">
              <h2>{t('guide.requirements')}</h2>
              <ul class="bullets">
                {page.requirements[lang].map((r) => (
                  <li>{r}</li>
                ))}
              </ul>
            </section>
            <section class="guide" id="steps">
              <h2>{t('guide.steps')}</h2>
              <CopyField t={t} id="guide-mcp-url" value={ctx.mcpUrl} label={t('home.mcpUrl')} />
              <ClientSteps ctx={ctx} guide={guide} idPrefix="" />
            </section>
            <section class="guide" id="check">
              <h2>{t('guide.verify')}</h2>
              <p>{t('guide.verifyText', { client })}</p>
            </section>
            <section class="guide" id="troubleshooting">
              <h2>{t('guide.troubleshooting')}</h2>
              <FaqList items={page.troubleshooting[lang]} />
            </section>
            {ready.length ? (
              <section class="guide" id="services">
                <h2>{t('guide.services', { client })}</h2>
                <p class="muted">{t('guide.servicesLead')}</p>
                <ServiceGrid
                  ctx={ctx}
                  services={ready}
                  href={(s) => (hasCombos ? comboPath(s.id, guide) : `/services/${s.id}`)}
                />
              </section>
            ) : null}
            {useCases.length ? (
              <section class="guide" id="use-cases">
                <h2>{t('guide.useCases', { client })}</h2>
                <UseCaseCards ctx={ctx} items={useCases} />
              </section>
            ) : null}
            <section class="guide" id="faq">
              <h2>{t('guide.faq')}</h2>
              <FaqList items={faq} />
              <p class="small muted">
                {t('guide.checked', { client, date: formatDate(lang, CLIENT_PAGES_CHECKED) })}
              </p>
            </section>
            <section class="guide" id="others">
              <h2>{t('guide.others')}</h2>
              <ClientGrid ctx={ctx} clients={PAGE_CLIENTS.filter((g) => g !== guide)} href={clientPath} />
            </section>
          </div>
        </div>
      </div>
      <CtaBand ctx={ctx} />
    </SiteLayout>
  );
};

// ---------------------------------------------------------------------------
// Service × client: /services/<service>/<client>
// ---------------------------------------------------------------------------

const quoteList = (lang: Locale, items: string[]) =>
  new Intl.ListFormat(lang, { type: 'conjunction' }).format(
    items.map((x) => (lang === 'ru' ? `«${x}»` : `“${x}”`)),
  );

/** Questions about one service in one client, answered from its real actions and sign-in. */
function comboFaq(t: Translate, lang: Locale, service: ServiceDetail, client: string): QA[] {
  const vars = { service: service.name, client };
  const risky = service.actions.filter((a) => a.risk === 'dangerous').map((a) => a.title);
  const changes = service.actions.some((a) => a.risk !== 'read');
  const items: QA[] = [
    { q: t('combo.faq.multi.q', vars), a: t('combo.faq.multi.a', vars) },
    {
      q: t('combo.faq.confirm.q', vars),
      a: !changes
        ? t('combo.faq.readonly', vars)
        : risky.length
          ? t('combo.faq.confirm.risky', { ...vars, actions: quoteList(lang, risky) })
          : t('combo.faq.confirm.none', vars),
    },
  ];
  if (service.connect !== 'none')
    items.push({
      q: t('combo.faq.official.q', vars),
      a: t(service.connect === 'oauth' ? 'combo.faq.official.oauth' : 'combo.faq.official.form', vars),
    });
  const shared = sharedFaq(t, client);
  return [...items, shared[0]!, shared[3]!];
}

export const ServiceClientPage: FC<{
  ctx: PageCtx;
  service: ServiceDetail;
  guide: ClientGuide;
  services: PublicService[];
}> = ({ ctx, service, guide, services }) => {
  const { t, lang } = ctx;
  const client = clientName(guide, lang);
  const page = clientPage(guide);
  const path = comboPath(service.id, guide);
  const url = `${ctx.publicUrl}${localizedPath(path, lang)}`;
  const meta = serviceMeta(service.id);
  const vars = { service: service.name, client };
  const minutes = page.minutes + 2;
  const examples = quoteList(
    lang,
    service.actions.slice(0, 3).map((a) => a.title),
  );
  const answer = t('combo.answer', { ...vars, n: service.actions.length, examples, minutes });
  const faq = comboFaq(t, lang, service, client);
  const crumbs = [
    home(ctx),
    { name: t('site.nav.services'), path: '/services' },
    { name: service.name, path: `/services/${service.id}` },
    { name: client, path },
  ];
  const connectUrl = `/connect/${encodeURIComponent(service.id)}`;
  const connectHref = ctx.user ? connectUrl : `/signup?next=${encodeURIComponent(connectUrl)}`;
  const step1 = t(`combo.step1.${service.connect}`, vars);
  const others = services.filter((s) => s.ready && s.id !== service.id);
  return (
    <SiteLayout
      ctx={ctx}
      title={t('combo.title', vars)}
      description={t('combo.description', { ...vars, blurb: blurb(lang, service) })}
      current="services"
      canonicalPath={path}
      ogType="article"
      noindex={!service.ready}
      jsonLd={[
        crumbsLd(ctx, crumbs),
        howTo({
          name: t('combo.h1', vars),
          description: answer,
          url,
          lang,
          totalTime: ISO_MINUTES(minutes),
          steps: [
            { name: t('combo.step1', vars), text: step1 },
            { name: t('combo.step2', vars), text: guide.steps[lang].join(' ') },
            { name: t('combo.step3', vars), text: service.prompts[0] ?? t('guide.step.askText') },
          ],
        }),
        faqPage(faq),
      ]}
    >
      <section class="section svc-page">
        <div class="wrap">
          <Crumbs ctx={ctx} items={crumbs} />
          <div class="svc-hero">
            <ServiceLogo icon={meta?.icon} glyph={meta?.glyph} name={service.name} size="lg" />
            <div class="grow">
              <h1 class="section-title">{t('combo.h1', vars)}</h1>
              <p class="lead">{answer}</p>
            </div>
            {service.ready ? (
              <div class="svc-cta">
                <a class="btn primary lg" href={connectHref}>
                  {t('service.connectCta', { service: service.name })} <Icon name="arrow" />
                </a>
                {ctx.user ? null : <span class="small muted">{t('service.ctaNote')}</span>}
              </div>
            ) : null}
          </div>
          {service.ready ? null : (
            <div class="notice info">{t('service.notReady', { service: service.name })}</div>
          )}
          <div class="svc-detail-grid">
            <div class="card step-card-plain" id="step-1">
              <h2>1. {t('combo.step1', vars)}</h2>
              <p>{step1}</p>
              {service.connect === 'form' && service.guide ? (
                <SetupGuideView t={t} guide={service.guide} />
              ) : null}
            </div>
            <div class="card guide" id="step-2">
              <h2>2. {t('combo.step2', vars)}</h2>
              <p class="small muted">{guide.note[lang]}</p>
              <CopyField t={t} id="combo-mcp-url" value={ctx.mcpUrl} label={t('home.mcpUrl')} />
              <ClientSteps ctx={ctx} guide={guide} idPrefix="client-" />
              <p>
                <a href={localizedPath(clientPath(guide), lang)}>
                  {t('guide.full')}: {client} <Icon name="arrow" />
                </a>
              </p>
            </div>
          </div>
          <div class="card" id="step-3">
            <h2>3. {t('combo.step3', vars)}</h2>
            {service.prompts.length ? (
              <PromptList t={t} prompts={service.prompts} idPrefix="ask" />
            ) : (
              <p class="muted">{t('service.promptsNone', { service: service.name })}</p>
            )}
          </div>
          <div class="card flush">
            <div class="card-head pad">
              <h2>{t('combo.tools', vars)}</h2>
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
          <RelatedUseCases
            ctx={ctx}
            services={services}
            serviceId={service.id}
            title={t('combo.useCases', vars)}
          />
          <div class="card">
            <h2>{t('guide.faq')}</h2>
            <FaqList items={faq} />
          </div>
          <div class="card">
            <h2>{t('combo.otherClients', vars)}</h2>
            <ClientGrid
              ctx={ctx}
              clients={COMBO_CLIENTS.filter((g) => g !== guide)}
              href={(g) => comboPath(service.id, g)}
            />
          </div>
          {others.length ? (
            <div class="card">
              <h2>{t('combo.otherServices', vars)}</h2>
              <ServiceGrid ctx={ctx} services={others} href={(s) => comboPath(s.id, guide)} />
            </div>
          ) : null}
        </div>
      </section>
    </SiteLayout>
  );
};

/** "Use Gmail with: Claude · ChatGPT · …" and what people do with it, on a service's own page. */
export const UseWith: FC<{ ctx: PageCtx; service: PublicService; services: PublicService[] }> = ({
  ctx,
  service,
  services,
}) => (
  <>
    <div class="card">
      <h2>{ctx.t('combo.useWith', { service: service.name })}</h2>
      <ClientGrid ctx={ctx} clients={COMBO_CLIENTS} href={(g) => comboPath(service.id, g)} />
    </div>
    <RelatedUseCases
      ctx={ctx}
      services={services}
      serviceId={service.id}
      title={ctx.t('combo.useCases', { service: service.name })}
    />
  </>
);

// ---------------------------------------------------------------------------
// FAQ: /faq
// ---------------------------------------------------------------------------

type FaqKey =
  | 'what'
  | 'mcp'
  | 'why'
  | 'clients'
  | 'services'
  | 'install'
  | 'chat'
  | 'many'
  | 'custom'
  | 'secrets'
  | 'injection'
  | 'revoke'
  | 'delete'
  | 'action'
  | 'limit'
  | 'reset'
  | 'upgrade';

export const FAQ_GROUPS: { id: 'basics' | 'setup' | 'security' | 'pricing'; keys: FaqKey[] }[] = [
  { id: 'basics', keys: ['what', 'mcp', 'why', 'clients', 'services'] },
  { id: 'setup', keys: ['install', 'chat', 'many', 'custom'] },
  { id: 'security', keys: ['secrets', 'injection', 'revoke', 'delete'] },
  { id: 'pricing', keys: ['action', 'limit', 'reset', 'upgrade'] },
];

/** The FAQ texts in the reader's language, with the catalogue filled in. */
export function faqGroups(t: Translate, lang: Locale, services: PublicService[]) {
  const names = new Intl.ListFormat(lang, { type: 'conjunction' }).format(
    services.filter((s) => s.ready).map((s) => s.name),
  );
  return FAQ_GROUPS.map((group) => ({
    id: group.id,
    items: group.keys.map((k) => ({ q: t(`faq.${k}.q`), a: t(`faq.${k}.a`, { services: names }) })),
  }));
}

export const FaqPageView: FC<{ ctx: PageCtx; services: PublicService[] }> = ({ ctx, services }) => {
  const { t, lang } = ctx;
  const groups = faqGroups(t, lang, services);
  const crumbs = [home(ctx), { name: t('site.nav.faq'), path: '/faq' }];
  return (
    <SiteLayout
      ctx={ctx}
      title={t('faqPage.title')}
      description={t('faqPage.description')}
      current="docs"
      canonicalPath="/faq"
      jsonLd={[crumbsLd(ctx, crumbs), faqPage(groups.flatMap((g) => g.items))]}
    >
      <section class="section">
        <div class="wrap">
          <Crumbs ctx={ctx} items={crumbs} />
          <div class="section-head">
            <h1>{t('faqPage.h1')}</h1>
            <p>{t('faqPage.lead')}</p>
          </div>
          {groups.map((g) => (
            <div class="faq-group" id={g.id}>
              <h2>{t(`faqPage.group.${g.id}`)}</h2>
              <FaqList items={g.items} />
            </div>
          ))}
          {ctx.supportEmail ? (
            <p class="muted">
              {t('faqPage.more')}{' '}
              <a href={`mailto:${ctx.supportEmail}`}>{t('faqPage.contact', { email: ctx.supportEmail })}</a>
            </p>
          ) : null}
        </div>
      </section>
      <CtaBand ctx={ctx} />
    </SiteLayout>
  );
};

// ---------------------------------------------------------------------------
// Comparisons: /compare and /compare/<slug>
// ---------------------------------------------------------------------------

export const CompareIndexPage: FC<{ ctx: PageCtx }> = ({ ctx }) => {
  const { t, lang } = ctx;
  const crumbs = [home(ctx), { name: t('site.nav.compare'), path: '/compare' }];
  return (
    <SiteLayout
      ctx={ctx}
      title={t('compare.index.title')}
      description={t('compare.index.description')}
      current="docs"
      canonicalPath="/compare"
      jsonLd={[crumbsLd(ctx, crumbs)]}
    >
      <section class="section">
        <div class="wrap">
          <Crumbs ctx={ctx} items={crumbs} />
          <div class="section-head">
            <h1>{t('compare.index.h1')}</h1>
            <p>{t('compare.index.lead')}</p>
          </div>
          <div class="svc-grid wide-cards">
            {COMPARE_PAGES.map((p) => (
              <a class="svc" href={localizedPath(`/compare/${p.slug}`, lang)}>
                <span class="grow">
                  <span class="name">{p.body[lang].h1}</span>
                  <span class="meta">{p.body[lang].description}</span>
                </span>
              </a>
            ))}
          </div>
        </div>
      </section>
    </SiteLayout>
  );
};

export const CompareView: FC<{ ctx: PageCtx; page: ComparePage; services: PublicService[] }> = ({
  ctx,
  page,
  services,
}) => {
  const { t, lang } = ctx;
  const body = page.body[lang];
  const vars = contentVars(services);
  const path = `/compare/${page.slug}`;
  const crumbs = [home(ctx), { name: t('site.nav.compare'), path: '/compare' }, { name: body.h1, path }];
  return (
    <SiteLayout
      ctx={ctx}
      title={`${body.title} · ${BRAND.name}`}
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
          url: `${ctx.publicUrl}${localizedPath(path, lang)}`,
          updated: page.checked,
          lang,
        }),
      ]}
    >
      <div class="wrap">
        <article class="prose">
          <Crumbs ctx={ctx} items={crumbs} />
          <h1>{body.h1}</h1>
          <p class="muted">{t('article.updated', { date: formatDate(lang, page.checked) })}</p>
          <p class="lead">{fill(body.summary, vars)}</p>
          <div class="card flush table-wrap">
            <table class="compare vs">
              <thead>
                <tr>
                  <th>{t('compare.feature')}</th>
                  <th>{BRAND.name}</th>
                  <th>{page.other}</th>
                </tr>
              </thead>
              <tbody>
                {body.rows.map((r) => (
                  <tr>
                    <td>{r.feature}</td>
                    <td>{fill(r.manyplug, vars)}</td>
                    <td>{r.other}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>{t('compare.chooseManyplug')}</h2>
          <ul>
            {body.chooseManyplug.map((x) => (
              <li>{x}</li>
            ))}
          </ul>
          <h2>{t('compare.chooseOther', { other: page.other })}</h2>
          <ul>
            {body.chooseOther.map((x) => (
              <li>{x}</li>
            ))}
          </ul>
          {body.together ? (
            <>
              <h2>{t('compare.together')}</h2>
              <p>{body.together}</p>
            </>
          ) : null}
          <p class="small muted">
            {t('compare.sources', { other: page.other, date: formatDate(lang, page.checked) })}{' '}
            {page.sources.map((s, i) => (
              <>
                {i ? ', ' : ''}
                <a href={s.url} rel="noopener" target="_blank">
                  {s.label}
                </a>
              </>
            ))}
          </p>
          <h2>{t('compare.others')}</h2>
          <ul>
            {COMPARE_PAGES.filter((p) => p !== page).map((p) => (
              <li>
                <a href={localizedPath(`/compare/${p.slug}`, lang)}>{p.body[lang].h1}</a>
              </li>
            ))}
          </ul>
        </article>
      </div>
      <CtaBand ctx={ctx} />
    </SiteLayout>
  );
};

// ---------------------------------------------------------------------------
// Explainers (/guides/<slug>) and blog posts (/blog/<slug>)
// ---------------------------------------------------------------------------

/** The sidebar of blog posts: every post, newest first, then the explainers. */
const BlogNav: FC<{ ctx: PageCtx; current?: string }> = ({ ctx, current }) => (
  <nav class="doc-nav" aria-label={ctx.t('site.nav.blog')}>
    <span class="group">{ctx.t('site.nav.blog')}</span>
    {BLOG_POSTS.map((p) => (
      <a
        href={localizedPath(blogPath(p.slug), ctx.lang)}
        aria-current={p.slug === current ? 'page' : undefined}
      >
        {p.body[ctx.lang].h1}
      </a>
    ))}
    <span class="group">{ctx.t('site.nav.guides')}</span>
    {ARTICLES.map((a) => (
      <a href={localizedPath(`/guides/${a.slug}`, ctx.lang)}>{a.body[ctx.lang].h1}</a>
    ))}
    <a href={localizedPath('/use-cases', ctx.lang)}>{ctx.t('site.nav.useCases')}</a>
  </nav>
);

const isPost = (a: Article | BlogPost): a is BlogPost => 'published' in a;

/** An explainer or a blog post: the direct answer, sections, questions and where to go next. */
export const ArticleView: FC<{ ctx: PageCtx; article: Article | BlogPost; services: PublicService[] }> = ({
  ctx,
  article,
  services,
}) => {
  const { t, lang } = ctx;
  const body = article.body[lang];
  const vars = contentVars(services);
  const post = isPost(article) ? article : undefined;
  const path = post ? blogPath(article.slug) : `/guides/${article.slug}`;
  const parent: Crumb = post
    ? { name: t('site.nav.blog'), path: '/blog' }
    : { name: t('site.nav.guides'), path: '/docs' };
  const crumbs = [home(ctx), parent, { name: body.h1, path }];
  const url = `${ctx.publicUrl}${localizedPath(path, lang)}`;
  const siblings = post
    ? BLOG_POSTS.filter((p) => p !== article).slice(0, 4)
    : ARTICLES.filter((a) => a !== article);
  const siblingPath = (a: Article) => (post ? blogPath(a.slug) : `/guides/${a.slug}`);
  return (
    <SiteLayout
      ctx={ctx}
      title={`${body.title} · ${BRAND.name}`}
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
          updated: article.updated,
          ...(post ? { published: post.published, type: 'BlogPosting' as const } : {}),
          lang,
        }),
        faqPage(body.faq),
      ]}
    >
      <div class="wrap">
        <div class="doc-layout">
          {post ? (
            <BlogNav ctx={ctx} current={article.slug} />
          ) : (
            <GuideNav ctx={ctx} current={article.slug} />
          )}
          <article class="prose">
            <Crumbs ctx={ctx} items={crumbs} />
            <h1>{body.h1}</h1>
            <p class="muted">
              {post
                ? t('blog.published', { date: formatDate(lang, post.published) })
                : t('article.updated', { date: formatDate(lang, article.updated) })}
            </p>
            <p class="lead">{fill(body.answer, vars)}</p>
            {body.sections.map((s) => (
              <>
                <h2>{s.h}</h2>
                {s.p.map((p) => (
                  <p>{fill(p, vars)}</p>
                ))}
                {s.list ? (
                  <ul>
                    {s.list.map((x) => (
                      <li>{fill(x, vars)}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            ))}
            <h2>{t('article.faq')}</h2>
            <FaqList items={body.faq} />
            <h2>{t('article.next')}</h2>
            <ul>
              <li>
                <a href={localizedPath('/docs', lang)}>{t('article.connect')}</a>
              </li>
              <li>
                <a href={localizedPath('/use-cases', lang)}>{t('article.useCases')}</a>
              </li>
              <li>
                <a href={localizedPath('/services', lang)}>{t('article.services')}</a>
              </li>
              {siblings.map((a) => (
                <li>
                  <a href={localizedPath(siblingPath(a), lang)}>{a.body[lang].h1}</a>
                </li>
              ))}
            </ul>
          </article>
        </div>
      </div>
      <CtaBand ctx={ctx} />
    </SiteLayout>
  );
};

// ---------------------------------------------------------------------------
// Blog index: /blog
// ---------------------------------------------------------------------------

export const BlogIndexPage: FC<{ ctx: PageCtx }> = ({ ctx }) => {
  const { t, lang } = ctx;
  const crumbs = [home(ctx), { name: t('site.nav.blog'), path: '/blog' }];
  return (
    <SiteLayout
      ctx={ctx}
      title={t('blog.title')}
      description={t('blog.description')}
      current="docs"
      canonicalPath="/blog"
      jsonLd={[crumbsLd(ctx, crumbs)]}
    >
      <section class="section">
        <div class="wrap">
          <Crumbs ctx={ctx} items={crumbs} />
          <div class="section-head">
            <h1>{t('blog.h1')}</h1>
            <p>{t('blog.lead')}</p>
          </div>
          <div class="post-list">
            {BLOG_POSTS.map((p) => (
              <a class="card post-card" href={localizedPath(blogPath(p.slug), lang)}>
                <span class="small muted">{formatDate(lang, p.published)}</span>
                <h2>{p.body[lang].h1}</h2>
                <p class="muted">{p.body[lang].description}</p>
              </a>
            ))}
          </div>
        </div>
      </section>
      <CtaBand ctx={ctx} />
    </SiteLayout>
  );
};
