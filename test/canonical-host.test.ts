import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { canonicalHost } from '../src/routes/canonical-host.js';
import type { AppEnv } from '../src/routes/context.js';

function app() {
  const a = new Hono<AppEnv>();
  a.use('*', canonicalHost('https://manyplug.com', ['manyplug.onrender.com']));
  a.all('*', (c) => c.text('served'));
  return a;
}

const on = (host: string, path: string, init: RequestInit = {}) =>
  app().request(`https://${host}${path}`, { ...init, headers: { host, ...(init.headers ?? {}) } });

describe('canonical host redirect', () => {
  it('sends pages on a former host to the same path on the new one', async () => {
    const res = await on('manyplug.onrender.com', '/app/accounts?tab=1');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://manyplug.com/app/accounts?tab=1');
  });

  it('keeps the method for MCP and OAuth calls', async () => {
    const res = await on('manyplug.onrender.com', '/mcp', { method: 'POST', body: '{}' });
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://manyplug.com/mcp');
  });

  it('serves the canonical host and health probes as usual', async () => {
    expect((await on('manyplug.com', '/')).status).toBe(200);
    expect((await on('manyplug.onrender.com', '/healthz')).status).toBe(200);
  });
});
