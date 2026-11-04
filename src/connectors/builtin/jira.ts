import { defineManifestConnector } from '../manifest/compile.js';
import type { CapabilityBinding, CapabilityOutput } from '../sdk.js';
import { ConnectorError, type ConnectorUi, withUi } from '../sdk.js';

/**
 * Jira Cloud REST API v2 (v2 takes and returns plain-text descriptions and comments; v3 uses the
 * verbose Atlassian Document Format). Basic auth with the account email and an API token.
 */

const ISSUE_FIELDS = [
  'key',
  'fields.summary',
  'fields.status.name',
  'fields.issuetype.name',
  'fields.priority.name',
  'fields.assignee.displayName',
  'fields.duedate',
  'fields.updated',
];
const SEARCH_FIELDS = 'summary,status,issuetype,priority,assignee,duedate,updated,project';
const issueKey = { type: 'string', minLength: 1, description: 'Issue key, e.g. "ENG-42"' };

interface JiraIssue {
  key: string;
  fields?: {
    summary?: string;
    duedate?: string | null;
    status?: { statusCategory?: { key?: string } };
    priority?: { name?: string };
    project?: { key?: string };
  };
}

/** JQL string literal: quotes and backslashes escaped. */
const jqlString = (value: string) => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** Jira's priorities by name, mapped to the shared 1 (normal) … 4 (urgent) scale. */
const PRIORITY: Record<string, number> = { highest: 4, high: 3, medium: 2, low: 1, lowest: 1 };

/**
 * The shared task list is "my issues". The search endpoint refuses unbounded JQL, and issues of
 * the whole site are rarely what "my tasks" means.
 */
const listTasks: CapabilityBinding = {
  id: 'tasks.list',
  mapInput: ({ query, status, due_before, limit }) => {
    const clauses = ['assignee = currentUser()'];
    if (status === 'open') clauses.push('statusCategory != Done');
    if (status === 'done') clauses.push('statusCategory = Done');
    if (typeof query === 'string' && query.trim()) clauses.push(`text ~ ${jqlString(query.trim())}`);
    if (typeof due_before === 'string') clauses.push(`due <= "${due_before.slice(0, 10)}"`);
    return { jql: `${clauses.join(' AND ')} ORDER BY duedate ASC, updated DESC`, limit };
  },
  mapOutput: (result, _input) => {
    const { items, nextCursor } = result as { items: JiraIssue[]; nextCursor?: string };
    return {
      items: items.map(
        (issue): CapabilityOutput<'tasks.list'> => ({
          id: issue.key,
          title: issue.fields?.summary ?? issue.key,
          status: issue.fields?.status?.statusCategory?.key === 'done' ? 'done' : 'open',
          ...(issue.fields?.duedate ? { due: issue.fields.duedate } : {}),
          ...(PRIORITY[issue.fields?.priority?.name?.toLowerCase() ?? '']
            ? { priority: PRIORITY[issue.fields!.priority!.name!.toLowerCase()] }
            : {}),
          ...(issue.fields?.project?.key ? { project: issue.fields.project.key } : {}),
        }),
      ),
      ...(nextCursor ? { nextCursor } : {}),
    };
  },
};

/** A Jira issue needs a project; the shared `project` is taken as the project key. */
const createTask: CapabilityBinding = {
  id: 'tasks.create',
  mapInput: ({ title, description, due, project }) => {
    if (typeof project !== 'string' || !project.trim()) {
      throw new ConnectorError(
        'invalid_input',
        'Jira needs a project: pass its key (e.g. "ENG") as project; jira_list_projects lists them.',
      );
    }
    return {
      project_key: project.trim().toUpperCase(),
      summary: title,
      ...(description ? { description } : {}),
      ...(typeof due === 'string' ? { duedate: due.slice(0, 10) } : {}),
    };
  },
  mapOutput: (result) => {
    const { key } = result as { key: string };
    return { id: key };
  },
};

const manifest = defineManifestConnector(
  {
    id: 'jira',
    name: 'Jira',
    description: 'Jira Cloud issues and projects: search with JQL, read, create, update, comment, move.',
    version: '1.0.0',
    homepage: 'https://developer.atlassian.com/cloud/jira/platform/rest/v2/',
    instructions:
      'jira_search_issues takes JQL, e.g. "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC", "project = ENG AND text ~ \\"login\\"". A query must have at least one condition. To change status, call jira_list_transitions, then jira_transition_issue.',
    baseUrl: 'https://{{config.site}}.atlassian.net/rest/api/2',
    config: {
      type: 'object',
      properties: {
        site: {
          type: 'string',
          pattern: '^[a-zA-Z0-9][a-zA-Z0-9-]*$',
          description: 'Your Jira site name: the part before .atlassian.net, e.g. "acme"',
        },
        email: { type: 'string', format: 'email', description: 'Email you sign in to Atlassian with' },
      },
      required: ['site', 'email'],
    },
    credentials: {
      type: 'object',
      properties: {
        apiToken: {
          type: 'string',
          minLength: 1,
          description: 'API token: https://id.atlassian.com/manage-profile/security/api-tokens',
        },
      },
      required: ['apiToken'],
    },
    auth: { type: 'basic', username: '{{config.email}}', password: '{{credentials.apiToken}}' },
    rateLimit: { requests: 100, perSeconds: 60 },
    errorMessagePaths: ['errorMessages.0', 'errors.summary', 'errors.project', 'message'],
    test: { request: { method: 'GET', path: '/myself' }, identity: '{{response.emailAddress}}' },
    actions: [
      {
        name: 'search_issues',
        title: 'Search issues',
        description: 'Finds issues with a JQL query, most relevant first.',
        input: {
          type: 'object',
          properties: {
            jql: { type: 'string', minLength: 1, description: 'JQL query' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
          },
          required: ['jql'],
        },
        hints: { readOnly: true, idempotent: true },
        request: {
          method: 'GET',
          path: '/search/jql',
          query: { jql: '{{input.jql}}', maxResults: '{{input.limit}}', fields: SEARCH_FIELDS },
        },
        response: {
          root: 'issues',
          fields: [...ISSUE_FIELDS, 'fields.project.key', 'fields.status.statusCategory.key'],
        },
        pagination: { type: 'cursor', param: 'nextPageToken', nextPath: 'nextPageToken' },
      },
      {
        name: 'get_issue',
        title: 'Get issue',
        description: 'Returns an issue with its description.',
        input: { type: 'object', properties: { issue_key: issueKey }, required: ['issue_key'] },
        hints: { readOnly: true, idempotent: true },
        request: {
          method: 'GET',
          path: '/issue/{issue_key}',
          query: {
            fields: `${SEARCH_FIELDS},description,reporter,labels,created,parent`,
          },
        },
        response: {
          fields: [
            ...ISSUE_FIELDS,
            'fields.project.key',
            'fields.description',
            'fields.reporter.displayName',
            'fields.labels',
            'fields.created',
            'fields.parent.key',
          ],
        },
      },
      {
        name: 'list_comments',
        title: 'List comments',
        description: 'Lists comments of an issue, newest first.',
        input: {
          type: 'object',
          properties: {
            issue_key: issueKey,
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
          required: ['issue_key'],
        },
        hints: { readOnly: true, idempotent: true },
        request: {
          method: 'GET',
          path: '/issue/{issue_key}/comment',
          query: { orderBy: '-created', maxResults: '{{input.limit}}' },
        },
        response: { root: 'comments', fields: ['id', 'author.displayName', 'created', 'body'] },
        pagination: { type: 'offset', param: 'startAt', limitParam: 'limit', defaultLimit: 20 },
      },
      {
        name: 'list_projects',
        title: 'List projects',
        description: 'Lists projects with their keys.',
        input: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Part of the project name or key' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          },
        },
        hints: { readOnly: true, idempotent: true },
        request: {
          method: 'GET',
          path: '/project/search',
          query: { query: '{{input.query}}', maxResults: '{{input.limit}}' },
        },
        response: { root: 'values', fields: ['key', 'name', 'projectTypeKey'] },
        pagination: { type: 'offset', param: 'startAt', limitParam: 'limit', defaultLimit: 50 },
      },
      {
        name: 'create_issue',
        title: 'Create issue',
        description: 'Creates an issue in a project.',
        input: {
          type: 'object',
          properties: {
            project_key: { type: 'string', minLength: 1, description: 'Project key, e.g. "ENG"' },
            summary: { type: 'string', minLength: 1 },
            description: { type: 'string', description: 'Plain text or Jira wiki markup' },
            issue_type: { type: 'string', default: 'Task', description: 'Task, Bug, Story, Epic…' },
            duedate: { type: 'string', description: 'YYYY-MM-DD' },
            labels: { type: 'array', items: { type: 'string' } },
          },
          required: ['project_key', 'summary'],
        },
        hints: { readOnly: false, destructive: false },
        risk: 'write',
        undo: { kind: 'action', action: 'delete_issue' },
        request: {
          method: 'POST',
          path: '/issue',
          body: {
            fields: {
              project: { key: '{{input.project_key}}' },
              issuetype: { name: '{{input.issue_type}}' },
              summary: '{{input.summary}}',
              description: '{{input.description}}',
              duedate: '{{input.duedate}}',
              labels: '{{input.labels}}',
            },
          },
        },
        response: { fields: ['key'] },
      },
      {
        name: 'update_issue',
        title: 'Update issue',
        description: 'Changes the summary, description, due date or labels of an issue.',
        input: {
          type: 'object',
          properties: {
            issue_key: issueKey,
            summary: { type: 'string', minLength: 1 },
            description: { type: 'string' },
            duedate: { type: 'string', description: 'YYYY-MM-DD' },
            labels: { type: 'array', items: { type: 'string' }, description: 'Replaces all labels' },
          },
          required: ['issue_key'],
        },
        hints: { readOnly: false, destructive: false, idempotent: true },
        risk: 'write',
        request: {
          method: 'PUT',
          path: '/issue/{issue_key}',
          body: {
            fields: {
              summary: '{{input.summary}}',
              description: '{{input.description}}',
              duedate: '{{input.duedate}}',
              labels: '{{input.labels}}',
            },
          },
        },
        response: { empty: 'Updated.' },
      },
      {
        name: 'list_transitions',
        title: 'List transitions',
        description: 'Statuses an issue can move to now, with transition ids.',
        input: { type: 'object', properties: { issue_key: issueKey }, required: ['issue_key'] },
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/issue/{issue_key}/transitions' },
        response: { root: 'transitions', fields: ['id', 'name', 'to.name', 'to.statusCategory.key'] },
      },
      {
        name: 'transition_issue',
        title: 'Change status',
        description: 'Moves an issue to another status with a transition id from jira_list_transitions.',
        input: {
          type: 'object',
          properties: { issue_key: issueKey, transition_id: { type: 'string', minLength: 1 } },
          required: ['issue_key', 'transition_id'],
        },
        hints: { readOnly: false, destructive: false },
        risk: 'write',
        request: {
          method: 'POST',
          path: '/issue/{issue_key}/transitions',
          body: { transition: { id: '{{input.transition_id}}' } },
        },
        response: { empty: 'Status changed.' },
      },
      {
        name: 'add_comment',
        title: 'Add comment',
        description: 'Adds a comment to an issue.',
        input: {
          type: 'object',
          properties: { issue_key: issueKey, body: { type: 'string', minLength: 1 } },
          required: ['issue_key', 'body'],
        },
        hints: { readOnly: false, destructive: false },
        risk: 'write',
        request: { method: 'POST', path: '/issue/{issue_key}/comment', body: { body: '{{input.body}}' } },
        response: { fields: ['id', 'created'] },
      },
      {
        name: 'delete_issue',
        title: 'Delete issue',
        description: 'Deletes an issue permanently.',
        input: { type: 'object', properties: { issue_key: issueKey }, required: ['issue_key'] },
        hints: { readOnly: false, destructive: true, idempotent: true },
        risk: 'dangerous',
        request: { method: 'DELETE', path: '/issue/{issue_key}' },
        response: { empty: 'Deleted.' },
      },
    ],
  },
  { actions: { search_issues: { capability: listTasks }, create_issue: { capability: createTask } } },
);

const ui: ConnectorUi = {
  primaryFields: ['site', 'email', 'apiToken'],
  locales: {
    ru: {
      description:
        'Задачи и проекты Jira Cloud: поиск по JQL, чтение, создание, изменение, комментарии, смена статуса.',
      setup: {
        form: {
          summary: 'Адрес вашего Jira, почта и токен API. Около двух минут.',
          steps: [
            {
              text: 'Откройте страницу токенов API Atlassian и нажмите Create API token (без scopes).',
              link: {
                label: 'Открыть токены API Atlassian',
                url: 'https://id.atlassian.com/manage-profile/security/api-tokens',
              },
            },
            { text: 'Назовите токен Manyplug, выберите срок действия и нажмите Create.' },
            { text: 'Скопируйте токен: Atlassian покажет его только один раз.' },
            {
              text: 'В форме укажите имя сайта (из адреса acme.atlassian.net — это acme), почту, с которой входите в Atlassian, и токен.',
            },
          ],
          tips: [
            'ИИ видит в Jira то же, что и вы. Чтобы закрыть доступ, отзовите токен на той же странице.',
            'Несколько сайтов Jira? Подключите каждый отдельным аккаунтом.',
          ],
        },
      },
      prompts: [
        'Какие задачи в Jira на мне и что горит на этой неделе?',
        'Заведи баг в ENG: «Не работает вход через Safari» с тем, что мы обсудили.',
        'Перескажи ENG-142 и последние комментарии.',
        'Переведи ENG-140 в «Готово» и напиши в комментарии, что фикс в релизе.',
      ],
      fields: {
        site: { label: 'Сайт Jira', hint: 'Часть адреса до .atlassian.net: для acme.atlassian.net — acme.' },
        email: { label: 'Почта Atlassian', hint: 'Та, с которой вы входите в Jira.' },
        apiToken: { label: 'Токен API', hint: 'Создаётся на id.atlassian.com → Security → API tokens.' },
      },
      actions: {
        search_issues: { title: 'Поиск задач', description: 'Находит задачи по запросу JQL.' },
        get_issue: { title: 'Задача', description: 'Показывает задачу с описанием.' },
        list_comments: { title: 'Комментарии', description: 'Комментарии к задаче, сначала новые.' },
        list_projects: { title: 'Список проектов', description: 'Проекты Jira с их ключами.' },
        create_issue: { title: 'Новая задача', description: 'Создаёт задачу в проекте.' },
        update_issue: {
          title: 'Изменение задачи',
          description: 'Меняет название, описание, срок или метки задачи.',
        },
        list_transitions: {
          title: 'Доступные статусы',
          description: 'Статусы, в которые задачу можно перевести сейчас.',
        },
        transition_issue: { title: 'Смена статуса', description: 'Переводит задачу в другой статус.' },
        add_comment: { title: 'Новый комментарий', description: 'Добавляет комментарий к задаче.' },
        delete_issue: {
          title: 'Удаление задачи',
          description: 'Удаляет задачу без возможности восстановления.',
        },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'Your Jira address, email and an API token. Takes about two minutes.',
          steps: [
            {
              text: 'Open your Atlassian API tokens page and click Create API token (the one without scopes).',
              link: {
                label: 'Open Atlassian API tokens',
                url: 'https://id.atlassian.com/manage-profile/security/api-tokens',
              },
            },
            { text: 'Name it Manyplug, pick an expiry date and click Create.' },
            { text: 'Copy the token: Atlassian shows it only once.' },
            {
              text: 'In the form, enter your site name (acme for acme.atlassian.net), the email you sign in to Atlassian with, and the token.',
            },
          ],
          tips: [
            'The AI sees in Jira what you see. To cut access, revoke the token on the same page.',
            'Several Jira sites? Connect each one as its own account.',
          ],
        },
      },
      prompts: [
        'What Jira issues are assigned to me, and what is due this week?',
        'File a bug in ENG: “Safari login fails”, with what we just discussed.',
        'Summarize ENG-142 and its latest comments.',
        'Move ENG-140 to Done and comment that the fix is in the release.',
      ],
      fields: {
        site: { label: 'Jira site', hint: 'The part before .atlassian.net: for acme.atlassian.net, acme.' },
        email: { label: 'Atlassian email', hint: 'The one you sign in to Jira with.' },
        apiToken: { label: 'API token', hint: 'Create it at id.atlassian.com → Security → API tokens.' },
      },
      actions: {
        search_issues: { title: 'Search issues', description: 'Finds issues with a JQL query.' },
        get_issue: { title: 'Get an issue', description: 'Shows an issue with its description.' },
        list_comments: { title: 'List comments', description: 'Comments of an issue, newest first.' },
        list_projects: { title: 'List projects', description: 'Jira projects with their keys.' },
        create_issue: { title: 'Create an issue', description: 'Creates an issue in a project.' },
        update_issue: {
          title: 'Update an issue',
          description: 'Changes the summary, description, due date or labels of an issue.',
        },
        list_transitions: {
          title: 'Available statuses',
          description: 'Statuses the issue can move to right now.',
        },
        transition_issue: { title: 'Change status', description: 'Moves an issue to another status.' },
        add_comment: { title: 'Add a comment', description: 'Adds a comment to an issue.' },
        delete_issue: { title: 'Delete an issue', description: 'Deletes an issue permanently.' },
      },
    },
  },
};

export default withUi(manifest, ui);
