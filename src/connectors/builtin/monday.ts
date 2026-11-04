import { z } from 'zod';
import { HttpClient } from '../http/client.js';
import {
  type AccountContext,
  ConnectorError,
  compact,
  defineConnector,
  type ErrorKind,
  page,
  truncateText,
} from '../sdk.js';

/**
 * monday.com GraphQL API with a personal API token. GraphQL reports failures as `errors` (often in an
 * HTTP 200 answer) and column values travel as JSON strings, so this is a code connector on top of
 * the shared HTTP client.
 */

const API_VERSION = '2025-04';

const Credentials = z.object({
  token: z
    .string()
    .trim()
    .min(20, 'paste the whole API token')
    .describe('Personal API token: avatar → Developers → API token'),
});

type Ctx = AccountContext<Record<string, never>, z.output<typeof Credentials>>;

interface GraphQLError {
  message: string;
  extensions?: { code?: string; retry_in_seconds?: number };
}

const ERROR_KINDS: Record<string, ErrorKind> = {
  UNAUTHENTICATED: 'auth',
  USER_UNAUTHORIZED: 'permission',
  FORBIDDEN: 'permission',
  COMPLEXITY_BUDGET_EXHAUSTED: 'rate_limited',
  RATE_LIMIT_EXCEEDED: 'rate_limited',
  ComplexityException: 'rate_limited',
  ResourceNotFoundException: 'not_found',
  InvalidBoardIdException: 'not_found',
  InvalidItemIdException: 'not_found',
  InvalidColumnIdException: 'invalid_input',
  ColumnValueException: 'invalid_input',
};

/** Runs a GraphQL operation; `errors` in the answer become a `ConnectorError` of the right kind. */
export async function mondayQuery<T>(ctx: Ctx, query: string, variables: Record<string, unknown> = {}) {
  const client = new HttpClient(ctx, {
    baseUrl: 'https://api.monday.com',
    headers: { authorization: ctx.credentials.token, 'api-version': API_VERSION },
    errorMessagePaths: ['errors.0.message', 'error_message'],
  });
  const response = await client.request<{
    data?: T;
    errors?: GraphQLError[];
    error_code?: string;
    error_message?: string;
  }>({ method: 'POST', url: '/v2', json: { query, variables } });
  const body = response.data;
  const error = body?.errors?.[0];
  if (error || body?.error_message || !body?.data) {
    const code = error?.extensions?.code ?? body?.error_code ?? '';
    const kind = ERROR_KINDS[code] ?? 'invalid_input';
    const message = error?.message ?? body?.error_message ?? 'empty answer';
    throw new ConnectorError(
      kind,
      `monday.com: ${message}`,
      kind === 'rate_limited' ? { retryAfterSeconds: error?.extensions?.retry_in_seconds ?? 60 } : {},
    );
  }
  return body.data;
}

interface ColumnValue {
  id: string;
  text?: string | null;
  type?: string;
  column?: { title: string };
}

interface ItemNode {
  id: string;
  name: string;
  state?: string;
  updated_at?: string;
  url?: string;
  group?: { id: string; title: string } | null;
  board?: { id: string; name: string } | null;
  column_values?: ColumnValue[];
}

const ITEM_NODE =
  'id name state updated_at url group { id title } board { id name } column_values { id text type column { title } }';

/** Compact item: non-empty column values keyed by their title. */
const itemOut = (i: ItemNode) =>
  compact({
    id: i.id,
    name: i.name,
    board: i.board?.name,
    board_id: i.board?.id,
    group: i.group?.title,
    state: i.state === 'active' ? undefined : i.state,
    updated: i.updated_at,
    columns: Object.fromEntries(
      (i.column_values ?? [])
        .filter((c) => c.text)
        .map((c) => [c.column?.title ?? c.id, truncateText(String(c.text), 500)]),
    ),
    url: i.url,
  });

const Id = z
  .union([z.string().regex(/^\d+$/), z.number().int().positive()])
  .transform(String)
  .describe('Numeric id');
const ColumnValues = z
  .record(z.string(), z.unknown())
  .describe(
    'By column id (from monday_get_board): text "abc", numbers "42", status {"label":"Done"}, date {"date":"2026-11-20"}, people {"personsAndTeams":[{"id":123,"kind":"person"}]}',
  );

export default defineConnector({
  id: 'monday',
  name: 'monday.com',
  description: 'monday.com boards and items: find and read items, create, update columns, post updates.',
  version: '1.0.0',
  homepage: 'https://developer.monday.com/api-reference/',
  instructions:
    'Items live on boards in groups. Column values are set by column id: read the board with monday_get_board first to see column ids, types and status labels.',
  credentials: Credentials,
  rateLimit: { requests: 60, perSeconds: 60 },
  async test(ctx) {
    const { me } = await mondayQuery<{ me: { name: string; email?: string; account?: { name: string } } }>(
      ctx,
      'query { me { name email account { name } } }',
    );
    return { ok: true, identity: me.email ?? me.name };
  },
  ui: {
    locales: {
      ru: {
        description: 'Доски и элементы monday.com: поиск и чтение, создание, изменение колонок, обновления.',
        setup: {
          form: {
            summary: 'Личный токен API monday.com. Меньше минуты.',
            steps: [
              {
                text: 'В monday.com нажмите на аватар → Developers, откройте My access tokens.',
                link: {
                  label: 'Где найти токен',
                  url: 'https://developer.monday.com/api-reference/docs/authentication',
                },
              },
              { text: 'Нажмите Show, затем Copy, чтобы скопировать токен.' },
              { text: 'Вставьте токен в форму.' },
            ],
            tips: [
              'Токен действует от вашего имени и видит те же доски, что и вы.',
              'Если нажать Regenerate, старый токен перестанет работать: тогда вставьте новый.',
            ],
          },
        },
        prompts: [
          'Какие задачи на доске «Маркетинг» в статусе «В работе»?',
          'Добавь на доску «Контент-план» элемент «Пост о запуске» со сроком на пятницу.',
          'Поставь элементу «Лендинг» статус Done и напиши апдейт, что всё готово.',
          'Перескажи последние апдейты по элементу «Редизайн».',
        ],
        fields: { token: { label: 'Токен API', hint: 'Аватар → Developers → My access tokens.' } },
        actions: {
          list_boards: { title: 'Доски', description: 'Доски с id и рабочими пространствами.' },
          get_board: { title: 'Доска', description: 'Группы и колонки доски с вариантами статусов.' },
          list_items: { title: 'Элементы', description: 'Элементы доски, с поиском по названию.' },
          get_item: { title: 'Элемент', description: 'Колонки и последние апдейты элемента.' },
          create_item: { title: 'Новый элемент', description: 'Создаёт элемент на доске.' },
          update_item: { title: 'Изменение элемента', description: 'Меняет название и значения колонок.' },
          add_update: { title: 'Апдейт', description: 'Пишет обновление к элементу.' },
          archive_item: { title: 'В архив', description: 'Архивирует элемент (его можно вернуть).' },
        },
      },
      en: {
        setup: {
          form: {
            summary: 'Your monday.com personal API token. Takes under a minute.',
            steps: [
              {
                text: 'In monday.com, click your avatar → Developers and open My access tokens.',
                link: {
                  label: 'Where to find the token',
                  url: 'https://developer.monday.com/api-reference/docs/authentication',
                },
              },
              { text: 'Click Show, then Copy.' },
              { text: 'Paste the token into the form.' },
            ],
            tips: [
              'The token acts as you and sees the same boards you do.',
              'Regenerate makes the old token stop working: paste the new one then.',
            ],
          },
        },
        prompts: [
          'Which items on the Marketing board are Working on it?',
          'Add “Launch post” to the Content plan board, due Friday.',
          'Set “Landing page” to Done and post an update that it is finished.',
          'Summarize the latest updates on the “Redesign” item.',
        ],
        fields: { token: { label: 'API token', hint: 'Avatar → Developers → My access tokens.' } },
        actions: {
          list_boards: { title: 'Boards', description: 'Boards with ids and workspaces.' },
          get_board: { title: 'Get a board', description: 'Groups and columns with status labels.' },
          list_items: { title: 'Items', description: 'Items of a board, with a name search.' },
          get_item: { title: 'Get an item', description: 'Columns and latest updates of an item.' },
          create_item: { title: 'Create an item', description: 'Creates an item on a board.' },
          update_item: { title: 'Update an item', description: 'Changes the name and column values.' },
          add_update: { title: 'Post an update', description: 'Writes an update on an item.' },
          archive_item: { title: 'Archive', description: 'Archives an item (it can be restored).' },
        },
      },
    },
  },
  actions: (action) => [
    action({
      name: 'list_boards',
      title: 'List boards',
      description: 'Lists active boards with their ids and workspaces.',
      input: z.object({
        limit: z.number().int().min(1).max(100).default(50),
        page: z.number().int().min(1).default(1),
      }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ limit, page: pageNo }, ctx) => {
        const { boards } = await mondayQuery<{
          boards: { id: string; name: string; items_count?: number; workspace?: { name: string } | null }[];
        }>(
          ctx,
          `query Boards($limit: Int, $page: Int) { boards(limit: $limit, page: $page, state: active, order_by: used_at) {
            id name items_count workspace { name } } }`,
          { limit, page: pageNo },
        );
        return boards
          .filter((b) => !b.name.startsWith('Subitems of '))
          .map((b) =>
            compact({ id: b.id, name: b.name, items: b.items_count, workspace: b.workspace?.name }),
          );
      },
    }),
    action({
      name: 'get_board',
      title: 'Get board',
      description: 'Returns a board’s groups and columns (ids, types, status labels).',
      input: z.object({ board_id: Id }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ board_id }, ctx) => {
        const { boards } = await mondayQuery<{
          boards: {
            id: string;
            name: string;
            description?: string | null;
            groups: { id: string; title: string }[];
            columns: { id: string; title: string; type: string; settings_str?: string }[];
          }[];
        }>(
          ctx,
          `query Board($ids: [ID!]) { boards(ids: $ids) { id name description groups { id title }
            columns { id title type settings_str } } }`,
          { ids: [board_id] },
        );
        const board = boards[0];
        if (!board) throw new ConnectorError('not_found', `No board ${board_id}. Use monday_list_boards.`);
        return compact({
          id: board.id,
          name: board.name,
          description: board.description ?? undefined,
          groups: board.groups,
          columns: board.columns.map((c) =>
            compact({ id: c.id, title: c.title, type: c.type, labels: labelsOf(c) }),
          ),
        });
      },
    }),
    action({
      name: 'list_items',
      title: 'List items',
      description: 'Lists items of a board, optionally whose name contains some text.',
      input: z.object({
        board_id: Id,
        query: z.string().trim().max(200).optional().describe('Text in the item name'),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().max(2000).optional().describe('nextCursor from the previous result'),
      }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ board_id, query, limit, cursor }, ctx) => {
        if (cursor) {
          const { next_items_page } = await mondayQuery<{
            next_items_page: { cursor?: string | null; items: ItemNode[] };
          }>(
            ctx,
            `query Next($cursor: String!, $limit: Int!) { next_items_page(cursor: $cursor, limit: $limit) {
              cursor items { ${ITEM_NODE} } } }`,
            { cursor, limit },
          );
          return page(next_items_page.items.map(itemOut), {
            nextCursor: next_items_page.cursor ?? undefined,
          });
        }
        const { boards } = await mondayQuery<{
          boards: { items_page: { cursor?: string | null; items: ItemNode[] } }[];
        }>(
          ctx,
          `query Items($ids: [ID!], $limit: Int!, $params: ItemsQuery) { boards(ids: $ids) {
            items_page(limit: $limit, query_params: $params) { cursor items { ${ITEM_NODE} } } } }`,
          {
            ids: [board_id],
            limit,
            ...(query
              ? {
                  params: {
                    rules: [{ column_id: 'name', compare_value: [query], operator: 'contains_text' }],
                  },
                }
              : {}),
          },
        );
        const items = boards[0]?.items_page;
        if (!items) throw new ConnectorError('not_found', `No board ${board_id}. Use monday_list_boards.`);
        return page(items.items.map(itemOut), { nextCursor: items.cursor ?? undefined });
      },
    }),
    action({
      name: 'get_item',
      title: 'Get item',
      description: 'Returns an item with all column values and its latest updates.',
      input: z.object({ item_id: Id }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ item_id }, ctx) => {
        const { items } = await mondayQuery<{
          items: (ItemNode & {
            updates?: {
              body?: string;
              text_body?: string;
              created_at: string;
              creator?: { name: string } | null;
            }[];
          })[];
        }>(
          ctx,
          `query Item($ids: [ID!]) { items(ids: $ids) { ${ITEM_NODE}
            updates(limit: 10) { text_body created_at creator { name } } } }`,
          { ids: [item_id] },
        );
        const item = items[0];
        if (!item) throw new ConnectorError('not_found', `No item ${item_id}.`);
        return compact({
          ...itemOut(item),
          updates: item.updates?.map((u) => ({
            from: u.creator?.name ?? 'unknown',
            date: u.created_at,
            text: truncateText(u.text_body ?? '', 1500),
          })),
        });
      },
    }),
    action({
      name: 'create_item',
      title: 'Create item',
      description: 'Creates an item on a board, optionally in a group and with column values.',
      input: z.object({
        board_id: Id,
        name: z.string().trim().min(1).max(255),
        group_id: z
          .string()
          .max(100)
          .optional()
          .describe('Group id from monday_get_board; default is the top group'),
        column_values: ColumnValues.optional(),
      }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      undo: { kind: 'action', action: 'archive_item' },
      run: async ({ board_id, name, group_id, column_values }, ctx) => {
        const { create_item } = await mondayQuery<{ create_item: ItemNode }>(
          ctx,
          `mutation Create($board: ID!, $group: String, $name: String!, $values: JSON) {
            create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $values,
              create_labels_if_missing: false) { ${ITEM_NODE} } }`,
          {
            board: board_id,
            name,
            ...(group_id ? { group: group_id } : {}),
            ...(column_values ? { values: JSON.stringify(column_values) } : {}),
          },
        );
        return itemOut(create_item);
      },
    }),
    action({
      name: 'update_item',
      title: 'Update item',
      description: 'Renames an item and/or changes its column values (status, date, people, text…).',
      input: z.object({
        board_id: Id,
        item_id: Id,
        name: z.string().trim().min(1).max(255).optional(),
        column_values: ColumnValues.optional(),
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      run: async ({ board_id, item_id, name, column_values }, ctx) => {
        const values = { ...(column_values ?? {}), ...(name ? { name } : {}) };
        if (!Object.keys(values).length) {
          throw new ConnectorError('invalid_input', 'Pass name or column_values.');
        }
        const { change_multiple_column_values } = await mondayQuery<{
          change_multiple_column_values: ItemNode;
        }>(
          ctx,
          `mutation Update($board: ID!, $item: ID!, $values: JSON!) {
            change_multiple_column_values(board_id: $board, item_id: $item, column_values: $values) { ${ITEM_NODE} } }`,
          { board: board_id, item: item_id, values: JSON.stringify(values) },
        );
        return itemOut(change_multiple_column_values);
      },
    }),
    action({
      name: 'add_update',
      title: 'Post update',
      description: 'Posts an update (comment) on an item; mentions notify people.',
      input: z.object({
        item_id: Id,
        body: z.string().trim().min(1).max(20_000).describe('Text; simple HTML allowed'),
      }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      run: async ({ item_id, body }, ctx) => {
        const { create_update } = await mondayQuery<{ create_update: { id: string; created_at: string } }>(
          ctx,
          'mutation Update($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id created_at } }',
          { item: item_id, body },
        );
        return create_update;
      },
    }),
    action({
      name: 'archive_item',
      title: 'Archive item',
      description: 'Archives an item; it can be restored from the board archive for 30 days.',
      input: z.object({ item_id: Id }),
      hints: { readOnly: false, destructive: true, idempotent: true },
      risk: 'write',
      run: async ({ item_id }, ctx) => {
        const { archive_item } = await mondayQuery<{ archive_item: { id: string; state?: string } }>(
          ctx,
          'mutation Archive($item: ID!) { archive_item(item_id: $item) { id state } }',
          { item: item_id },
        );
        return archive_item;
      },
    }),
  ],
});

/** Status and dropdown labels from a column's settings JSON, so the AI can pick a valid one. */
function labelsOf(column: { type: string; settings_str?: string }): string[] | undefined {
  if (!['status', 'dropdown'].includes(column.type) || !column.settings_str) return undefined;
  try {
    const settings = JSON.parse(column.settings_str) as {
      labels?: Record<string, string> | { id: number; name: string }[];
    };
    const labels = settings.labels;
    if (!labels) return undefined;
    const names = Array.isArray(labels) ? labels.map((l) => l.name) : Object.values(labels);
    return names.filter((n) => typeof n === 'string' && n.length > 0);
  } catch {
    return undefined;
  }
}
