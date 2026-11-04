import { describe, expect, it } from 'vitest';
import figma from '../../src/connectors/builtin/figma.js';
import freshdesk from '../../src/connectors/builtin/freshdesk.js';
import mailchimp from '../../src/connectors/builtin/mailchimp.js';
import monday from '../../src/connectors/builtin/monday.js';
import sentry from '../../src/connectors/builtin/sentry.js';
import typeform from '../../src/connectors/builtin/typeform.js';
import wordpress from '../../src/connectors/builtin/wordpress.js';
import { fakeRoutes, json, type RecordedRequest, testAccount } from './harness.js';

// Third catalogue batch. Fixtures follow the documented response shapes of each API, trimmed.

const body = (req: RecordedRequest) => JSON.parse(req.body!);
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('monday.com', () => {
  const ops: { query: string; variables: Record<string, unknown> }[] = [];
  const item = {
    id: '101',
    name: 'Landing page',
    state: 'active',
    updated_at: '2026-11-03T10:00:00Z',
    url: 'https://acme.monday.com/boards/7/pulses/101',
    group: { id: 'topics', title: 'This week' },
    board: { id: '7', name: 'Marketing' },
    column_values: [
      { id: 'status', text: 'Working on it', type: 'status', column: { title: 'Status' } },
      { id: 'date4', text: '', type: 'date', column: { title: 'Due' } },
    ],
  };
  const service = fakeRoutes({
    'POST /v2': (req) => {
      const op = body(req) as { query: string; variables: Record<string, unknown> };
      ops.push(op);
      if (op.query.includes('me {')) return json({ data: { me: { name: 'Ann', email: 'ann@acme.com' } } });
      if (op.query.includes('next_items_page')) {
        return json({ data: { next_items_page: { cursor: null, items: [] } } });
      }
      if (op.query.includes('items_page')) {
        return json({ data: { boards: [{ items_page: { cursor: 'c2', items: [item] } }] } });
      }
      if (op.query.includes('columns {')) {
        return json({
          data: {
            boards: [
              {
                id: '7',
                name: 'Marketing',
                groups: [{ id: 'topics', title: 'This week' }],
                columns: [
                  {
                    id: 'status',
                    title: 'Status',
                    type: 'status',
                    settings_str: '{"labels":{"0":"Working on it","1":"Done","2":"Stuck"}}',
                  },
                ],
              },
            ],
          },
        });
      }
      if (op.query.includes('change_multiple_column_values')) {
        return json({ data: { change_multiple_column_values: { ...item, name: 'Landing' } } });
      }
      if (op.query.includes('archive_item')) {
        return json({
          errors: [{ message: 'Item not found', extensions: { code: 'InvalidItemIdException' } }],
        });
      }
      return json({ errors: [{ message: 'Unexpected', extensions: { code: 'X' } }] });
    },
  });
  const acc = testAccount(monday, {
    credentials: { token: 'eyJhbGciOiJIUzI1NiJ9.token' },
    fetch: service.fetch,
  });

  it('sends the token as is, with a pinned API version', async () => {
    expect(await monday.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    const call = service.calls.at(-1)!;
    expect(call.headers.get('authorization')).toBe('eyJhbGciOiJIUzI1NiJ9.token');
    expect(call.headers.get('api-version')).toBe('2025-04');
  });

  it('searches items by name, keeps filled columns by title, and pages with the cursor', async () => {
    const result = (await acc.run('list_items', { board_id: 7, query: 'landing' })) as {
      items: unknown[];
      nextCursor?: string;
    };
    expect(ops.at(-1)!.variables).toMatchObject({
      ids: ['7'],
      params: { rules: [{ column_id: 'name', compare_value: ['landing'], operator: 'contains_text' }] },
    });
    expect(result.items[0]).toEqual({
      id: '101',
      name: 'Landing page',
      board: 'Marketing',
      board_id: '7',
      group: 'This week',
      updated: '2026-11-03T10:00:00Z',
      columns: { Status: 'Working on it' },
      url: 'https://acme.monday.com/boards/7/pulses/101',
    });
    expect(result.nextCursor).toBe('c2');
    await acc.run('list_items', { board_id: 7, cursor: 'c2' });
    expect(ops.at(-1)!.query).toContain('next_items_page');
    expect(ops.at(-1)!.variables).toEqual({ cursor: 'c2', limit: 25 });
  });

  it('lists status labels of a board', async () => {
    const board = (await acc.run('get_board', { board_id: '7' })) as { columns: unknown[] };
    expect(board.columns).toEqual([
      { id: 'status', title: 'Status', type: 'status', labels: ['Working on it', 'Done', 'Stuck'] },
    ]);
  });

  it('sends column values as a JSON string, with the name merged in', async () => {
    await acc.run('update_item', {
      board_id: 7,
      item_id: 101,
      name: 'Landing',
      column_values: { status: { label: 'Done' } },
    });
    expect(JSON.parse(String(ops.at(-1)!.variables.values))).toEqual({
      status: { label: 'Done' },
      name: 'Landing',
    });
    await expect(acc.run('update_item', { board_id: 7, item_id: 101 })).rejects.toMatchObject({
      kind: 'invalid_input',
    });
  });

  it('turns GraphQL errors into connector errors', async () => {
    await expect(acc.run('archive_item', { item_id: 999 })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('freshdesk', () => {
  const service = fakeRoutes({
    'GET /api/v2/agents/me': { id: 1, contact: { name: 'Ann', email: 'ann@acme.com' } },
    'GET /api/v2/search/tickets': {
      results: [{ id: 1207, subject: 'Where is my order', status: 2 }],
      total: 1,
    },
    'POST /api/v2/tickets/1207/notes': (req) => json({ id: 5, ticket_id: 1207, ...body(req) }),
    'POST /api/v2/tickets/1207/reply': (req) => json({ id: 6, ticket_id: 1207, ...body(req) }),
    'GET /api/v2/contacts/autocomplete': [{ id: 9, name: 'Anna Smith' }],
  });
  const acc = testAccount(freshdesk, {
    config: { domain: 'acme' },
    credentials: { apiKey: 'abcdef123456' },
    fetch: service.fetch,
  });

  it('uses the key as the basic-auth user name', async () => {
    expect(await freshdesk.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    expect(service.calls.at(-1)!.headers.get('authorization')).toBe(basic('abcdef123456', 'X'));
  });

  it('quotes search queries and pages by number', async () => {
    const result = (await acc.run('search_tickets', { query: 'status:2 AND priority:4' })) as {
      nextCursor?: string;
    };
    expect(service.calls.at(-1)!.url.searchParams.get('query')).toBe('"status:2 AND priority:4"');
    expect(service.calls.at(-1)!.url.searchParams.get('page')).toBe('1');
    await acc.run('search_tickets', { query: 'status:2', cursor: result.nextCursor });
    expect(service.calls.at(-1)!.url.searchParams.get('page')).toBe('2');
  });

  it('keeps notes private by default and marks replies dangerous', async () => {
    await acc.run('add_note', { ticket_id: 1207, body: 'Checked the warehouse' });
    expect(body(service.calls.at(-1)!)).toEqual({ body: 'Checked the warehouse', private: true });
    expect(freshdesk.actions.find((a) => a.name === 'reply')!.risk).toBe('dangerous');
  });

  it('finds people for the shared contact search', async () => {
    expect(await acc.runCapability('contacts.search', { query: 'anna' })).toEqual([
      { id: '9', name: 'Anna Smith' },
    ]);
    expect(service.calls.at(-1)!.url.searchParams.get('term')).toBe('anna');
  });
});

describe('sentry', () => {
  const issuesUrl = 'https://de.sentry.io/api/0/organizations/acme/issues/';
  const service = fakeRoutes({
    'GET /api/0/organizations/acme/': { id: '1', slug: 'acme', name: 'ACME' },
    'GET /api/0/organizations/acme/issues/': (req) =>
      json(
        [
          {
            id: '42',
            shortId: 'WEB-1A2',
            title: 'TypeError: x is undefined',
            level: 'error',
            status: 'unresolved',
            count: '120',
            project: { id: '3', slug: 'web' },
            assignedTo: null,
            stats: { '24h': [] },
          },
        ],
        {
          headers: {
            link: req.url.searchParams.get('cursor')
              ? `<${issuesUrl}?cursor=0:200:0>; rel="previous"; results="true"; cursor="0:0:1", <${issuesUrl}?cursor=0:300:0>; rel="next"; results="false"; cursor="0:300:0"`
              : `<${issuesUrl}?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <${issuesUrl}?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"`,
          },
        },
      ),
    'PUT /api/0/organizations/acme/issues/WEB-1A2/': (req) => json({ id: '42', ...body(req) }),
  });
  const acc = testAccount(sentry, {
    config: { host: 'de.sentry.io', organization: 'acme' },
    credentials: { token: 'sntryu_0123456789abcdef0123' },
    fetch: service.fetch,
  });

  it('talks to the chosen region of the organization', async () => {
    expect(await sentry.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ACME' });
    const call = service.calls.at(-1)!;
    expect(call.url.host).toBe('de.sentry.io');
    expect(call.headers.get('authorization')).toBe('Bearer sntryu_0123456789abcdef0123');
  });

  it('follows next links until Sentry says there are no more results', async () => {
    const first = (await acc.run('list_issues', {})) as { items: unknown[]; nextCursor?: string };
    expect(service.calls.at(-1)!.url.searchParams.get('query')).toBe('is:unresolved');
    expect(service.calls.at(-1)!.url.searchParams.get('statsPeriod')).toBe('14d');
    expect(first.items[0]).toEqual({
      id: '42',
      shortId: 'WEB-1A2',
      title: 'TypeError: x is undefined',
      level: 'error',
      status: 'unresolved',
      count: '120',
      project: { slug: 'web' },
    });
    expect(first.nextCursor).toBeDefined();
    const second = (await acc.run('list_issues', { cursor: first.nextCursor })) as { nextCursor?: string };
    expect(service.calls.at(-1)!.url.searchParams.get('cursor')).toBe('0:100:0');
    expect(second.nextCursor).toBeUndefined();
  });

  it('resolves and assigns with the API field names', async () => {
    await acc.run('update_issue', { issue_id: 'WEB-1A2', status: 'resolved', assigned_to: 'ann@acme.com' });
    expect(body(service.calls.at(-1)!)).toEqual({ status: 'resolved', assignedTo: 'ann@acme.com' });
  });
});

describe('figma', () => {
  const service = fakeRoutes({
    'GET /v1/me': { id: '1', email: 'ann@acme.com', handle: 'Ann' },
    'GET /v1/files/AbCdEf123456': (req) =>
      json({
        name: 'Landing',
        lastModified: '2026-11-01T10:00:00Z',
        version: '1',
        editorType: 'figma',
        thumbnailUrl: 'https://x.test/t.png',
        depth: req.url.searchParams.get('depth'),
        document: { id: '0:0', children: [{ id: '0:1', name: 'Page 1', children: [] }] },
      }),
    'POST /v1/files/AbCdEf123456/comments': (req) => json({ id: 'c1', created_at: 'now', ...body(req) }),
  });
  const acc = testAccount(figma, { credentials: { token: 'figd_abc' }, fetch: service.fetch });

  it('sends the personal token in X-Figma-Token', async () => {
    expect(await figma.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    expect(service.calls.at(-1)!.headers.get('x-figma-token')).toBe('figd_abc');
  });

  it('reads only the top of the document tree', async () => {
    const file = await acc.run('get_file', { file_key: 'AbCdEf123456' });
    expect(service.calls.at(-1)!.url.searchParams.get('depth')).toBe('2');
    expect(file).toEqual({
      name: 'Landing',
      lastModified: '2026-11-01T10:00:00Z',
      version: '1',
      editorType: 'figma',
      document: { children: [{ id: '0:1', name: 'Page 1', children: [] }] },
    });
  });

  it('pins comments to a node only when asked', async () => {
    await acc.run('add_comment', { file_key: 'AbCdEf123456', message: 'Looks good' });
    expect(body(service.calls.at(-1)!)).toEqual({ message: 'Looks good' });
    await acc.run('comment_on_node', { file_key: 'AbCdEf123456', node_id: '12:34', message: 'Orange' });
    expect(body(service.calls.at(-1)!)).toEqual({
      message: 'Orange',
      client_meta: { node_id: '12:34', node_offset: { x: 0, y: 0 } },
    });
  });
});

describe('wordpress', () => {
  const next = 'https://acme.com/blog/wp-json/wp/v2/posts?page=2';
  const service = fakeRoutes({
    'GET /blog/wp-json/wp/v2/users/me': { id: 1, name: 'Ann', email: 'ann@acme.com' },
    'GET /blog/wp-json/wp/v2/posts': (req) =>
      json(
        [
          {
            id: 7,
            status: 'draft',
            link: 'https://acme.com/blog/?p=7',
            title: { rendered: 'Launch', raw: 'Launch' },
            content: { rendered: '<p>…</p>' },
            guid: { rendered: 'x' },
          },
        ],
        req.url.searchParams.get('page') ? {} : { headers: { link: `<${next}>; rel="next"` } },
      ),
    'POST /blog/wp-json/wp/v2/posts': (req) => json({ id: 8, ...body(req) }),
    'POST /blog/wp-json/wp/v2/posts/8': (req) => json({ id: 8, ...body(req) }),
  });
  const acc = testAccount(wordpress, {
    config: { site: 'acme.com/blog', username: 'ann' },
    credentials: { appPassword: 'abcd EFGH ijkl MNOP qrst UVWX' },
    fetch: service.fetch,
  });

  it('uses the application password over basic auth on the site path', async () => {
    expect(await wordpress.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    const call = service.calls.at(-1)!;
    expect(call.url.href).toBe('https://acme.com/blog/wp-json/wp/v2/users/me?context=edit');
    expect(call.headers.get('authorization')).toBe(basic('ann', 'abcd EFGH ijkl MNOP qrst UVWX'));
  });

  it('lists posts with link pagination and trimmed fields', async () => {
    const result = (await acc.run('list_posts', { search: 'launch' })) as {
      items: unknown[];
      nextCursor?: string;
    };
    expect(service.calls.at(-1)!.url.searchParams.get('status')).toBe('any');
    expect(result.items[0]).toEqual({
      id: 7,
      status: 'draft',
      link: 'https://acme.com/blog/?p=7',
      title: { rendered: 'Launch' },
    });
    await acc.run('list_posts', { cursor: result.nextCursor });
    expect(service.calls.at(-1)!.url.href).toBe(next);
  });

  it('creates drafts and keeps publishing a separate, dangerous step', async () => {
    await acc.run('create_post', { title: 'Year in review', content: '<p>Hi</p>' });
    expect(body(service.calls.at(-1)!)).toEqual({
      title: 'Year in review',
      content: '<p>Hi</p>',
      status: 'draft',
    });
    expect(wordpress.actions.find((a) => a.name === 'publish_post')!.risk).toBe('dangerous');
    await acc.run('publish_post', { post_id: 8, date: '2026-11-20T09:00:00' });
    expect(body(service.calls.at(-1)!)).toEqual({ status: 'publish', date: '2026-11-20T09:00:00' });
  });
});

describe('mailchimp', () => {
  const service = fakeRoutes({
    'GET /3.0/': { account_name: 'ACME', email: 'ann@acme.com' },
    'GET /3.0/lists': (req) =>
      json({
        lists:
          Number(req.url.searchParams.get('offset') ?? 0) >= 2
            ? []
            : [
                { id: 'a1', name: 'Newsletter', stats: { member_count: 1200 }, contact: { company: 'ACME' } },
                { id: 'a2', name: 'Beta', stats: { member_count: 40 } },
              ],
      }),
    'PUT /3.0/lists/a1/members/ben%40acme.com': (req) =>
      json({ id: 'h', email_address: 'ben@acme.com', status: 'pending', ...body(req) }),
    'POST /3.0/lists/a1/members/ben%40acme.com/tags': () => new Response(null, { status: 204 }),
  });
  const acc = testAccount(mailchimp, {
    config: { dc: 'us21' },
    credentials: { apiKey: `${'0'.repeat(32)}-us21` },
    fetch: service.fetch,
  });

  it('calls the data center of the key', async () => {
    expect(await mailchimp.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    const call = service.calls.at(-1)!;
    expect(call.url.host).toBe('us21.api.mailchimp.com');
    expect(call.headers.get('authorization')).toBe(basic('manyplug', `${'0'.repeat(32)}-us21`));
  });

  it('pages audiences by offset', async () => {
    const first = (await acc.run('list_audiences', { count: 2 })) as {
      items: unknown[];
      nextCursor?: string;
    };
    expect(first.items).toEqual([
      { id: 'a1', name: 'Newsletter', stats: { member_count: 1200 } },
      { id: 'a2', name: 'Beta', stats: { member_count: 40 } },
    ]);
    await acc.run('list_audiences', { count: 2, cursor: first.nextCursor });
    expect(service.calls.at(-1)!.url.searchParams.get('offset')).toBe('2');
  });

  it('adds subscribers as pending unless told otherwise, and tags them', async () => {
    await acc.run('add_member', {
      list_id: 'a1',
      email: 'ben@acme.com',
      first_name: 'Ben',
      tags: ['webinar'],
    });
    expect(body(service.calls.at(-1)!)).toEqual({
      email_address: 'ben@acme.com',
      status_if_new: 'pending',
      merge_fields: { FNAME: 'Ben' },
      tags: ['webinar'],
    });
    expect(
      await acc.run('tag_member', {
        list_id: 'a1',
        email: 'ben@acme.com',
        tags: [{ name: 'vip', status: 'active' }],
      }),
    ).toBe('Tags updated.');
    expect(body(service.calls.at(-1)!)).toEqual({ tags: [{ name: 'vip', status: 'active' }] });
  });
});

describe('typeform', () => {
  const service = fakeRoutes({
    'GET /me': { alias: 'Ann', email: 'ann@acme.com' },
    'GET /forms/abc123/responses': {
      total_items: 1,
      page_count: 1,
      items: [
        {
          token: 't1',
          landing_id: 't1',
          submitted_at: '2026-11-02T10:00:00Z',
          metadata: { user_agent: 'x' },
          answers: [{ field: { id: 'f1', type: 'short_text', ref: 'name' }, type: 'text', text: 'Ann' }],
        },
      ],
    },
    'DELETE /forms/abc123/responses': () => new Response(null, { status: 200 }),
  });
  const acc = testAccount(typeform, {
    config: { host: 'api.eu.typeform.com' },
    credentials: { token: 'tfp_0123456789abcdefghij' },
    fetch: service.fetch,
  });

  it('uses the EU API when the account lives there', async () => {
    expect(await typeform.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    expect(service.calls.at(-1)!.url.host).toBe('api.eu.typeform.com');
  });

  it('returns completed responses without metadata noise', async () => {
    const result = await acc.run('list_responses', { form_id: 'abc123', since: '2026-11-01T00:00:00Z' });
    expect(service.calls.at(-1)!.url.searchParams.get('completed')).toBe('true');
    expect(result).toEqual([
      {
        token: 't1',
        submitted_at: '2026-11-02T10:00:00Z',
        answers: [{ field: { id: 'f1', type: 'short_text', ref: 'name' }, type: 'text', text: 'Ann' }],
      },
    ]);
  });

  it('deletes responses only as a dangerous action', async () => {
    expect(typeform.actions.find((a) => a.name === 'delete_responses')!.risk).toBe('dangerous');
    await acc.run('delete_responses', { form_id: 'abc123', tokens: 't1,t2' });
    expect(service.calls.at(-1)!.url.searchParams.get('included_response_ids')).toBe('t1,t2');
  });
});
