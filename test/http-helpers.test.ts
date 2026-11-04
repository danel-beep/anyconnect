import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { clientIp, safeNextPath } from '../src/web/http.js';

describe('safeNextPath', () => {
  it('keeps local paths', () => {
    expect(safeNextPath('/app/services?tab=add#x')).toBe('/app/services?tab=add#x');
    expect(safeNextPath('/oauth/authorize?client_id=a&redirect_uri=https%3A%2F%2Fclaude.ai')).toBe(
      '/oauth/authorize?client_id=a&redirect_uri=https%3A%2F%2Fclaude.ai',
    );
  });

  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    '\t//evil.example',
    '/%09/evil.example'.replace('%09', '\t'),
    'javascript:alert(1)',
    '',
    undefined,
    42,
  ])('refuses %j', (next) => {
    expect(safeNextPath(next, '/app')).toBe('/app');
  });
});

describe('clientIp', () => {
  const ipOf = async (trust: { hops: number; header?: string }, headers: Record<string, string>) => {
    const app = new Hono().get('/', (c) => c.text(clientIp(c, trust)));
    return (await app.request('/', { headers })).text();
  };

  it('takes the address the nearest trusted proxy saw, not what the client wrote', async () => {
    // Client sent "1.1.1.1"; Cloudflare appended the real client, Render the Cloudflare edge.
    const xff = { 'x-forwarded-for': '1.1.1.1, 203.0.113.7, 104.22.17.40' };
    expect(await ipOf({ hops: 2 }, xff)).toBe('203.0.113.7');
    expect(await ipOf({ hops: 1 }, { 'x-forwarded-for': '1.1.1.1, 203.0.113.7' })).toBe('203.0.113.7');
    // Fewer entries than proxies: the leftmost one.
    expect(await ipOf({ hops: 2 }, { 'x-forwarded-for': '203.0.113.7' })).toBe('203.0.113.7');
  });

  it('prefers a platform header and ignores forwarded headers when no proxy is trusted', async () => {
    expect(
      await ipOf(
        { hops: 1, header: 'cf-connecting-ip' },
        { 'cf-connecting-ip': '198.51.100.2', 'x-forwarded-for': '1.1.1.1' },
      ),
    ).toBe('198.51.100.2');
    expect(await ipOf({ hops: 0 }, { 'x-forwarded-for': '1.1.1.1' })).not.toBe('1.1.1.1');
  });
});
