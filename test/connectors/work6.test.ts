import { describe, expect, it } from 'vitest';
import harvest from '../../src/connectors/builtin/harvest.js';
import netlify from '../../src/connectors/builtin/netlify.js';
import pagerduty from '../../src/connectors/builtin/pagerduty.js';
import postmark from '../../src/connectors/builtin/postmark.js';
import toggl from '../../src/connectors/builtin/toggl.js';
import twilio from '../../src/connectors/builtin/twilio.js';
import { fakeRoutes, json, type RecordedRequest, testAccount } from './harness.js';

// Sixth catalogue batch. Fixtures follow the documented response shapes of each API, trimmed.

const body = (req: RecordedRequest) => JSON.parse(req.body!);
const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

describe('twilio', () => {
  // Built at runtime so secret scanners do not mistake the fixture for a real SID.
  const sid = `AC${'0'.repeat(32)}`;
  const base = `/2010-04-01/Accounts/${sid}`;
  const message = {
    sid: `SM${'1'.repeat(32)}`,
    from: '+14155550100',
    to: '+14155550123',
    body: 'The courier arrives at 3 pm.',
    status: 'delivered',
    direction: 'outbound-api',
    date_sent: 'Wed, 04 Nov 2026 15:00:00 +0000',
    error_message: null,
    price: '-0.0079',
  };
  const service = fakeRoutes({
    [`GET ${base}/IncomingPhoneNumbers.json`]: { incoming_phone_numbers: [], next_page_uri: null },
    [`GET ${base}/Messages.json`]: (req) =>
      json({
        messages: [message],
        next_page_uri: req.url.searchParams.get('Page')
          ? null
          : `${base}/Messages.json?PageSize=20&Page=1&PageToken=PASM01`,
      }),
    [`POST ${base}/Messages.json`]: { ...message, status: 'queued' },
  });
  const acc = testAccount(twilio, {
    config: { accountSid: sid },
    credentials: { authToken: 'f'.repeat(32) },
    fetch: service.fetch,
  });

  it('signs in with the account SID and auth token', async () => {
    expect(await twilio.test!(acc.ctx as never)).toMatchObject({ ok: true });
    expect(service.calls.at(-1)!.headers.get('authorization')).toBe(basic(sid, 'f'.repeat(32)));
  });

  it('sends SMS as a form and keeps it dangerous', async () => {
    expect(twilio.actions.find((a) => a.name === 'send_sms')!.risk).toBe('dangerous');
    const sent = await acc.run('send_sms', {
      to: '+14155550123',
      from: '+14155550100',
      body: 'The courier arrives at 3 pm.',
    });
    expect(sent).toMatchObject({ sid: message.sid, status: 'queued' });
    const call = service.calls.at(-1)!;
    expect(call.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(call.body!))).toEqual({
      To: '+14155550123',
      From: '+14155550100',
      Body: 'The courier arrives at 3 pm.',
    });
  });

  it('follows the relative next page link on the API origin', async () => {
    const first = (await acc.run('list_messages', { to: '+14155550123' })) as {
      items: Record<string, unknown>[];
      nextCursor?: string;
    };
    expect(service.calls.at(-1)!.url.searchParams.get('To')).toBe('+14155550123');
    expect(first.items[0]).not.toHaveProperty('price');
    const second = (await acc.run('list_messages', { cursor: first.nextCursor })) as { nextCursor?: string };
    const call = service.calls.at(-1)!;
    expect(call.url.host).toBe('api.twilio.com');
    expect(call.url.searchParams.get('PageToken')).toBe('PASM01');
    expect(second.nextCursor).toBeUndefined();
  });
});

describe('postmark', () => {
  const service = fakeRoutes({
    'GET /server': { ID: 1, Name: 'ACME transactional' },
    'POST /email/withTemplate': (req) =>
      json({
        To: body(req).To,
        SubmittedAt: '2026-11-04T15:00:00Z',
        MessageID: 'm-1',
        ErrorCode: 0,
        Message: 'OK',
      }),
    'GET /messages/outbound': (req) =>
      json({
        TotalCount: 3,
        Messages: Array.from({ length: Number(req.url.searchParams.get('count')) }, (_, i) => ({
          MessageID: `m-${i}`,
          To: [{ Email: 'ben@acme.com' }],
          Subject: 'Reset your password',
          Status: 'Sent',
          ReceivedAt: '2026-11-04T15:00:00Z',
          TextBody: 'long body the AI does not need',
        })),
      }),
  });
  const acc = testAccount(postmark, {
    credentials: { token: 'server-token-0123456789' },
    fetch: service.fetch,
  });

  it('uses the server token header and names the server', async () => {
    expect(await postmark.test!(acc.ctx as never)).toMatchObject({
      ok: true,
      identity: 'ACME transactional',
    });
    expect(service.calls.at(-1)!.headers.get('x-postmark-server-token')).toBe('server-token-0123456789');
  });

  it('sends templates with their model and the default stream', async () => {
    expect(postmark.actions.find((a) => a.name === 'send_template')!.risk).toBe('dangerous');
    await acc.run('send_template', {
      template_id: 42,
      from: 'billing@acme.com',
      to: 'ann@acme.com',
      model: { amount: '$120' },
    });
    expect(body(service.calls.at(-1)!)).toEqual({
      TemplateId: 42,
      TemplateModel: { amount: '$120' },
      From: 'billing@acme.com',
      To: 'ann@acme.com',
      MessageStream: 'outbound',
    });
  });

  it('pages sent messages by offset and trims bodies', async () => {
    const first = (await acc.run('search_messages', { recipient: 'ben@acme.com', count: 2 })) as {
      items: Record<string, unknown>[];
      nextCursor?: string;
    };
    expect(first.items).toHaveLength(2);
    expect(first.items[0]).not.toHaveProperty('TextBody');
    await acc.run('search_messages', { recipient: 'ben@acme.com', count: 2, cursor: first.nextCursor });
    const query = service.calls.at(-1)!.url.searchParams;
    expect(query.get('offset')).toBe('2');
    expect(query.get('recipient')).toBe('ben@acme.com');
  });
});

describe('pagerduty', () => {
  const incident = {
    id: 'PT4KHLK',
    incident_number: 1234,
    title: 'Database is down',
    status: 'triggered',
    urgency: 'high',
    created_at: '2026-11-04T15:00:00Z',
    service: { id: 'PIJ90N7', summary: 'Database', self: 'https://api.pagerduty.com/services/PIJ90N7' },
    assignments: [],
    html_url: 'https://acme.pagerduty.com/incidents/PT4KHLK',
  };
  const service = fakeRoutes({
    'GET /services': { services: [], limit: 1, offset: 0, more: false },
    'GET /incidents': { incidents: [incident], limit: 25, offset: 0, more: false },
    'PUT /incidents/PT4KHLK': (req) => json({ incident: { ...incident, status: body(req).incident.status } }),
    'POST /incidents': (req) =>
      json({ incident: { ...incident, title: body(req).incident.title } }, { status: 201 }),
  });
  const acc = testAccount(pagerduty, {
    config: { host: 'api.eu.pagerduty.com', fromEmail: 'ann@acme.com' },
    credentials: { apiKey: 'u+abcdefghij0123456789' },
    fetch: service.fetch,
  });

  it('sends the token, API version and From headers to the account region', async () => {
    expect(await pagerduty.test!(acc.ctx as never)).toMatchObject({ ok: true });
    const call = service.calls.at(-1)!;
    expect(call.url.host).toBe('api.eu.pagerduty.com');
    expect(call.headers.get('authorization')).toBe('Token token=u+abcdefghij0123456789');
    expect(call.headers.get('accept')).toBe('application/vnd.pagerduty+json;version=2');
    expect(call.headers.get('from')).toBe('ann@acme.com');
  });

  it('leaves the From header out when no user email is set', async () => {
    const noFrom = fakeRoutes({ 'GET /services': { services: [] } });
    const other = testAccount(pagerduty, {
      credentials: { apiKey: 'u+abcdefghij0123456789' },
      fetch: noFrom.fetch,
    });
    await pagerduty.test!(other.ctx as never);
    expect(noFrom.calls[0]!.headers.has('from')).toBe(false);
    expect(noFrom.calls[0]!.url.host).toBe('api.pagerduty.com');
  });

  it('lists open incidents with array filters', async () => {
    const result = (await acc.run('list_incidents', {})) as { items: Record<string, unknown>[] };
    expect(service.calls.at(-1)!.url.searchParams.getAll('statuses[]')).toEqual([
      'triggered',
      'acknowledged',
    ]);
    expect(result.items[0]).toMatchObject({ id: 'PT4KHLK', service: { summary: 'Database' } });
  });

  it('acknowledges by reference and opens incidents as a dangerous action', async () => {
    await acc.run('set_status', { id: 'PT4KHLK', status: 'acknowledged' });
    expect(body(service.calls.at(-1)!)).toEqual({
      incident: { type: 'incident_reference', status: 'acknowledged' },
    });
    expect(pagerduty.actions.find((a) => a.name === 'create_incident')!.risk).toBe('dangerous');
    await acc.run('create_incident', {
      service_id: 'PIJ90N7',
      title: 'Checkout errors',
      details: '5xx spike',
    });
    expect(body(service.calls.at(-1)!)).toEqual({
      incident: {
        type: 'incident',
        title: 'Checkout errors',
        service: { id: 'PIJ90N7', type: 'service_reference' },
        body: { type: 'incident_body', details: '5xx spike' },
      },
    });
  });
});

describe('netlify', () => {
  const service = fakeRoutes({
    'GET /api/v1/user': { id: 'u', email: 'ann@acme.com' },
    'GET /api/v1/sites/acme.netlify.app/deploys': (req) =>
      json(
        req.url.searchParams.get('page') === '2'
          ? []
          : [
              {
                id: 'd1',
                state: 'error',
                error_message: 'Build script returned non-zero exit code: 2',
                branch: 'main',
              },
            ],
      ),
    'POST /api/v1/sites/acme.netlify.app/builds': { id: 'b1', deploy_id: 'd2', done: false },
    'POST /api/v1/sites/acme.netlify.app/deploys/d1/restore': { id: 'd1', state: 'ready' },
  });
  const acc = testAccount(netlify, {
    credentials: { token: 'nfp_0123456789abcdefghij' },
    fetch: service.fetch,
  });

  it('lists deploys page by page', async () => {
    expect(await netlify.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    const first = (await acc.run('list_deploys', { site_id: 'acme.netlify.app' })) as {
      items: unknown[];
      nextCursor?: string;
    };
    expect(first.items[0]).toMatchObject({ state: 'error', branch: 'main' });
    const second = (await acc.run('list_deploys', {
      site_id: 'acme.netlify.app',
      cursor: first.nextCursor,
    })) as {
      nextCursor?: string;
    };
    expect(second.nextCursor).toBeUndefined();
  });

  it('starts builds and keeps publishing an old deploy dangerous', async () => {
    await acc.run('start_build', { site_id: 'acme.netlify.app', clear_cache: true });
    expect(body(service.calls.at(-1)!)).toEqual({ clear_cache: true });
    expect(netlify.actions.find((a) => a.name === 'publish_deploy')!.risk).toBe('dangerous');
    expect(await acc.run('publish_deploy', { site_id: 'acme.netlify.app', deploy_id: 'd1' })).toMatchObject({
      state: 'ready',
    });
  });
});

describe('harvest', () => {
  const entry = {
    id: 636709355,
    spent_date: '2026-11-04',
    hours: 0,
    notes: 'Design',
    is_running: true,
    billable: true,
    project: { id: 14308069, name: 'ACME website', code: 'ACME' },
    task: { id: 8083365, name: 'Design' },
    client: { id: 5735776, name: 'ACME' },
    user: { id: 1782959, name: 'Ann Smith' },
    timer_started_at: '2026-11-04T15:00:00Z',
  };
  const service = fakeRoutes({
    'GET /v2/users/me': { id: 1782959, email: 'ann@acme.com' },
    'POST /v2/time_entries': (req) => json({ ...entry, ...body(req) }, { status: 201 }),
    'PATCH /v2/time_entries/636709355/stop': { ...entry, is_running: false, hours: 1.5 },
    'GET /v2/time_entries': (req) =>
      json({
        time_entries: [entry],
        links: {
          next: req.url.searchParams.get('page')
            ? null
            : 'https://api.harvestapp.com/v2/time_entries?page=2&per_page=100',
        },
      }),
  });
  const acc = testAccount(harvest, {
    config: { accountId: '123456' },
    credentials: { token: '1234567.pt.abcdefghijklmnop' },
    fetch: service.fetch,
  });

  it('sends the account id and a contactable User-Agent', async () => {
    expect(await harvest.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    const call = service.calls.at(-1)!;
    expect(call.headers.get('harvest-account-id')).toBe('123456');
    expect(call.headers.get('authorization')).toBe('Bearer 1234567.pt.abcdefghijklmnop');
    expect(call.headers.get('user-agent')).toMatch(/^Manyplug \(https:/);
  });

  it('starts a timer when hours are left out and stops it', async () => {
    const started = await acc.run('log_time', {
      project_id: 14308069,
      task_id: 8083365,
      spent_date: '2026-11-04',
    });
    expect(body(service.calls.at(-1)!)).toEqual({
      project_id: 14308069,
      task_id: 8083365,
      spent_date: '2026-11-04',
    });
    expect(started).toMatchObject({ is_running: true, project: { name: 'ACME website' } });
    expect(started).not.toHaveProperty('timer_started_at');
    expect(await acc.run('stop_timer', { id: 636709355 })).toMatchObject({ is_running: false, hours: 1.5 });
  });

  it('follows links.next for more entries', async () => {
    const first = (await acc.run('list_time_entries', { from: '2026-11-02' })) as { nextCursor?: string };
    await acc.run('list_time_entries', { cursor: first.nextCursor });
    expect(service.calls.at(-1)!.url.searchParams.get('page')).toBe('2');
  });
});

describe('toggl', () => {
  const entry = {
    id: 3765424181,
    workspace_id: 7468372,
    project_id: 201234567,
    description: 'Call with ACME',
    start: '2026-11-04T15:00:00Z',
    stop: null,
    duration: -1762268400,
    tags: [],
    billable: false,
    uid: 9876543,
    server_deleted_at: null,
  };
  const service = fakeRoutes({
    'GET /api/v9/me': {
      id: 9876543,
      email: 'ann@acme.com',
      default_workspace_id: 7468372,
      api_token: 'secret',
    },
    'POST /api/v9/workspaces/7468372/time_entries': (req) => json({ ...entry, ...body(req) }),
    'PATCH /api/v9/workspaces/7468372/time_entries/3765424181/stop': { ...entry, duration: 1800 },
    'DELETE /api/v9/workspaces/7468372/time_entries/3765424181': () => new Response(null, { status: 200 }),
  });
  const acc = testAccount(toggl, {
    credentials: { token: 'abcdef0123456789abcdef0123456789' },
    fetch: service.fetch,
  });

  it('signs in with the token as user and never returns it', async () => {
    expect(await toggl.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    expect(service.calls.at(-1)!.headers.get('authorization')).toBe(
      basic('abcdef0123456789abcdef0123456789', 'api_token'),
    );
    expect(await acc.run('me', {})).not.toHaveProperty('api_token');
  });

  it('starts a running timer and stops it', async () => {
    await acc.run('start_timer', {
      workspace_id: 7468372,
      start: '2026-11-04T15:00:00Z',
      description: 'Call with ACME',
      project_id: 201234567,
    });
    expect(body(service.calls.at(-1)!)).toEqual({
      created_with: 'Manyplug',
      workspace_id: 7468372,
      start: '2026-11-04T15:00:00Z',
      duration: -1,
      description: 'Call with ACME',
      project_id: 201234567,
    });
    expect(await acc.run('stop_timer', { workspace_id: 7468372, id: 3765424181 })).toMatchObject({
      duration: 1800,
    });
  });

  it('keeps deleting entries dangerous', async () => {
    expect(toggl.actions.find((a) => a.name === 'delete_time_entry')!.risk).toBe('dangerous');
    expect(await acc.run('delete_time_entry', { workspace_id: 7468372, id: 3765424181 })).toBe(
      'Time entry deleted.',
    );
  });
});
