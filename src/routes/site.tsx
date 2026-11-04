import { Hono } from 'hono';
import { actionRisk, actionText, connectorGuide, connectorText } from '../connectors/sdk.js';
import { fontFile } from '../web/assets.js';
import { HIDDEN_SERVICES, serviceAlternative } from '../web/catalog.js';
import { SITE_JS, THEME_JS } from '../web/client-scripts.js';
import { FAVICON_SVG } from '../web/favicon.js';
import { safeNextPath } from '../web/http.js';
import { legalDoc } from '../web/legal.js';
import {
  DocsPage,
  LandingPage,
  LegalPage,
  PricingPage,
  type PublicService,
  ServiceDetailPage,
  ServicesPage,
} from '../web/site.js';
import { supportDoc } from '../web/support.js';
import type { AppContext, AppEnv } from './context.js';
import { currentUser } from './context.js';
import { pageCtx, saveLocale } from './page-helpers.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const HOURLY = 'public, max-age=3600';

/** Built-in services shown on the public website (the setup and demo connectors are hidden). */
async function publicServices(c: AppContext): Promise<PublicService[]> {
  const s = c.get('services');
  const entries = await s.admin.services(undefined);
  const builtin = new Map(s.connectors.builtin.all().map((x) => [x.id, x]));
  const lang = c.get('locale');
  return entries
    .filter((e) => !HIDDEN_SERVICES.has(e.service))
    .map((e) => ({
      id: e.service,
      // Names in the page language ("Почта (IMAP/SMTP)"), as the connect form shows them.
      name: builtin.has(e.service) ? connectorText(builtin.get(e.service)!, lang).name : e.name,
      description: e.description,
      connect: e.connect,
      ready: e.ready,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The public website: landing, pricing, services, docs, legal pages, plus its static files
 * (fonts, scripts, favicon, robots.txt, sitemap). Everything here works signed out.
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

  const script = (body: string) => (c: AppContext) =>
    c.body(body, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': HOURLY,
      'X-Content-Type-Options': 'nosniff',
    });
  app.get('/assets/theme.js', script(THEME_JS));
  app.get('/assets/site.js', script(SITE_JS));

  app.get('/favicon.svg', (c) =>
    c.body(FAVICON_SVG, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': HOURLY }),
  );
  app.get('/favicon.ico', (c) => c.redirect('/favicon.svg', 301));

  app.get('/robots.txt', (c) => {
    const base = c.get('services').config.publicUrl;
    return c.text(
      [
        'User-agent: *',
        'Allow: /',
        'Disallow: /app',
        'Disallow: /admin',
        'Disallow: /oauth/',
        'Disallow: /connect/',
        'Disallow: /confirm',
        'Disallow: /api/',
        'Disallow: /mcp',
        `Sitemap: ${base}/sitemap.xml`,
        '',
      ].join('\n'),
      200,
      { 'Cache-Control': HOURLY },
    );
  });

  app.get('/sitemap.xml', async (c) => {
    const base = c.get('services').config.publicUrl;
    const paths = ['/', '/pricing', '/services', '/docs', '/support', '/privacy', '/terms'];
    for (const service of await publicServices(c)) paths.push(`/services/${service.id}`);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths
      .map((p) => `  <url><loc>${base}${p}</loc></url>`)
      .join('\n')}\n</urlset>\n`;
    return c.body(xml, 200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': HOURLY });
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
    return c.redirect(safeNextPath(next ?? '/'), 303);
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
    const s = c.get('services');
    const id = c.req.param('id');
    const connector = HIDDEN_SERVICES.has(id)
      ? undefined
      : s.connectors.builtin.all().find((x) => x.id === id);
    const entry = connector && (await publicServices(c)).find((x) => x.id === id);
    if (!connector || !entry) return c.notFound();
    const ctx = pageCtx(c, await currentUser(c));
    const guide = connectorGuide(connector, ctx.lang, entry.connect === 'oauth' ? 'oauth' : 'form');
    return c.html(
      <ServiceDetailPage
        ctx={ctx}
        service={{
          ...entry,
          guide: guide.setup,
          prompts: guide.prompts,
          alternative: entry.ready ? undefined : serviceAlternative(id, s.connectors.builtin.all(), ctx.lang),
          // Texts for people in the page language; the AI keeps the connector's own descriptions.
          actions: connector.actions.map((a) => ({
            name: a.name,
            ...actionText(connector, a, ctx.lang),
            risk: actionRisk(a),
          })),
        }}
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

  app.get('/support', async (c) => {
    const ctx = pageCtx(c, await currentUser(c));
    const doc = supportDoc(ctx.lang, { publicUrl: ctx.publicUrl, supportEmail: ctx.supportEmail });
    return c.html(<LegalPage ctx={ctx} doc={doc} path="/support" />);
  });

  for (const kind of ['privacy', 'terms'] as const) {
    app.get(`/${kind}`, async (c) => {
      const ctx = pageCtx(c, await currentUser(c));
      const doc = legalDoc(kind, ctx.lang, {
        publicUrl: ctx.publicUrl,
        supportEmail: ctx.supportEmail,
      });
      return c.html(<LegalPage ctx={ctx} doc={doc} path={`/${kind}`} />);
    });
  }

  return app;
}
