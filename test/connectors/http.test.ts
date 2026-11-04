import { describe, expect, it } from 'vitest';
import http, { resolveWithinBase } from '../../src/connectors/builtin/http.js';
import { fakeHttp, json, testAccount } from './harness.js';

const BASE = 'https://api.example.test/v2';

function account(
  config: Record<string, unknown> = {},
  credentials: Record<string, unknown> = { token: 's3cret' },
) {
  const service = fakeHttp((req) => {
    if (req.method === 'POST') {
      return json({ id: 99, ...JSON.parse(req.body ?? '{}') }, { status: 201 });
    }
    if (req.url.pathname === '/v2/users') {
      return json(
        {
          data: Array.from({ length: 50 }, (_, i) => ({
            id: i + 1,
            name: `User ${i + 1}`,
            bio: 'x'.repeat(200),
          })),
          meta: { next: 'abc' },
        },
        { headers: { link: '<https://api.example.test/v2/users?page=2>; rel="next"' } },
      );
    }
    if (req.url.pathname === '/v2/users/1' && req.method === 'GET')
      return json({ id: 1, name: 'Ann', team: { id: 7, name: 'Core' } });
    if (req.url.pathname === '/v2/text')
      return new Response('plain answer', { headers: { 'content-type': 'text/plain' } });
    if (req.url.pathname === '/v2/missing')
      return json({ error: { message: 'No such thing' } }, { status: 404 });
    if (req.url.pathname === '/v2/private') return json({ message: 'Bad token' }, { status: 401 });
    return new Response(null, { status: 204 });
  });
  return {
    service,
    acc: testAccount(http, { config: { baseUrl: BASE, ...config }, credentials, fetch: service.fetch }),
  };
}

describe('http connector', () => {
  it('keeps every request under the base URL', () => {
    expect(resolveWithinBase(BASE, '/users/1')).toBe('https://api.example.test/v2/users/1');
    expect(resolveWithinBase(`${BASE}/`, 'users?x=1')).toBe('https://api.example.test/v2/users?x=1');
    for (const bad of [
      'https://evil.test/x',
      '//evil.test/x',
      '../v1/admin',
      '/../../etc',
      'javascript:alert(1)',
    ]) {
      expect(() => resolveWithinBase(BASE, bad), bad).toThrow(/relative|stay under/);
    }
  });

  it('GETs with bearer auth, query and field selection', async () => {
    const { acc, service } = account();
    const result = (await acc.run('get', {
      path: '/users/1',
      query: { expand: 'team' },
      fields: ['name', 'team.name'],
    })) as Record<string, unknown>;
    expect(result).toEqual({ status: 200, data: { name: 'Ann', team: { name: 'Core' } } });
    expect(service.calls[0]!.headers.get('authorization')).toBe('Bearer s3cret');
    expect(service.calls[0]!.url.searchParams.get('expand')).toBe('team');
  });

  it('supports header, query and basic auth', async () => {
    const header = account({ auth: 'header', authName: 'X-Token' });
    await header.acc.run('get', { path: '/users/1' });
    expect(header.service.calls[0]!.headers.get('x-token')).toBe('s3cret');
    expect(header.service.calls[0]!.headers.get('authorization')).toBeNull();
    const query = account({ auth: 'query' });
    await query.acc.run('get', { path: '/users/1' });
    expect(query.service.calls[0]!.url.searchParams.get('api_key')).toBe('s3cret');
    const basic = account({ auth: 'basic' }, { username: 'u', password: 'p' });
    await basic.acc.run('get', { path: '/users/1' });
    expect(basic.service.calls[0]!.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('u:p').toString('base64')}`,
    );
  });

  it('cuts large arrays to whole items and keeps paging headers', async () => {
    const { acc } = account();
    const result = (await acc.run('get', { path: '/users', root: 'data', maxChars: 2000 })) as {
      data: unknown[];
      truncated: { shownItems: number; totalItems: number };
      headers: Record<string, string>;
    };
    expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(2000);
    expect(result.truncated.totalItems).toBe(50);
    expect(result.truncated.shownItems).toBe(result.data.length);
    expect(result.headers.link).toContain('rel="next"');
    const small = (await acc.run('get', { path: '/users', root: 'data', fields: ['id'] })) as {
      data: unknown[];
      truncated?: unknown;
    };
    expect(small.data).toHaveLength(50);
    expect(small.truncated).toBeUndefined();
  });

  it('sends JSON bodies for writes and returns text responses as text', async () => {
    const { acc, service } = account();
    const created = (await acc.run('request', {
      method: 'POST',
      path: '/users',
      body: { name: 'Bob' },
    })) as Record<string, unknown>;
    expect(created).toEqual({ status: 201, data: { id: 99, name: 'Bob' } });
    expect(service.calls[0]!.headers.get('content-type')).toBe('application/json');
    const text = (await acc.run('get', { path: '/text' })) as Record<string, unknown>;
    expect(text).toEqual({ status: 200, headers: { 'content-type': 'text/plain' }, data: 'plain answer' });
  });

  it('maps service errors to connector errors with the service message', async () => {
    const { acc } = account();
    await expect(acc.run('get', { path: '/missing' })).rejects.toMatchObject({
      kind: 'not_found',
      message: 'No such thing',
    });
    await expect(acc.run('get', { path: '/private' })).rejects.toMatchObject({ kind: 'auth' });
    await expect(acc.run('get', { path: 'https://evil.test/' })).rejects.toMatchObject({
      kind: 'invalid_input',
    });
  });

  it('asks for a token when none is saved', async () => {
    const { acc } = account({}, {});
    await expect(acc.run('get', { path: '/users/1' })).rejects.toMatchObject({ kind: 'auth' });
  });
});
