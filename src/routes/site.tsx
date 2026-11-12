import { Hono } from 'hono';
import { ASSET_URLS, assetCacheControl } from '../web/asset-urls.js';
import { fontFile } from '../web/assets.js';
import { SITE_JS, THEME_JS } from '../web/client-scripts.js';
import { FAVICON_SVG } from '../web/favicon.js';
import { safeNextPath } from '../web/http.js';
import { LandingPage } from '../web/landing.js';
import { LEGAL_KINDS, legalDoc } from '../web/legal.js';
import { withoutLang } from '../web/seo/urls.js';
import { UseWith } from '../web/seo-pages.js';
import { DocsPage, LegalPage, PricingPage, ServiceDetailPage, ServicesPage } from '../web/site.js';
import { StatusPage } from '../web/status-page.js';
import { supportDoc } from '../web/support.js';
import { trustDoc } from '../web/trust.js';
import { TrustPage } from '../web/trust-page.js';
import type { AppContext, AppEnv } from './context.js';
import { currentUser } from './context.js';
import { pageCtx, saveLocale } from './page-helpers.js';
import { publicServices, serviceDetail } from './site-data.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const HOURLY = 'public, max-age=3600';

/**
 * The public website: landing, pricing, services, docs, legal pages, plus its static files
 * (fonts, scripts, favicon). Guides, comparisons, robots.txt, the sitemap and llms.txt live in
 * `seo.tsx`. Everything here works signed out.
 */
export function siteRoutes() {
  const app = new Hono<AppEnv>();

  // --- Static files ---------------------------------------------------------
  app.get('/assets/fonts/:file', (c) => {
    const bytes = fontFile(c.req.param('file'));
    if (!bytes) return c.notFound();
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': 'font/woff2',
      'Cache-Control': IMMUTABLE,
      'X-Content-Type-Options': 'nosniff',
    });
  });

  const script = (body: string, url: string) => (c: AppContext) =>
    c.body(body, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': assetCacheControl(url, c.req.query('v')),
      'X-Content-Type-Options': 'nosniff',
    });
  app.get('/assets/theme.js', script(THEME_JS, ASSET_URLS.theme));
  app.get('/assets/site.js', script(SITE_JS, ASSET_URLS.site));

  app.get('/favicon.svg', (c) =>
    c.body(FAVICON_SVG, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': HOURLY }),
  );
  app.get('/favicon.ico', (c) => c.redirect('/favicon.svg', 301));

  // --- Status page ---------------------------------------------------------------
  app.get('/status', async (c) => {
    const data = await c.get('services').ops.status.page();
    return c.html(<StatusPage ctx={pageCtx(c, await currentUser(c))} data={data} />);
  });

  // For external monitors and embeds: the same data, without internal details.
  app.get('/status.json', async (c) => {
    const data = await c.get('services').ops.status.page({ days: 30 });
    return c.json(
      {
        status: data.updatedAt ? data.overall : 'unknown',
        updatedAt: data.updatedAt?.toISOString() ?? null,
        stale: data.stale,
        components: data.components.map((x) => ({
          id: x.id,
          status: x.status,
          since: x.since.toISOString(),
          uptime30d: x.uptime,
          ...(x.note ? { affected: x.note } : {}),
        })),
        incidents: data.incidents.map((i) => ({
          component: i.component,
          status: i.status,
          startedAt: i.startedAt.toISOString(),
          endedAt: i.endedAt?.toISOString() ?? null,
        })),
      },
      200,
      { 'Cache-Control': 'public, max-age=30', 'Access-Control-Allow-Origin': '*' },
    );
  });

  // --- Language switch --------------------------------------------------------
  app.get('/prefs/lang', async (c) => {
    const to = c.req.query('to');
    if (to === 'ru' || to === 'en') {
      saveLocale(c, to);
      // A language the user chose in Settings follows the quick switch, so the two never disagree.
      const user = await currentUser(c);
      if (user?.locale && user.locale !== to)
        await c.get('services').users.setProfile(user.id, { locale: to });
    }
    let next = c.req.query('next');
    if (!next) {
      // Without `next`, go back to the page the switch was on (same origin only).
      const referer = c.req.header('referer');
      try {
        const url = referer ? new URL(referer) : undefined;
        if (url && url.origin === c.get('services').config.publicUrl) next = url.pathname + url.search;
      } catch {
        next = undefined;
      }
    }
    // A page reached as /docs?lang=ru would otherwise keep its language after the switch.
    return c.redirect(withoutLang(safeNextPath(next ?? '/')), 303);
  });

  // --- Pages ------------------------------------------------------------------
  app.get('/', async (c) => {
    const ctx = pageCtx(c, await currentUser(c));
    return c.html(<LandingPage ctx={ctx} services={await publicServices(c)} />);
  });

  app.get('/pricing', async (c) => c.html(<PricingPage ctx={pageCtx(c, await currentUser(c))} />));

  app.get('/services', async (c) =>
    c.html(<ServicesPage ctx={pageCtx(c, await currentUser(c))} services={await publicServices(c)} />),
  );

  app.get('/services/:id', async (c) => {
    const service = await serviceDetail(c, c.req.param('id'));
    if (!service) return c.notFound();
    const ctx = pageCtx(c, await currentUser(c));
    return c.html(
      <ServiceDetailPage
        ctx={ctx}
        service={service}
        useWith={
          service.ready ? (
            <UseWith ctx={ctx} service={service} services={await publicServices(c)} />
          ) : undefined
        }
      />,
    );
  });

  app.get('/docs', async (c) =>
    c.html(
      <DocsPage
        ctx={pageCtx(c, await currentUser(c))}
        services={await publicServices(c)}
        telegram={Boolean(c.get('services').telegramBot)}
      />,
    ),
  );

  app.get('/trust', async (c) => {
    const ctx = pageCtx(c, await currentUser(c));
    return c.html(
      <TrustPage
        ctx={ctx}
        doc={trustDoc(ctx.lang, {
          supportEmail: ctx.supportEmail,
          merchant: c.get('services').billing.provider?.merchant,
        })}
      />,
    );
  });

  app.get('/support', async (c) => {
    const ctx = pageCtx(c, await currentUser(c));
    const doc = supportDoc(ctx.lang, { publicUrl: ctx.publicUrl, supportEmail: ctx.supportEmail });
    return c.html(<LegalPage ctx={ctx} doc={doc} path="/support" />);
  });

  for (const kind of LEGAL_KINDS) {
    app.get(`/${kind}`, async (c) => {
      const ctx = pageCtx(c, await currentUser(c));
      const doc = legalDoc(kind, ctx.lang, {
        publicUrl: ctx.publicUrl,
        supportEmail: ctx.supportEmail,
        operator: c.get('services').config.site.legalOperator,
        merchant: c.get('services').billing.provider?.merchant,
      });
      return c.html(<LegalPage ctx={ctx} doc={doc} path={`/${kind}`} />);
    });
  }

  return app;
}
