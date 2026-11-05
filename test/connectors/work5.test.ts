import { describe, expect, it } from 'vitest';
import miro from '../../src/connectors/builtin/miro.js';
import sendgrid from '../../src/connectors/builtin/sendgrid.js';
import smartsheet from '../../src/connectors/builtin/smartsheet.js';
import zoom from '../../src/connectors/builtin/zoom.js';
import { fakeRoutes, json, type RecordedRequest, testAccount } from './harness.js';

// Fifth catalogue batch. Fixtures follow the documented response shapes of each API, trimmed.

const body = (req: RecordedRequest) => JSON.parse(req.body!);

describe('zoom', () => {
  let tokenCalls = 0;
  const meeting = {
    id: 85012345678,
    uuid: 'u1',
    topic: 'Call with ACME',
    type: 2,
    start_time: '2026-11-05T15:00:00Z',
    duration: 30,
    timezone: 'Europe/Berlin',
    join_url: 'https://zoom.us/j/85012345678',
    password: 'abc123',
    host_email: 'ann@acme.com',
  };
  const service = fakeRoutes({
    'POST /oauth/token': (req) => {
      tokenCalls++;
      expect(req.url.searchParams.get('grant_type')).toBe('account_credentials');
      expect(req.url.searchParams.get('account_id')).toBe('acct_0123456789');
      return json({ access_token: `zoom-token-${tokenCalls}`, token_type: 'bearer', expires_in: 3599 });
    },
    'GET /v2/users/me': { id: 'u', email: 'ann@acme.com' },
    'GET /v2/users/me/meetings': (req) =>
      json({
        meetings: [meeting],
        next_page_token: req.url.searchParams.get('next_page_token') ? '' : 'p2',
      }),
    'POST /v2/users/me/meetings': (req) => json({ ...meeting, ...body(req) }),
    'DELETE /v2/meetings/85012345678': () => new Response(null, { status: 204 }),
  });
  const acc = testAccount(zoom, {
    credentials: {
      accountId: 'acct_0123456789',
      clientId: 'client_0123456789',
      clientSecret: 'secret_0123456789',
    },
    fetch: service.fetch,
  });

  it('exchanges the app credentials once and reuses the token', async () => {
    expect(await zoom.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    const exchange = service.calls.find((c) => c.url.pathname === '/oauth/token')!;
    expect(exchange.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('client_0123456789:secret_0123456789').toString('base64')}`,
    );
    await acc.run('list_meetings', {});
    expect(tokenCalls).toBe(1);
    expect(service.calls.at(-1)!.headers.get('authorization')).toBe('Bearer zoom-token-1');
  });

  it('lists meetings with a cursor and joins the shared calendar', async () => {
    const first = (await acc.run('list_meetings', {})) as { items: unknown[]; nextCursor?: string };
    expect(first.items[0]).toEqual({
      id: '85012345678',
      topic: 'Call with ACME',
      start: '2026-11-05T15:00:00Z',
      duration: 30,
      timezone: 'Europe/Berlin',
      join_url: 'https://zoom.us/j/85012345678',
    });
    expect(first.nextCursor).toBe('p2');
    const events = (await acc.runCapability('calendar.list_events', {
      from: '2026-11-05T00:00:00Z',
      to: '2026-11-06T00:00:00Z',
      query: 'acme',
    })) as {
      items: unknown[];
    };
    expect(events.items).toEqual([
      {
        id: '85012345678',
        title: 'Call with ACME',
        start: '2026-11-05T15:00:00Z',
        end: '2026-11-05T15:30:00.000Z',
        location: 'https://zoom.us/j/85012345678',
        url: 'https://zoom.us/j/85012345678',
        calendar: 'Zoom',
      },
    ]);
  });

  it('creates meetings from the shared calendar event', async () => {
    const created = await acc.runCapability('calendar.create_event', {
      title: 'Call with ACME',
      start: '2026-11-05T15:00:00Z',
      end: '2026-11-05T15:45:00Z',
    });
    expect(body(service.calls.at(-1)!)).toEqual({
      topic: 'Call with ACME',
      type: 2,
      start_time: '2026-11-05T15:00:00Z',
      duration: 45,
    });
    expect(created).toEqual({ id: '85012345678', url: 'https://zoom.us/j/85012345678' });
  });

  it('keeps cancelling dangerous', async () => {
    expect(zoom.actions.find((a) => a.name === 'cancel_meeting')!.risk).toBe('dangerous');
    expect(await acc.run('cancel_meeting', { meeting_id: '85012345678' })).toBe('Meeting cancelled.');
  });

  it('reports wrong app credentials as an auth problem', async () => {
    const bad = testAccount(zoom, {
      credentials: {
        accountId: 'acct_bad_000000',
        clientId: 'client_0123456789',
        clientSecret: 'secret_0123456789',
      },
      fetch: fakeRoutes({
        'POST /oauth/token': () =>
          json({ reason: 'Invalid client_id or client_secret', error: 'invalid_client' }, { status: 400 }),
      }).fetch,
    });
    await expect(bad.run('list_meetings', {})).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('miro', () => {
  const service = fakeRoutes({
    'GET /v2/boards': {
      data: [{ id: 'uXjVOD6LSME=', name: 'Ideas', viewLink: 'https://miro.com/app/board/uXjVOD6LSME=' }],
    },
    'GET /v2/boards/uXjVOD6LSME%3D/items': (req) =>
      json({
        data: [
          { id: '345', type: 'sticky_note', data: { content: 'Partner program' }, position: { x: 0, y: 0 } },
        ],
        ...(req.url.searchParams.get('cursor') ? {} : { cursor: 'c2' }),
      }),
    'POST /v2/boards/uXjVOD6LSME%3D/sticky_notes': (req) =>
      json({ id: '346', type: 'sticky_note', ...body(req) }),
  });
  const acc = testAccount(miro, {
    credentials: { token: 'eyJtaXJvLnRva2VuIjoxfQ.abc' },
    fetch: service.fetch,
  });

  it('encodes board ids in paths and pages items by cursor', async () => {
    const first = (await acc.run('list_items', { board_id: 'uXjVOD6LSME=' })) as { nextCursor?: string };
    await acc.run('list_items', { board_id: 'uXjVOD6LSME=', cursor: first.nextCursor });
    expect(service.calls.at(-1)!.url.searchParams.get('cursor')).toBe('c2');
  });

  it('adds sticky notes with only the given style and position', async () => {
    await acc.run('add_sticky_note', {
      board_id: 'uXjVOD6LSME=',
      content: 'Partner program',
      color: 'yellow',
      x: 100,
    });
    expect(body(service.calls.at(-1)!)).toEqual({
      data: { content: 'Partner program', shape: 'square' },
      style: { fillColor: 'yellow' },
      position: { x: 100 },
    });
  });
});

describe('sendgrid', () => {
  const service = fakeRoutes({
    'GET /v3/scopes': { scopes: ['mail.send'] },
    'POST /v3/mail/send': () => new Response(null, { status: 202 }),
  });
  const acc = testAccount(sendgrid, { credentials: { apiKey: 'SG.abc.def' }, fetch: service.fetch });

  it('sends HTML email as a dangerous action', async () => {
    expect(await sendgrid.test!(acc.ctx as never)).toMatchObject({ ok: true });
    expect(sendgrid.actions.find((a) => a.name === 'send_email')!.risk).toBe('dangerous');
    expect(
      await acc.run('send_email', {
        from_email: 'news@acme.com',
        to: [{ email: 'ben@acme.com', name: 'Ben' }],
        subject: 'Hi',
        html: '<p>Hi</p>',
      }),
    ).toBe('Accepted for delivery.');
    const call = service.calls.at(-1)!;
    expect(call.headers.get('authorization')).toBe('Bearer SG.abc.def');
    expect(body(call)).toEqual({
      personalizations: [{ to: [{ email: 'ben@acme.com', name: 'Ben' }] }],
      from: { email: 'news@acme.com' },
      subject: 'Hi',
      content: [{ type: 'text/html', value: '<p>Hi</p>' }],
    });
  });
});

describe('smartsheet', () => {
  const service = fakeRoutes({
    'GET /2.0/users/me': { id: 1, email: 'ann@acme.com' },
    'POST /2.0/sheets/42/rows': (req) =>
      json({
        message: 'SUCCESS',
        result: body(req).map((_: unknown, i: number) => ({ id: 900 + i, rowNumber: 10 + i })),
      }),
  });
  const acc = testAccount(smartsheet, {
    config: { host: 'api.smartsheet.eu' },
    credentials: { token: 'smartsheet_token_0123456789' },
    fetch: service.fetch,
  });

  it('talks to the account region', async () => {
    expect(await smartsheet.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    expect(service.calls.at(-1)!.url.host).toBe('api.smartsheet.eu');
  });

  it('sends rows as the request body array', async () => {
    const rows = [{ toBottom: true, cells: [{ columnId: 1, value: 'ACME' }] }];
    expect(await acc.run('add_rows', { sheet_id: 42, rows })).toEqual([{ id: 900, rowNumber: 10 }]);
    expect(body(service.calls.at(-1)!)).toEqual(rows);
  });
});
