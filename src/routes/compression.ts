import { Duplex } from 'node:stream';
import { constants, createBrotliCompress, createGzip } from 'node:zlib';
import type { MiddlewareHandler } from 'hono';
import { type ContentEncoding, negotiateEncoding } from '../web/static-asset.js';

export interface CompressionOptions {
  /** Content types that are compressed (pages, feeds, text); everything else goes out as it is. */
  contentType: RegExp;
  /** Bodies with a known length below this many bytes are not worth it. */
  threshold?: number;
}

/**
 * Brotli quality for bodies rendered per request: 4 costs about what gzip -6 does and comes out
 * 5–20% smaller (measured on the landing, docs and services pages). Higher levels cost several
 * times more CPU for a few percent; static files are compressed once at the maximum instead
 * (`encodedBody`).
 */
const BROTLI_QUALITY = 4;
const GZIP_LEVEL = 6;

/**
 * Compresses dynamic responses (pages, feeds, llms.txt) in the best encoding the client takes:
 * brotli, else gzip. Streams the body through, so a large page does not sit in memory twice.
 * Responses that already have an encoding (the static files) or ask for `no-transform` are left
 * alone, and every compressible type says `Vary: Accept-Encoding` so shared caches keep one copy
 * per encoding.
 */
export function compression(opts: CompressionOptions): MiddlewareHandler {
  const threshold = opts.threshold ?? 1024;
  return async (c, next) => {
    await next();
    const res = c.res;
    if (!opts.contentType.test(res.headers.get('Content-Type') ?? '')) return;
    if (res.headers.has('Content-Encoding')) return;
    if (!/\baccept-encoding\b/i.test(res.headers.get('Vary') ?? ''))
      res.headers.append('Vary', 'Accept-Encoding');
    if (
      !res.body ||
      c.req.method === 'HEAD' ||
      /\bno-transform\b/i.test(res.headers.get('Cache-Control') ?? '')
    )
      return;
    const length = res.headers.get('Content-Length');
    if (length !== null && Number(length) < threshold) return;
    const encoding = negotiateEncoding(c.req.header('Accept-Encoding'));
    if (!encoding) return;
    c.res = new Response(res.body.pipeThrough(Duplex.toWeb(compressor(encoding, length))), res);
    c.res.headers.delete('Content-Length');
    c.res.headers.set('Content-Encoding', encoding);
  };
}

function compressor(encoding: ContentEncoding, length: string | null) {
  if (encoding === 'gzip') return createGzip({ level: GZIP_LEVEL });
  return createBrotliCompress({
    params: {
      [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      ...(length !== null ? { [constants.BROTLI_PARAM_SIZE_HINT]: Number(length) } : {}),
    },
  });
}
