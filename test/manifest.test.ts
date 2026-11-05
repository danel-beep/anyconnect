import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../src/connectors/http/client.js';
import { getPath, pickFields } from '../src/connectors/http/json-path.js';
import { TokenBucketLimiter } from '../src/connectors/http/rate-limit.js';
import { placeholders, render } from '../src/connectors/http/template.js';
import { defineManifestConnector, ManifestError } from '../src/connectors/manifest/compile.js';
import type { HttpManifestInput } from '../src/connectors/manifest/schema.js';
import { BUILTIN_PROVIDERS, validateProvider } from '../src/connectors/oauth/providers.js';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import {
  type AccountContext,
  type ConnectorDefinition,
  ConnectorError,
  type FetchLike,
  type OAuthAccess,
} from '../src/connectors/sdk.js';
import { buildCatalog } from '../src/hub/catalog.js';
import { createNetworkPolicy } from '../src/lib/network.js';

interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
}

type Handler = (req: Recorded) => Response | Promise<Response>;

function fakeFetch(handler: Handler): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (input, init) => {
    const req: Recorded = {
      method: init?.method ?? 'GET',
      url: new URL(input instanceof Request ? input.url : input.toString()),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(req);
    return handler(req);
  };
  return { fetch, calls };
}

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

function context(
  fetch: FetchLike,
  extra: Partial<AccountContext<unknown, unknown>> = {},
): AccountContext<unknown, unknown> {
  return {
    account: { id: 'acc_1', name: 'work', label: 'Work' },
    config: {},
    credentials: {},
    updateCredentials: async () => {},
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fetch,
    network: { lookup: () => {}, assertHostAllowed: () => {} },
    ...extra,
  };
}

async function run(
  connector: ConnectorDefinition,
  action: string,
  input: Record<string, unknown>,
  ctx: AccountContext<unknown, unknown>,
) {
  const definition = connector.actions.find((a) => a.name === action)!;
  const parsed = definition.input.parse(input);
  return definition.run(parsed, {
    ...ctx,
    config: connector.config.parse(ctx.config),
    credentials: connector.credentials.parse(ctx.credentials),
  });
}

const TASKS: HttpManifestInput = {
  id: 'tracker',
  name: 'Tasks',
  description: 'A fake task tracker',
  baseUrl: 'https://{{config.region}}.tasks.example/api/v1',
  config: {
    type: 'object',
    properties: { region: { type: 'string', default: 'eu', description: 'Data region' } },
  },
  auth: { type: 'api_key', in: 'header', name: 'X-Api-Key' },
  headers: { 'X-Api-Version': '2026-01' },
  errorMessagePaths: ['error.detail'],
  pagination: { type: 'cursor', param: 'after', nextPath: 'meta.next' },
  test: { request: { method: 'GET', path: '/me' }, identity: '{{response.email}}' },
  actions: [
    {
      name: 'list_tasks',
      description: 'Lists tasks of a project.',
      input: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project id' },
          done: { type: 'boolean' },
        },
        required: ['project_id'],
      },
      hints: { readOnly: true },
      request: { method: 'GET', path: '/projects/{project_id}/tasks' },
      response: { root: 'data', fields: ['id', 'title', 'due.date'] },
      pagination: true,
    },
    {
      name: 'create_task',
      description: 'Creates a task.',
      input: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1 }, priority: { type: 'integer', default: 2 } },
        required: ['title'],
      },
      request: { method: 'POST', path: '/tasks' },
      response: { root: 'data' },
    },
    {
      name: 'delete_task',
      description: 'Deletes a task.',
      input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      hints: { destructive: true },
      request: { method: 'DELETE', path: '/tasks/{id}' },
      response: { empty: 'Task deleted.' },
    },
    {
      name: 'search',
      description: 'Searches tasks with a form-encoded query.',
      input: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      request: {
        method: 'POST',
        path: '/search',
        body: { query: '{{input.q}}', owner: '{{account.name}}', unused: '{{input.missing}}' },
        bodyType: 'form',
      },
    },
  ],
};

describe('templates and JSON paths', () => {
  it('keeps types for whole placeholders and drops missing values', () => {
    const scope = { input: { n: 5, tags: ['a'], q: 'x y' }, config: { host: 'h' } };
    expect(render('{{input.n}}', scope)).toBe(5);
    expect(render({ a: '{{input.tags}}', b: '{{input.nope}}', c: 'q={{input.q}}' }, scope)).toEqual({
      a: ['a'],
      c: 'q=x y',
    });
    expect(render('https://{{config.missing}}.x', scope)).toBeUndefined();
    expect(placeholders({ a: '{{input.a}} {{config.b}}' })).toEqual(['input.a', 'config.b']);
  });

  it('reads and projects nested fields', () => {
    const data = { items: [{ id: 1, user: { name: 'A', email: 'a@x' }, big: 'x' }] };
    expect(getPath(data, 'items.0.user.email')).toBe('a@x');
    expect(pickFields(data.items, ['id', 'user.name'])).toEqual([{ id: 1, user: { name: 'A' } }]);
  });
});

describe('HTTP manifest connectors', () => {
  const connector = defineManifestConnector(TASKS);

  it('compiles into a valid connector the catalog understands', () => {
    expect(() => new ConnectorRegistry().register(connector)).not.toThrow();
    const catalog = buildCatalog({
      connectors: [connector],
      accounts: [
        {
          id: 'acc_1',
          workspaceId: 'w',
          connectorId: 'tracker',
          name: 'work',
          label: 'Work',
          description: null,
          config: {},
          dataKeyEncrypted: null,
          credentialsEncrypted: null,
          enabled: true,
          status: 'active',
          statusMessage: null,
          settings: {},
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          lastUsedAt: null,
          checkedAt: null,
          reauthNotifiedAt: null,
        },
      ],
    });
    const list = catalog.tools.find((t) => t.name === 'tracker_list_tasks')!;
    const props = list.inputSchema.properties as Record<string, { description?: string }>;
    expect(Object.keys(props)).toEqual(['account', 'project_id', 'done', 'cursor']);
    expect(props.project_id?.description).toBe('Project id');
    expect(list.annotations.readOnlyHint).toBe(true);
    expect(catalog.tools.find((t) => t.name === 'tracker_delete_task')!.annotations.destructiveHint).toBe(
      true,
    );
    // API-key auth gets a default credentials schema.
    expect(Object.keys(connector.credentials.shape)).toEqual(['apiKey']);
  });

  it('builds the request from templates, path params and the remaining input', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({
        data: [{ id: 't1', title: 'Write docs', due: { date: '2026-11-05', tz: 'UTC' }, internal: 1 }],
        meta: { next: 'abc' },
      }),
    );
    const ctx = context(fetch, { config: { region: 'us' }, credentials: { apiKey: 'k-123' } });
    const result = await run(connector, 'list_tasks', { project_id: 'p/1', done: false }, ctx);
    expect(calls[0]!.url.toString()).toBe('https://us.tasks.example/api/v1/projects/p%2F1/tasks?done=false');
    expect(calls[0]!.headers.get('x-api-key')).toBe('k-123');
    expect(calls[0]!.headers.get('x-api-version')).toBe('2026-01');
    expect(result).toEqual({
      items: [{ id: 't1', title: 'Write docs', due: { date: '2026-11-05' } }],
      nextCursor: expect.any(String),
    });

    await run(
      connector,
      'list_tasks',
      { project_id: 'p1', cursor: (result as { nextCursor: string }).nextCursor },
      ctx,
    );
    expect(calls[1]!.url.searchParams.get('after')).toBe('abc');
    expect(calls[1]!.url.searchParams.has('cursor')).toBe(false);
  });

  it('sends JSON and form bodies, and handles empty responses', async () => {
    const { fetch, calls } = fakeFetch((req) =>
      req.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ data: { id: 'new' } }),
    );
    const ctx = context(fetch, { credentials: { apiKey: 'k' } });
    expect(await run(connector, 'create_task', { title: 'Hi', extra: 'dropped' }, ctx)).toEqual({
      id: 'new',
    });
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ title: 'Hi', priority: 2 });
    expect(calls[0]!.headers.get('content-type')).toBe('application/json');

    expect(await run(connector, 'delete_task', { id: 't 1' }, ctx)).toBe('Task deleted.');
    expect(calls[1]!.url.pathname).toBe('/api/v1/tasks/t%201');

    await run(connector, 'search', { q: 'a&b' }, ctx);
    expect(calls[2]!.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(calls[2]!.body).toBe('query=a%26b&owner=work');
  });

  it('maps HTTP errors to connector errors with the service message', async () => {
    const statuses: Response[] = [
      json({ error: { detail: 'Project p1 does not exist' } }, { status: 404 }),
      json({ error: { detail: 'Slow down' } }, { status: 429, headers: { 'retry-after': '120' } }),
      json({ error: { detail: 'Bad key' } }, { status: 401 }),
      new Response('<html>oops</html>', { status: 400, headers: { 'content-type': 'text/html' } }),
    ];
    const { fetch } = fakeFetch(() => statuses.shift()!);
    const ctx = context(fetch, { credentials: { apiKey: 'k' } });
    const attempt = () => run(connector, 'list_tasks', { project_id: 'p1' }, ctx).catch((e) => e);
    const notFound = await attempt();
    expect(notFound).toBeInstanceOf(ConnectorError);
    expect(notFound).toMatchObject({ kind: 'not_found', message: 'Project p1 does not exist' });
    expect(await attempt()).toMatchObject({ kind: 'rate_limited', options: { retryAfterSeconds: 120 } });
    expect(await attempt()).toMatchObject({ kind: 'auth', message: 'Bad key' });
    // HTML error pages are not shown to the AI.
    expect(await attempt()).toMatchObject({
      kind: 'invalid_input',
      message: 'The service answered HTTP 400',
    });
  });

  it('retries idempotent requests once on 503 and short 429s', async () => {
    const answers = [
      new Response('busy', { status: 503, headers: { 'retry-after': '0' } }),
      json({ data: [], meta: {} }),
    ];
    const { fetch, calls } = fakeFetch(() => answers.shift()!);
    const result = await run(
      connector,
      'list_tasks',
      { project_id: 'p1' },
      context(fetch, { credentials: { apiKey: 'k' } }),
    );
    expect(calls).toHaveLength(2);
    expect(result).toEqual({ items: [] });
  });

  it('refuses a missing API key before calling the service', async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    const definition = connector.actions.find((a) => a.name === 'create_task')!;
    const error = await Promise.resolve(
      definition.run(
        { title: 'x', priority: 1 },
        context(fetch, { config: { region: 'eu' }, credentials: {} }),
      ),
    ).catch((e) => e);
    expect(error).toMatchObject({ kind: 'auth' });
    expect(calls).toHaveLength(0);
  });

  it('runs the connection test and extracts the identity', async () => {
    const { fetch } = fakeFetch(() => json({ email: 'me@example.com' }));
    const result = await connector.test!(
      context(fetch, { config: { region: 'eu' }, credentials: { apiKey: 'k' } }),
    );
    expect(result).toEqual({ ok: true, identity: 'me@example.com' });
  });

  it('uses the OAuth token, refreshes it once on 401 and retries', async () => {
    const oauthConnector = defineManifestConnector({
      id: 'oauthy',
      name: 'OAuthy',
      description: 'OAuth service',
      baseUrl: 'https://api.oauthy.example',
      auth: { type: 'oauth2', provider: 'github', scopes: ['repo'] },
      actions: [{ name: 'me', description: 'Who am I', request: { method: 'GET', path: '/user' } }],
    });
    expect(oauthConnector.oauth).toEqual({ provider: 'github', scopes: ['repo'] });
    let token = 'old';
    const oauth: OAuthAccess = {
      get accessToken() {
        return token;
      },
      tokenType: 'Bearer',
      scopes: ['repo'],
      extra: {},
      refresh: async () => {
        token = 'new';
        return token;
      },
    };
    const { fetch, calls } = fakeFetch((req) =>
      req.headers.get('authorization') === 'Bearer new' ? json({ login: 'octo' }) : json({}, { status: 401 }),
    );
    expect(await run(oauthConnector, 'me', {}, context(fetch, { oauth }))).toEqual({ login: 'octo' });
    expect(calls.map((c) => c.headers.get('authorization'))).toEqual(['Bearer old', 'Bearer new']);

    const unconnected = await Promise.resolve(oauthConnector.actions[0]!.run({}, context(fetch))).catch(
      (e) => e,
    );
    expect(unconnected).toMatchObject({ kind: 'auth' });
  });

  it('supports page, offset and Link-header pagination', async () => {
    const paged = defineManifestConnector({
      id: 'paged',
      name: 'Paged',
      description: 'Pagination styles',
      baseUrl: 'https://api.paged.example',
      actions: [
        {
          name: 'pages',
          description: 'Page numbers',
          request: { method: 'GET', path: '/p' },
          response: { root: 'items' },
          pagination: { type: 'page', param: 'page', start: 1 },
        },
        {
          name: 'offsets',
          description: 'Offsets',
          input: { type: 'object', properties: { limit: { type: 'integer', default: 2 } } },
          request: { method: 'GET', path: '/o' },
          pagination: { type: 'offset', param: 'offset', limitParam: 'limit' },
        },
        {
          name: 'links',
          description: 'Link header',
          request: { method: 'GET', path: '/l' },
          pagination: { type: 'link' },
        },
      ],
    });
    const { fetch, calls } = fakeFetch((req) => {
      if (req.url.pathname === '/p')
        return json({ items: req.url.searchParams.get('page') === '1' ? [1, 2] : [] });
      if (req.url.pathname === '/o') return json([1, 2]);
      return json([1], {
        headers: {
          link: '<https://api.paged.example/l?page=2>; rel="next", <https://api.paged.example/l?page=9>; rel="last"',
        },
      });
    });
    const ctx = context(fetch);
    const first = (await run(paged, 'pages', {}, ctx)) as { items: number[]; nextCursor?: string };
    expect(calls[0]!.url.searchParams.get('page')).toBe('1');
    const second = (await run(paged, 'pages', { cursor: first.nextCursor }, ctx)) as { nextCursor?: string };
    expect(calls[1]!.url.searchParams.get('page')).toBe('2');
    expect(second.nextCursor).toBeUndefined();

    const offset = (await run(paged, 'offsets', {}, ctx)) as { nextCursor?: string };
    await run(paged, 'offsets', { cursor: offset.nextCursor }, ctx);
    expect(calls[3]!.url.searchParams.get('offset')).toBe('2');

    const linked = (await run(paged, 'links', {}, ctx)) as { nextCursor: string };
    await run(paged, 'links', { cursor: linked.nextCursor }, ctx);
    expect(calls[5]!.url.toString()).toBe('https://api.paged.example/l?page=2');

    // A crafted cursor pointing at another origin is refused: credentials never leave the API.
    const evil = Buffer.from(JSON.stringify({ v: 'https://evil.example/steal' })).toString('base64url');
    await expect(run(paged, 'links', { cursor: evil }, ctx)).rejects.toMatchObject({ kind: 'invalid_input' });
  });

  it('rejects invalid manifests with precise messages', () => {
    const base = { id: 'bad', name: 'Bad', description: 'x', baseUrl: 'https://x.example' };
    expect(() =>
      defineManifestConnector({
        ...base,
        actions: [{ name: 'get', description: 'x', request: { method: 'GET', path: '/items/{id}' } }],
      }),
    ).toThrow(/path parameter \{id\} is not an input/);
    expect(() =>
      defineManifestConnector({
        ...base,
        actions: [
          { name: 'list', description: 'x', request: { method: 'GET', path: '/' }, pagination: true },
        ],
      }),
    ).toThrow(ManifestError);
    expect(() =>
      defineManifestConnector({
        ...base,
        actions: [{ name: 'Bad-Name', description: 'x', request: { method: 'GET', path: '/' } }],
      }),
    ).toThrow(/actions.0.name/);
    const withAccount = defineManifestConnector({
      ...base,
      actions: [
        {
          name: 'get',
          description: 'x',
          input: { type: 'object', properties: { account: { type: 'string' } } },
          request: { method: 'GET', path: '/' },
        },
      ],
    });
    expect(() => new ConnectorRegistry().register(withAccount)).toThrow(/must not define an "account" input/);
  });

  it('declares risk, undo and capabilities with template mappings', async () => {
    const base = { id: 'todo', name: 'Todo', description: 'x', baseUrl: 'https://todo.example' };
    const todo = defineManifestConnector({
      ...base,
      actions: [
        {
          name: 'search',
          description: 'Finds tasks',
          input: { type: 'object', properties: { text: { type: 'string' }, max: { type: 'number' } } },
          hints: { readOnly: true },
          request: { method: 'GET', path: '/tasks' },
          capability: {
            id: 'tasks.list',
            input: { text: '{{input.query}}', max: '{{input.limit}}' },
            output: {
              id: '{{item.gid}}',
              title: '{{item.name}}',
              url: 'https://todo.example/t/{{item.gid}}',
            },
          },
        },
        {
          name: 'add',
          description: 'Adds a task',
          input: { type: 'object', properties: { name: { type: 'string' } } },
          request: { method: 'POST', path: '/tasks' },
          risk: 'write',
          undo: { kind: 'action', action: 'remove' },
          capability: 'tasks.create',
        },
        {
          name: 'remove',
          description: 'Deletes a task',
          input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          request: { method: 'DELETE', path: '/tasks/{id}' },
          risk: 'dangerous',
          undo: { kind: 'none' },
        },
      ],
    });
    expect(() => new ConnectorRegistry().register(todo)).not.toThrow();
    const [search, add, remove] = todo.actions;
    expect(add).toMatchObject({ risk: 'write', undo: { kind: 'action', action: 'remove' } });
    expect(remove!.risk).toBe('dangerous');
    expect(add!.capability).toEqual([{ id: 'tasks.create' }]);

    const [binding] = search!.capability as unknown as {
      mapInput: (...args: unknown[]) => unknown;
      mapOutput: (...args: unknown[]) => unknown;
    }[];
    expect(binding!.mapInput({ query: 'milk', limit: 5, status: 'open' })).toEqual({ text: 'milk', max: 5 });
    const items = [{ gid: '7', name: 'Buy milk', extra: true }];
    const mapped = [{ id: '7', title: 'Buy milk', url: 'https://todo.example/t/7' }];
    expect(binding!.mapOutput(items, {})).toEqual(mapped);
    expect(binding!.mapOutput({ items, nextCursor: 'c' }, {})).toEqual({ items: mapped, nextCursor: 'c' });

    // Mistakes are caught when the connector is built or registered.
    const action = { name: 'a', description: 'x', request: { method: 'GET' as const, path: '/' } };
    expect(() =>
      defineManifestConnector({
        ...base,
        actions: [{ ...action, capability: { id: 'tasks.create', input: { t: '{{credentials.key}}' } } }],
      }),
    ).toThrow(/placeholder \{\{credentials.key\}\} must start with input/);
    const unknown = defineManifestConnector({ ...base, actions: [{ ...action, capability: 'tasks.fly' }] });
    expect(() => new ConnectorRegistry().register(unknown)).toThrow(/unknown capability "tasks.fly"/);
    const wrongRisk = defineManifestConnector({
      ...base,
      actions: [{ ...action, capability: 'tasks.list' }],
    });
    expect(() => new ConnectorRegistry().register(wrongRisk)).toThrow(/capability "tasks.list" is read-only/);
    const badUndo = defineManifestConnector({
      ...base,
      actions: [{ ...action, undo: { kind: 'action', action: 'nope' } }],
    });
    expect(() => new ConnectorRegistry().register(badUndo)).toThrow(/unknown undo action "nope"/);
    expect(() =>
      defineManifestConnector({ ...base, actions: [{ ...action, risk: 'scary' as never }] }),
    ).toThrow(/actions.0.risk/);
  });
});

describe('HTTP client helpers', () => {
  it('rate limits per key: short waits are absorbed, long ones become rate_limited', async () => {
    const limiter = new TokenBucketLimiter({ maxWaitMs: 50 });
    const limit = { requests: 2, perSeconds: 60 };
    await limiter.acquire('a', limit);
    await limiter.acquire('a', limit);
    await expect(limiter.acquire('a', limit)).rejects.toMatchObject({ kind: 'rate_limited' });
    await limiter.acquire('b', limit); // other accounts are not affected
  });

  it('turns network failures into upstream errors', async () => {
    const client = new HttpClient(
      context(async () => {
        throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
      }),
    );
    await expect(client.post('https://x.example/a', {})).rejects.toMatchObject({
      kind: 'upstream',
      message: 'Could not reach the service: ECONNREFUSED',
    });
  });
});

describe('OAuth providers', () => {
  it('are all valid', () => {
    for (const provider of Object.values(BUILTIN_PROVIDERS))
      expect(() => validateProvider(provider)).not.toThrow();
  });

  it('are checked when a connector is registered', () => {
    const connector = defineManifestConnector({
      id: 'unknownprov',
      name: 'X',
      description: 'x',
      baseUrl: 'https://x.example',
      auth: { type: 'oauth2', provider: 'nope', scopes: [] },
      actions: [{ name: 'a', description: 'x', request: { method: 'GET', path: '/' } }],
    });
    expect(() => new ConnectorRegistry().register(connector)).toThrow(/Unknown OAuth provider "nope"/);
  });
});

describe('network policy', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('blocks private addresses unless allowed', async () => {
    const strict = createNetworkPolicy({ allowPrivateNetwork: false });
    const open = createNetworkPolicy({ allowPrivateNetwork: true });
    try {
      const error = await strict.fetch(url).catch((e) => e);
      expect(String(error.cause?.message ?? error.message)).toMatch(/private address/);
      expect(() => strict.assertHostAllowed('10.1.2.3')).toThrow(ConnectorError);
      expect(() => strict.assertHostAllowed('example.com')).not.toThrow();
      const ok = await open.fetch(url);
      expect(await ok.json()).toEqual({ ok: true });

      // Through the HTTP client the policy error surfaces as a connector error.
      const client = new HttpClient(context(strict.fetch));
      await expect(client.get(url)).rejects.toMatchObject({ kind: 'permission' });
    } finally {
      await strict.close();
      await open.close();
    }
  });
});
