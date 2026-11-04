import { describe, expect, it } from 'vitest';
import { blocksToMarkdown, markdownToBlocks } from '../../src/connectors/builtin/notion/format.js';
import notion, { notionId } from '../../src/connectors/builtin/notion/index.js';
import { fakeRoutes, json, testAccount } from './harness.js';

const PAGE = '1a2b3c4d5e6f40718293a4b5c6d7e8f9';
const PAGE_ID = '1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9';
const DB_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const rt = (text: string) => [{ type: 'text', plain_text: text, text: { content: text }, annotations: {} }];

const row = {
  object: 'page',
  id: PAGE_ID,
  url: `https://www.notion.so/Plan-${PAGE}`,
  last_edited_time: '2026-11-03T10:00:00.000Z',
  parent: { type: 'database_id', database_id: DB_ID },
  properties: {
    Name: { id: 'title', type: 'title', title: rt('Plan Q4') },
    Status: { id: 's', type: 'status', status: { id: '1', name: 'In progress', color: 'blue' } },
    Tags: { id: 't', type: 'multi_select', multi_select: [{ id: 'a', name: 'work', color: 'red' }] },
    Due: { id: 'd', type: 'date', date: { start: '2026-11-05', end: null, time_zone: null } },
    Points: { id: 'p', type: 'number', number: 3 },
    Notes: { id: 'n', type: 'rich_text', rich_text: [] },
  },
};

const blocks = [
  { id: 'b1', type: 'heading_2', has_children: false, heading_2: { rich_text: rt('Goals') } },
  {
    id: 'b2',
    type: 'bulleted_list_item',
    has_children: true,
    bulleted_list_item: { rich_text: rt('Ship hub') },
  },
  { id: 'b3', type: 'to_do', has_children: false, to_do: { rich_text: rt('Write docs'), checked: true } },
  { id: 'b4', type: 'child_page', has_children: true, child_page: { title: 'Details' } },
];

function setup() {
  const service = fakeRoutes({
    'GET /v1/users/me': { object: 'user', type: 'bot', bot: { workspace_name: 'Danel HQ' } },
    'POST /v1/search': { object: 'list', results: [row], next_cursor: 'cur2', has_more: true },
    [`GET /v1/pages/${PAGE_ID}`]: row,
    [`GET /v1/blocks/${PAGE_ID}/children`]: {
      object: 'list',
      results: blocks,
      next_cursor: null,
      has_more: false,
    },
    'GET /v1/blocks/b2/children': {
      object: 'list',
      results: [
        { id: 'c1', type: 'paragraph', has_children: false, paragraph: { rich_text: rt('by Friday') } },
      ],
      has_more: false,
      next_cursor: null,
    },
    [`GET /v1/databases/${DB_ID}`]: {
      object: 'database',
      id: DB_ID,
      title: rt('Projects'),
      properties: row.properties,
    },
    [`POST /v1/databases/${DB_ID}/query`]: {
      object: 'list',
      results: [row],
      next_cursor: null,
      has_more: false,
    },
    'POST /v1/pages': (req) =>
      json({ ...row, id: 'new-page-id', url: 'https://www.notion.so/new', _sent: JSON.parse(req.body!) }),
    [`PATCH /v1/pages/${PAGE_ID}`]: (req) => {
      const sent = JSON.parse(req.body!) as { properties: Record<string, object> };
      const properties: Record<string, object> = { ...row.properties };
      for (const [name, value] of Object.entries(sent.properties)) {
        properties[name] = { ...(properties[name] ?? {}), ...value };
      }
      return json({ ...row, properties });
    },
    [`PATCH /v1/blocks/${PAGE_ID}/children`]: { object: 'list', results: [] },
  });
  return {
    service,
    acc: testAccount(notion, { credentials: { token: 'ntn_secret' }, fetch: service.fetch }),
  };
}

describe('notion', () => {
  it('accepts ids and URLs', () => {
    expect(notionId(PAGE)).toBe(PAGE_ID);
    expect(notionId(`https://www.notion.so/acme/Plan-Q4-${PAGE}?pvs=4`)).toBe(PAGE_ID);
    expect(() => notionId('nope')).toThrow();
  });

  it('converts Markdown both ways', () => {
    const md = '# Title\n- item\n- [x] done\n1. first\n> quote\n```ts\nconst a = 1;\n```\ntext';
    const converted = markdownToBlocks(md) as { type: string }[];
    expect(converted.map((b) => b.type)).toEqual([
      'heading_1',
      'bulleted_list_item',
      'to_do',
      'numbered_list_item',
      'quote',
      'code',
      'paragraph',
    ]);
    const asNotion = converted.map((b, i) => ({ id: String(i), ...b })) as never;
    expect(blocksToMarkdown(asNotion)).toBe(
      md.replace('```ts\nconst a = 1;\n```', '```ts\nconst a = 1;\n```'),
    );
  });

  it('sends the token and API version, identifies the workspace', async () => {
    const { acc, service } = setup();
    expect(await notion.test!(acc.ctx as never)).toMatchObject({ identity: 'Danel HQ' });
    expect(service.calls[0]!.headers.get('notion-version')).toBe('2022-06-28');
    expect(service.calls[0]!.headers.get('authorization')).toBe('Bearer ntn_secret');
  });

  it('searches with compact results', async () => {
    const { acc } = setup();
    expect(await acc.run('search', { query: 'plan' })).toEqual({
      results: [
        {
          id: PAGE_ID,
          type: 'page',
          title: 'Plan Q4',
          url: `https://www.notion.so/Plan-${PAGE}`,
          edited: '2026-11-03T10:00:00.000Z',
        },
      ],
      nextCursor: 'cur2',
    });
  });

  it('reads a page as Markdown with plain properties', async () => {
    const { acc } = setup();
    const page = (await acc.run('read_page', { page_id: row.url })) as Record<string, unknown>;
    expect(page.properties).toEqual({ Status: 'In progress', Tags: ['work'], Due: '2026-11-05', Points: 3 });
    expect(page.content).toBe(`## Goals\n- Ship hub\n  by Friday\n- [x] Write docs\n📄 Details (page b4)`);
    expect(page.truncated).toBeUndefined();
  });

  it('queries a database into flat rows', async () => {
    const { acc } = setup();
    const result = (await acc.run('query_database', { database_id: DB_ID })) as {
      rows: Record<string, unknown>[];
    };
    expect(result.rows[0]).toMatchObject({ id: PAGE_ID, Name: 'Plan Q4', Status: 'In progress' });
  });

  it('creates a database row from plain values using the schema', async () => {
    const { acc, service } = setup();
    await acc.run('create_page', {
      database_id: DB_ID,
      title: 'New task',
      properties: { status: 'Done', Tags: ['home'], Due: '2026-11-10', Points: 5 },
      content: '- step one',
    });
    const sent = JSON.parse(service.calls.at(-1)!.body!);
    expect(sent.parent).toEqual({ database_id: DB_ID });
    expect(sent.properties).toEqual({
      Status: { status: { name: 'Done' } },
      Tags: { multi_select: [{ name: 'home' }] },
      Due: { date: { start: '2026-11-10' } },
      Points: { number: 5 },
      Name: { title: [{ text: { content: 'New task' } }] },
    });
    expect(sent.children[0].type).toBe('bulleted_list_item');
    await expect(
      acc.run('create_page', { database_id: DB_ID, title: 'x', properties: { Nope: 1 } }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
  });

  it('updates properties of a row', async () => {
    const { acc, service } = setup();
    const updated = (await acc.run('update_page', {
      page_id: PAGE_ID,
      properties: { Status: 'Done' },
    })) as Record<string, unknown>;
    expect(JSON.parse(service.calls.at(-1)!.body!)).toEqual({
      properties: { Status: { status: { name: 'Done' } } },
    });
    expect(updated.Status).toBe('Done');
  });

  it('maps "not shared with the integration" to not_found with Notion\'s hint', async () => {
    const service = fakeRoutes({
      [`GET /v1/pages/${PAGE_ID}`]: () =>
        json(
          {
            object: 'error',
            status: 404,
            code: 'object_not_found',
            message:
              'Could not find page. Make sure the relevant pages and databases are shared with your integration.',
          },
          { status: 404 },
        ),
      [`GET /v1/blocks/${PAGE_ID}/children`]: { results: [], has_more: false, next_cursor: null },
    });
    const acc = testAccount(notion, { credentials: { token: 'x' }, fetch: service.fetch });
    await expect(acc.run('read_page', { page_id: PAGE_ID })).rejects.toMatchObject({
      kind: 'not_found',
      message: expect.stringContaining('shared with your integration'),
    });
  });
});
