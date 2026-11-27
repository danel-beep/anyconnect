import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

/** The encodings a response body can be sent in besides identity, in the hub's order of preference. */
export type ContentEncoding = 'br' | 'gzip';
export const CONTENT_ENCODINGS: readonly ContentEncoding[] = ['br', 'gzip'];

/**
 * One file the site serves as it is (styles, scripts, fonts, icons). Pages link `url`, which carries
 * a content version (`?v=<hash>`): a deploy that changes the file changes its address, so a browser
 * keeps the current one for a year and never a stale one. The route serves the file whatever the
 * version says (an old page still gets styles), but only the current version is kept that long.
 */
export interface StaticAsset {
  /** Where it is served, e.g. `/assets/app.css`. */
  readonly path: string;
  /** The address pages link: `path?v=<version>`. */
  readonly url: string;
  readonly version: string;
  readonly contentType: string;
  readonly body: Uint8Array;
  /**
   * Text that shrinks when compressed. Fonts and images are compressed formats already and go out
   * as they are.
   */
  readonly compressible: boolean;
}

const COMPRESSIBLE_TYPE = /^(?:text\/|image\/svg\+xml|application\/(?:javascript|json|xml))/;

export function staticAsset(path: string, contentType: string, content: string | Uint8Array): StaticAsset {
  const body = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const version = createHash('sha256').update(body).digest('hex').slice(0, 12);
  return {
    path,
    url: `${path}?v=${version}`,
    version,
    contentType,
    body,
    compressible: COMPRESSIBLE_TYPE.test(contentType),
  };
}

const ONE_YEAR = 'public, max-age=31536000, immutable';
const ONE_HOUR = 'public, max-age=3600';

/**
 * `Cache-Control` for a request of `asset`: the current version (`?v=` matches) may be kept for a
 * year, since a new deploy changes the address; anything else (an old or no version) for an hour.
 */
export function assetCacheControl(asset: Pick<StaticAsset, 'version'>, requestedVersion: string | undefined) {
  return requestedVersion === asset.version ? ONE_YEAR : ONE_HOUR;
}

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const encoded = new WeakMap<StaticAsset, Map<ContentEncoding, Promise<Uint8Array>>>();

/**
 * The body of `asset` in `encoding`, compressed once per process at the strongest setting (the file
 * never changes while the process runs, so the cost is paid once instead of on every request). Runs
 * on the libuv thread pool, so the first request does not hold up the others.
 */
export function encodedBody(asset: StaticAsset, encoding: ContentEncoding): Promise<Uint8Array> {
  let byEncoding = encoded.get(asset);
  if (!byEncoding) {
    byEncoding = new Map();
    encoded.set(asset, byEncoding);
  }
  let body = byEncoding.get(encoding);
  if (!body) {
    body = (
      encoding === 'br'
        ? brotli(asset.body, {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
              [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
              [constants.BROTLI_PARAM_SIZE_HINT]: asset.body.byteLength,
            },
          })
        : gzipAsync(asset.body, { level: constants.Z_BEST_COMPRESSION })
    ).then((bytes) => new Uint8Array(bytes));
    // A failure is not remembered: the next request tries again.
    body.catch(() => byEncoding.delete(encoding));
    byEncoding.set(encoding, body);
  }
  return body;
}

/**
 * The encoding to send a body in, given the request's `Accept-Encoding`: the first of `offered`
 * with the highest weight the client gives it (`*` covers the ones it does not name, `q=0` refuses
 * one), or undefined for identity.
 */
export function negotiateEncoding(
  acceptEncoding: string | undefined,
  offered: readonly ContentEncoding[] = CONTENT_ENCODINGS,
): ContentEncoding | undefined {
  if (!acceptEncoding) return undefined;
  const weights = new Map<string, number>();
  for (const part of acceptEncoding.split(',')) {
    const [name, ...params] = part.split(';').map((x) => x.trim().toLowerCase());
    if (!name) continue;
    let weight = 1;
    for (const param of params) {
      const q = /^q=([01](?:\.\d{0,3})?)$/.exec(param);
      if (q) weight = Number(q[1]);
    }
    weights.set(name, weight);
  }
  let best: ContentEncoding | undefined;
  let bestWeight = 0;
  for (const encoding of offered) {
    const weight = weights.get(encoding) ?? weights.get('*') ?? 0;
    if (weight > bestWeight) {
      best = encoding;
      bestWeight = weight;
    }
  }
  return best;
}
