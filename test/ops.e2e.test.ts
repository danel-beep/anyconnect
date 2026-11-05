import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import demo from '../src/connectors/builtin/demo.js';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { defineConnector } from '../src/connectors/sdk.js';
import type { Principal } from '../src/core/principal.js';
import { migrationState } from '../src/ops/builtin-checks.js';
import { enableTotp, resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

/** A service whose action crashes (a connector bug), to see what the AI, the logs and the admin get. */
const crashy = defineConnector({
  id: 'crashy',
  name: 'Crashy',
  description: 'Fails unexpectedly',
  version: '1.0.0',
  actions: (action) => [
    action({
      name: 'explode',
      description: 'Throws',
      input: z.object({}),
      hints: { readOnly: true },
      run: () => {
        throw new TypeError("Cannot read properties of undefined (reading 'id') for jane@example.com");
      },
    }),
  ],
});

describe('operations: request ids, error tracking, health checks, job runs', () => {
  let hub: TestHub;
  let principal: Principal;
  const sentry: string[] = [];

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await hub?.close();
    sentry.length = 0;
    hub = await startTestHub({
      connectors: new ConnectorRegistry().register(demo).register(crashy),
      env: { SENTRY_DSN: 'https://pub@sentry.example.com/42' },
      sentryFetch: async (_url, init) => {
        sentry.push(String(init?.body));
        return new Response('{}');
      },
    });
    hub.app.get('/boom/:id', () => {
      throw new Error('kaboom with token=abcdef123456');
    });
    const workspace = (await hub.services.db.query.workspaces.findFirst())!;
    const user = (await hub.services.db.query.users.findFirst())!;
    principal = { kind: 'api_token', userId: user.id, workspaceId: workspace.id, scopes: ['mcp'] };
    await hub.services.accounts.create(workspace.id, { connectorId: 'crashy', name: 'main', label: 'Main' });
  });

  afterAll(async () => {
    await hub?.close();
  });

  const flushErrors = () => hub.services.ops.errorStore.flush();

  it('gives every response a request id, keeping a sane one from the caller', async () => {
    const own = await fetch(`${hub.baseUrl}/healthz`, { headers: { 'x-request-id': 'trace-abc-123' } });
    expect(own.headers.get('x-request-id')).toBe('trace-abc-123');
    const fresh = await fetch(`${hub.baseUrl}/healthz`, { headers: { 'x-request-id': 'no good' } });
    expect(fresh.headers.get('x-request-id')).toMatch(/^[0-9a-f]{16}$/);
    expect(await fresh.json()).toMatchObject({ status: 'ok', version: hub.services.ops.release });
  });

  it('is ready when the database answers and the schema is current', async () => {
    const response = await fetch(`${hub.baseUrl}/readyz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', checks: { database: 'ok', migrations: 'ok' } });
    expect(await migrationState(hub.services.database.pool)).toMatchObject({ state: 'current' });
  });

  it('reports a pending migration as not ready', async () => {
    const pool = hub.services.database.pool;
    const { rows } = await pool.query(
      'select id, hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1',
    );
    await pool.query('delete from drizzle.__drizzle_migrations where id = $1', [rows[0].id]);
    try {
      const response = await fetch(`${hub.baseUrl}/readyz`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: 'unavailable', checks: { migrations: 'down' } });
    } finally {
      await pool.query(
        'insert into drizzle.__drizzle_migrations (id, hash, created_at) values ($1, $2, $3)',
        [rows[0].id, rows[0].hash, rows[0].created_at],
      );
    }
  });

  it('turns a crash in a route into a 500 with a reference, grouped and scrubbed', async () => {
    const first = await fetch(`${hub.baseUrl}/boom/usr_01j9z3k6m4q8v2w7x5y1z3a4b6`, {
      headers: { accept: 'text/html', 'x-request-id': 'req-boom-1' },
    });
    expect(first.status).toBe(500);
    const html = await first.text();
    const ref = html.match(/\b([0-9a-f]{10})\b/)?.[1];
    expect(ref).toBeDefined();
    const api = await fetch(`${hub.baseUrl}/boom/usr_01j9z3k6m4q8v2w7x5y1z3a4zz`);
    expect(await api.text()).toMatch(/^Internal error \(ref [0-9a-f]{10}\)$/);

    await flushErrors();
    const groups = await hub.services.ops.errorStore.list();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      source: 'http',
      type: 'Error',
      message: 'kaboom with token=[redacted]',
      count: 2,
      context: { method: 'GET', path: '/boom/:id' },
    });
    expect(groups[0]!.stack).not.toContain('abcdef123456');
    // The latest occurrence's ids, so a user's report can be found.
    expect(groups[0]!.lastRef).not.toBe(ref);
    await hub.services.ops.errors.flush();
    expect(sentry).toHaveLength(2);
    expect(sentry[0]).toContain('"request_id":"req-boom-1"');
    expect(sentry.join()).not.toContain('abcdef123456');
  });

  it('tells the AI about a crashed tool with a reference and records it', async () => {
    const catalog = await hub.services.hub.getCatalog(principal);
    const result = await hub.services.hub.callTool(principal, catalog, 'crashy_explode', {});
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    const ref = text.match(/ref ([0-9a-f]{10})/)?.[1];
    expect(ref).toBeDefined();
    expect(text).not.toContain('jane@example.com');
    await flushErrors();
    const [group] = await hub.services.ops.errorStore.list();
    expect(group).toMatchObject({
      source: 'tool',
      type: 'TypeError',
      lastRef: ref,
      context: { tool: 'crashy_explode', connector: 'crashy' },
    });
    expect(group!.message).toContain('[email]');
  });

  it('reopens a resolved error when it happens again', async () => {
    await fetch(`${hub.baseUrl}/boom/1`);
    await flushErrors();
    const [group] = await hub.services.ops.errorStore.list();
    await hub.services.ops.errorStore.setResolved(group!.id, true);
    expect(await hub.services.ops.errorStore.list({ status: 'open' })).toHaveLength(0);
    await fetch(`${hub.baseUrl}/boom/2`);
    await flushErrors();
    const [again] = await hub.services.ops.errorStore.list({ status: 'open' });
    expect(again).toMatchObject({ id: group!.id, count: 2, resolvedAt: null });
    expect(await hub.services.ops.errorStore.summary(new Date(Date.now() - 60_000))).toEqual({
      open: 1,
      recent: 1,
    });
  });

  it('records job runs and failures', async () => {
    const jobs = hub.services.jobs;
    await jobs.runNow('accounts.health_check');
    let runs = await hub.services.ops.jobRuns.list();
    expect(runs.find((r) => r.name === 'accounts.health_check')).toMatchObject({
      runs: 1,
      failures: 0,
      consecutiveFailures: 0,
    });

    // A job that fails: recorded on the job and in the error tracker.
    const original = hub.services.health.checkStaleAccounts;
    hub.services.health.checkStaleAccounts = async () => {
      throw new Error('upstream password=hunter2 refused');
    };
    try {
      await expect(jobs.runNow('accounts.health_check')).rejects.toThrow();
    } finally {
      hub.services.health.checkStaleAccounts = original;
    }
    runs = await hub.services.ops.jobRuns.list();
    expect(runs.find((r) => r.name === 'accounts.health_check')).toMatchObject({
      runs: 2,
      failures: 1,
      consecutiveFailures: 1,
      lastError: 'upstream password=[redacted] refused',
    });
    await flushErrors();
    const [group] = await hub.services.ops.errorStore.list();
    expect(group).toMatchObject({ source: 'job', context: { job: 'accounts.health_check' } });
  });

  it('shows errors, health checks and jobs in the admin panel', async () => {
    await fetch(`${hub.baseUrl}/boom/1`);
    await flushErrors();
    const admin = new TestBrowser(hub.baseUrl);
    await admin.login();
    await enableTotp(admin);

    const system = await admin.request('/admin/system');
    expect(system.status).toBe(200);
    const systemHtml = await system.text();
    expect(systemHtml).toContain('id="health"');
    expect(systemHtml).toContain('accounts.refresh_tokens');

    const page = await admin.request('/admin/errors');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('kaboom with token=[redacted]');
    const [group] = await hub.services.ops.errorStore.list();
    const { csrf } = TestBrowser.hiddenInputs(html);
    const resolve = await admin.request(`/admin/errors/${group!.id}/resolve`, { form: { csrf: csrf! } });
    expect(resolve.status).toBe(303);
    expect((await hub.services.ops.errorStore.get(group!.id))!.resolvedAt).not.toBeNull();
    const { rows } = await hub.services.database.pool.query(
      "select action from admin_audit_log where action like 'error.%'",
    );
    expect(rows).toEqual([{ action: 'error.resolve' }]);

    // Not for regular users, not without the CSRF token.
    const anonymous = new TestBrowser(hub.baseUrl);
    expect((await anonymous.request('/admin/errors')).status).toBe(302);
    expect(
      (await admin.request(`/admin/errors/${group!.id}/reopen`, { form: { csrf: 'nope' } })).status,
    ).toBe(403);
  });
});
