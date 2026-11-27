import { Hono } from 'hono';
import { ALL_STATIC_ASSETS } from '../web/asset-urls.js';
import { assetCacheControl, encodedBody, negotiateEncoding, type StaticAsset } from '../web/static-asset.js';
import type { AppContext, AppEnv } from './context.js';

/**
 * The site's static files (`ALL_STATIC_ASSETS`): text files go out in the best encoding the browser
 * takes (brotli, else gzip), compressed once per process; an ETag lets a browser whose hourly copy
 * expired revalidate it with a 304 instead of downloading it again.
 */
export function assetRoutes() {
  const app = new Hono<AppEnv>();
  for (const asset of ALL_STATIC_ASSETS) app.get(asset.path, (c) => serveAsset(c, asset));
  return app;
}

async function serveAsset(c: AppContext, asset: StaticAsset): Promise<Response> {
  const encoding = asset.compressible ? negotiateEncoding(c.req.header('Accept-Encoding')) : undefined;
  // One tag per representation: the brotli and the gzip bytes of a file are different bodies.
  const etag = `"${asset.version}${encoding ? `-${encoding}` : ''}"`;
  const headers: Record<string, string> = {
    'Content-Type': asset.contentType,
    'Cache-Control': assetCacheControl(asset, c.req.query('v')),
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
  };
  if (asset.compressible) headers.Vary = 'Accept-Encoding';
  if (matchesEtag(c.req.header('If-None-Match'), etag)) return c.body(null, 304, headers);
  if (!encoding) return c.body(asset.body as Uint8Array<ArrayBuffer>, 200, headers);
  const body = await encodedBody(asset, encoding);
  return c.body(body as Uint8Array<ArrayBuffer>, 200, { ...headers, 'Content-Encoding': encoding });
}

/** `If-None-Match` names the current version (weak or strong form, or `*`). */
function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(',').some((tag) => {
    const t = tag.trim();
    return t === '*' || t === etag || t === `W/${etag}`;
  });
}
