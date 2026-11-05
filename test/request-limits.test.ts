import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { RateLimiter, rateLimitIp } from '../src/lib/rate-limit.js';
import { SMALL_BODY_BYTES } from '../src/routes/body-limit.js';
import { ADMIN, resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

describe('rate limiter', () => {
  it('counts IPv6 clients by /64 and IPv4 clients by address', () => {
    expect(rateLimitIp('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitIp('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitIp('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(rateLimitIp('2001:0db8:0001:0002::5')).toBe('2001:db8:1:2::/64');
    expect(rateLimitIp('[2001:db8::1]')).toBe('2001:db8:0:0::/64');
    expect(rateLimitIp('unknown')).toBe('unknown');
  });

  it('keeps memory bounded whatever keys clients send', () => {
    const limiter = new RateLimiter(100);
    try {
      for (let i = 0; i < 1000; i++) limiter.consume(`login:email:${'x'.repeat(10_000)}${i}`, 10, 60_000);
      expect(limiter.size).toBeLessThanOrEqual(100);
      // A long key still counts as itself.
      const key = `login:email:${'y'.repeat(10_000)}`;
      for (let i = 0; i < 3; i++) limiter.consume(key, 3, 60_000);
      expect(limiter.consume(key, 3, 60_000).allowed).toBe(false);
      limiter.reset(key);
      expect(limiter.consume(key, 3, 60_000).allowed).toBe(true);
    } finally {
      limiter.close();
    }
  });
});

/** Posts `size` bytes with a Content-Length and resolves with the status (the hub answers before reading). */
function post(url: string, size: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(size) },
    });
    request.on('response', (response) => {
      response.resume();
      resolve(response.statusCode!);
    });
    request.on('error', reject);
    // Only the headers: the declared length alone is refused.
    request.flushHeaders();
  });
}

/** A body streamed in 64 KB chunks without a length, as `fetch` sends a ReadableStream. */
function streamed(size: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(64 * 1024).fill(97);
  let left = size;
  return new ReadableStream({
    pull(controller) {
      if (left <= 0) return controller.close();
      const part = chunk.subarray(0, Math.min(left, chunk.length));
      left -= part.length;
      controller.enqueue(part);
    },
  });
}

describe('request limits', () => {
  let hub: TestHub;
  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ env: { MAX_REQUEST_BODY_MB: '1', TRUST_PROXY: '1' } });
  });
  afterAll(async () => {
    await hub?.close();
  });

  it('rejects oversized bodies before reading them, with or without Content-Length', async () => {
    // Sign-in and OAuth endpoints take small bodies only, the rest up to MAX_REQUEST_BODY_MB.
    expect(await post(`${hub.baseUrl}/oauth/register`, SMALL_BODY_BYTES + 1)).toBe(413);
    expect(await post(`${hub.baseUrl}/api/v1/accounts`, 1024 * 1024 + 1)).toBe(413);

    // A body streamed without a length is counted while it arrives.
    const app = createApp(hub.services);
    const send = (path: string, size: number) =>
      app.fetch(
        new Request(`${hub.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' },
          body: streamed(size),
          duplex: 'half',
        } as RequestInit),
      );
    expect((await send('/login', SMALL_BODY_BYTES + 1)).status).toBe(413);
    const mcp = await send('/mcp', 1024 * 1024 + 1);
    expect(mcp.status).toBe(413);
    expect(await mcp.json()).toMatchObject({ error: { code: 'payload_too_large' } });

    // Normal requests are untouched.
    const small = await fetch(`${hub.baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'ok', redirect_uris: ['https://app.example/cb'] }),
    });
    expect(small.status).toBe(201);
  });

  it('does not let a blocked address use up the attempts of an account', async () => {
    const attacker = new TestBrowser(hub.baseUrl);
    const attempt = async (browser: TestBrowser, ip: string, email: string, password: string) => {
      const page = await browser.request('/login');
      const hidden = TestBrowser.hiddenInputs(await page.text());
      const response = await fetch(new URL('/login', hub.baseUrl), {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: hub.baseUrl,
          'x-forwarded-for': ip,
          cookie: ['ac_csrf', '__Host-ac_csrf']
            .filter((name) => browser.cookie(name))
            .map((name) => `${name}=${browser.cookie(name)}`)
            .join('; '),
        },
        body: new URLSearchParams({ ...hidden, email, password }).toString(),
      });
      return response.status;
    };
    // The attacker's whole /64 runs out of attempts…
    for (let i = 0; i < 20; i++) await attempt(attacker, `2001:db8:7:7::${i + 1}`, `n${i}@x.example`, 'nope');
    expect(await attempt(attacker, '2001:db8:7:7::99', ADMIN.email, 'nope')).toBe(429);
    for (let i = 0; i < 15; i++) await attempt(attacker, '2001:db8:7:7::1', ADMIN.email, 'nope');
    // …while the owner, from elsewhere, still signs in.
    const owner = new TestBrowser(hub.baseUrl);
    expect(await attempt(owner, '198.51.100.20', ADMIN.email, ADMIN.password)).toBe(303);
  });
});
