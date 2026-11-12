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
  ['::', 96], // unspecified, loopback and the deprecated IPv4-compatible block
  ['64:ff9b:1::', 48], // local-use NAT64 (RFC 8215)
  ['100::', 64], // discard
  ['2001::', 32], // Teredo: tunnels to an IPv4 address
  ['2001:10::', 28], // ORCHID (deprecated)
  ['2001:20::', 28], // ORCHIDv2
  ['2001:db8::', 32], // documentation
  ['3fff::', 20], // documentation (RFC 9637)
  ['5f00::', 16], // SRv6 segment ids
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link local
  ['fec0::', 10], // site local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv6');
}

/** The eight 16-bit groups of an IPv6 address (any notation, zone id ignored). */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase().split('%')[0]!;
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const octets = dotted[2]!.split('.').map(Number);
    if (octets.some((o) => o > 255)) return undefined;
    text = `${dotted[1]}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN,
  );
  return groups.some(Number.isNaN) ? undefined : groups;
}

const ipv4Of = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

/**
 * The IPv4 address an IPv6 address stands for, when it embeds one that a host or a translator on
 * the way may connect to: IPv4-mapped (`::ffff:a.b.c.d`), IPv4-translated (`::ffff:0:a.b.c.d`),
 * NAT64 (`64:ff9b::a.b.c.d`, also written `64:ff9b::7f00:1`) and 6to4 (`2002:AABB:CCDD::`).
 */
function embeddedIpv4(groups: number[]): string | undefined {
  const zeros = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);
  if (zeros(0, 5) && groups[5] === 0xffff) return ipv4Of(groups[6]!, groups[7]!);
  if (zeros(0, 4) && groups[4] === 0xffff && groups[5] === 0) return ipv4Of(groups[6]!, groups[7]!);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zeros(2, 6)) return ipv4Of(groups[6]!, groups[7]!);
  if (groups[0] === 0x2002) return ipv4Of(groups[1]!, groups[2]!);
  return undefined;
}

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) {
    const groups = ipv6Groups(address);
    if (!groups) return false;
    const ipv4 = embeddedIpv4(groups);
    if (ipv4 !== undefined) return isPublicAddress(ipv4);
    const canonical = groups.map((g) => g.toString(16)).join(':');
    return !blocked.check(canonical, 'ipv6');
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
            // Reject before destroying: a destroyed response can still emit `end`, which would
            // otherwise resolve with a silently truncated body.
            reject(new UnsafeUrlError(`Response is larger than ${maxBytes} bytes`));
            req.destroy();
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
