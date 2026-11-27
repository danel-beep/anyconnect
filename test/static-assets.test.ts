import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compression } from '../src/routes/compression.js';
import { ALL_STATIC_ASSETS, STATIC_ASSETS } from '../src/web/asset-urls.js';
import { FONT_ASSETS, FONT_FACES } from '../src/web/assets.js';
import { OG_IMAGE_PATH } from '../src/web/seo/og-image.js';
import { encodedBody, negotiateEncoding, staticAsset } from '../src/web/static-asset.js';
import { APP_CSS } from '../src/web/styles.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

describe('negotiateEncoding', () => {
  it.each([
    [undefined, undefined],
    ['', undefined],
    ['identity', undefined],
    ['gzip, deflate, br, zstd', 'br'],
    ['gzip', 'gzip'],
    ['GZIP;Q=0.5', 'gzip'],
    ['br;q=0, gzip', 'gzip'],
    ['br;q=0.5, gzip;q=0.8', 'gzip'],
    ['br;q=0.8, gzip;q=0.8', 'br'],
    ['*', 'br'],
    ['*;q=0', undefined],
    ['gzip;q=0, *', 'br'],
    ['deflate', undefined],
  ])('%s → %s', (header, expected) => {
    expect(negotiateEncoding(header)).toBe(expected);
  });
});

describe('static assets', () => {
  it('versions every address by content and serves each path once', () => {
    const paths = ALL_STATIC_ASSETS.map((a) => a.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const asset of ALL_STATIC_ASSETS) expect(asset.url).toBe(`${asset.path}?v=${asset.version}`);
    expect(staticAsset('/a', 'text/plain', 'x').version).not.toBe(
      staticAsset('/a', 'text/plain', 'y').version,
    );
    // The preview image keeps the address pages already announce.
    expect(STATIC_ASSETS.ogImage.url).toBe(OG_IMAGE_PATH);
  });

  it('links fonts from the stylesheet by their versioned address', () => {
    for (const font of Object.values(FONT_ASSETS)) {
      expect(FONT_FACES).toContain(`url(${font.url})`);
      expect(APP_CSS).toContain(`url(${font.url})`);
    }
  });

  it('compresses text once and leaves fonts and images as they are', async () => {
    const css = STATIC_ASSETS.css;
    expect(css.compressible).toBe(true);
    expect(STATIC_ASSETS.favicon.compressible).toBe(true);
    expect(STATIC_ASSETS.ogImage.compressible).toBe(false);
    for (const font of Object.values(FONT_ASSETS)) expect(font.compressible).toBe(false);

    const br = await encodedBody(css, 'br');
    expect(await encodedBody(css, 'br')).toBe(br);
    expect(Buffer.from(brotliDecompressSync(br)).equals(Buffer.from(css.body))).toBe(true);
    const gz = await encodedBody(css, 'gzip');
    expect(Buffer.from(gunzipSync(gz)).equals(Buffer.from(css.body))).toBe(true);
    expect(br.byteLength).toBeLessThan(gz.byteLength);
  });
});

describe('compression middleware', () => {
  const app = new Hono();
  app.use('*', compression({ contentType: /^text\//, threshold: 100 }));
  app.get('/big', (c) => c.text('hello '.repeat(200)));
  app.get('/small', (c) => c.text('hi', 200, { 'Content-Length': '2' }));
  app.get('/json', (c) => c.json({ text: 'hello '.repeat(200) }));
  app.get('/raw', (c) => c.text('hello '.repeat(200), 200, { 'Cache-Control': 'no-transform' }));

  const get = (path: string, encoding = 'gzip, br') =>
    app.request(path, { headers: { 'Accept-Encoding': encoding } });

  it('streams large text in the encoding the client prefers', async () => {
    const br = await get('/big');
    expect(br.headers.get('content-encoding')).toBe('br');
    expect(br.headers.get('content-length')).toBeNull();
    expect(br.headers.get('vary')).toBe('Accept-Encoding');
    expect(brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString()).toBe('hello '.repeat(200));

    const gz = await get('/big', 'gzip');
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).toBe('hello '.repeat(200));
  });

  it('leaves small bodies, other types, no-transform and HEAD alone', async () => {
    for (const path of ['/small', '/json', '/raw'])
      expect((await get(path)).headers.get('content-encoding'), path).toBeNull();
    expect((await get('/big', 'identity')).headers.get('content-encoding')).toBeNull();
    expect((await get('/big', 'identity')).headers.get('vary')).toBe('Accept-Encoding');
    const head = await app.request('/big', { method: 'HEAD', headers: { 'Accept-Encoding': 'br' } });
    expect(head.headers.get('content-encoding')).toBeNull();
  });
});

describe('asset routes', () => {
  let hub: TestHub;
  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub();
  });
  afterAll(async () => {
    await hub?.close();
  });
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${hub.baseUrl}${path}`, { headers });

  it('serves every file with its type, cache rule and a per-encoding ETag', async () => {
    for (const asset of ALL_STATIC_ASSETS) {
      const res = await get(asset.url, { 'Accept-Encoding': 'br, gzip' });
      expect(res.status, asset.path).toBe(200);
      expect(res.headers.get('content-type')).toBe(asset.contentType);
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('content-encoding')).toBe(asset.compressible ? 'br' : null);
      expect(res.headers.get('etag')).toBe(
        asset.compressible ? `"${asset.version}-br"` : `"${asset.version}"`,
      );
      expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(asset.body))).toBe(true);
    }
  });

  it('answers a revalidation of the same file with 304', async () => {
    const css = STATIC_ASSETS.css;
    const first = await get(css.path, { 'Accept-Encoding': 'gzip' });
    const etag = first.headers.get('etag')!;
    expect(etag).toBe(`"${css.version}-gzip"`);
    expect(first.headers.get('cache-control')).toBe('public, max-age=3600');
    const again = await get(css.path, { 'Accept-Encoding': 'gzip', 'If-None-Match': etag });
    expect(again.status).toBe(304);
    // A copy in another encoding is another representation: sent in full.
    expect((await get(css.path, { 'Accept-Encoding': 'br', 'If-None-Match': etag })).status).toBe(200);
    expect((await get(css.path, { 'If-None-Match': '"000000000000"' })).status).toBe(200);
  });
});
