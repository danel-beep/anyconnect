import { defineManifestConnector } from '../manifest/compile.js';
import type { CapabilityBinding, CapabilityOutput } from '../sdk.js';
import { type ConnectorUi, withUi } from '../sdk.js';

const TASK_FIELDS = [
  'id',
  'content',
  'description',
  'project_id',
  'due.string',
  'due.date',
  'priority',
  'labels',
  'checked',
];
const taskId = { type: 'string', minLength: 1, description: 'Task id' };
const taskFields = {
  content: { type: 'string', description: 'Task title; supports Markdown' },
  description: { type: 'string' },
  project_id: { type: 'string', description: 'From todoist_list_projects; default is Inbox' },
  due_string: {
    type: 'string',
    description: 'Natural language, e.g. "tomorrow 10am", "every monday", "завтра"',
  },
  due_lang: { type: 'string', description: 'Language of due_string, e.g. "ru"' },
  due_date: { type: 'string', description: 'All-day due date, YYYY-MM-DD (instead of due_string)' },
  due_datetime: { type: 'string', description: 'Due moment, RFC 3339 (instead of due_string)' },
  priority: { type: 'integer', minimum: 1, maximum: 4, description: '4 = urgent (p1), 1 = normal' },
  labels: { type: 'array', items: { type: 'string' } },
};

interface TodoistTask {
  id: string;
  content: string;
  project_id?: string;
  due?: { date?: string };
  priority?: number;
  checked?: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const taskUrl = (id: string) => `https://app.todoist.com/app/task/${id}`;

/**
 * Todoist's filter endpoint returns open tasks only, so `status: "done"` yields nothing here.
 * Without other conditions the filter lists every priority, i.e. all open tasks.
 */
const listTasks: CapabilityBinding = {
  id: 'tasks.list',
  mapInput: ({ query, due_before, limit }) => {
    const parts = [
      typeof query === 'string' && query && `search: ${query.replace(/[&|()]/g, ' ')}`,
      typeof due_before === 'string' && `due before: ${due_before.slice(0, 10)}`,
    ].filter(Boolean);
    return { query: parts.length ? parts.join(' & ') : 'p1 | p2 | p3 | p4', limit };
  },
  mapOutput: (result, input) => {
    const { items, nextCursor } = result as { items: TodoistTask[]; nextCursor?: string };
    if (input.status === 'done') return { items: [] };
    return {
      items: items.map(
        (t): CapabilityOutput<'tasks.list'> => ({
          id: t.id,
          title: t.content,
          status: t.checked ? 'done' : 'open',
          ...(t.due?.date ? { due: t.due.date } : {}),
          ...(t.priority ? { priority: t.priority } : {}),
          ...(t.project_id ? { project: t.project_id } : {}),
          url: taskUrl(t.id),
        }),
      ),
      ...(nextCursor ? { nextCursor } : {}),
    };
  },
};

/** The canonical `project` is a name; Todoist needs a project id, so it is not mapped yet. */
const createTask: CapabilityBinding = {
  id: 'tasks.create',
  mapInput: ({ title, description, due, priority }) => ({
    content: title,
    ...(description ? { description } : {}),
    ...(typeof due === 'string' ? (DATE.test(due) ? { due_date: due } : { due_datetime: due }) : {}),
    ...(priority ? { priority } : {}),
  }),
  mapOutput: (result) => {
    const t = result as TodoistTask;
    return { id: t.id, url: taskUrl(t.id) };
  },
};

/** Todoist API v1. API token from Settings → Integrations → Developer, or OAuth. */
const manifest = defineManifestConnector(
  {
    id: 'todoist',
    name: 'Todoist',
    description: 'Todoist tasks and projects: find, add, update, complete tasks.',
    version: '1.0.0',
    homepage: 'https://developer.todoist.com/api/v1',
    instructions:
      'todoist_find_tasks takes a Todoist filter: "today", "overdue", "7 days", "#Work & p1", "@label", "search: text".',
    baseUrl: 'https://api.todoist.com/api/v1',
    // OAuth through the hub's Todoist app, or the personal API token without one.
    auth: {
      type: 'oauth2',
      provider: 'todoist',
      scopes: ['data:read_write', 'data:delete'],
      token: '{{credentials.token}}',
    },
    credentials: {
      type: 'object',
      properties: {
        token: {
          type: 'string',
          minLength: 1,
          description: 'API token (only without OAuth): Todoist → Settings → Integrations → Developer',
        },
      },
    },
    rateLimit: { requests: 300, perSeconds: 60 },
    errorMessagePaths: ['error'],
    pagination: { type: 'cursor', param: 'cursor', nextPath: 'next_cursor' },
    test: { request: { method: 'GET', path: '/user' }, identity: '{{response.email}}' },
    actions: [
      {
        name: 'find_tasks',
        title: 'Find tasks',
        description: 'Finds open tasks matching a Todoist filter query.',
        input: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Filter, e.g. "today | overdue"' },
            lang: { type: 'string', description: 'Language of the query, e.g. "ru"' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
          required: ['query'],
        },
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/tasks/filter' },
        response: { root: 'results', fields: TASK_FIELDS },
        pagination: true,
      },
      {
        name: 'list_projects',
        title: 'List projects',
        description: 'Lists projects with their ids.',
        input: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
        },
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/projects' },
        response: { root: 'results', fields: ['id', 'name', 'parent_id', 'is_inbox_project'] },
        pagination: true,
      },
      {
        name: 'add_task',
        title: 'Add task',
        description: 'Creates a task.',
        input: { type: 'object', properties: taskFields, required: ['content'] },
        hints: { readOnly: false, destructive: false },
        risk: 'write',
        undo: { kind: 'action', action: 'delete_task' },
        request: { method: 'POST', path: '/tasks' },
        response: { fields: TASK_FIELDS },
      },
      {
        name: 'update_task',
        title: 'Update task',
        description: 'Changes a task: title, description, due date, priority, labels.',
        input: { type: 'object', properties: { task_id: taskId, ...taskFields }, required: ['task_id'] },
        hints: { readOnly: false, destructive: false, idempotent: true },
        risk: 'write',
        request: { method: 'POST', path: '/tasks/{task_id}' },
        response: { fields: TASK_FIELDS },
      },
      {
        name: 'complete_task',
        title: 'Complete task',
        description: 'Marks a task as done (a recurring task moves to its next date).',
        input: { type: 'object', properties: { task_id: taskId }, required: ['task_id'] },
        hints: { readOnly: false, destructive: false, idempotent: true },
        risk: 'write',
        undo: { kind: 'action', action: 'reopen_task' },
        request: { method: 'POST', path: '/tasks/{task_id}/close', body: {} },
        response: { empty: 'Completed.' },
      },
      {
        name: 'reopen_task',
        title: 'Reopen task',
        description: 'Reopens a completed task.',
        input: { type: 'object', properties: { task_id: taskId }, required: ['task_id'] },
        hints: { readOnly: false, destructive: false, idempotent: true },
        risk: 'write',
        undo: { kind: 'action', action: 'complete_task' },
        request: { method: 'POST', path: '/tasks/{task_id}/reopen', body: {} },
        response: { empty: 'Reopened.' },
      },
      {
        name: 'delete_task',
        title: 'Delete task',
        description: 'Deletes a task permanently.',
        input: { type: 'object', properties: { task_id: taskId }, required: ['task_id'] },
        hints: { readOnly: false, destructive: true, idempotent: true },
        risk: 'dangerous',
        request: { method: 'DELETE', path: '/tasks/{task_id}' },
        response: { empty: 'Deleted.' },
      },
    ],
  },
  {
    actions: {
      find_tasks: { capability: listTasks },
      add_task: { capability: createTask },
    },
  },
);

/** How the service reads on the website; the AI keeps the English texts of the manifest. */
const ui: ConnectorUi = {
  locales: {
    ru: {
      setup: {
        oauth: {
          summary: 'Ваш аккаунт Todoist. Меньше минуты.',
          steps: [
            {
              text: 'Нажмите «Подключить» и войдите в Todoist.',
            },
            {
              text: 'Нажмите Agree: AnyConnect сможет читать, добавлять, менять и удалять задачи и проекты.',
            },
            {
              text: 'Готово. Ещё один аккаунт Todoist? Подключите его так же.',
            },
          ],
        },
        form: {
          summary: 'Токен API Todoist. Около минуты.',
          steps: [
            {
              text: 'Откройте Todoist → «Настройки» → «Интеграции» → «Для разработчиков».',
              link: {
                label: 'Открыть Todoist → «Для разработчиков»',
                url: 'https://app.todoist.com/app/settings/integrations/developer',
              },
            },
            {
              text: 'Нажмите «Скопировать токен API».',
            },
            {
              text: 'Вставьте его в форму и нажмите «Подключить».',
            },
          ],
          tips: [
            'Токен открывает весь ваш Todoist. Чтобы закрыть доступ, выпустите новый токен на той же странице.',
          ],
        },
      },
      prompts: [
        'Что у меня на сегодня и завтра?',
        'Добавь в «Работу» задачу «Отправить договор ACME» на пятницу 10:00.',
        'Какие просроченные задачи можно закрыть? Сначала покажи список.',
        'Перенеси всё из «Личного» с меткой «потом» на следующий понедельник.',
      ],
      description: 'Задачи и проекты Todoist: поиск, создание, изменение и выполнение задач.',
      fields: {
        token: {
          label: 'Токен API',
          hint: 'Найти его можно в Todoist: Настройки → Интеграции → Разработчик.',
        },
      },
      actions: {
        find_tasks: { title: 'Поиск задач', description: 'Находит открытые задачи по фильтру Todoist.' },
        list_projects: { title: 'Список проектов', description: 'Проекты Todoist с их идентификаторами.' },
        add_task: { title: 'Новая задача', description: 'Создаёт задачу.' },
        update_task: {
          title: 'Изменение задачи',
          description: 'Меняет название, описание, срок, приоритет или метки задачи.',
        },
        complete_task: {
          title: 'Выполнение задачи',
          description: 'Отмечает задачу выполненной. Повторяющаяся задача переносится на следующую дату.',
        },
        reopen_task: { title: 'Возврат задачи', description: 'Снова открывает выполненную задачу.' },
        delete_task: {
          title: 'Удаление задачи',
          description: 'Удаляет задачу без возможности восстановления.',
        },
      },
    },
    en: {
      setup: {
        oauth: {
          summary: 'Your Todoist account. Takes under a minute.',
          steps: [
            {
              text: 'Click Connect and sign in to Todoist.',
            },
            {
              text: 'Click Agree: AnyConnect may read, add, change and delete your tasks and projects.',
            },
            {
              text: 'Done. Another Todoist account? Connect it the same way.',
            },
          ],
        },
        form: {
          summary: 'Your Todoist API token. Takes about a minute.',
          steps: [
            {
              text: 'Open Todoist → Settings → Integrations → Developer.',
              link: {
                label: 'Open Todoist → Developer',
                url: 'https://app.todoist.com/app/settings/integrations/developer',
              },
            },
            {
              text: 'Click Copy API token.',
            },
            {
              text: 'Paste it into the form and click Connect.',
            },
          ],
          tips: ['The token opens your whole Todoist. To cut access, issue a new token on the same page.'],
        },
      },
      prompts: [
        'What is due today and tomorrow?',
        'Add “Send the contract to ACME” to Work for Friday 10 am.',
        'Which overdue tasks can I close? Show me the list first.',
        'Move everything in Personal tagged “later” to next Monday.',
      ],
      fields: {
        token: {
          label: 'API token',
          hint: 'Find it in Todoist: Settings → Integrations → Developer.',
        },
      },
      actions: {
        find_tasks: { title: 'Find tasks', description: 'Finds open tasks that match a Todoist filter.' },
        list_projects: { title: 'List projects', description: 'Todoist projects with their ids.' },
        add_task: { title: 'Add a task', description: 'Creates a task.' },
        update_task: {
          title: 'Update a task',
          description: 'Changes the title, description, due date, priority or labels of a task.',
        },
        complete_task: {
          title: 'Complete a task',
          description: 'Marks a task as done. A recurring task moves to its next date.',
        },
        reopen_task: { title: 'Reopen a task', description: 'Reopens a completed task.' },
        delete_task: { title: 'Delete a task', description: 'Deletes a task permanently.' },
      },
    },
  },
};

export default withUi(manifest, ui);
