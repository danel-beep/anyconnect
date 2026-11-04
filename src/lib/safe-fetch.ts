import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Outbound HTTP for URLs that come from untrusted input (OAuth client metadata documents today;
 * user-supplied API specs and webhooks later). Guards against SSRF: only public addresses are
 * reachable, checked at connect time (so DNS rebinding cannot bypass it), with strict timeouts,
 * a response size cap and no automatic redirects.
 */

const blocked = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) {
    const lower = address.toLowerCase();
    // IPv4-mapped / NAT64 addresses embed an IPv4 address that must be checked too.
    const embedded = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (embedded) return isPublicAddress(embedded[1]!);
    if (lower.startsWith('::ffff:')) return false;
    return !blocked.check(address, 'ipv6');
  }
  return false;
}

export class UnsafeUrlError extends Error {
  override name = 'UnsafeUrlError';
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

export function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = addresses as dns.LookupAddress[];
    const unsafe = list.find((a) => !isPublicAddress(a.address));
    if (unsafe || list.length === 0) {
      return callback(new UnsafeUrlError(`${hostname} resolves to a non-public address`), '');
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
}

export interface SafeFetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Allow http:// and private addresses (local development and tests only). */
  allowPrivateNetwork?: boolean;
}

export interface SafeFetchResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const url = new URL(rawUrl);
  const allowPrivate = options.allowPrivateNetwork ?? false;
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    return Promise.reject(new UnsafeUrlError('Only https URLs are allowed'));
  }
  if (url.username || url.password)
    return Promise.reject(new UnsafeUrlError('URLs with credentials are not allowed'));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && net.isIP(host) && !isPublicAddress(host)) {
    return Promise.reject(new UnsafeUrlError('Requests to non-public addresses are not allowed'));
  }

  const timeoutMs = options.timeoutMs ?? 5000;
  const maxBytes = options.maxBytes ?? 256 * 1024;
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: options.method ?? 'GET',
        headers: { 'user-agent': 'Manyplug/1.0', ...options.headers },
        timeout: timeoutMs,
        ...(allowPrivate ? {} : { lookup: guardedLookup as unknown as typeof dns.lookup }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new UnsafeUrlError(`Response is larger than ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    const deadline = setTimeout(
      () => req.destroy(new Error(`Request timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.on('close', () => clearTimeout(deadline));
    if (options.body) req.write(options.body);
    req.end();
  });
}
