import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

const repo = {
  owner: { type: 'string', description: 'Repository owner (user or organization)' },
  repo: { type: 'string', description: 'Repository name' },
};
const issueNumber = { type: 'integer', minimum: 1, description: 'Issue or pull request number' };
const perPage = { type: 'integer', minimum: 1, maximum: 100, default: 20 };

const ISSUE_FIELDS = [
  'number',
  'title',
  'state',
  'user.login',
  'comments',
  'updated_at',
  'html_url',
  'pull_request.html_url',
];

/** GitHub REST API. Personal access token (fine-grained or classic) or OAuth. */
const manifest = defineManifestConnector({
  id: 'github',
  name: 'GitHub',
  description: 'GitHub repositories, issues, pull requests and notifications.',
  version: '1.0.0',
  homepage: 'https://docs.github.com/rest',
  instructions:
    'github_search_issues uses GitHub search syntax (e.g. "is:open is:pr review-requested:@me", "repo:o/r label:bug"). Issue tools also work for pull requests.',
  baseUrl: 'https://api.github.com',
  // OAuth through the hub's GitHub app, or a personal access token without one.
  auth: {
    type: 'oauth2',
    provider: 'github',
    scopes: ['repo', 'notifications', 'read:user'],
    token: '{{credentials.token}}',
  },
  credentials: {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        minLength: 1,
        description:
          'Personal access token (only without OAuth): https://github.com/settings/personal-access-tokens',
      },
    },
  },
  headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  rateLimit: { requests: 80, perSeconds: 60 },
  errorMessagePaths: ['message'],
  pagination: { type: 'link' },
  test: { request: { method: 'GET', path: '/user' }, identity: '{{response.login}}' },
  actions: [
    {
      name: 'search_issues',
      title: 'Search issues and PRs',
      description: 'Searches issues and pull requests across GitHub with search qualifiers.',
      input: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Search query, e.g. "is:open assignee:@me"' },
          sort: { type: 'string', enum: ['updated', 'created', 'comments'] },
          per_page: perPage,
        },
        required: ['q'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/search/issues' },
      response: { root: 'items', fields: [...ISSUE_FIELDS, 'repository_url'] },
      pagination: true,
    },
    {
      name: 'get_issue',
      title: 'Get issue or PR',
      description: 'Returns an issue or pull request with its description.',
      input: {
        type: 'object',
        properties: { ...repo, number: issueNumber },
        required: ['owner', 'repo', 'number'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/repos/{owner}/{repo}/issues/{number}' },
      response: {
        fields: [...ISSUE_FIELDS, 'body', 'created_at', 'closed_at', 'assignee.login', 'milestone.title'],
      },
    },
    {
      name: 'list_comments',
      title: 'List comments',
      description: 'Lists comments of an issue or pull request, oldest first.',
      input: {
        type: 'object',
        properties: { ...repo, number: issueNumber, per_page: perPage },
        required: ['owner', 'repo', 'number'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/repos/{owner}/{repo}/issues/{number}/comments' },
      response: { fields: ['id', 'user.login', 'created_at', 'body'] },
      pagination: true,
    },
    {
      name: 'create_issue',
      title: 'Create issue',
      description: 'Opens a new issue.',
      input: {
        type: 'object',
        properties: {
          ...repo,
          title: { type: 'string', minLength: 1 },
          body: { type: 'string', description: 'Markdown' },
          labels: { type: 'array', items: { type: 'string' } },
          assignees: { type: 'array', items: { type: 'string' }, description: 'Logins' },
        },
        required: ['owner', 'repo', 'title'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: { method: 'POST', path: '/repos/{owner}/{repo}/issues' },
      response: { fields: ['number', 'html_url'] },
    },
    {
      name: 'update_issue',
      title: 'Update issue',
      description: 'Changes title, body, state (open/closed), labels or assignees of an issue or PR.',
      input: {
        type: 'object',
        properties: {
          ...repo,
          number: issueNumber,
          title: { type: 'string' },
          body: { type: 'string' },
          state: { type: 'string', enum: ['open', 'closed'] },
          state_reason: { type: 'string', enum: ['completed', 'not_planned', 'reopened'] },
          labels: { type: 'array', items: { type: 'string' }, description: 'Replaces all labels' },
          assignees: { type: 'array', items: { type: 'string' }, description: 'Replaces all assignees' },
        },
        required: ['owner', 'repo', 'number'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: { method: 'PATCH', path: '/repos/{owner}/{repo}/issues/{number}' },
      response: { fields: ['number', 'state', 'html_url'] },
    },
    {
      name: 'add_comment',
      title: 'Comment',
      description: 'Adds a comment to an issue or pull request.',
      input: {
        type: 'object',
        properties: {
          ...repo,
          number: issueNumber,
          body: { type: 'string', minLength: 1, description: 'Markdown' },
        },
        required: ['owner', 'repo', 'number', 'body'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: { method: 'POST', path: '/repos/{owner}/{repo}/issues/{number}/comments' },
      response: { fields: ['id', 'html_url'] },
    },
    {
      name: 'list_pull_requests',
      title: 'List pull requests',
      description: 'Lists pull requests of a repository, recently updated first.',
      input: {
        type: 'object',
        properties: {
          ...repo,
          state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
          per_page: perPage,
        },
        required: ['owner', 'repo'],
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/repos/{owner}/{repo}/pulls',
        query: {
          state: '{{input.state}}',
          per_page: '{{input.per_page}}',
          sort: 'updated',
          direction: 'desc',
        },
      },
      response: {
        fields: [
          'number',
          'title',
          'state',
          'draft',
          'user.login',
          'head.ref',
          'base.ref',
          'updated_at',
          'html_url',
        ],
      },
      pagination: true,
    },
    {
      name: 'list_repos',
      title: 'List repositories',
      description: 'Lists repositories the account can access, recently updated first.',
      input: {
        type: 'object',
        properties: {
          affiliation: { type: 'string', default: 'owner,collaborator,organization_member' },
          per_page: perPage,
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/user/repos',
        query: { affiliation: '{{input.affiliation}}', per_page: '{{input.per_page}}', sort: 'updated' },
      },
      response: { fields: ['full_name', 'private', 'description', 'default_branch', 'updated_at'] },
      pagination: true,
    },
    {
      name: 'list_notifications',
      title: 'Notifications',
      description: 'Unread notifications: review requests, mentions, assigned issues, CI.',
      input: {
        type: 'object',
        properties: {
          all: { type: 'boolean', default: false, description: 'Include read ones' },
          per_page: perPage,
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/notifications' },
      response: {
        fields: [
          'id',
          'reason',
          'subject.title',
          'subject.type',
          'subject.url',
          'repository.full_name',
          'updated_at',
        ],
      },
      pagination: true,
    },
  ],
});

/** How the service reads on the website; the AI keeps the English texts of the manifest. */
const ui: ConnectorUi = {
  locales: {
    ru: {
      description: 'Репозитории, задачи, пулл-реквесты и уведомления GitHub.',
      fields: {
        token: {
          label: 'Персональный токен доступа',
          hint: 'Нужен, только если не входить через GitHub. Создать токен можно на github.com/settings/personal-access-tokens.',
        },
      },
      actions: {
        search_issues: {
          title: 'Поиск задач и пулл-реквестов',
          description: 'Ищет задачи и пулл-реквесты по всему GitHub с фильтрами поиска.',
        },
        get_issue: {
          title: 'Задача или пулл-реквест',
          description: 'Показывает задачу или пулл-реквест с описанием.',
        },
        list_comments: {
          title: 'Комментарии',
          description: 'Комментарии к задаче или пулл-реквесту, сначала старые.',
        },
        create_issue: { title: 'Новая задача', description: 'Создаёт задачу в репозитории.' },
        update_issue: {
          title: 'Изменение задачи',
          description:
            'Меняет заголовок, описание, статус (открыта или закрыта), метки или исполнителей задачи или пулл-реквеста.',
        },
        add_comment: {
          title: 'Новый комментарий',
          description: 'Добавляет комментарий к задаче или пулл-реквесту.',
        },
        list_pull_requests: {
          title: 'Список пулл-реквестов',
          description: 'Пулл-реквесты репозитория, сначала недавно обновлённые.',
        },
        list_repos: {
          title: 'Список репозиториев',
          description: 'Репозитории, к которым есть доступ, сначала недавно обновлённые.',
        },
        list_notifications: {
          title: 'Уведомления',
          description: 'Непрочитанные уведомления: запросы на ревью, упоминания, назначенные задачи, сборки.',
        },
      },
    },
    en: {
      fields: {
        token: {
          label: 'Personal access token',
          hint: 'Only if you do not sign in with GitHub. Create one at github.com/settings/personal-access-tokens.',
        },
      },
      actions: {
        search_issues: {
          title: 'Search issues and pull requests',
          description: 'Searches issues and pull requests across GitHub with search filters.',
        },
        get_issue: {
          title: 'Issue or pull request',
          description: 'Shows an issue or pull request with its description.',
        },
        list_comments: {
          title: 'Comments',
          description: 'Comments on an issue or pull request, oldest first.',
        },
        create_issue: { title: 'Create an issue', description: 'Opens a new issue in a repository.' },
        update_issue: {
          title: 'Update an issue',
          description:
            'Changes the title, body, state (open or closed), labels or assignees of an issue or pull request.',
        },
        add_comment: { title: 'Add a comment', description: 'Comments on an issue or pull request.' },
        list_pull_requests: {
          title: 'List pull requests',
          description: 'Pull requests of a repository, recently updated first.',
        },
        list_repos: {
          title: 'List repositories',
          description: 'Repositories you can access, recently updated first.',
        },
        list_notifications: {
          title: 'Notifications',
          description: 'Unread notifications: review requests, mentions, assigned issues, CI runs.',
        },
      },
    },
  },
};

export default withUi(manifest, ui);
