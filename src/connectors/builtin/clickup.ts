import { z } from 'zod';
import { HttpClient, type QueryValue } from '../http/client.js';
import {
  type AccountContext,
  type CapabilityOutput,
  ConnectorError,
  compact,
  defineConnector,
  page,
  truncateText,
} from '../sdk.js';

/**
 * ClickUp API v2 with a personal token. Tasks live in lists inside spaces and folders of a
 * workspace, and "my tasks" needs the user id, so this is a code connector that resolves the
 * workspace, the user and list names by itself.
 */

const Credentials = z.object({
  token: z
    .string()
    .trim()
    .regex(/^pk_/, 'a ClickUp personal token starts with pk_')
    .describe('Personal API token: ClickUp → Settings → Apps → API Token'),
});

type Ctx = AccountContext<Record<string, never>, z.output<typeof Credentials>>;

const client = (ctx: Ctx) =>
  new HttpClient(ctx, {
    baseUrl: 'https://api.clickup.com/api/v2',
    // Personal tokens go without the "Bearer" prefix.
    headers: { authorization: ctx.credentials.token },
    errorMessagePaths: ['err', 'error'],
  });

async function get<T>(
  ctx: Ctx,
  url: string,
  query: Record<string, QueryValue | QueryValue[]> = {},
): Promise<T> {
  const clean = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)) as Record<
    string,
    QueryValue
  >;
  return (await client(ctx).request<T>({ method: 'GET', url, query: clean })).data;
}

async function send<T>(ctx: Ctx, method: 'POST' | 'PUT' | 'DELETE', url: string, json?: unknown): Promise<T> {
  return (await client(ctx).request<T>({ method, url, ...(json !== undefined ? { json } : {}) })).data;
}

interface Task {
  id: string;
  name: string;
  status?: { status?: string; type?: string };
  due_date?: string | null;
  priority?: { id?: string; priority?: string } | null;
  url?: string;
  list?: { id?: string; name?: string };
  assignees?: { username?: string }[];
  date_updated?: string;
}

const msToIso = (ms: string | null | undefined) => (ms ? new Date(Number(ms)).toISOString() : undefined);
const isoToMs = (iso: string) => {
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(ms)) throw new ConnectorError('invalid_input', `Not a date: ${iso}`);
  return ms;
};

const taskItem = (t: Task) =>
  compact({
    id: t.id,
    name: t.name,
    status: t.status?.status,
    closed: t.status?.type === 'closed' || t.status?.type === 'done' || undefined,
    due: msToIso(t.due_date),
    priority: t.priority?.priority,
    list: t.list?.name,
    assignees: t.assignees?.map((a) => a.username).filter(Boolean),
    url: t.url,
  });

// ClickUp priorities: 1 urgent, 2 high, 3 normal, 4 low. The shared scale is 1 (normal) … 4 (urgent).
const CLICKUP_PRIORITY: Record<string, number> = { urgent: 4, high: 3, normal: 2, low: 1 };

/** The workspace (ClickUp "team") to use: the given one, or the only one. */
async function workspaceId(ctx: Ctx, given: string | undefined): Promise<string> {
  if (given) return given;
  const { teams } = await get<{ teams: { id: string; name: string }[] }>(ctx, '/team');
  if (teams.length === 1) return teams[0]!.id;
  if (teams.length === 0) throw new ConnectorError('not_found', 'This ClickUp account has no workspace.');
  throw new ConnectorError(
    'invalid_input',
    `Pass workspace: this account has several (${teams.map((t) => `${t.name} = ${t.id}`).join(', ')}).`,
  );
}

async function userId(ctx: Ctx): Promise<number> {
  const { user } = await get<{ user: { id: number } }>(ctx, '/user');
  return user.id;
}

interface ListRef {
  id: string;
  name: string;
  space: string;
  folder?: string;
}

/** All lists of the workspace: folderless ones and those in folders, with their place. */
async function allLists(ctx: Ctx, workspace: string): Promise<ListRef[]> {
  const { spaces } = await get<{ spaces: { id: string; name: string }[] }>(ctx, `/team/${workspace}/space`, {
    archived: false,
  });
  const perSpace = await Promise.all(
    spaces.slice(0, 20).map(async (space) => {
      const [folders, lists] = await Promise.all([
        get<{ folders: { name: string; lists: { id: string; name: string }[] }[] }>(
          ctx,
          `/space/${space.id}/folder`,
          {
            archived: false,
          },
        ),
        get<{ lists: { id: string; name: string }[] }>(ctx, `/space/${space.id}/list`, { archived: false }),
      ]);
      return [
        ...lists.lists.map((l) => ({ id: l.id, name: l.name, space: space.name })),
        ...folders.folders.flatMap((f) =>
          f.lists.map((l) => ({ id: l.id, name: l.name, space: space.name, folder: f.name })),
        ),
      ];
    }),
  );
  return perSpace.flat();
}

async function resolveList(ctx: Ctx, list: string, workspace: string | undefined): Promise<string> {
  if (/^\d+$/.test(list)) return list;
  const lists = await allLists(ctx, await workspaceId(ctx, workspace));
  const wanted = list.trim().toLowerCase();
  const matches = lists.filter((l) => l.name.toLowerCase() === wanted);
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0)
    throw new ConnectorError('not_found', `No ClickUp list "${list}". Use clickup_list_lists.`);
  throw new ConnectorError(
    'invalid_input',
    `Several lists are called "${list}": ${matches.map((l) => `${[l.space, l.folder].filter(Boolean).join(' / ')} = ${l.id}`).join(', ')}. Pass the id.`,
  );
}

const TaskId = z.string().trim().min(1).max(40).describe('Task id');
const Workspace = z
  .string()
  .trim()
  .regex(/^\d+$/)
  .optional()
  .describe('Workspace id; only with several workspaces');
const List = z.string().trim().min(1).max(200).describe('List name or id');
const Priority = z.number().int().min(1).max(4).describe('1 urgent, 2 high, 3 normal, 4 low');
const Due = z.string().max(40).describe('YYYY-MM-DD or RFC 3339');

type TaskOut = CapabilityOutput<'tasks.list'>;

export default defineConnector({
  id: 'clickup',
  name: 'ClickUp',
  description: 'ClickUp tasks and lists: find your tasks, read, create, update, comment, delete.',
  version: '1.0.0',
  homepage: 'https://developer.clickup.com/reference',
  instructions:
    'Tasks live in lists; a list can be given by name. Status is set by its name in the list (e.g. "in progress").',
  credentials: Credentials,
  rateLimit: { requests: 90, perSeconds: 60 },
  async test(ctx) {
    const { user } = await get<{ user: { email?: string; username?: string } }>(ctx, '/user');
    return { ok: true, identity: user.email ?? user.username ?? 'ClickUp' };
  },
  ui: {
    locales: {
      ru: {
        description:
          'Задачи и списки ClickUp: ваши задачи, чтение, создание, изменение, комментарии и удаление.',
        setup: {
          form: {
            summary: 'Личный токен API ClickUp. Около минуты.',
            steps: [
              {
                text: 'Откройте ClickUp → аватар → Settings → Apps.',
                link: { label: 'Открыть настройки ClickUp', url: 'https://app.clickup.com/settings/apps' },
              },
              { text: 'В блоке API Token нажмите Generate (или Copy, если токен уже есть).' },
              { text: 'Вставьте токен (pk_…) в форму и нажмите «Подключить».' },
            ],
            tips: [
              'Токен действует от вашего имени во всех пространствах. Новый токен (Regenerate) отключает старый.',
            ],
          },
        },
        prompts: [
          'Что у меня в ClickUp на эту неделю?',
          'Добавь в список «Спринт 12» задачу «Обновить тарифы» с высоким приоритетом.',
          'Переведи задачу про лендинг в статус «in review» и оставь комментарий.',
          'Какие срочные задачи у меня просрочены?',
        ],
        fields: { token: { label: 'Токен API', hint: 'ClickUp → Settings → Apps → API Token.' } },
        actions: {
          find_tasks: { title: 'Поиск задач', description: 'Ваши задачи или задачи списка, с фильтрами.' },
          get_task: { title: 'Задача', description: 'Показывает задачу с описанием и комментариями.' },
          list_lists: { title: 'Списки', description: 'Все списки пространств и папок.' },
          create_task: { title: 'Новая задача', description: 'Создаёт задачу в списке.' },
          update_task: {
            title: 'Изменение задачи',
            description: 'Меняет название, описание, статус, приоритет или срок задачи.',
          },
          add_comment: { title: 'Новый комментарий', description: 'Добавляет комментарий к задаче.' },
          delete_task: { title: 'Удаление задачи', description: 'Удаляет задачу.' },
        },
      },
      en: {
        setup: {
          form: {
            summary: 'A ClickUp personal API token. Takes about a minute.',
            steps: [
              {
                text: 'Open ClickUp → your avatar → Settings → Apps.',
                link: { label: 'Open ClickUp settings', url: 'https://app.clickup.com/settings/apps' },
              },
              { text: 'Under API Token, click Generate (or Copy if you already have one).' },
              { text: 'Paste the token (pk_…) into the form and click Connect.' },
            ],
            tips: ['The token acts as you in all workspaces. Regenerate makes the old one stop working.'],
          },
        },
        prompts: [
          'What do I have in ClickUp this week?',
          'Add “Update pricing” to the Sprint 12 list with high priority.',
          'Move the landing page task to “in review” and leave a comment.',
          'Which of my urgent tasks are overdue?',
        ],
        fields: { token: { label: 'API token', hint: 'ClickUp → Settings → Apps → API Token.' } },
        actions: {
          find_tasks: {
            title: 'Find tasks',
            description: 'Your tasks or the tasks of a list, with filters.',
          },
          get_task: { title: 'Get a task', description: 'Shows a task with its description and comments.' },
          list_lists: { title: 'List lists', description: 'All lists of the spaces and folders.' },
          create_task: { title: 'Create a task', description: 'Creates a task in a list.' },
          update_task: {
            title: 'Update a task',
            description: 'Changes the name, description, status, priority or due date of a task.',
          },
          add_comment: { title: 'Add a comment', description: 'Adds a comment to a task.' },
          delete_task: { title: 'Delete a task', description: 'Deletes a task.' },
        },
      },
    },
  },
  actions: (action) => [
    action({
      name: 'find_tasks',
      title: 'Find tasks',
      description: 'Lists tasks assigned to you (or of one list), soonest due first; query filters by name.',
      input: z.object({
        query: z.string().trim().max(200).optional().describe('Words in the task name'),
        list: List.optional(),
        workspace: Workspace,
        include_closed: z.boolean().default(false),
        due_before: Due.optional(),
        cursor: z.string().max(20).optional().describe('nextCursor from the previous result'),
      }),
      hints: { readOnly: true, idempotent: true },
      capability: {
        id: 'tasks.list',
        mapInput: ({ query, status, due_before }) => ({
          ...(typeof query === 'string' && query ? { query } : {}),
          include_closed: status !== 'open',
          ...(typeof due_before === 'string' ? { due_before } : {}),
        }),
        mapOutput: (result, input) => {
          const { items, nextCursor } = result as {
            items: ReturnType<typeof taskItem>[];
            nextCursor?: string;
          };
          return {
            items: items
              .map((t): TaskOut => {
                const priority = CLICKUP_PRIORITY[String(t.priority)];
                return {
                  id: String(t.id),
                  title: String(t.name),
                  status: t.closed ? 'done' : 'open',
                  ...(t.due ? { due: String(t.due) } : {}),
                  ...(priority ? { priority } : {}),
                  ...(t.list ? { project: String(t.list) } : {}),
                  ...(t.url ? { url: String(t.url) } : {}),
                };
              })
              .filter((t) => input.status !== 'done' || t.status === 'done'),
            ...(nextCursor ? { nextCursor } : {}),
          };
        },
      },
      run: async ({ query, list, workspace, include_closed, due_before, cursor }, ctx) => {
        const pageNo = cursor ? Number(cursor) : 0;
        const common = {
          page: pageNo,
          include_closed,
          subtasks: true,
          order_by: 'due_date',
          reverse: true,
          ...(due_before ? { due_date_lt: isoToMs(due_before) } : {}),
        };
        const result = list
          ? await get<{ tasks: Task[]; last_page?: boolean }>(
              ctx,
              `/list/${await resolveList(ctx, list, workspace)}/task`,
              common,
            )
          : await get<{ tasks: Task[]; last_page?: boolean }>(
              ctx,
              `/team/${await workspaceId(ctx, workspace)}/task`,
              {
                ...common,
                'assignees[]': await userId(ctx),
              },
            );
        const words = query?.toLowerCase();
        const tasks = words ? result.tasks.filter((t) => t.name.toLowerCase().includes(words)) : result.tasks;
        // ClickUp pages hold 100 tasks; a full page means there may be more.
        const more =
          result.last_page === false || (result.last_page === undefined && result.tasks.length >= 100);
        return page(tasks.map(taskItem), { nextCursor: more ? String(pageNo + 1) : undefined });
      },
    }),
    action({
      name: 'get_task',
      title: 'Get task',
      description: 'Returns a task with its description and latest comments.',
      input: z.object({ task_id: TaskId }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ task_id }, ctx) => {
        const [task, comments] = await Promise.all([
          get<Task & { text_content?: string; date_created?: string; tags?: { name: string }[] }>(
            ctx,
            `/task/${task_id}`,
          ),
          get<{ comments: { comment_text?: string; date?: string; user?: { username?: string } }[] }>(
            ctx,
            `/task/${task_id}/comment`,
          ),
        ]);
        return compact({
          ...taskItem(task),
          description: task.text_content ? truncateText(task.text_content, 6000) : undefined,
          created: msToIso(task.date_created),
          tags: task.tags?.map((t) => t.name),
          comments: comments.comments.slice(0, 20).map((c) => ({
            from: c.user?.username ?? 'unknown',
            date: msToIso(c.date),
            text: truncateText(c.comment_text ?? '', 1500),
          })),
        });
      },
    }),
    action({
      name: 'list_lists',
      title: 'List lists',
      description: 'Lists all lists of the workspace with their space and folder.',
      input: z.object({ workspace: Workspace }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ workspace }, ctx) => allLists(ctx, await workspaceId(ctx, workspace)),
    }),
    action({
      name: 'create_task',
      title: 'Create task',
      description: 'Creates a task in a list.',
      input: z.object({
        list: List,
        name: z.string().trim().min(1).max(1000),
        description: z.string().max(50_000).optional().describe('Markdown'),
        status: z.string().max(60).optional(),
        priority: Priority.optional(),
        due: Due.optional(),
        assign_to_me: z.boolean().default(true),
        workspace: Workspace,
      }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      undo: { kind: 'action', action: 'delete_task' },
      capability: {
        id: 'tasks.create',
        mapInput: ({ title, description, due, project, priority }) => {
          if (typeof project !== 'string' || !project) {
            throw new ConnectorError('invalid_input', 'ClickUp needs a list: pass its name as project.');
          }
          return {
            list: project,
            name: title,
            ...(description ? { description } : {}),
            ...(typeof due === 'string' ? { due } : {}),
            ...(typeof priority === 'number' ? { priority: 5 - priority } : {}),
          };
        },
        mapOutput: (result) => {
          const { id, url } = result as { id: string; url?: string };
          return { id, ...(url ? { url } : {}) };
        },
      },
      run: async ({ list, name, description, status, priority, due, assign_to_me, workspace }, ctx) => {
        const listId = await resolveList(ctx, list, workspace);
        const task = await send<Task>(ctx, 'POST', `/list/${listId}/task`, {
          name,
          ...(description ? { markdown_description: description } : {}),
          ...(status ? { status } : {}),
          ...(priority ? { priority } : {}),
          ...(due ? { due_date: isoToMs(due), due_date_time: !/^\d{4}-\d{2}-\d{2}$/.test(due) } : {}),
          ...(assign_to_me ? { assignees: [await userId(ctx)] } : {}),
        });
        return taskItem(task);
      },
    }),
    action({
      name: 'update_task',
      title: 'Update task',
      description: 'Changes name, description, status, priority or due date of a task.',
      input: z.object({
        task_id: TaskId,
        name: z.string().trim().min(1).max(1000).optional(),
        description: z.string().max(50_000).optional().describe('Replaces the description'),
        status: z.string().max(60).optional().describe('Status name in the list, e.g. "complete"'),
        priority: Priority.optional(),
        due: Due.nullable().optional().describe('YYYY-MM-DD or RFC 3339, or null to clear'),
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      run: async ({ task_id, name, description, status, priority, due }, ctx) => {
        const body: Record<string, unknown> = compact({ name, description, status, priority });
        if (due !== undefined) body.due_date = due === null ? null : isoToMs(due);
        if (Object.keys(body).length === 0) throw new ConnectorError('invalid_input', 'Nothing to change.');
        return taskItem(await send<Task>(ctx, 'PUT', `/task/${task_id}`, body));
      },
    }),
    action({
      name: 'add_comment',
      title: 'Add comment',
      description: 'Adds a comment to a task.',
      input: z.object({ task_id: TaskId, text: z.string().trim().min(1).max(50_000) }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      run: async ({ task_id, text }, ctx) => {
        const comment = await send<{ id: string | number }>(ctx, 'POST', `/task/${task_id}/comment`, {
          comment_text: text,
          notify_all: false,
        });
        return { id: String(comment.id) };
      },
    }),
    action({
      name: 'delete_task',
      title: 'Delete task',
      description: 'Deletes a task.',
      input: z.object({ task_id: TaskId }),
      hints: { readOnly: false, destructive: true, idempotent: true },
      risk: 'dangerous',
      run: async ({ task_id }, ctx) => {
        await send(ctx, 'DELETE', `/task/${task_id}`);
        return { deleted: task_id };
      },
    }),
  ],
});
