import { z } from 'zod';
import { HttpClient } from '../../http/client.js';
import { type AccountContext, type CapabilityOutput, ConnectorError, defineConnector } from '../../sdk.js';
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

type Summary = ReturnType<typeof summary>;

/** A page summary as the shared `files.*` item (Notion pages are documents). */
const fileItem = (p: Summary): CapabilityOutput<'files.search'> => ({
  id: p.id,
  name: p.title,
  mime_type: p.type === 'database' ? 'application/vnd.notion.database' : 'application/vnd.notion.page',
  ...(p.edited ? { modified: p.edited } : {}),
  ...(p.url ? { url: p.url } : {}),
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
  oauth: { provider: 'notion', scopes: [], optional: true },
  // Notion allows about three requests per second per integration.
  rateLimit: { requests: 3, perSeconds: 1 },
  async test(ctx) {
    const { data } = await api(ctx).get<{
      name?: string;
      bot?: { owner?: { user?: { name?: string } }; workspace_name?: string };
    }>('users/me');
    return { ok: true, identity: data.bot?.workspace_name ?? data.name ?? 'Notion' };
  },
  ui: {
    locales: {
      ru: {
        setup: {
          oauth: {
            summary: 'Вы входите в Notion и выбираете страницы, которые увидит ИИ.',
            minutes: 1,
            needs: ['Аккаунт Notion'],
            steps: [
              { text: 'Нажмите **Подключить** и войдите в Notion.' },
              {
                text: 'Выберите пространство, нажмите **Select pages** и отметьте страницы для Manyplug. ИИ увидит только их и всё, что внутри.',
              },
              {
                text: 'Нажмите **Allow access**. Вы вернётесь сюда, и пространство появится в списке аккаунтов.',
              },
            ],
            tips: [
              'Понадобятся ещё страницы? На странице в Notion откройте **•••** → **Connections** и добавьте Manyplug.',
            ],
            problems: [
              {
                problem: 'ИИ пишет, что не может найти страницу',
                fix: 'Эта страница не открыта для Manyplug. В Notion откройте её, нажмите **•••** → **Connections** и добавьте Manyplug.',
              },
              {
                problem: 'Notion не даёт подключить приложение к пространству',
                fix: 'В пространстве подключать приложения может только владелец. Попросите владельца пространства подключить Manyplug или разрешить это участникам.',
              },
            ],
          },
          form: {
            summary:
              'Вы создаёте внутреннюю интеграцию в Notion, открываете ей нужные страницы и вставляете сюда её секрет.',
            minutes: 3,
            needs: ['Пространство Notion, где вы владелец: только владельцы создают интеграции'],
            steps: [
              {
                text: 'Откройте интеграции Notion и нажмите **New integration**.',
                link: {
                  label: 'Открыть интеграции Notion',
                  url: 'https://www.notion.so/profile/integrations',
                },
              },
              {
                text: 'Назовите её Manyplug, выберите пространство, оставьте тип **Internal** и нажмите **Save**.',
              },
              {
                text: 'Скопируйте **Internal Integration Secret** (начинается с ntn_) и вставьте его в форму.',
                fills: ['token'],
              },
              {
                text: 'В Notion откройте каждую нужную страницу или базу, нажмите **•••** → **Connections** и добавьте интеграцию.',
              },
            ],
            tips: [
              'ИИ видит только страницы, открытые интеграции: начните с нужных и добавляйте остальные когда угодно.',
            ],
            problems: [
              {
                problem: '«API token is invalid»',
                fix: 'Скопируйте секрет ещё раз на странице интеграции кнопкой **Show** → **Copy**. Он начинается с ntn_ или secret_.',
              },
              {
                problem: 'ИИ пишет, что страница не найдена',
                fix: 'Страница не открыта интеграции. Откройте её в Notion, нажмите **•••** → **Connections** и добавьте Manyplug.',
              },
              {
                problem: 'Нет кнопки **New integration**',
                fix: 'Интеграции создают только владельцы пространства. Попросите владельца создать её или подключитесь кнопкой входа через Notion.',
              },
            ],
          },
        },
        prompts: [
          'Найди в Notion наш чек-лист онбординга и перескажи его.',
          'Добавь строку в «Контент-план»: «Пост о запуске», статус «Черновик», срок пятница.',
          'Что изменилось на странице Roadmap за эту неделю?',
          'Допиши заметки с сегодняшней встречи на страницу «Синк команды».',
        ],
        description:
          'Страницы и базы данных Notion: поиск, чтение страниц в Markdown, выборки из баз, создание и изменение.',
        fields: {
          token: {
            label: 'Секрет интеграции (ntn_…)',
            hint: 'Создайте внутреннюю интеграцию на notion.so/profile/integrations и откройте ей доступ к нужным страницам.',
          },
        },
        actions: {
          search: {
            title: 'Поиск',
            description: 'Находит страницы и базы данных по названию, сначала недавно изменённые.',
          },
          read_page: {
            title: 'Чтение страницы',
            description: 'Показывает страницу: название, свойства и содержимое в Markdown.',
          },
          query_database: {
            title: 'Выборка из базы',
            description: 'Строки базы данных со свойствами. Можно отфильтровать и отсортировать.',
          },
          create_page: {
            title: 'Новая страница',
            description:
              'Создаёт страницу внутри другой страницы или строку в базе данных, с содержимым в Markdown.',
          },
          update_page: {
            title: 'Изменение страницы',
            description: 'Меняет свойства страницы или строки базы либо переносит её в корзину.',
          },
          append_content: {
            title: 'Дополнение страницы',
            description: 'Дописывает содержимое в Markdown в конец страницы.',
          },
        },
      },
      en: {
        setup: {
          oauth: {
            summary: 'You sign in to Notion and choose the pages the AI may see.',
            minutes: 1,
            needs: ['A Notion account'],
            steps: [
              { text: 'Click **Connect** and sign in to Notion.' },
              {
                text: 'Pick the workspace, click **Select pages** and tick the pages for Manyplug. The AI sees only those pages and everything inside them.',
              },
              {
                text: 'Click **Allow access**. You are back here, and the workspace shows up in your accounts.',
              },
            ],
            tips: [
              'Need more pages later? On a page in Notion, open **•••** → **Connections** and add Manyplug.',
            ],
            problems: [
              {
                problem: 'The AI says it cannot find a page',
                fix: 'That page is not shared with Manyplug. Open it in Notion, click **•••** → **Connections** and add Manyplug.',
              },
              {
                problem: 'Notion does not let you add the app to the workspace',
                fix: 'Only a workspace owner can add apps there. Ask the owner to connect Manyplug or to let members do it.',
              },
            ],
          },
          form: {
            summary:
              'You create an internal integration in Notion, share the pages you need with it and paste its secret here.',
            minutes: 3,
            needs: ['A Notion workspace where you are an owner: only owners create integrations'],
            steps: [
              {
                text: 'Open Notion integrations and click **New integration**.',
                link: {
                  label: 'Open Notion integrations',
                  url: 'https://www.notion.so/profile/integrations',
                },
              },
              {
                text: 'Name it Manyplug, pick your workspace, keep the type **Internal** and click **Save**.',
              },
              {
                text: 'Copy the **Internal Integration Secret** (it starts with ntn_) and paste it into the form.',
                fills: ['token'],
              },
              {
                text: 'In Notion, open each page or database the AI should see, click **•••** → **Connections** and add the integration.',
              },
            ],
            tips: [
              'The AI only sees pages shared with the integration, so start with the ones you need and add more any time.',
            ],
            problems: [
              {
                problem: '“API token is invalid”',
                fix: 'Copy the secret again on the integration page with **Show** → **Copy**. It starts with ntn_ or secret_.',
              },
              {
                problem: 'The AI says a page cannot be found',
                fix: 'The page is not shared with the integration. Open it in Notion, click **•••** → **Connections** and add Manyplug.',
              },
              {
                problem: 'There is no **New integration** button',
                fix: 'Only workspace owners create integrations. Ask an owner to create it, or connect with the Notion sign-in button instead.',
              },
            ],
          },
        },
        prompts: [
          'Find our onboarding checklist in Notion and summarise it.',
          'Add a row to Content calendar: “Launch post”, status Draft, due Friday.',
          'What changed on the Roadmap page this week?',
          'Append today’s meeting notes to the “Team sync” page.',
        ],
        fields: {
          token: {
            label: 'Integration secret (ntn_…)',
            hint: 'Create an internal integration at notion.so/profile/integrations and give it access to the pages you need.',
          },
        },
        actions: {
          search: {
            title: 'Search',
            description: 'Finds pages and databases by title, recently edited first.',
          },
          read_page: {
            title: 'Read a page',
            description: 'Shows a page: its title, properties and content as Markdown.',
          },
          query_database: {
            title: 'Query a database',
            description: 'Rows of a database with their properties, optionally filtered and sorted.',
          },
          create_page: {
            title: 'Create a page',
            description: 'Creates a page under another page, or a row in a database, with Markdown content.',
          },
          update_page: {
            title: 'Update a page',
            description: 'Changes properties of a page or database row, or moves it to the trash.',
          },
          append_content: {
            title: 'Add to a page',
            description: 'Adds Markdown content to the end of a page.',
          },
        },
      },
    },
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
      capability: {
        id: 'files.search',
        mapInput: ({ query, limit }) => ({ query, limit, type: 'page' }),
        mapOutput: (result) => {
          const { results, nextCursor } = result as { results: Summary[]; nextCursor?: string };
          return { items: results.map(fileItem), ...(nextCursor ? { nextCursor } : {}) };
        },
      },
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
      capability: {
        id: 'files.read',
        mapInput: ({ id, max_chars }) => ({
          page_id: id,
          maxChars: Math.min(100_000, Math.max(500, Number(max_chars))),
        }),
        mapOutput: (result): CapabilityOutput<'files.read'> => {
          const r = result as Summary & { content: string; truncated?: boolean };
          return { ...fileItem(r), text: r.content, ...(r.truncated ? { truncated: true } : {}) };
        },
      },
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
      risk: 'write',
      undo: { kind: 'action', action: 'update_page', note: 'trash: true' },
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
      // Trashed pages are restorable (trash: false).
      risk: 'write',
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
      risk: 'write',
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
