import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toolCalls } from '../src/db/schema.js';
import { connectionsCheck } from '../src/ops/builtin-checks.js';
import { type CheckResult, HealthRegistry } from '../src/ops/checks.js';
import { StatusService } from '../src/ops/status.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

const MINUTE = 60_000;

describe('status page', () => {
  let hub: TestHub;
  let clock: number;
  let db: CheckResult;
  let jobs: CheckResult;
  let status: StatusService;

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await hub?.close();
    hub = await startTestHub();
    await hub.services.database.pool.query('TRUNCATE status_components, status_days, status_incidents');
    clock = Date.parse('2026-11-05T10:00:30Z');
    db = { status: 'ok' };
    jobs = { status: 'ok' };
    const health = new HealthRegistry()
      .register({
        name: 'database',
        critical: true,
        components: ['database', 'web', 'mcp'],
        run: async () => db,
      })
      .register({ name: 'jobs', critical: false, components: ['jobs'], run: async () => jobs });
    status = new StatusService({ db: hub.services.db, health, now: () => clock });
  });

  afterAll(async () => {
    await hub?.close();
  });

  const tick = async (minutes = 1) => {
    clock += minutes * MINUTE;
    return status.sample();
  };

  it('records each minute, opens and closes incidents', async () => {
    expect(await status.sample()).toEqual({ web: 'ok', mcp: 'ok', jobs: 'ok', database: 'ok' });
    // A second run in the same minute changes nothing.
    await status.sample();
    jobs = { status: 'degraded', detail: 'late: accounts.refresh_tokens' };
    await tick();
    await tick();
    jobs = { status: 'ok' };
    await tick();

    const page = await status.page();
    expect(page.overall).toBe('ok');
    expect(page.stale).toBe(false);
    const byId = Object.fromEntries(page.components.map((c) => [c.id, c]));
    expect(Object.keys(byId)).toEqual(['web', 'mcp', 'jobs', 'database']);
    expect(byId.jobs!.days).toHaveLength(90);
    expect(byId.jobs!.days.at(-1)).toEqual({ day: '2026-11-05', status: 'ok', uptime: 1 });
    expect(byId.jobs!.days[0]!.status).toBe('none');
    expect(page.incidents).toEqual([
      {
        component: 'jobs',
        status: 'degraded',
        startedAt: new Date('2026-11-05T10:01:00Z'),
        endedAt: new Date('2026-11-05T10:03:00Z'),
      },
    ]);
    const { rows } = await hub.services.database.pool.query(
      "select ok_minutes, degraded_minutes from status_days where component = 'jobs'",
    );
    expect(rows).toEqual([{ ok_minutes: 2, degraded_minutes: 2 }]);
  });

  it('keeps the worst status of an incident and shows the current one', async () => {
    await status.sample();
    db = { status: 'degraded', detail: 'slow: 1500 ms' };
    await tick();
    db = { status: 'down', detail: 'no answer' };
    await tick();
    db = { status: 'degraded' };
    await tick();
    const page = await status.page();
    expect(page.overall).toBe('degraded');
    const web = page.components.find((c) => c.id === 'web')!;
    expect(web.status).toBe('degraded');
    expect(web.note).toBeUndefined(); // internal details stay private
    expect(web.uptime).toBeCloseTo(3 / 4);
    expect(page.incidents.filter((i) => i.component === 'web')).toEqual([
      expect.objectContaining({ status: 'down', endedAt: null }),
    ]);
  });

  it('counts minutes nobody sampled as missing, as one incident, split by day', async () => {
    clock = Date.parse('2026-11-05T23:50:10Z');
    await status.sample();
    await tick(30); // 00:20 next day: the hub was not running in between
    const page = await status.page();
    const web = page.components.find((c) => c.id === 'web')!;
    // 9 unsampled minutes: some trouble that day; 20 on the next: not reachable.
    expect(web.days.at(-2)).toMatchObject({ day: '2026-11-05', status: 'degraded' });
    expect(web.days.at(-1)).toMatchObject({ day: '2026-11-06', status: 'missing' });
    const { rows } = await hub.services.database.pool.query(
      "select day::text, missing_minutes from status_days where component = 'web' order by day",
    );
    expect(rows).toEqual([
      { day: '2026-11-05', missing_minutes: 9 },
      { day: '2026-11-06', missing_minutes: 20 },
    ]);
    expect(page.incidents).toEqual([
      expect.objectContaining({
        component: 'all',
        status: 'missing',
        startedAt: new Date('2026-11-05T23:51:00Z'),
        endedAt: new Date('2026-11-06T00:20:00Z'),
      }),
    ]);
    // When sampling stops, the page says its data is old.
    clock += 10 * MINUTE;
    expect((await status.page()).stale).toBe(true);
  });

  it('forgets old history', async () => {
    await status.sample();
    clock += 401 * 86_400_000;
    await status.prune(400);
    const { rows } = await hub.services.database.pool.query('select count(*)::int as n from status_days');
    expect(rows[0].n).toBe(0);
  });

  it('flags built-in services that keep failing on their side', async () => {
    const workspace = (await hub.services.db.query.workspaces.findFirst())!;
    const row = (connectorId: string, outcome: string | null) => ({
      workspaceId: workspace.id,
      connectorId,
      toolName: `${connectorId}_x`,
      principalType: 'api_token' as const,
      status: outcome ? ('error' as const) : ('ok' as const),
      outcome,
      durationMs: 5,
    });
    await hub.services.db.insert(toolCalls).values([
      ...Array.from({ length: 4 }, () => row('gmail', 'upstream')),
      row('gmail', 'timeout'),
      row('gmail', null),
      // Slack: failures, but the user's own fault (auth), not Slack's.
      ...Array.from({ length: 6 }, () => row('slack', 'auth')),
      // A user-defined service is private: never named.
      ...Array.from({ length: 6 }, () => row('svc_private', 'upstream')),
      // Too few calls to judge.
      row('notion', 'upstream'),
    ]);
    const check = connectionsCheck({
      db: hub.services.db,
      services: () =>
        new Map([
          ['gmail', 'Gmail'],
          ['slack', 'Slack'],
          ['notion', 'Notion'],
        ]),
    });
    expect(await check.run(AbortSignal.timeout(1000))).toEqual({ status: 'degraded', detail: 'Gmail' });
  });

  it('serves the page and its JSON, with real checks through the public address', async () => {
    const empty = await fetch(`${hub.baseUrl}/status`);
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain('No status data yet');

    const sampled = await hub.services.ops.status.sample();
    expect(sampled).toMatchObject({ web: 'ok', mcp: 'ok', database: 'ok', connections: 'ok' });

    const html = await (await fetch(`${hub.baseUrl}/status`)).text();
    expect(html).toContain('All systems operational');
    expect(html).toContain('AI app connections');
    expect(html).toContain('http-equiv="refresh"');
    const json = (await (await fetch(`${hub.baseUrl}/status.json`)).json()) as {
      components: { id: string }[];
    };
    expect(json).toMatchObject({ status: 'ok', stale: false, incidents: [] });
    expect(json.components.map((c: { id: string }) => c.id)).toEqual([
      'web',
      'mcp',
      'connections',
      'jobs',
      'database',
    ]);
    expect(json.components[0]).toMatchObject({ status: 'ok', uptime30d: 1 });

    const ru = await (await fetch(`${hub.baseUrl}/status`, { headers: { cookie: 'ac_lang=ru' } })).text();
    expect(ru).toContain('Всё работает');
    expect(await (await fetch(`${hub.baseUrl}/sitemap.xml`)).text()).toContain('/status</loc>');
  });
});
