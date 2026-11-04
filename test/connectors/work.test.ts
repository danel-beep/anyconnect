import { describe, expect, it } from 'vitest';
import airtable from '../../src/connectors/builtin/airtable.js';
import asana from '../../src/connectors/builtin/asana.js';
import hubspot from '../../src/connectors/builtin/hubspot.js';
import jira from '../../src/connectors/builtin/jira.js';
import linear from '../../src/connectors/builtin/linear.js';
import trello from '../../src/connectors/builtin/trello.js';
import { ConnectorError } from '../../src/connectors/sdk.js';
import { fakeHttp, fakeRoutes, json, type RecordedRequest, testAccount } from './harness.js';

// Task managers and CRMs. Fixtures follow the documented response shapes of each API, trimmed.

const body = (req: RecordedRequest) => JSON.parse(req.body!);

describe('jira', () => {
  const issue = {
    id: '10001',
    key: 'ENG-42',
    self: 'https://acme.atlassian.net/rest/api/2/issue/10001',
    fields: {
      summary: 'Safari login fails',
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate', name: 'In Progress' } },
      issuetype: { name: 'Bug', iconUrl: 'https://x' },
      priority: { name: 'High', iconUrl: 'https://x' },
      assignee: { displayName: 'Ann Lee', accountId: 'a1', avatarUrls: { '48x48': 'https://x' } },
      duedate: '2026-11-10',
      updated: '2026-11-03T10:00:00.000+0000',
      project: { key: 'ENG', name: 'Engineering' },
    },
  };
  const service = fakeRoutes({
    'GET /rest/api/2/myself': { accountId: 'a1', emailAddress: 'ann@acme.com', displayName: 'Ann Lee' },
    'GET /rest/api/2/search/jql': (req) =>
      json(
        req.url.searchParams.get('nextPageToken')
          ? { issues: [], isLast: true }
          : { issues: [issue], nextPageToken: 'tok2', isLast: false },
      ),
    'POST /rest/api/2/issue': (req) =>
      json({ id: '10002', key: `${body(req).fields.project.key}-43`, self: 'https://x' }, { status: 201 }),
    'PUT /rest/api/2/issue/ENG-42': () => new Response(null, { status: 204 }),
    'GET /rest/api/2/issue/ENG-404': () =>
      json(
        { errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} },
        { status: 404 },
      ),
  });
  const acc = testAccount(jira, {
    config: { site: 'acme', email: 'ann@acme.com' },
    credentials: { apiToken: 'tok' },
    fetch: service.fetch,
  });

  it('signs in with email and API token on the site', async () => {
    expect(await jira.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    const call = service.calls.at(-1)!;
    expect(call.url.host).toBe('acme.atlassian.net');
    expect(call.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('ann@acme.com:tok').toString('base64')}`,
    );
  });

  it('rejects a full URL as the site name', () => {
    expect(jira.config.safeParse({ site: 'https://acme.atlassian.net', email: 'a@b.c' }).success).toBe(false);
  });

  it('searches with JQL, keeps the answer compact and pages with nextPageToken', async () => {
    const page = (await acc.run('search_issues', { jql: 'project = ENG' })) as {
      items: Record<string, unknown>[];
      nextCursor?: string;
    };
    expect(page.items[0]).toEqual({
      key: 'ENG-42',
      fields: {
        summary: 'Safari login fails',
        status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        issuetype: { name: 'Bug' },
        priority: { name: 'High' },
        assignee: { displayName: 'Ann Lee' },
        duedate: '2026-11-10',
        updated: '2026-11-03T10:00:00.000+0000',
        project: { key: 'ENG' },
      },
    });
    const first = service.calls.at(-1)!.url.searchParams;
    expect(first.get('jql')).toBe('project = ENG');
    expect(first.get('maxResults')).toBe('30');
    await acc.run('search_issues', { jql: 'project = ENG', cursor: page.nextCursor });
    expect(service.calls.at(-1)!.url.searchParams.get('nextPageToken')).toBe('tok2');
  });

  it('creates issues with a default type and leaves out what was not given', async () => {
    expect(await acc.run('create_issue', { project_key: 'ENG', summary: 'Export is slow' })).toEqual({
      key: 'ENG-43',
    });
    expect(body(service.calls.at(-1)!)).toEqual({
      fields: { project: { key: 'ENG' }, issuetype: { name: 'Task' }, summary: 'Export is slow' },
    });
  });

  it('updates only the given fields', async () => {
    expect(await acc.run('update_issue', { issue_key: 'ENG-42', duedate: '2026-12-01' })).toBe('Updated.');
    expect(body(service.calls.at(-1)!)).toEqual({ fields: { duedate: '2026-12-01' } });
  });

  it('explains missing issues', async () => {
    await expect(acc.run('get_issue', { issue_key: 'ENG-404' })).rejects.toMatchObject({
      kind: 'not_found',
      message: expect.stringContaining('Issue does not exist'),
    });
  });

  it('lists my open issues as tasks with escaped search words', async () => {
    const listed = await acc.runCapability('tasks.list', {
      query: 'say "hi"',
      due_before: '2026-11-30T00:00:00Z',
    });
    expect(service.calls.at(-1)!.url.searchParams.get('jql')).toBe(
      'assignee = currentUser() AND statusCategory != Done AND text ~ "say \\"hi\\"" AND due <= "2026-11-30" ORDER BY duedate ASC, updated DESC',
    );
    expect(listed.items).toEqual([
      {
        id: 'ENG-42',
        title: 'Safari login fails',
        status: 'open',
        due: '2026-11-10',
        priority: 3,
        project: 'ENG',
      },
    ]);
  });

  it('creates tasks in a project and asks for one when it is missing', async () => {
    expect(await acc.runCapability('tasks.create', { title: 'Call ACME', project: 'eng' })).toEqual({
      id: 'ENG-43',
    });
    await expect(acc.runCapability('tasks.create', { title: 'Call ACME' })).rejects.toBeInstanceOf(
      ConnectorError,
    );
  });
});

describe('linear', () => {
  const node = {
    identifier: 'ENG-7',
    title: 'Speed up export',
    priority: 2,
    dueDate: '2026-11-20',
    url: 'https://linear.app/acme/issue/ENG-7',
    updatedAt: '2026-11-03T10:00:00.000Z',
    state: { name: 'Todo', type: 'unstarted' },
    assignee: { name: 'Ann' },
    team: { key: 'ENG' },
  };
  const ops: { query: string; variables: Record<string, unknown> }[] = [];
  const service = fakeHttp((req) => {
    const { query, variables } = body(req);
    ops.push({ query, variables });
    const data = (d: unknown) => json({ data: d });
    if (query.includes('viewer { name email }'))
      return data({ viewer: { name: 'Ann', email: 'ann@acme.com' } });
    if (query.includes('viewer { id }')) return data({ viewer: { id: 'u1' } });
    if (query.includes('issues(')) {
      return data({
        issues: {
          nodes: [node],
          pageInfo: variables.after
            ? { hasNextPage: false, endCursor: 'c2' }
            : { hasNextPage: true, endCursor: 'c1' },
        },
      });
    }
    if (query.includes('teams(')) {
      const key = variables.filter?.key?.eqIgnoreCase;
      const teams = [
        { id: 't1', key: 'ENG', name: 'Engineering' },
        { id: 't2', key: 'DES', name: 'Design' },
      ];
      return data({ teams: { nodes: key ? teams.filter((t) => t.key === key.toUpperCase()) : teams } });
    }
    if (query.includes('team(id:')) {
      return data({
        team: {
          states: {
            nodes: [
              { id: 's1', name: 'Todo' },
              { id: 's2', name: 'In Progress' },
            ],
          },
        },
      });
    }
    if (query.includes('issue(id: $id) { team')) return data({ issue: { team: { id: 't1' } } });
    if (query.includes('issueCreate'))
      return data({ issueCreate: { issue: { ...node, identifier: 'ENG-8' } } });
    if (query.includes('issueUpdate'))
      return data({ issueUpdate: { issue: { ...node, state: { name: 'In Progress', type: 'started' } } } });
    if (query.includes('issue(id:')) {
      return json({
        data: null,
        errors: [
          {
            message: 'Entity not found',
            extensions: { type: 'entity not found', userPresentableMessage: 'Issue not found' },
          },
        ],
      });
    }
    return json({ errors: [{ message: 'unexpected' }] }, { status: 400 });
  });
  const acc = testAccount(linear, { credentials: { apiKey: 'lin_api_abc' }, fetch: service.fetch });

  it('sends the personal key without Bearer', async () => {
    expect(await linear.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    expect(service.calls.at(-1)!.headers.get('authorization')).toBe('lin_api_abc');
    expect(service.calls.at(-1)!.url.toString()).toBe('https://api.linear.app/graphql');
    expect(linear.credentials.safeParse({ apiKey: 'xyz' }).success).toBe(false);
  });

  it('searches my open issues and pages only while Linear says there is more', async () => {
    const first = (await acc.run('search_issues', { query: 'export', team: 'eng' })) as {
      items: unknown[];
      nextCursor?: string;
    };
    expect(first.items).toEqual([
      {
        id: 'ENG-7',
        title: 'Speed up export',
        state: 'Todo',
        state_type: 'unstarted',
        priority: 2,
        due: '2026-11-20',
        assignee: 'Ann',
        team: 'ENG',
        updated: '2026-11-03T10:00:00.000Z',
        url: 'https://linear.app/acme/issue/ENG-7',
      },
    ]);
    expect(ops.at(-1)!.variables.filter).toEqual({
      and: [
        {
          or: [
            { title: { containsIgnoreCase: 'export' } },
            { description: { containsIgnoreCase: 'export' } },
          ],
        },
        { team: { key: { eqIgnoreCase: 'eng' } } },
        { assignee: { isMe: { eq: true } } },
        { state: { type: { nin: ['completed', 'canceled'] } } },
      ],
    });
    const second = (await acc.run('search_issues', { cursor: first.nextCursor })) as { nextCursor?: string };
    expect(ops.at(-1)!.variables.after).toBe('c1');
    expect(second.nextCursor).toBeUndefined();
  });

  it('turns GraphQL errors into clear errors', async () => {
    await expect(acc.run('get_issue', { id: 'ENG-404' })).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Linear: Issue not found',
    });
  });

  it('needs a team when the workspace has several, and resolves status names', async () => {
    await expect(acc.run('create_issue', { title: 'X' })).rejects.toMatchObject({
      kind: 'invalid_input',
      message: expect.stringContaining('ENG, DES'),
    });
    await acc.run('create_issue', {
      title: 'X',
      team: 'ENG',
      status: 'todo',
      assign_to_me: true,
      priority: 1,
    });
    expect(ops.at(-1)!.variables.input).toEqual({
      teamId: 't1',
      title: 'X',
      priority: 1,
      stateId: 's1',
      assigneeId: 'u1',
    });
    await expect(acc.run('update_issue', { id: 'ENG-7', status: 'Shipped' })).rejects.toMatchObject({
      message: expect.stringContaining('Todo, In Progress'),
    });
    await acc.run('update_issue', { id: 'ENG-7', status: 'In Progress', due_date: null });
    expect(ops.at(-1)!.variables).toEqual({ id: 'ENG-7', input: { stateId: 's2', dueDate: null } });
  });

  it('maps priorities between Linear and the shared scale', async () => {
    const listed = await acc.runCapability('tasks.list', {});
    expect(listed.items[0]).toEqual({
      id: 'ENG-7',
      title: 'Speed up export',
      status: 'open',
      due: '2026-11-20',
      priority: 3,
      project: 'ENG',
      url: 'https://linear.app/acme/issue/ENG-7',
    });
    expect(await acc.runCapability('tasks.create', { title: 'Y', project: 'ENG', priority: 4 })).toEqual({
      id: 'ENG-8',
      url: 'https://linear.app/acme/issue/ENG-7',
    });
    expect(ops.at(-1)!.variables.input).toMatchObject({ priority: 1 });
  });
});

describe('asana', () => {
  const task = {
    gid: '1201',
    name: 'Check the forms',
    due_on: '2026-11-07',
    due_at: null,
    completed: false,
    assignee: { gid: '9', name: 'Ann' },
    projects: [{ gid: '77', name: 'Website launch' }],
    permalink_url: 'https://app.asana.com/0/77/1201',
  };
  const service = fakeRoutes({
    'GET /api/1.0/users/me': (req) =>
      json({
        data:
          req.url.searchParams.get('opt_fields') === 'email,name'
            ? { gid: '9', name: 'Ann', email: 'ann@acme.com' }
            : { gid: '9', workspaces: [{ gid: '555', name: 'ACME' }] },
      }),
    'GET /api/1.0/tasks': { data: [task], next_page: { offset: 'off2', path: '/tasks?offset=off2' } },
    'GET /api/1.0/workspaces/555/typeahead': (req) =>
      json({
        data:
          req.url.searchParams.get('resource_type') === 'project'
            ? [{ gid: '77', name: 'Website launch' }]
            : [task, { ...task, gid: '1202', completed: true }],
      }),
    'POST /api/1.0/tasks': (req) =>
      json({ data: { ...task, gid: '1300', name: body(req).data.name } }, { status: 201 }),
    'PUT /api/1.0/tasks/1201': (req) => json({ data: { ...task, ...body(req).data } }),
  });
  const acc = testAccount(asana, { credentials: { token: '2/1234567890/abc:def' }, fetch: service.fetch });

  it('identifies the account with the bearer token', async () => {
    expect(await asana.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    expect(service.calls.at(-1)!.headers.get('authorization')).toBe('Bearer 2/1234567890/abc:def');
  });

  it('lists my open tasks in the only workspace and pages with offset', async () => {
    const page = (await acc.run('find_tasks', {})) as { items: unknown[]; nextCursor?: string };
    expect(page.items).toEqual([
      {
        id: '1201',
        name: 'Check the forms',
        completed: false,
        due: '2026-11-07',
        assignee: 'Ann',
        projects: ['Website launch'],
        url: 'https://app.asana.com/0/77/1201',
      },
    ]);
    const q = service.calls.at(-1)!.url.searchParams;
    expect([q.get('assignee'), q.get('workspace'), q.get('completed_since')]).toEqual(['me', '555', 'now']);
    await acc.run('find_tasks', { project: 'website launch', cursor: page.nextCursor });
    const next = service.calls.at(-1)!.url.searchParams;
    expect([next.get('project'), next.get('offset'), next.get('assignee')]).toEqual(['77', 'off2', null]);
  });

  it('searches by name and drops completed tasks', async () => {
    const page = (await acc.run('find_tasks', { query: 'forms' })) as { items: { id: string }[] };
    expect(page.items.map((t) => t.id)).toEqual(['1201']);
  });

  it('creates tasks in a named project or in my tasks', async () => {
    await acc.run('create_task', { name: 'Publish', project: 'Website launch' });
    expect(body(service.calls.at(-1)!)).toEqual({ data: { name: 'Publish', projects: ['77'] } });
    const created = await acc.runCapability('tasks.create', {
      title: 'Call ACME',
      due: '2026-11-09T10:00:00Z',
    });
    expect(created).toEqual({ id: '1300', url: 'https://app.asana.com/0/77/1201' });
    expect(body(service.calls.at(-1)!)).toEqual({
      data: { name: 'Call ACME', due_on: '2026-11-09', workspace: '555', assignee: 'me' },
    });
  });

  it('completes tasks and refuses empty updates', async () => {
    expect(await acc.run('update_task', { task_id: '1201', completed: true })).toMatchObject({
      completed: true,
    });
    await expect(acc.run('update_task', { task_id: '1201' })).rejects.toMatchObject({
      kind: 'invalid_input',
    });
  });

  it('maps tasks to the shared list', async () => {
    const listed = await acc.runCapability('tasks.list', { status: 'open' });
    expect(listed.items).toEqual([
      {
        id: '1201',
        title: 'Check the forms',
        status: 'open',
        due: '2026-11-07',
        project: 'Website launch',
        url: 'https://app.asana.com/0/77/1201',
      },
    ]);
  });
});

describe('trello', () => {
  const card = {
    id: 'c1',
    name: 'Landing page',
    due: '2026-11-08T12:00:00.000Z',
    dueComplete: false,
    idList: 'l1',
    idBoard: 'b1',
    url: 'https://trello.com/c/abc/1-landing-page',
    closed: false,
    badges: { votes: 0 },
  };
  const service = fakeRoutes({
    'GET /1/members/me': { id: 'm1', username: 'ann', fullName: 'Ann' },
    'GET /1/search': { options: {}, cards: [card] },
    'POST /1/cards': (req) => json({ ...card, ...body(req), id: 'c2' }),
    'PUT /1/cards/c1': (req) => json({ ...card, ...body(req) }),
  });
  const key = 'a'.repeat(32);
  const acc = testAccount(trello, {
    credentials: { apiKey: key, token: 'ATTA'.padEnd(64, 'x') },
    fetch: service.fetch,
  });

  it('sends key and token in the Authorization header, not the URL', async () => {
    expect(await trello.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann' });
    const call = service.calls.at(-1)!;
    expect(call.headers.get('authorization')).toBe(
      `OAuth oauth_consumer_key="${key}", oauth_token="${'ATTA'.padEnd(64, 'x')}"`,
    );
    expect(call.url.search).not.toContain('token');
  });

  it('creates cards in a list and moves them', async () => {
    await acc.run('create_card', { list_id: 'l1', name: 'Webinar' });
    expect(body(service.calls.at(-1)!)).toEqual({ idList: 'l1', name: 'Webinar', pos: 'bottom' });
    await acc.run('update_card', { card_id: 'c1', list_id: 'l2' });
    expect(body(service.calls.at(-1)!)).toEqual({ idList: 'l2' });
  });

  it('lists my open cards as tasks', async () => {
    const listed = await acc.runCapability('tasks.list', {});
    expect(service.calls.at(-1)!.url.searchParams.get('query')).toBe('@me is:open');
    expect(listed).toEqual([
      {
        id: 'c1',
        title: 'Landing page',
        status: 'open',
        due: '2026-11-08T12:00:00.000Z',
        url: 'https://trello.com/c/abc/1-landing-page',
      },
    ]);
  });
});

describe('airtable', () => {
  const record = {
    id: 'rec1',
    createdTime: '2026-11-01T00:00:00.000Z',
    fields: { Name: 'ACME', Status: 'Lead' },
  };
  const service = fakeRoutes({
    'GET /v0/meta/whoami': { id: 'usr1', email: 'ann@acme.com' },
    'GET /v0/appABC/Deals%20Q4': (req) =>
      json(req.url.searchParams.get('offset') ? { records: [] } : { records: [record], offset: 'itr1/rec1' }),
    'POST /v0/appABC/Deals%20Q4': (req) =>
      json({ records: body(req).records.map((r: object) => ({ ...record, ...r })) }),
  });
  const acc = testAccount(airtable, { credentials: { token: 'patXYZ.123' }, fetch: service.fetch });

  it('identifies the account and checks the token format', async () => {
    expect(await airtable.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    expect(service.calls.at(-1)!.headers.get('authorization')).toBe('Bearer patXYZ.123');
    expect(airtable.credentials.safeParse({ token: 'key123' }).success).toBe(false);
  });

  it('lists records with a formula and sort, and pages with offset', async () => {
    const page = (await acc.run('list_records', {
      base_id: 'appABC',
      table: 'Deals Q4',
      formula: "{Status} = 'Lead'",
      sort_field: 'Name',
    })) as { items: unknown[]; nextCursor?: string };
    expect(page.items).toEqual([record]);
    const q = service.calls.at(-1)!.url.searchParams;
    expect(Object.fromEntries(q)).toEqual({
      filterByFormula: "{Status} = 'Lead'",
      'sort[0][field]': 'Name',
      'sort[0][direction]': 'asc',
      pageSize: '30',
    });
    await acc.run('list_records', { base_id: 'appABC', table: 'Deals Q4', cursor: page.nextCursor });
    expect(service.calls.at(-1)!.url.searchParams.get('offset')).toBe('itr1/rec1');
  });

  it('creates records with typecast', async () => {
    await acc.run('create_records', {
      base_id: 'appABC',
      table: 'Deals Q4',
      records: [{ fields: { Name: 'Globex' } }],
    });
    expect(body(service.calls.at(-1)!)).toEqual({
      records: [{ fields: { Name: 'Globex' } }],
      typecast: true,
    });
  });

  it('refuses ids that are not Airtable ids (no path tricks)', () => {
    const action = airtable.actions.find((a) => a.name === 'get_record')!;
    expect(action.input.safeParse({ base_id: '../meta', table: 'T', record_id: 'rec1' }).success).toBe(false);
  });
});

describe('hubspot', () => {
  const contact = {
    id: '501',
    properties: {
      email: 'anna@acme.com',
      firstname: 'Anna',
      lastname: 'Smith',
      phone: null,
      company: 'ACME',
      hs_object_id: '501',
      createdate: '2026-10-01T00:00:00Z',
    },
    archived: false,
  };
  const service = fakeRoutes({
    'GET /account-info/v3/details': { portalId: 4242, uiDomain: 'app.hubspot.com' },
    'POST /crm/v3/objects/contacts/search': (req) =>
      json(
        body(req).after
          ? { total: 2, results: [] }
          : { total: 2, results: [contact], paging: { next: { after: '1', link: 'https://x' } } },
      ),
    'PATCH /crm/v3/objects/deals/900': (req) => json({ id: '900', properties: body(req).properties }),
  });
  const acc = testAccount(hubspot, { credentials: { token: 'pat-na1-abc' }, fetch: service.fetch });

  it('identifies the portal', async () => {
    expect(await hubspot.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'HubSpot 4242' });
    expect(service.calls.at(-1)!.headers.get('authorization')).toBe('Bearer pat-na1-abc');
  });

  it('searches contacts with chosen properties and pages with after in the body', async () => {
    const page = (await acc.run('search_contacts', { query: 'acme' })) as {
      items: unknown[];
      nextCursor?: string;
    };
    expect(page.items[0]).toEqual({
      id: '501',
      properties: {
        email: 'anna@acme.com',
        firstname: 'Anna',
        lastname: 'Smith',
        phone: null,
        company: 'ACME',
      },
    });
    expect(body(service.calls.at(-1)!)).toMatchObject({ query: 'acme', limit: 20 });
    await acc.run('search_contacts', { query: 'acme', cursor: page.nextCursor });
    expect(body(service.calls.at(-1)!)).toMatchObject({ query: 'acme', after: '1' });
  });

  it('updates only the given deal properties', async () => {
    await acc.run('update_deal', { deal_id: '900', dealstage: 'contractsent' });
    expect(body(service.calls.at(-1)!)).toEqual({ properties: { dealstage: 'contractsent' } });
  });

  it('finds contacts for the shared contact search', async () => {
    expect(await acc.runCapability('contacts.search', { query: 'anna' })).toEqual([
      { id: '501', name: 'Anna Smith', emails: ['anna@acme.com'], company: 'ACME' },
    ]);
  });
});
