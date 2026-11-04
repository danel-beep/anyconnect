import { describe, expect, it } from 'vitest';
import calendly from '../../src/connectors/builtin/calendly.js';
import clickup from '../../src/connectors/builtin/clickup.js';
import confluence from '../../src/connectors/builtin/confluence.js';
import gitlab from '../../src/connectors/builtin/gitlab.js';
import gsheets from '../../src/connectors/builtin/google-sheets.js';
import intercom from '../../src/connectors/builtin/intercom.js';
import pipedrive from '../../src/connectors/builtin/pipedrive.js';
import zendesk from '../../src/connectors/builtin/zendesk.js';
import { fakeRoutes, json, type RecordedRequest, testAccount } from './harness.js';

// Second catalogue batch. Fixtures follow the documented response shapes of each API, trimmed.

const body = (req: RecordedRequest) => JSON.parse(req.body!);
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('confluence', () => {
  const service = fakeRoutes({
    'GET /wiki/rest/api/user/current': { accountId: 'a1', email: 'ann@acme.com', displayName: 'Ann' },
    'GET /wiki/rest/api/search': (req) =>
      json({
        results: [
          {
            content: { id: '123', type: 'page', title: 'Onboarding', space: { key: 'HR', name: 'People' } },
            excerpt: 'How we <b>onboard</b> new people',
            url: '/spaces/HR/pages/123/Onboarding',
            lastModified: '2026-11-01T10:00:00.000Z',
          },
        ],
        _links: req.url.searchParams.get('cursor') ? {} : { next: '/rest/api/search?cql=x&cursor=abc' },
      }),
    'GET /wiki/api/v2/pages/123': (req) =>
      json(
        req.url.searchParams.get('body-format') === 'view'
          ? {
              id: '123',
              title: 'Onboarding',
              version: { number: 4, createdAt: '2026-11-01T10:00:00.000Z' },
              body: { view: { value: '<h1>Day one</h1><p>Get a <a href="https://x.test">laptop</a>.</p>' } },
              _links: { webui: '/spaces/HR/pages/123/Onboarding' },
            }
          : {
              id: '123',
              title: 'Onboarding',
              status: 'current',
              version: { number: 4 },
              body: { storage: { value: '<p>old</p>' } },
            },
      ),
    'PUT /wiki/api/v2/pages/123': (req) => json({ id: '123', version: { number: body(req).version.number } }),
    'GET /wiki/api/v2/spaces': { results: [{ id: '9', key: 'HR', name: 'People' }] },
    'POST /wiki/api/v2/pages': (req) =>
      json({ id: '200', title: body(req).title, _links: { webui: '/x/200' } }),
  });
  const acc = testAccount(confluence, {
    config: { site: 'acme', email: 'ann@acme.com' },
    credentials: { apiToken: 'tok' },
    fetch: service.fetch,
  });

  it('signs in on the site wiki with email and token', async () => {
    expect(await confluence.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    const call = service.calls.at(-1)!;
    expect(call.url.toString()).toBe('https://acme.atlassian.net/wiki/rest/api/user/current');
    expect(call.headers.get('authorization')).toBe(basic('ann@acme.com', 'tok'));
  });

  it('searches words as safe CQL and pages with the cursor', async () => {
    const found = await acc.runCapability('files.search', { query: 'on "board"' });
    expect(service.calls.at(-1)!.url.searchParams.get('cql')).toBe(
      '(title ~ "on \\"board\\"" OR text ~ "on \\"board\\"") AND type = page',
    );
    expect(found.items).toEqual([
      {
        id: '123',
        name: 'Onboarding',
        path: 'HR',
        mime_type: 'text/html',
        modified: '2026-11-01T10:00:00.000Z',
        url: 'https://acme.atlassian.net/wiki/spaces/HR/pages/123/Onboarding',
      },
    ]);
    await acc.run('search', { query: 'x', cursor: found.nextCursor });
    expect(service.calls.at(-1)!.url.searchParams.get('cursor')).toBe('abc');
  });

  it('reads pages as text', async () => {
    const read = await acc.runCapability('files.read', { id: '123' });
    expect(read.text).toContain('Day one');
    expect(read.text).toContain('laptop (https://x.test)');
    expect(read.url).toBe('https://acme.atlassian.net/wiki/spaces/HR/pages/123/Onboarding');
  });

  it('creates pages from plain text and bumps the version on update', async () => {
    await acc.run('create_page', { space: 'HR', title: 'Retro', body: 'Went well\n\nTo <fix>' });
    expect(body(service.calls.at(-1)!)).toEqual({
      spaceId: '9',
      status: 'current',
      title: 'Retro',
      body: { representation: 'storage', value: '<p>Went well</p><p>To &lt;fix&gt;</p>' },
    });
    await acc.run('update_page', { id: '123', title: 'Onboarding v2' });
    expect(body(service.calls.at(-1)!)).toMatchObject({
      title: 'Onboarding v2',
      body: { value: '<p>old</p>' },
      version: { number: 5 },
    });
  });
});

describe('gitlab', () => {
  const service = fakeRoutes({
    'GET /api/v4/user': { id: 1, username: 'ann' },
    'GET /api/v4/projects/acme%2Fweb/issues/7': {
      iid: 7,
      project_id: 3,
      title: 'CSV export fails',
      state: 'opened',
      labels: ['bug'],
      author: { username: 'bob', avatar_url: 'x' },
      description: 'Steps',
      web_url: 'https://gitlab.acme.com/acme/web/-/issues/7',
    },
    'POST /api/v4/projects/acme%2Fweb/issues': (req) =>
      json({ iid: 8, project_id: 3, web_url: 'https://x/8', title: body(req).title }, { status: 201 }),
  });
  const acc = testAccount(gitlab, {
    config: { host: 'gitlab.acme.com' },
    credentials: { token: 'glpat-xxxxxxxxxxxxxxxxxxxx' },
    fetch: service.fetch,
  });

  it('works with a self-managed host and a bearer token', async () => {
    expect(await gitlab.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann' });
    const call = service.calls.at(-1)!;
    expect(call.url.host).toBe('gitlab.acme.com');
    expect(call.headers.get('authorization')).toBe('Bearer glpat-xxxxxxxxxxxxxxxxxxxx');
    expect(gitlab.config.parse({})).toEqual({ host: 'gitlab.com' });
    expect(gitlab.config.safeParse({ host: 'evil.test/path' }).success).toBe(false);
  });

  it('addresses projects by their path', async () => {
    const issue = (await acc.run('get_issue', { project: 'acme/web', iid: 7 })) as Record<string, unknown>;
    expect(issue).toMatchObject({ iid: 7, title: 'CSV export fails', author: { username: 'bob' } });
    await acc.run('create_issue', { project: 'acme/web', title: 'New', labels: 'bug,ui' });
    expect(body(service.calls.at(-1)!)).toEqual({ title: 'New', labels: 'bug,ui' });
  });
});

describe('clickup', () => {
  const task = {
    id: 'abc1',
    name: 'Update pricing',
    status: { status: 'to do', type: 'open' },
    due_date: '1793750400000',
    priority: { id: '2', priority: 'high' },
    url: 'https://app.clickup.com/t/abc1',
    list: { id: '501', name: 'Sprint 12' },
    assignees: [{ username: 'ann' }],
  };
  const service = fakeRoutes({
    'GET /api/v2/user': { user: { id: 77, username: 'ann', email: 'ann@acme.com' } },
    'GET /api/v2/team': { teams: [{ id: '9001', name: 'ACME' }] },
    'GET /api/v2/team/9001/task': { tasks: [task, { ...task, id: 'abc2', name: 'Other' }], last_page: false },
    'GET /api/v2/team/9001/space': { spaces: [{ id: '30', name: 'Product' }] },
    'GET /api/v2/space/30/folder': {
      folders: [{ id: '40', name: 'Q4', lists: [{ id: '501', name: 'Sprint 12' }] }],
    },
    'GET /api/v2/space/30/list': { lists: [{ id: '502', name: 'Backlog' }] },
    'POST /api/v2/list/501/task': (req) => json({ ...task, id: 'abc3', name: body(req).name }),
  });
  const acc = testAccount(clickup, { credentials: { token: 'pk_123_ABC' }, fetch: service.fetch });

  it('sends the personal token as is', async () => {
    expect(await clickup.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    expect(service.calls.at(-1)!.headers.get('authorization')).toBe('pk_123_ABC');
  });

  it('lists my tasks in the only workspace, filters by words and pages', async () => {
    const result = (await acc.run('find_tasks', { query: 'pricing' })) as {
      items: unknown[];
      nextCursor?: string;
    };
    const q = service.calls.at(-1)!.url.searchParams;
    expect([q.get('assignees[]'), q.get('page'), q.get('include_closed')]).toEqual(['77', '0', 'false']);
    expect(result.items).toEqual([
      {
        id: 'abc1',
        name: 'Update pricing',
        status: 'to do',
        due: '2026-11-04T00:00:00.000Z',
        priority: 'high',
        list: 'Sprint 12',
        assignees: ['ann'],
        url: 'https://app.clickup.com/t/abc1',
      },
    ]);
    expect(result.nextCursor).toBe('1');
  });

  it('creates tasks in a list given by name, assigned to me', async () => {
    const created = await acc.runCapability('tasks.create', {
      title: 'Ship',
      project: 'sprint 12',
      due: '2026-11-10',
      priority: 4,
    });
    expect(created).toEqual({ id: 'abc3', url: 'https://app.clickup.com/t/abc1' });
    expect(body(service.calls.at(-1)!)).toEqual({
      name: 'Ship',
      priority: 1,
      due_date: Date.parse('2026-11-10T12:00:00Z'),
      due_date_time: false,
      assignees: [77],
    });
  });

  it('maps tasks to the shared list', async () => {
    const listed = await acc.runCapability('tasks.list', {});
    expect(listed.items[0]).toEqual({
      id: 'abc1',
      title: 'Update pricing',
      status: 'open',
      due: '2026-11-04T00:00:00.000Z',
      priority: 3,
      project: 'Sprint 12',
      url: 'https://app.clickup.com/t/abc1',
    });
  });
});

describe('calendly', () => {
  const event = {
    uri: 'https://api.calendly.com/scheduled_events/EV1',
    name: 'Intro call',
    status: 'active',
    start_time: '2026-11-05T10:00:00.000000Z',
    end_time: '2026-11-05T10:30:00.000000Z',
    location: { type: 'zoom', join_url: 'https://zoom.us/j/1' },
    invitees_counter: { active: 1, total: 1 },
  };
  const service = fakeRoutes({
    'GET /users/me': { resource: { uri: 'https://api.calendly.com/users/U1', email: 'ann@acme.com' } },
    'GET /scheduled_events': { collection: [event], pagination: { next_page_token: 'p2', count: 1 } },
    'GET /event_types': {
      collection: [
        { uri: 'https://api.calendly.com/event_types/ET1', name: '30 Minute Meeting', duration: 30 },
      ],
    },
    'POST /scheduling_links': {
      resource: { booking_url: 'https://calendly.com/d/abc', owner_type: 'EventType' },
    },
    'POST /scheduled_events/EV1/cancellation': { resource: { canceled_by: 'Ann' } },
  });
  const acc = testAccount(calendly, {
    credentials: { token: 'eyJraWQiOiJ0ZXN0In0.payload' },
    fetch: service.fetch,
  });

  it('scopes meetings to the user and maps them to calendar events', async () => {
    const listed = await acc.runCapability('calendar.list_events', {
      from: '2026-11-05T00:00:00Z',
      to: '2026-11-06T00:00:00Z',
    });
    const q = service.calls.at(-1)!.url.searchParams;
    expect([q.get('user'), q.get('min_start_time'), q.get('sort')]).toEqual([
      'https://api.calendly.com/users/U1',
      '2026-11-05T00:00:00Z',
      'start_time:asc',
    ]);
    expect(listed.items).toEqual([
      {
        id: 'EV1',
        title: 'Intro call',
        start: '2026-11-05T10:00:00.000000Z',
        end: '2026-11-05T10:30:00.000000Z',
        location: 'https://zoom.us/j/1',
        calendar: 'Calendly',
      },
    ]);
    expect(listed.nextCursor).toBe('p2');
  });

  it('makes one-time links for an event type named in words', async () => {
    expect(await acc.run('create_booking_link', { event_type: '30 minute meeting' })).toEqual({
      url: 'https://calendly.com/d/abc',
      event_type: '30 Minute Meeting',
    });
    expect(body(service.calls.at(-1)!)).toEqual({
      max_event_count: 1,
      owner: 'https://api.calendly.com/event_types/ET1',
      owner_type: 'EventType',
    });
  });

  it('cancels meetings and calls it dangerous', async () => {
    expect(calendly.actions.find((a) => a.name === 'cancel_event')!.risk).toBe('dangerous');
    await acc.run('cancel_event', { id: 'EV1', reason: 'Moving' });
    expect(body(service.calls.at(-1)!)).toEqual({ reason: 'Moving' });
  });
});

describe('zendesk', () => {
  const service = fakeRoutes({
    'GET /api/v2/users/me.json': { user: { id: 1, email: 'agent@acme.com' } },
    'GET /api/v2/search.json': (req) =>
      json(
        req.url.searchParams.get('page')
          ? { results: [], next_page: null }
          : {
              results: [
                { id: 4821, subject: 'Refund', status: 'open', url: 'https://x', via: { channel: 'email' } },
              ],
              next_page: 'https://acme.zendesk.com/api/v2/search.json?page=2&query=x',
              count: 30,
            },
      ),
    'PUT /api/v2/tickets/4821.json': (req) =>
      json({ ticket: { id: 4821, status: body(req).ticket.status ?? 'open' } }),
    'GET /api/v2/users/search.json': {
      users: [{ id: 9, name: 'Anna Smith', email: 'anna@acme.com', phone: null, role: 'end-user' }],
    },
  });
  const acc = testAccount(zendesk, {
    config: { subdomain: 'acme', email: 'agent@acme.com' },
    credentials: { apiToken: 'tok1234567' },
    fetch: service.fetch,
  });

  it('uses the email/token form of basic auth', async () => {
    expect(await zendesk.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'agent@acme.com' });
    expect(service.calls.at(-1)!.headers.get('authorization')).toBe(
      basic('agent@acme.com/token', 'tok1234567'),
    );
  });

  it('searches tickets only and follows next_page on the same site', async () => {
    const result = (await acc.run('search_tickets', { query: 'status<solved' })) as { nextCursor?: string };
    expect(service.calls.at(-1)!.url.searchParams.get('query')).toBe('type:ticket status<solved');
    await acc.run('search_tickets', { query: 'status<solved', cursor: result.nextCursor });
    expect(service.calls.at(-1)!.url.searchParams.get('page')).toBe('2');
  });

  it('keeps notes internal and marks public replies dangerous', async () => {
    await acc.run('add_note', { ticket_id: 4821, body: 'Waiting on the warehouse' });
    expect(body(service.calls.at(-1)!)).toEqual({
      ticket: { comment: { body: 'Waiting on the warehouse', public: false } },
    });
    expect(zendesk.actions.find((a) => a.name === 'reply')!.risk).toBe('dangerous');
    await acc.run('reply', { ticket_id: 4821, body: 'Done', status: 'solved' });
    expect(body(service.calls.at(-1)!)).toEqual({
      ticket: { comment: { body: 'Done', public: true }, status: 'solved' },
    });
  });

  it('finds people for the shared contact search', async () => {
    expect(await acc.runCapability('contacts.search', { query: 'anna' })).toEqual([
      { id: '9', name: 'Anna Smith', emails: ['anna@acme.com'] },
    ]);
  });
});

describe('intercom', () => {
  const service = fakeRoutes({
    'GET /me': { type: 'admin', id: '814', email: 'ann@acme.com', app: { name: 'ACME' } },
    'POST /conversations/search': (req) =>
      json({
        conversations: [
          {
            id: '1001',
            state: 'open',
            updated_at: 1793613600,
            source: { body: '<p>Login <b>broken</b></p>', author: { name: 'Anna', type: 'user' } },
          },
        ],
        pages: body(req).pagination.starting_after ? {} : { next: { starting_after: 'WzE3' } },
      }),
    'POST /conversations/1001/reply': (req) => json({ id: '1001', echo: body(req) }),
    'POST /contacts/search': { data: [{ id: 'c1', name: 'Anna', email: 'anna@acme.com', role: 'user' }] },
  });
  const acc = testAccount(intercom, {
    config: { region: 'eu' },
    credentials: { token: 'dG9rOjEyMzQ1Njc4OTAxMjM0NTY3OA==' },
    fetch: service.fetch,
  });

  it('talks to the regional API with a pinned version', async () => {
    expect(await intercom.test!(acc.ctx as never)).toMatchObject({
      ok: true,
      identity: 'ann@acme.com @ ACME',
    });
    const call = service.calls.at(-1)!;
    expect(call.url.host).toBe('api.eu.intercom.io');
    expect(call.headers.get('intercom-version')).toBe('2.11');
  });

  it('lists open conversations as text and pages with starting_after', async () => {
    const result = (await acc.run('search_conversations', {})) as { items: unknown[]; nextCursor?: string };
    expect(result.items).toEqual([
      {
        id: '1001',
        state: 'open',
        from: 'Anna',
        preview: 'Login broken',
        updated: '2026-11-02T10:00:00.000Z',
      },
    ]);
    await acc.run('search_conversations', { cursor: result.nextCursor });
    expect(body(service.calls.at(-1)!).pagination).toEqual({ per_page: 20, starting_after: 'WzE3' });
  });

  it('replies as the token owner; notes are internal', async () => {
    await acc.run('add_note', { id: '1001', body: 'Checked logs' });
    expect(body(service.calls.at(-1)!)).toEqual({
      message_type: 'note',
      type: 'admin',
      admin_id: '814',
      body: 'Checked logs',
    });
    expect(intercom.actions.find((a) => a.name === 'reply')!.risk).toBe('dangerous');
  });

  it('finds contacts for the shared contact search', async () => {
    expect(await acc.runCapability('contacts.search', { query: 'anna' })).toEqual([
      { id: 'c1', name: 'Anna', emails: ['anna@acme.com'] },
    ]);
  });
});

describe('pipedrive', () => {
  const token = 'a'.repeat(40);
  const service = fakeRoutes({
    'GET /v1/users/me': { success: true, data: { id: 1, email: 'ann@acme.com' } },
    'GET /v1/persons/search': (req) =>
      json({
        success: true,
        data: {
          items: [
            {
              result_score: 1,
              item: {
                id: 5,
                name: 'Anna Smith',
                emails: ['anna@acme.com'],
                phones: [],
                organization: { id: 2, name: 'ACME' },
              },
            },
          ],
        },
        additional_data: {
          pagination: req.url.searchParams.get('start')
            ? { more_items_in_collection: false }
            : { start: 0, limit: 20, more_items_in_collection: true, next_start: 20 },
        },
      }),
    'PUT /v1/deals/9': (req) => json({ success: true, data: { id: 9, ...body(req) } }),
  });
  const acc = testAccount(pipedrive, { credentials: { apiToken: token }, fetch: service.fetch });

  it('sends the token in a header, never in the URL', async () => {
    expect(await pipedrive.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    const call = service.calls.at(-1)!;
    expect(call.headers.get('x-api-token')).toBe(token);
    expect(call.url.search).not.toContain(token);
  });

  it('pages searches with next_start and maps people to contacts', async () => {
    const found = (await acc.run('search_persons', { term: 'anna' })) as { nextCursor?: string };
    await acc.run('search_persons', { term: 'anna', cursor: found.nextCursor });
    expect(service.calls.at(-1)!.url.searchParams.get('start')).toBe('20');
    expect(await acc.runCapability('contacts.search', { query: 'anna' })).toEqual([
      { id: '5', name: 'Anna Smith', emails: ['anna@acme.com'], company: 'ACME' },
    ]);
  });

  it('moves deals with only the given fields', async () => {
    await acc.run('update_deal', { deal_id: 9, stage_id: 3, status: 'won' });
    expect(body(service.calls.at(-1)!)).toEqual({ stage_id: 3, status: 'won' });
  });
});

describe('google sheets', () => {
  const id = '1AbCdEfGhIjKlMnOp';
  const service = fakeRoutes({
    'GET /drive/v3/about': { user: { emailAddress: 'ann@acme.com' } },
    'GET /drive/v3/files': { files: [{ id, name: 'Budget 2027', modifiedTime: '2026-11-01T00:00:00Z' }] },
    [`GET /v4/spreadsheets/${id}/values/Sheet1!A1%3AB3`]: {
      range: 'Sheet1!A1:B3',
      majorDimension: 'ROWS',
      values: [
        ['Month', 'Total'],
        ['Jan', '$1,200'],
        ['Feb', '$900'],
      ],
    },
    [`POST /v4/spreadsheets/${id}/values/Leads:append`]: {
      updates: { updatedRange: 'Leads!A10:C10', updatedRows: 1 },
    },
    'POST /v4/spreadsheets': (req) =>
      json({
        spreadsheetId: 'NEW1234567890',
        sheets: [{ properties: { title: 'Sheet1' } }],
        echo: body(req),
      }),
    "PUT /v4/spreadsheets/NEW1234567890/values/'Sheet1'!A1": { updatedCells: 2 },
    [`POST /v4/spreadsheets/${id}:batchUpdate`]: {
      replies: [{ addSheet: { properties: { sheetId: 7, title: 'Q4' } } }],
    },
  });
  const acc = testAccount(gsheets, { oauth: { accessToken: 'ya29.x' }, fetch: service.fetch });

  it('identifies the Google account and needs OAuth', async () => {
    expect(await gsheets.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    expect(gsheets.oauth).toMatchObject({ provider: 'google' });
    await expect(
      testAccount(gsheets, { fetch: service.fetch }).run('find_spreadsheets', {}),
    ).rejects.toMatchObject({
      kind: 'auth',
    });
  });

  it('finds spreadsheets by name with an escaped Drive query', async () => {
    await acc.run('find_spreadsheets', { query: "Ann's" });
    expect(service.calls.at(-1)!.url.searchParams.get('q')).toBe(
      "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and name contains 'Ann\\'s'",
    );
  });

  it('reads ranges from an id or a spreadsheet URL', async () => {
    const read = await acc.run('read_range', {
      spreadsheet_id: `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`,
      range: 'Sheet1!A1:B3',
      max_rows: 2,
    });
    expect(read).toEqual({
      range: 'Sheet1!A1:B3',
      rows: [
        ['Month', 'Total'],
        ['Jan', '$1,200'],
      ],
      total_rows: 3,
      truncated: true,
    });
  });

  it('appends rows as typed by a person', async () => {
    await acc.run('append_rows', {
      spreadsheet_id: id,
      range: 'Leads',
      values: [['ACME', 'Anna', '=TODAY()']],
    });
    const call = service.calls.at(-1)!;
    expect(call.url.searchParams.get('valueInputOption')).toBe('USER_ENTERED');
    expect(call.url.searchParams.get('insertDataOption')).toBe('INSERT_ROWS');
    expect(body(call)).toEqual({ majorDimension: 'ROWS', values: [['ACME', 'Anna', '=TODAY()']] });
  });

  it('creates spreadsheets with headers and adds sheets', async () => {
    expect(await acc.run('create_spreadsheet', { title: 'Plan', headers: ['Date', 'Topic'] })).toEqual({
      id: 'NEW1234567890',
      sheet: 'Sheet1',
      url: 'https://docs.google.com/spreadsheets/d/NEW1234567890/edit',
    });
    expect(await acc.run('add_sheet', { spreadsheet_id: id, name: 'Q4' })).toEqual({
      sheet: 'Q4',
      sheet_id: 7,
    });
  });
});
