import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedLookup, safeFetch, UnsafeUrlError } from '../src/lib/safe-fetch.js';

/**
 * `safeFetch` is the hub's only door to URLs from untrusted input (OAuth client metadata today).
 * `isPublicAddress` has its own table in oauth-units.test.ts; these tests cover the request side:
 * what is refused before connecting, the connect-time DNS check, and the size and time limits.
 */
describe('safeFetch (SSRF guard for untrusted URLs)', () => {
  let server: http.Server;
  let base: string;
  const received: { method?: string; body: string; headers: http.IncomingHttpHeaders }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        received.push({ method: req.method, body, headers: req.headers });
        if (req.url === '/big') return res.end('x'.repeat(10_000));
        if (req.url === '/slow') return setTimeout(() => res.end('late'), 2_000);
        if (req.url === '/redirect') {
          res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it.each([
    ['plain http', 'http://example.com/metadata.json', 'Only https'],
    ['another scheme', 'file:///etc/passwd', 'Only https'],
    ['credentials in the URL', 'https://user:pass@example.com/', 'credentials'],
    ['loopback', 'https://127.0.0.1/', 'non-public'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data', 'non-public'],
    ['private network', 'https://10.0.0.5:8443/', 'non-public'],
    ['IPv6 loopback', 'https://[::1]/', 'non-public'],
    ['IPv4-mapped IPv6', 'https://[::ffff:127.0.0.1]/', 'non-public'],
    ['IPv4 written as a number', 'https://2130706433/', 'non-public'],
  ])('refuses %s before connecting', async (_name, url, message) => {
    const error = await safeFetch(url).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsafeUrlError);
    expect((error as Error).message).toContain(message);
  });

  it('checks the resolved address at connect time, so a public-looking name cannot reach the host', async () => {
    // `localhost` is a name, not an IP literal, so only the connect-time lookup can catch it.
    const error = await safeFetch('https://localhost:1/').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsafeUrlError);
    expect((error as Error).message).toContain('non-public');
  });

  it('passes public addresses through the lookup in both callback forms', async () => {
    const lookup = (options: { all?: boolean }) =>
      new Promise<unknown[]>((resolve) =>
        guardedLookup('localhost', { family: 4, ...options }, (err, address, family) =>
          resolve([err, address, family]),
        ),
      );
    // localhost is never public: the guard reports an error and no address.
    const [err, address] = await lookup({});
    expect(err).toBeInstanceOf(UnsafeUrlError);
    expect(address).toBe('');
    const [allErr] = await lookup({ all: true });
    expect(allErr).toBeInstanceOf(UnsafeUrlError);

    const [missing] = await new Promise<unknown[]>((resolve) =>
      guardedLookup('does-not-exist.invalid', {}, (e, a) => resolve([e, a])),
    );
    expect(missing).toBeInstanceOf(Error);
    expect(missing).not.toBeInstanceOf(UnsafeUrlError);
  });

  it('fetches with method, body and headers when private networks are allowed (dev and tests)', async () => {
    const response = await safeFetch(`${base}/token`, {
      method: 'POST',
      body: 'a=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      allowPrivateNetwork: true,
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    expect(response.headers['content-type']).toBe('application/json');
    const last = received.at(-1)!;
    expect(last).toMatchObject({ method: 'POST', body: 'a=1' });
    expect(last.headers['user-agent']).toBe('Manyplug/1.0');
  });

  it('does not follow redirects', async () => {
    const response = await safeFetch(`${base}/redirect`, { allowPrivateNetwork: true });
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('169.254.169.254');
  });

  it('stops reading a response larger than the cap', async () => {
    const error = await safeFetch(`${base}/big`, { allowPrivateNetwork: true, maxBytes: 1000 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UnsafeUrlError);
    expect((error as Error).message).toContain('larger than 1000 bytes');
  });

  it('gives up on a slow server after the timeout', async () => {
    const started = Date.now();
    const error = await safeFetch(`${base}/slow`, { allowPrivateNetwork: true, timeoutMs: 200 }).catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toContain('timed out after 200 ms');
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});
