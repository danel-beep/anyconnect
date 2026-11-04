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
      setup: {
        oauth: {
          summary: 'Ваш аккаунт GitHub. Меньше минуты.',
          steps: [
            {
              text: 'Нажмите «Подключить» и войдите в GitHub.',
            },
            {
              text: 'Нажмите Authorize: Manyplug получит доступ к репозиториям, задачам, pull request’ам и уведомлениям.',
            },
            {
              text: 'Для репозиториев организации может понадобиться одобрение владельца: GitHub покажет кнопку Request рядом с организацией.',
            },
          ],
        },
        form: {
          summary: 'Персональный токен с точными правами (fine-grained). Около двух минут.',
          steps: [
            {
              text: 'Откройте GitHub → Settings → Developer settings → Fine-grained tokens и нажмите Generate new token.',
              link: {
                label: 'Создать токен на GitHub',
                url: 'https://github.com/settings/personal-access-tokens/new',
              },
            },
            {
              text: 'Назовите его Manyplug, выберите срок действия и в Repository access — репозитории, с которыми будет работать ИИ.',
            },
            {
              text: 'В Permissions поставьте Issues и Pull requests на Read and write, Contents — на Read-only.',
            },
            {
              text: 'Нажмите Generate token, скопируйте его (github_pat_…) и вставьте в форму.',
            },
          ],
          tips: [
            'Когда срок токена истечёт, у аккаунта появится «Войти заново»: создайте новый токен и вставьте его через «Переподключить».',
          ],
        },
      },
      prompts: [
        'Какие pull request’ы ждут моего ревью?',
        'Перескажи открытые задачи с меткой bug в acme/web.',
        'Заведи задачу в acme/api: «Ошибки лимита на /export» — с тем, что мы сейчас обсудили.',
        'Какие уведомления GitHub пришли сегодня?',
      ],
      description: 'Репозитории, задачи, пулл-реквесты и уведомления GitHub.',
      fields: {
        token: {
          label: 'Персональный токен доступа',
          hint: 'Создать токен можно на github.com/settings/personal-access-tokens.',
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
      setup: {
        oauth: {
          summary: 'Your GitHub account. Takes under a minute.',
          steps: [
            {
              text: 'Click Connect and sign in to GitHub.',
            },
            {
              text: 'Click Authorize: Manyplug gets access to your repositories, issues, pull requests and notifications.',
            },
            {
              text: 'Organisation repositories may need an owner’s approval: GitHub shows a Request button next to the organisation.',
            },
          ],
        },
        form: {
          summary: 'A fine-grained personal access token. Takes about two minutes.',
          steps: [
            {
              text: 'Open GitHub → Settings → Developer settings → Fine-grained tokens and click Generate new token.',
              link: {
                label: 'Create a token on GitHub',
                url: 'https://github.com/settings/personal-access-tokens/new',
              },
            },
            {
              text: 'Name it Manyplug, choose an expiry and, under Repository access, the repositories the AI may use.',
            },
            {
              text: 'Under Permissions, set Issues and Pull requests to Read and write, and Contents to Read-only.',
            },
            {
              text: 'Click Generate token, copy it (github_pat_…) and paste it into the form.',
            },
          ],
          tips: [
            'When the token expires, the account shows “Sign in again”: create a new token and paste it with Reconnect.',
          ],
        },
      },
      prompts: [
        'Which pull requests are waiting for my review?',
        'Summarise open issues labelled bug in acme/web.',
        'Open an issue in acme/api: “Rate limit errors on /export”, with what we just discussed.',
        'What GitHub notifications did I get today?',
      ],
      fields: {
        token: {
          label: 'Personal access token',
          hint: 'Create one at github.com/settings/personal-access-tokens.',
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
