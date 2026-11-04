import { Hono } from 'hono';
import { PLANS } from '../billing/plans.js';
import { serviceMeta } from '../web/catalog.js';
import { clientName } from '../web/clients.js';
import { translator } from '../web/i18n.js';
import { ARTICLES, article } from '../web/seo/articles.js';
import { clientIdBySlug } from '../web/seo/client-pages.js';
import { COMPARE_PAGES, comparePage } from '../web/seo/compare-pages.js';
import { robotsTxt, type SitemapEntry, sitemapXml } from '../web/seo/crawlers.js';
import { planVars } from '../web/seo/facts.js';
import { type LlmsInput, llmsFullTxt, llmsTxt } from '../web/seo/llms.js';
import { OG_IMAGE_PNG } from '../web/seo/og-image.js';
import {
  ArticleView,
  ClientGuidePage,
  COMBO_CLIENTS,
  CompareIndexPage,
  CompareView,
  clientPage,
  clientPath,
  comboPath,
  FaqPageView,
  faqGroups,
  PAGE_CLIENTS,
  ServiceClientPage,
} from '../web/seo-pages.js';
import type { AppContext, AppEnv } from './context.js';
import { currentUser } from './context.js';
import { pageCtx } from './page-helpers.js';
import { publicServices, serviceDetail, serviceDetails } from './site-data.js';

const HOURLY = 'public, max-age=3600';

/** Static pages of the site that belong in the sitemap (generated pages are added from the catalogue). */
const STATIC_PAGES: SitemapEntry[] = [
  { path: '/', priority: 1 },
  { path: '/pricing', priority: 0.8 },
  { path: '/services', priority: 0.8 },
  { path: '/docs', priority: 0.8 },
  { path: '/faq', priority: 0.6 },
  { path: '/compare', priority: 0.5 },
  { path: '/status', priority: 0.3 },
  { path: '/privacy', priority: 0.2 },
  { path: '/terms', priority: 0.2 },
];

/** What llms.txt and llms-full.txt are built from (English). */
async function llmsInput(c: AppContext, full: boolean): Promise<LlmsInput> {
  const s = c.get('services');
  const t = translator('en');
  const services = await publicServices(c, 'en');
  const free = PLANS.find((p) => p.id === 'free');
  return {
    publicUrl: s.config.publicUrl,
    mcpUrl: s.config.mcpUrl,
    t,
    services,
    ...(full ? { details: await serviceDetails(c, 'en') } : {}),
    clients: PAGE_CLIENTS.map((guide) => ({
      guide,
      path: clientPath(guide),
      intro: clientPage(guide).intro.en,
      name: clientName(guide, 'en'),
    })),
    plans: PLANS,
    faq: faqGroups(t, 'en', services).flatMap((g) => g.items),
    articles: ARTICLES,
    compare: COMPARE_PAGES,
    vars: {
      count: services.filter((x) => x.ready && serviceMeta(x.id)?.category !== 'custom').length,
      freeAccounts: free?.limits.accounts ?? 0,
      ...planVars(),
    },
    serviceBlurb: (service) => serviceMeta(service.id)?.blurb.en ?? service.description,
    comboPath,
  };
}

/**
 * Docs and search pages: a guide per AI client (`/docs/<client>`), a page per service and client
 * (`/services/<service>/<client>`), the FAQ, comparisons, explainers, and what crawlers read:
 * robots.txt, the sitemap, llms.txt and the link preview image.
 */
export function seoRoutes() {
  const app = new Hono<AppEnv>();

  // --- For crawlers -----------------------------------------------------------
  app.get('/robots.txt', (c) =>
    c.text(robotsTxt(c.get('services').config.publicUrl), 200, { 'Cache-Control': HOURLY }),
  );

  app.get('/sitemap.xml', async (c) => {
    const services = await publicServices(c, 'en');
    const ready = services.filter((s) => s.ready);
    const entries: SitemapEntry[] = [
      ...STATIC_PAGES,
      ...PAGE_CLIENTS.map((g) => ({ path: clientPath(g), priority: 0.7 })),
      ...ARTICLES.map((a) => ({ path: `/guides/${a.slug}`, priority: 0.6 })),
      ...COMPARE_PAGES.map((p) => ({ path: `/compare/${p.slug}`, priority: 0.5 })),
      ...services.map((s) => ({ path: `/services/${s.id}`, priority: 0.7 })),
      // Only combinations that work here: the others are marked noindex.
      ...ready.flatMap((s) => COMBO_CLIENTS.map((g) => ({ path: comboPath(s.id, g), priority: 0.5 }))),
    ];
    return c.body(sitemapXml(c.get('services').config.publicUrl, entries), 200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': HOURLY,
    });
  });

  const markdown = (body: string) => ({
    body,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': HOURLY },
  });
  app.get('/llms.txt', async (c) => {
    const out = markdown(llmsTxt(await llmsInput(c, false)));
    return c.body(out.body, 200, out.headers);
  });
  app.get('/llms-full.txt', async (c) => {
    const out = markdown(llmsFullTxt(await llmsInput(c, true)));
    return c.body(out.body, 200, out.headers);
  });

  app.get('/assets/og.png', (c) =>
    c.body(new Uint8Array(OG_IMAGE_PNG), 200, {
      'Content-Type': 'image/png',
      'Cache-Control': HOURLY,
      'X-Content-Type-Options': 'nosniff',
    }),
  );

  // --- Pages ------------------------------------------------------------------
  app.get('/docs/:client', async (c) => {
    const id = clientIdBySlug(c.req.param('client'));
    const guide = PAGE_CLIENTS.find((g) => g.id === id);
    if (!guide) return c.notFound();
    return c.html(
      <ClientGuidePage
        ctx={pageCtx(c, await currentUser(c))}
        guide={guide}
        services={await publicServices(c)}
      />,
    );
  });

  app.get('/services/:id/:client', async (c) => {
    const id = clientIdBySlug(c.req.param('client'));
    const guide = COMBO_CLIENTS.find((g) => g.id === id);
    const service = guide && (await serviceDetail(c, c.req.param('id')));
    if (!guide || !service) return c.notFound();
    return c.html(
      <ServiceClientPage
        ctx={pageCtx(c, await currentUser(c))}
        service={service}
        guide={guide}
        services={await publicServices(c)}
      />,
    );
  });

  app.get('/faq', async (c) =>
    c.html(<FaqPageView ctx={pageCtx(c, await currentUser(c))} services={await publicServices(c)} />),
  );

  app.get('/compare', async (c) => c.html(<CompareIndexPage ctx={pageCtx(c, await currentUser(c))} />));

  app.get('/compare/:slug', async (c) => {
    const page = comparePage(c.req.param('slug'));
    if (!page) return c.notFound();
    return c.html(
      <CompareView ctx={pageCtx(c, await currentUser(c))} page={page} services={await publicServices(c)} />,
    );
  });

  app.get('/guides/:slug', async (c) => {
    const found = article(c.req.param('slug'));
    if (!found) return c.notFound();
    return c.html(
      <ArticleView
        ctx={pageCtx(c, await currentUser(c))}
        article={found}
        services={await publicServices(c)}
      />,
    );
  });

  return app;
}
