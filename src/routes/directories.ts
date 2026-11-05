import { Hono } from 'hono';
import { buildServerCard } from '../distribution/server-card.js';
import { SETUP_CONNECTOR } from '../hub/setup-tools.js';
import { VERSION } from '../version.js';
import { brandIconPng, ICON_SIZES, type IconSize } from '../web/brand-raster.js';
import { FAVICON_SVG } from '../web/favicon.js';
import { publicCors } from '../web/http.js';
import type { AppEnv } from './context.js';

const HOURLY = 'public, max-age=3600';

/**
 * What AI app directories and registries fetch from the hub: ownership proofs
 * (`/.well-known/<name>` from `WELL_KNOWN_*` variables, e.g. `mcp-registry-auth`,
 * `openai-apps-challenge`), the static server card and the brand icons. Mounted after the OAuth
 * routes, so their `/.well-known/` documents always win.
 */
export function directoryRoutes() {
  const app = new Hono<AppEnv>();
  let card: string | undefined;

  app.use('/.well-known/mcp/*', publicCors());
  app.get('/.well-known/mcp/server-card.json', (c) => {
    card ??= JSON.stringify(
      buildServerCard({
        version: VERSION,
        publicUrl: c.get('services').config.publicUrl,
        setup: SETUP_CONNECTOR,
      }),
    );
    return c.body(card, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': HOURLY });
  });

  app.get('/.well-known/:name', async (c, next) => {
    const proof = c.get('services').config.directories.wellKnown[c.req.param('name')];
    if (proof === undefined) return next();
    return c.text(proof, 200, { 'Cache-Control': 'no-cache' });
  });

  app.get('/icon.svg', (c) =>
    c.body(FAVICON_SVG, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': HOURLY }),
  );
  app.get('/:file{icon-[0-9]+\\.png}', (c) => {
    const size = Number(c.req.param('file').slice(5, -4));
    if (!ICON_SIZES.includes(size as IconSize)) return c.notFound();
    return c.body(new Uint8Array(brandIconPng(size)), 200, {
      'Content-Type': 'image/png',
      'Cache-Control': HOURLY,
    });
  });
  return app;
}
