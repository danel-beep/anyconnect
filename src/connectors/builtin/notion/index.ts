import { z } from 'zod';
import { HttpClient } from '../../http/client.js';
import { type AccountContext, ConnectorError, defineConnector } from '../../sdk.js';
import {
  blocksToMarkdown,
  buildProperty,
  flattenProperties,
  markdownToBlocks,
  type RichText,
  titleOf,
} from './format.js';

/**
 * Notion API (version 2022-06-28). Credentials: an internal integration secret (`ntn_…`), or OAuth.
 * Pages are returned as Markdown and properties as plain values, so the AI reads a page in one call
 * without Notion's block JSON.
 */

const NOTION_VERSION = '2022-06-28';

const Credentials = z.object({
  token: z
    .string()
    .min(1)
    .optional()
    .describe('Internal integration secret (ntn_…): https://www.notion.so/profile/integrations'),
});

type Ctx = AccountContext<Record<string, never>, z.output<typeof Credentials>>;

function api(ctx: Ctx): HttpClient {
  if (!ctx.oauth && !ctx.credentials.token) throw new ConnectorError('auth', 'Notion is not connected yet');
  return new HttpClient(ctx, {
    baseUrl: 'https://api.notion.com/v1',
    headers: {
      'Notion-Version': NOTION_VERSION,
      ...(ctx.oauth ? {} : { authorization: `Bearer ${ctx.credentials.token}` }),
    },
    errorMessagePaths: ['message'],
  });
}

/** Accepts a Notion id with or without dashes, or a notion.so URL, and returns the dashed id. */
export function notionId(value: string): string {
  const match =
    value.replace(/-/g, '').match(/([0-9a-f]{32})(?:[?#].*)?$/i) ?? value.match(/([0-9a-f]{32})/i);
  if (!match) throw new ConnectorError('invalid_input', `"${value}" is not a Notion id or URL`);
  const h = match[1]!.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

interface NotionList<T> {
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
}

interface NotionPage {
  object: 'page' | 'database';
  id: string;
  url?: string;
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
  parent?: { type: string; database_id?: string; page_id?: string };
  properties?: Record<string, { type: string; id?: string } & Record<string, any>>;
  title?: RichText[];
}

type Block = { id: string; type: string; has_children?: boolean; children?: Block[] } & Record<string, any>;

const MAX_BLOCKS = 400;
const MAX_NESTED_FETCHES = 40;

/** Loads a page's blocks (paginated) and their children up to two levels deep, within limits. */
async function loadBlocks(client: HttpClient, id: string): Promise<{ blocks: Block[]; complete: boolean }> {
  let budget = MAX_BLOCKS;
  let nestedFetches = 0;
  let complete = true;
  const fetchChildren = async (parent: string, depth: number): Promise<Block[]> => {
    const out: Block[] = [];
    let cursor: string | undefined;
    do {
      const { data } = await client.get<NotionList<Block>>(`blocks/${parent}/children`, {
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      for (const block of data.results) {
        if (budget-- <= 0) {
          complete = false;
          return out;
        }
        out.push(block);
      }
      cursor = data.has_more && data.next_cursor ? data.next_cursor : undefined;
    } while (cursor);
    if (depth < 2) {
      for (const block of out) {
        if (!block.has_children || block.type === 'child_page' || block.type === 'child_database') continue;
        if (nestedFetches++ >= MAX_NESTED_FETCHES) {
          complete = false;
          break;
        }
        block.children = await fetchChildren(block.id, depth + 1);
      }
    }
    return out;
  };
  const blocks = await fetchChildren(id, 0);
  return { blocks, complete };
}

const summary = (object: NotionPage) => ({
  id: object.id,
  type: object.object,
  title: titleOf(object) || '(untitled)',
  ...(object.url ? { url: object.url } : {}),
  ...(object.last_edited_time ? { edited: object.last_edited_time } : {}),
});

/** Plain values → Notion property JSON, using the property types of the database or page. */
function buildProperties(
  values: Record<string, unknown>,
  schema: Record<string, { type: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    const property =
      schema[name] ?? Object.entries(schema).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    const key = schema[name] ? name : Object.keys(schema).find((k) => k.toLowerCase() === name.toLowerCase());
    if (!property || !key) {
      throw new ConnectorError(
        'invalid_input',
        `Unknown property "${name}". Known: ${Object.keys(schema).join(', ')}`,
      );
    }
    const built = buildProperty(property.type, value);
    if (built === undefined) {
      throw new ConnectorError('invalid_input', `Property "${key}" (${property.type}) cannot be set here`);
    }
    out[key] = built;
  }
  return out;
}

const PageId = z.string().trim().min(32).max(300).describe('Page id or Notion URL');
const Properties = z
  .record(z.string(), z.unknown())
  .describe('Plain values by property name, e.g. {"Status":"Done","Due":"2026-11-05","Tags":["work"]}');

export default defineConnector({
  id: 'notion',
  name: 'Notion',
  description:
    'Notion pages and databases: search, read pages as Markdown, query databases, create and update.',
  version: '1.0.0',
  homepage: 'https://developers.notion.com/reference',
  instructions:
    'The integration only sees pages shared with it. Ids and notion.so URLs are both accepted. Database rows are pages: update them with notion_update_page.',
  credentials: Credentials,
  oauth: { provider: 'notion', scopes: [] },
  async test(ctx) {
    const { data } = await api(ctx).get<{
      name?: string;
      bot?: { owner?: { user?: { name?: string } }; workspace_name?: string };
    }>('users/me');
    return { ok: true, identity: data.bot?.workspace_name ?? data.name ?? 'Notion' };
  },
  actions: (action) => [
    action({
      name: 'search',
      title: 'Search',
      description: 'Finds pages and databases by title, recently edited first.',
      input: z.object({
        query: z.string().max(500).default(''),
        type: z.enum(['page', 'database']).optional(),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().max(200).optional().describe('nextCursor from the previous page'),
      }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ query, type, limit, cursor }, ctx) => {
        const { data } = await api(ctx).post<NotionList<NotionPage>>('search', {
          query,
          page_size: limit,
          sort: { direction: 'descending', timestamp: 'last_edited_time' },
          ...(type ? { filter: { property: 'object', value: type } } : {}),
          ...(cursor ? { start_cursor: cursor } : {}),
        });
        return {
          results: data.results.map(summary),
          ...(data.has_more && data.next_cursor ? { nextCursor: data.next_cursor } : {}),
        };
      },
    }),
    action({
      name: 'read_page',
      title: 'Read page',
      description: 'Returns a page: title, properties as plain values and the content as Markdown.',
      input: z.object({
        page_id: PageId,
        maxChars: z.number().int().min(500).max(100_000).default(8000),
      }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ page_id, maxChars }, ctx) => {
        const client = api(ctx);
        const id = notionId(page_id);
        const [{ data: page }, { blocks, complete }] = await Promise.all([
          client.get<NotionPage>(`pages/${id}`),
          loadBlocks(client, id),
        ]);
        let content = blocksToMarkdown(blocks);
        const totalChars = content.length;
        const truncated = totalChars > maxChars || !complete;
        if (totalChars > maxChars) content = `${content.slice(0, maxChars)}…`;
        const properties = flattenProperties(page.properties);
        for (const [name, value] of Object.entries(page.properties ?? {})) {
          if (value.type === 'title') delete properties[name];
        }
        return {
          ...summary(page),
          ...(Object.keys(properties).length ? { properties } : {}),
          content,
          ...(truncated ? { truncated: true } : {}),
        };
      },
    }),
    action({
      name: 'query_database',
      title: 'Query database',
      description:
        'Lists rows of a database with properties as plain values. Optional Notion filter and sorts.',
      input: z.object({
        database_id: PageId.describe('Database id or URL'),
        filter: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Notion filter object, e.g. {"property":"Status","status":{"equals":"In progress"}}'),
        sorts: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe('e.g. [{"property":"Due","direction":"ascending"}]'),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().max(200).optional(),
      }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ database_id, filter, sorts, limit, cursor }, ctx) => {
        const { data } = await api(ctx).post<NotionList<NotionPage>>(
          `databases/${notionId(database_id)}/query`,
          {
            page_size: limit,
            ...(filter ? { filter } : {}),
            ...(sorts ? { sorts } : {}),
            ...(cursor ? { start_cursor: cursor } : {}),
          },
        );
        return {
          rows: data.results.map((row) => ({
            id: row.id,
            ...(row.url ? { url: row.url } : {}),
            ...flattenProperties(row.properties),
          })),
          ...(data.has_more && data.next_cursor ? { nextCursor: data.next_cursor } : {}),
        };
      },
    }),
    action({
      name: 'create_page',
      title: 'Create page',
      description: 'Creates a page under a parent page, or a row in a database, with Markdown content.',
      input: z
        .object({
          parent_page_id: PageId.optional(),
          database_id: PageId.optional().describe('Create a database row instead'),
          title: z.string().max(2000),
          properties: Properties.optional().describe('Database rows only: other property values'),
          content: z
            .string()
            .max(100_000)
            .optional()
            .describe('Markdown: headings, lists, to-dos, quotes, code'),
        })
        .refine((v) => Boolean(v.parent_page_id) !== Boolean(v.database_id), {
          message: 'pass exactly one of parent_page_id or database_id',
        }),
      hints: { readOnly: false, destructive: false },
      run: async ({ parent_page_id, database_id, title, properties, content }, ctx) => {
        const client = api(ctx);
        const children = content ? markdownToBlocks(content).slice(0, 100) : [];
        let body: Record<string, unknown>;
        if (database_id) {
          const id = notionId(database_id);
          const { data: database } = await client.get<NotionPage>(`databases/${id}`);
          const schema = database.properties ?? {};
          const titleName = Object.entries(schema).find(([, p]) => p.type === 'title')?.[0] ?? 'Name';
          body = {
            parent: { database_id: id },
            properties: buildProperties({ ...properties, [titleName]: title }, schema),
          };
        } else {
          body = {
            parent: { page_id: notionId(parent_page_id!) },
            properties: { title: buildProperty('title', title) },
          };
        }
        const { data } = await client.post<NotionPage>('pages', {
          ...body,
          ...(children.length ? { children } : {}),
        });
        return { id: data.id, ...(data.url ? { url: data.url } : {}) };
      },
    }),
    action({
      name: 'update_page',
      title: 'Update page',
      description: 'Changes properties of a page or database row (plain values), or moves it to trash.',
      input: z.object({
        page_id: PageId,
        properties: Properties.optional(),
        trash: z.boolean().optional().describe('true moves the page to trash, false restores it'),
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      run: async ({ page_id, properties, trash }, ctx) => {
        if (!properties && trash === undefined)
          throw new ConnectorError('invalid_input', 'Pass properties or trash');
        const client = api(ctx);
        const id = notionId(page_id);
        let built: Record<string, unknown> | undefined;
        if (properties) {
          const { data: page } = await client.get<NotionPage>(`pages/${id}`);
          built = buildProperties(properties, page.properties ?? {});
        }
        const { data } = await client.request<NotionPage>({
          method: 'PATCH',
          url: `pages/${id}`,
          json: {
            ...(built ? { properties: built } : {}),
            ...(trash !== undefined ? { archived: trash } : {}),
          },
        });
        return {
          id: data.id,
          ...flattenProperties(data.properties),
          ...(data.archived ? { trashed: true } : {}),
        };
      },
    }),
    action({
      name: 'append_content',
      title: 'Append to page',
      description: 'Adds Markdown content to the end of a page.',
      input: z.object({ page_id: PageId, content: z.string().min(1).max(100_000) }),
      hints: { readOnly: false, destructive: false },
      run: async ({ page_id, content }, ctx) => {
        const blocks = markdownToBlocks(content);
        const client = api(ctx);
        const id = notionId(page_id);
        // The API accepts at most 100 blocks per request.
        for (let i = 0; i < blocks.length; i += 100) {
          await client.request({
            method: 'PATCH',
            url: `blocks/${id}/children`,
            json: { children: blocks.slice(i, i + 100) },
          });
        }
        return { appended: blocks.length };
      },
    }),
  ],
});
