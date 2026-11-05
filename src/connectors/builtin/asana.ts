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
 * Asana REST API with a personal access token. Most calls need a workspace and projects are often
 * named rather than known by id, so this is a code connector: it picks the only workspace by
 * itself and resolves project names.
 */

const Credentials = z.object({
  token: z
    .string()
    .trim()
    .min(10)
    .describe('Personal access token: Asana → Settings → Apps → Developer apps → Create new token'),
});

type Ctx = AccountContext<Record<string, never>, z.output<typeof Credentials>>;

const client = (ctx: Ctx) =>
  new HttpClient(ctx, {
    baseUrl: 'https://app.asana.com/api/1.0',
    headers: { authorization: `Bearer ${ctx.credentials.token}`, accept: 'application/json' },
    errorMessagePaths: ['errors.0.message'],
  });

const TASK_FIELDS = 'name,due_on,due_at,completed,assignee.name,projects.name,permalink_url';

interface AsanaPage<T> {
  data: T;
  next_page?: { offset?: string } | null;
}

async function get<T>(ctx: Ctx, url: string, query: Record<string, QueryValue> = {}) {
  const clean = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined));
  return (await client(ctx).request<AsanaPage<T>>({ method: 'GET', url, query: clean })).data;
}

async function send<T>(
  ctx: Ctx,
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  data?: unknown,
  optFields?: string,
) {
  const response = await client(ctx).request<AsanaPage<T>>({
    method,
    url,
    ...(optFields ? { query: { opt_fields: optFields } } : {}),
    ...(data !== undefined ? { json: { data } } : {}),
  });
  return response.data?.data;
}

interface Task {
  gid: string;
  name: string;
  due_on?: string | null;
  due_at?: string | null;
  completed?: boolean;
  assignee?: { name?: string } | null;
  projects?: { name?: string }[];
  permalink_url?: string;
}

const taskItem = (t: Task) =>
  compact({
    id: t.gid,
    name: t.name,
    completed: t.completed,
    due: t.due_at ?? t.due_on ?? undefined,
    assignee: t.assignee?.name,
    projects: t.projects?.map((p) => p.name).filter(Boolean),
    url: t.permalink_url,
  });

/** The workspace to use: the given one, or the only one of the account. */
async function workspaceId(ctx: Ctx, given: string | undefined): Promise<string> {
  if (given) return given;
  const me = await get<{ workspaces: { gid: string; name: string }[] }>(ctx, '/users/me', {
    opt_fields: 'workspaces.name',
  });
  const workspaces = me.data.workspaces ?? [];
  if (workspaces.length === 1) return workspaces[0]!.gid;
  if (workspaces.length === 0) throw new ConnectorError('not_found', 'This Asana account has no workspace.');
  throw new ConnectorError(
    'invalid_input',
    `Pass workspace: this account has several (${workspaces.map((w) => `${w.name} = ${w.gid}`).join(', ')}).`,
  );
}

/** A project id, or the project whose name matches. */
async function projectId(ctx: Ctx, project: string, workspace: string | undefined): Promise<string> {
  if (/^\d+$/.test(project)) return project;
  const ws = await workspaceId(ctx, workspace);
  const found = await get<{ gid: string; name: string }[]>(ctx, `/workspaces/${ws}/typeahead`, {
    resource_type: 'project',
    query: project,
    count: 10,
  });
  const wanted = project.trim().toLowerCase();
  const match =
    found.data.find((p) => p.name.toLowerCase() === wanted) ??
    (found.data.length === 1 ? found.data[0] : undefined);
  if (match) return match.gid;
  throw new ConnectorError(
    found.data.length ? 'invalid_input' : 'not_found',
    found.data.length
      ? `Several projects match "${project}": ${found.data.map((p) => p.name).join(', ')}.`
      : `No Asana project "${project}". Use asana_list_projects.`,
  );
}

const Gid = z.string().trim().regex(/^\d+$/, 'an Asana id is a number').describe('Task id');
const Workspace = z
  .string()
  .trim()
  .regex(/^\d+$/)
  .optional()
  .describe('Workspace id; only with several workspaces');
const Project = z.string().trim().min(1).max(200).describe('Project name or id');
const DueOn = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('YYYY-MM-DD');
const Limit = (max: number, fallback: number) => z.number().int().min(1).max(max).default(fallback);
const Cursor = z.string().max(500).optional().describe('nextCursor from the previous result');

type TaskItem = CapabilityOutput<'tasks.list'>;

export default defineConnector({
  id: 'asana',
  name: 'Asana',
  description: 'Asana tasks and projects: find, read, create, update, complete and comment on tasks.',
  version: '1.0.0',
  homepage: 'https://developers.asana.com/reference',
  credentials: Credentials,
  rateLimit: { requests: 150, perSeconds: 60 },
  async test(ctx) {
    const me = await get<{ email?: string; name?: string }>(ctx, '/users/me', { opt_fields: 'email,name' });
    return { ok: true, identity: me.data.email ?? me.data.name ?? 'Asana' };
  },
  ui: {
    locales: {
      ru: {
        description: 'Задачи и проекты Asana: поиск, чтение, создание, изменение, выполнение и комментарии.',
        setup: {
          form: {
            summary: 'Вы создаёте личный токен доступа в консоли разработчика Asana и вставляете его сюда.',
            minutes: 2,
            needs: ['Аккаунт Asana (подойдёт любой тариф)'],
            steps: [
              {
                text: 'Откройте консоль разработчика Asana и нажмите **Create new token**.',
                link: { label: 'Открыть консоль разработчика Asana', url: 'https://app.asana.com/0/my-apps' },
              },
              {
                text: 'Назовите токен Manyplug, отметьте согласие с условиями API и нажмите **Create token**.',
              },
              {
                text: 'Нажмите **Copy** и вставьте токен в форму. Asana показывает его только один раз.',
                fills: ['token'],
              },
            ],
            tips: [
              'Токен действует от вашего имени во всех ваших рабочих пространствах.',
              'Отозвать его можно в консоли разработчика в любой момент.',
            ],
            problems: [
              {
                problem: 'Форма пишет, что токен не подходит',
                fix: 'Создайте новый токен в консоли разработчика и скопируйте его кнопкой **Copy**, чтобы не потерять ни одного символа.',
              },
              {
                problem: 'ИИ не видит проект',
                fix: 'Токен видит то же, что и вы в Asana. Попросите добавить вас в проект или подключите аккаунт Asana, у которого он есть.',
              },
            ],
          },
        },
        prompts: [
          'Что у меня в Asana на эту неделю?',
          'Добавь в проект «Запуск сайта» задачу «Проверить формы» на пятницу.',
          'Отметь выполненной задачу про счёт для ACME и напиши в ней комментарий.',
          'Какие задачи в «Маркетинге» просрочены?',
        ],
        fields: {
          token: {
            label: 'Личный токен доступа',
            hint: 'Asana → Настройки → Приложения → Консоль разработчика.',
          },
        },
        actions: {
          find_tasks: {
            title: 'Поиск задач',
            description: 'Задачи проекта, ваши задачи или поиск по названию.',
          },
          get_task: { title: 'Задача', description: 'Показывает задачу с описанием и комментариями.' },
          list_projects: { title: 'Список проектов', description: 'Проекты пространства.' },
          create_task: {
            title: 'Новая задача',
            description: 'Создаёт задачу в проекте или в ваших задачах.',
          },
          update_task: {
            title: 'Изменение задачи',
            description: 'Меняет название, описание, срок или отмечает задачу выполненной.',
          },
          add_comment: { title: 'Новый комментарий', description: 'Добавляет комментарий к задаче.' },
          delete_task: { title: 'Удаление задачи', description: 'Переносит задачу в корзину Asana.' },
        },
      },
      en: {
        setup: {
          form: {
            summary: 'You create a personal access token in the Asana developer console and paste it here.',
            minutes: 2,
            needs: ['An Asana account (any plan)'],
            steps: [
              {
                text: 'Open the Asana developer console and click **Create new token**.',
                link: { label: 'Open the Asana developer console', url: 'https://app.asana.com/0/my-apps' },
              },
              { text: 'Name it Manyplug, tick the box to accept the API terms and click **Create token**.' },
              {
                text: 'Click **Copy** and paste the token into the form. Asana shows it only once.',
                fills: ['token'],
              },
            ],
            tips: [
              'The token acts as you in all your workspaces.',
              'You can revoke it in the developer console at any time.',
            ],
            problems: [
              {
                problem: 'The form says the token is not valid',
                fix: 'Create a new token in the developer console and copy it with the **Copy** button, so no character is lost.',
              },
              {
                problem: 'The AI does not see a project',
                fix: 'The token sees what you see in Asana. Ask to be added to the project, or connect the Asana account that has it.',
              },
            ],
          },
        },
        prompts: [
          'What do I have in Asana this week?',
          'Add “Check the forms” to the Website launch project for Friday.',
          'Mark the ACME invoice task done and leave a comment on it.',
          'Which tasks in Marketing are overdue?',
        ],
        fields: {
          token: { label: 'Personal access token', hint: 'Asana → Settings → Apps → Developer console.' },
        },
        actions: {
          find_tasks: {
            title: 'Find tasks',
            description: 'Tasks of a project, your tasks, or a search by name.',
          },
          get_task: { title: 'Get a task', description: 'Shows a task with its description and comments.' },
          list_projects: { title: 'List projects', description: 'Projects of a workspace.' },
          create_task: {
            title: 'Create a task',
            description: 'Creates a task in a project or in your tasks.',
          },
          update_task: {
            title: 'Update a task',
            description: 'Changes the name, description or due date, or marks a task done.',
          },
          add_comment: { title: 'Add a comment', description: 'Adds a comment to a task.' },
          delete_task: { title: 'Delete a task', description: 'Moves a task to the Asana trash.' },
        },
      },
    },
  },
  actions: (action) => [
    action({
      name: 'find_tasks',
      title: 'Find tasks',
      description:
        'Lists tasks of a project, or your own tasks without a project; with query, searches task names instead.',
      input: z.object({
        query: z.string().trim().max(200).optional().describe('Words in the task name'),
        project: Project.optional(),
        workspace: Workspace,
        status: z.enum(['open', 'all']).default('open'),
        limit: Limit(100, 30),
        cursor: Cursor,
      }),
      hints: { readOnly: true, idempotent: true },
      capability: {
        id: 'tasks.list',
        mapInput: ({ query, status, limit }) => ({
          ...(typeof query === 'string' && query ? { query } : {}),
          // Asana lists open tasks or everything; done-only is filtered from "all" below.
          status: status === 'open' ? 'open' : 'all',
          limit,
        }),
        mapOutput: (result, input) => {
          const { items, nextCursor } = result as {
            items: ReturnType<typeof taskItem>[];
            nextCursor?: string;
          };
          const dueBefore = typeof input.due_before === 'string' ? input.due_before : undefined;
          return {
            items: items
              .map(
                (t): TaskItem => ({
                  id: String(t.id),
                  title: String(t.name),
                  status: t.completed ? 'done' : 'open',
                  ...(t.due ? { due: String(t.due) } : {}),
                  ...(t.projects?.[0] ? { project: String(t.projects[0]) } : {}),
                  ...(t.url ? { url: String(t.url) } : {}),
                }),
              )
              .filter((t) => input.status !== 'done' || t.status === 'done')
              .filter((t) => !dueBefore || (t.due !== undefined && t.due <= dueBefore)),
            ...(nextCursor ? { nextCursor } : {}),
          };
        },
      },
      run: async ({ query, project, workspace, status, limit, cursor }, ctx) => {
        if (query) {
          const ws = await workspaceId(ctx, workspace);
          const found = await get<Task[]>(ctx, `/workspaces/${ws}/typeahead`, {
            resource_type: 'task',
            query,
            count: limit,
            opt_fields: TASK_FIELDS,
          });
          return page(found.data.filter((t) => status === 'all' || !t.completed).map(taskItem));
        }
        const scope = project
          ? { project: await projectId(ctx, project, workspace) }
          : { assignee: 'me', workspace: await workspaceId(ctx, workspace) };
        const result = await get<Task[]>(ctx, '/tasks', {
          ...scope,
          ...(status === 'open' ? { completed_since: 'now' } : {}),
          limit,
          offset: cursor,
          opt_fields: TASK_FIELDS,
        });
        return page(result.data.map(taskItem), { nextCursor: result.next_page?.offset });
      },
    }),
    action({
      name: 'get_task',
      title: 'Get task',
      description: 'Returns a task with its description and latest comments.',
      input: z.object({ task_id: Gid }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ task_id }, ctx) => {
        const [task, stories] = await Promise.all([
          get<Task & { notes?: string; created_at?: string; tags?: { name: string }[] }>(
            ctx,
            `/tasks/${task_id}`,
            {
              opt_fields: `${TASK_FIELDS},notes,created_at,tags.name`,
            },
          ),
          get<{ type: string; text?: string; created_at: string; created_by?: { name?: string } }[]>(
            ctx,
            `/tasks/${task_id}/stories`,
            { opt_fields: 'type,text,created_at,created_by.name', limit: 100 },
          ),
        ]);
        const t = task.data;
        return compact({
          ...taskItem(t),
          notes: t.notes ? truncateText(t.notes, 6000) : undefined,
          created: t.created_at,
          tags: t.tags?.map((tag) => tag.name),
          comments: stories.data
            .filter((s) => s.type === 'comment')
            .slice(-20)
            .map((s) => ({
              from: s.created_by?.name ?? 'unknown',
              date: s.created_at,
              text: truncateText(s.text ?? '', 1500),
            })),
        });
      },
    }),
    action({
      name: 'list_projects',
      title: 'List projects',
      description: 'Lists projects of the workspace that are not archived.',
      input: z.object({ workspace: Workspace, limit: Limit(100, 50), cursor: Cursor }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ workspace, limit, cursor }, ctx) => {
        const result = await get<{ gid: string; name: string; permalink_url?: string }[]>(ctx, '/projects', {
          workspace: await workspaceId(ctx, workspace),
          archived: false,
          limit,
          offset: cursor,
          opt_fields: 'name,permalink_url',
        });
        return page(
          result.data.map((p) => ({ id: p.gid, name: p.name, url: p.permalink_url })),
          { nextCursor: result.next_page?.offset },
        );
      },
    }),
    action({
      name: 'create_task',
      title: 'Create task',
      description: 'Creates a task in a project, or in your own tasks without a project.',
      input: z.object({
        name: z.string().trim().min(1).max(1000),
        notes: z.string().max(50_000).optional().describe('Description'),
        due_on: DueOn.optional(),
        project: Project.optional(),
        workspace: Workspace,
        assign_to_me: z.boolean().optional().describe('Default: yes without a project, no with one'),
      }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      undo: { kind: 'action', action: 'delete_task' },
      capability: {
        id: 'tasks.create',
        mapInput: ({ title, description, due, project }) => ({
          name: title,
          ...(description ? { notes: description } : {}),
          ...(typeof due === 'string' ? { due_on: due.slice(0, 10) } : {}),
          ...(typeof project === 'string' && project ? { project } : {}),
        }),
        mapOutput: (result) => {
          const { id, url } = result as { id: string; url?: string };
          return { id, ...(url ? { url } : {}) };
        },
      },
      run: async ({ name, notes, due_on, project, workspace, assign_to_me }, ctx) => {
        const target = project
          ? { projects: [await projectId(ctx, project, workspace)] }
          : { workspace: await workspaceId(ctx, workspace) };
        const task = await send<Task>(
          ctx,
          'POST',
          '/tasks',
          {
            name,
            ...(notes ? { notes } : {}),
            ...(due_on ? { due_on } : {}),
            ...target,
            ...((assign_to_me ?? !project) ? { assignee: 'me' } : {}),
          },
          TASK_FIELDS,
        );
        return taskItem(task!);
      },
    }),
    action({
      name: 'update_task',
      title: 'Update task',
      description: 'Changes name, description or due date of a task, or marks it done or open again.',
      input: z.object({
        task_id: Gid,
        name: z.string().trim().min(1).max(1000).optional(),
        notes: z.string().max(50_000).optional().describe('Replaces the description'),
        due_on: DueOn.nullable().optional().describe('YYYY-MM-DD, or null to clear'),
        completed: z.boolean().optional(),
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      run: async ({ task_id, ...changes }, ctx) => {
        const data = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
        if (Object.keys(data).length === 0) throw new ConnectorError('invalid_input', 'Nothing to change.');
        const task = await send<Task>(ctx, 'PUT', `/tasks/${task_id}`, data, TASK_FIELDS);
        return taskItem(task!);
      },
    }),
    action({
      name: 'add_comment',
      title: 'Add comment',
      description: 'Adds a comment to a task.',
      input: z.object({ task_id: Gid, text: z.string().trim().min(1).max(50_000) }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      run: async ({ task_id, text }, ctx) => {
        const story = await send<{ gid: string; created_at?: string }>(
          ctx,
          'POST',
          `/tasks/${task_id}/stories`,
          {
            text,
          },
        );
        return compact({ id: story?.gid, created: story?.created_at });
      },
    }),
    action({
      name: 'delete_task',
      title: 'Delete task',
      description: 'Moves a task to the trash (restorable in Asana for 30 days).',
      input: z.object({ task_id: Gid }),
      hints: { readOnly: false, destructive: true, idempotent: true },
      risk: 'dangerous',
      run: async ({ task_id }, ctx) => {
        await send(ctx, 'DELETE', `/tasks/${task_id}`);
        return { deleted: task_id };
      },
    }),
  ],
});
