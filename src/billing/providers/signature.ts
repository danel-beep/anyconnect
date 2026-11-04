import { createHmac, timingSafeEqual } from 'node:crypto';

/** HMAC-SHA256 as lowercase hex (the format Paddle and Stripe sign webhooks with). */
export function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

export function hexEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

/** How old a signed webhook may be (replay protection), in seconds. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** Whether a signature timestamp (seconds) is within the tolerance of `now`. */
export function fresh(timestamp: number, now: Date, tolerance = WEBHOOK_TOLERANCE_SECONDS): boolean {
  return Number.isFinite(timestamp) && Math.abs(now.getTime() / 1000 - timestamp) <= tolerance;
}

/** Parses `a=1;b=2` / `a=1,b=2` signature headers into a multimap. */
export function parseSignatureHeader(header: string, separator: ';' | ','): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of header.split(separator)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    out.set(key, [...(out.get(key) ?? []), value]);
  }
  return out;
}
