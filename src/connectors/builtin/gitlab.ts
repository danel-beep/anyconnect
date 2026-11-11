import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** GitLab REST API v4 (gitlab.com or a self-managed instance) with a personal access token. */

const project = {
  type: 'string',
  minLength: 1,
  description: 'Project id or full path, e.g. "acme/web"',
};
const iid = {
  type: 'integer',
  minimum: 1,
  description: 'Issue or merge request number (iid) in the project',
};
const perPage = { type: 'integer', minimum: 1, maximum: 100, default: 20 };
const ISSUE_FIELDS = [
  'iid',
  'project_id',
  'title',
  'state',
  'labels',
  'assignee.username',
  'author.username',
  'due_date',
  'updated_at',
  'web_url',
];
const MR_FIELDS = [
  'iid',
  'project_id',
  'title',
  'state',
  'draft',
  'author.username',
  'source_branch',
  'target_branch',
  'merge_status',
  'updated_at',
  'web_url',
];
const issueFields = {
  title: { type: 'string', minLength: 1 },
  description: { type: 'string', description: 'Markdown' },
  labels: { type: 'string', description: 'Comma-separated, e.g. "bug,backend"' },
  due_date: { type: 'string', description: 'YYYY-MM-DD' },
};

const manifest = defineManifestConnector({
  id: 'gitlab',
  name: 'GitLab',
  description: 'GitLab projects, issues and merge requests: find, read, create, update, comment.',
  version: '1.0.0',
  homepage: 'https://docs.gitlab.com/api/rest/',
  instructions:
    'Projects are addressed by id or full path ("group/project"); issues and merge requests by their number (iid) inside the project.',
  baseUrl: 'https://{{config.host}}/api/v4',
  config: {
    type: 'object',
    properties: {
      host: {
        type: 'string',
        default: 'gitlab.com',
        pattern: '^[a-zA-Z0-9.-]+(:[0-9]+)?$',
        description: 'gitlab.com, or the host of your self-managed GitLab, e.g. gitlab.acme.com',
      },
    },
  },
  credentials: {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        minLength: 20,
        description: 'Personal access token (glpat-…) with the api scope',
      },
    },
    required: ['token'],
  },
  auth: { type: 'bearer', token: '{{credentials.token}}' },
  rateLimit: { requests: 300, perSeconds: 60 },
  errorMessagePaths: ['message', 'error', 'error_description'],
  pagination: { type: 'link' },
  test: { request: { method: 'GET', path: '/user' }, identity: '{{response.username}}' },
  actions: [
    {
      name: 'list_projects',
      title: 'List projects',
      description: 'Lists projects you are a member of, recently active first.',
      input: {
        type: 'object',
        properties: { search: { type: 'string', description: 'Part of the name' }, per_page: perPage },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/projects',
        query: {
          membership: 'true',
          simple: 'true',
          order_by: 'last_activity_at',
          search: '{{input.search}}',
          per_page: '{{input.per_page}}',
        },
      },
      response: { fields: ['id', 'path_with_namespace', 'web_url', 'last_activity_at'] },
      pagination: true,
    },
    {
      name: 'search_issues',
      title: 'Search issues',
      description: 'Finds issues across projects: by default open ones assigned to you.',
      input: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Words in the title or description' },
          scope: {
            type: 'string',
            enum: ['assigned_to_me', 'created_by_me', 'all'],
            default: 'assigned_to_me',
          },
          state: { type: 'string', enum: ['opened', 'closed', 'all'], default: 'opened' },
          labels: { type: 'string', description: 'Comma-separated labels' },
          per_page: perPage,
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/issues',
        query: {
          search: '{{input.search}}',
          scope: '{{input.scope}}',
          state: '{{input.state}}',
          labels: '{{input.labels}}',
          per_page: '{{input.per_page}}',
        },
      },
      response: { fields: ISSUE_FIELDS },
      pagination: true,
    },
    {
      name: 'get_issue',
      title: 'Get issue',
      description: 'Returns an issue with its description.',
      input: { type: 'object', properties: { project, iid }, required: ['project', 'iid'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/projects/{project}/issues/{iid}' },
      response: {
        fields: [...ISSUE_FIELDS, 'description', 'created_at', 'milestone.title', 'user_notes_count'],
      },
    },
    {
      name: 'list_notes',
      title: 'List comments',
      description: 'Lists comments of an issue, oldest first.',
      input: {
        type: 'object',
        properties: { project, iid, per_page: perPage },
        required: ['project', 'iid'],
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/projects/{project}/issues/{iid}/notes',
        query: { sort: 'asc', per_page: '{{input.per_page}}' },
      },
      response: { fields: ['id', 'author.username', 'created_at', 'body', 'system'] },
      pagination: true,
    },
    {
      name: 'create_issue',
      title: 'Create issue',
      description: 'Opens an issue in a project.',
      input: { type: 'object', properties: { project, ...issueFields }, required: ['project', 'title'] },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      // The project may be public (and anyone's): see the `publishes` tag.
      tags: ['publishes'],
      request: { method: 'POST', path: '/projects/{project}/issues' },
      response: { fields: ['iid', 'project_id', 'web_url'] },
    },
    {
      name: 'update_issue',
      title: 'Update issue',
      description: 'Changes an issue, or closes / reopens it.',
      input: {
        type: 'object',
        properties: {
          project,
          iid,
          ...issueFields,
          state_event: { type: 'string', enum: ['close', 'reopen'] },
        },
        required: ['project', 'iid'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      // The project may be public (and anyone's): see the `publishes` tag.
      tags: ['publishes'],
      request: { method: 'PUT', path: '/projects/{project}/issues/{iid}' },
      response: { fields: ISSUE_FIELDS },
    },
    {
      name: 'add_note',
      title: 'Add comment',
      description: 'Adds a comment to an issue.',
      input: {
        type: 'object',
        properties: { project, iid, body: { type: 'string', minLength: 1, description: 'Markdown' } },
        required: ['project', 'iid', 'body'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      // The project may be public (and anyone's): see the `publishes` tag.
      tags: ['publishes'],
      request: { method: 'POST', path: '/projects/{project}/issues/{iid}/notes' },
      response: { fields: ['id', 'created_at'] },
    },
    {
      name: 'list_merge_requests',
      title: 'List merge requests',
      description:
        'Lists merge requests across projects: by default open ones you authored; for reviews use scope all with reviewer_username.',
      input: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['created_by_me', 'assigned_to_me', 'all'],
            default: 'created_by_me',
          },
          reviewer_username: {
            type: 'string',
            description: 'Only ones waiting for this reviewer; your username is the account identity',
          },
          state: { type: 'string', enum: ['opened', 'merged', 'closed', 'all'], default: 'opened' },
          project_id: { type: 'string', description: 'Only this project (id)' },
          per_page: perPage,
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/merge_requests',
        query: {
          scope: '{{input.scope}}',
          reviewer_username: '{{input.reviewer_username}}',
          state: '{{input.state}}',
          project_id: '{{input.project_id}}',
          per_page: '{{input.per_page}}',
        },
      },
      response: { fields: MR_FIELDS },
      pagination: true,
    },
    {
      name: 'get_merge_request',
      title: 'Get merge request',
      description: 'Returns a merge request with its description and pipeline status.',
      input: { type: 'object', properties: { project, iid }, required: ['project', 'iid'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/projects/{project}/merge_requests/{iid}' },
      response: {
        fields: [...MR_FIELDS, 'description', 'head_pipeline.status', 'changes_count', 'user_notes_count'],
      },
    },
  ],
});

const ui: ConnectorUi = {
  locales: {
    ru: {
      description:
        'Проекты, задачи и merge request’ы GitLab: поиск, чтение, создание, изменение и комментарии.',
      setup: {
        form: {
          summary: 'Вы создаёте персональный токен доступа в GitLab и вставляете его сюда.',
          minutes: 2,
          needs: [
            'Аккаунт на gitlab.com или на сервере GitLab вашей компании',
            'Если GitLab на сервере компании: его адрес, например gitlab.acme.com. Все шаги делайте на нём, а не на gitlab.com',
          ],
          steps: [
            {
              text: 'Откройте в GitLab **аватар → Edit profile → Access tokens** и нажмите **Add new token**.',
              link: {
                label: 'Открыть токены GitLab',
                url: 'https://gitlab.com/-/user_settings/personal_access_tokens',
              },
            },
            {
              text: 'Назовите токен Manyplug, задайте срок действия и в разделе **Select scopes** отметьте **api**.',
            },
            {
              text: 'Нажмите **Create token** внизу (в старых версиях **Create personal access token**) и скопируйте токен, он начинается с glpat-.',
              fills: ['token'],
            },
            {
              text: 'Если GitLab на сервере компании, впишите его адрес в форму без https://, например gitlab.acme.com. Для gitlab.com поле не меняйте.',
              fills: ['host'],
            },
          ],
          tips: [
            'Чтобы ИИ только читал, вместо **api** отметьте **read_api**.',
            'Отозвать токен можно на той же странице: **Revoke** рядом с ним.',
          ],
          problems: [
            {
              problem: 'Ошибка 401 или «Unauthorized»',
              fix: 'Токен истёк, отозван или скопирован с пробелом. Создайте новый и нажмите **Переподключить**.',
            },
            {
              problem: 'Ошибка 403 при создании задачи или комментария',
              fix: 'У токена право **read_api** вместо **api**. Создайте токен с **api** и вставьте его через **Переподключить**.',
            },
            {
              problem: 'Свой сервер GitLab не отвечает',
              fix: 'Проверьте адрес в поле «Сервер GitLab» (без https:// и пути). Сервер должен быть доступен из интернета, а не только из сети компании.',
            },
          ],
        },
      },
      prompts: [
        'Какие merge request’ы ждут моего ревью в GitLab?',
        'Какие задачи на мне открыты?',
        'Заведи задачу в acme/web: «Падает экспорт в CSV» с метками bug и backend.',
        'Перескажи MR !128 в acme/api и статус пайплайна.',
      ],
      fields: {
        host: {
          label: 'Сервер GitLab',
          hint: 'gitlab.com или адрес вашего сервера, например gitlab.acme.com.',
        },
        token: { label: 'Персональный токен доступа', hint: 'Edit profile → Access tokens, право api.' },
      },
      actions: {
        list_projects: { title: 'Список проектов', description: 'Проекты, в которых вы участвуете.' },
        search_issues: {
          title: 'Поиск задач',
          description: 'Ищет задачи во всех проектах, по умолчанию ваши открытые.',
        },
        get_issue: { title: 'Задача', description: 'Показывает задачу с описанием.' },
        list_notes: { title: 'Комментарии', description: 'Комментарии к задаче.' },
        create_issue: { title: 'Новая задача', description: 'Создаёт задачу в проекте.' },
        update_issue: {
          title: 'Изменение задачи',
          description: 'Меняет задачу, закрывает или открывает её снова.',
        },
        add_note: { title: 'Новый комментарий', description: 'Добавляет комментарий к задаче.' },
        list_merge_requests: {
          title: 'Merge request’ы',
          description: 'Ваши открытые merge request’ы или те, что ждут вашего ревью.',
        },
        get_merge_request: {
          title: 'Merge request',
          description: 'Показывает merge request с описанием и статусом пайплайна.',
        },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'You create a personal access token in GitLab and paste it here.',
          minutes: 2,
          needs: [
            'An account on gitlab.com or on your company’s GitLab server',
            'For a company server: its address, for example gitlab.acme.com. Do every step there, not on gitlab.com',
          ],
          steps: [
            {
              text: 'In GitLab, open **your avatar → Edit profile → Access tokens** and click **Add new token**.',
              link: {
                label: 'Open GitLab access tokens',
                url: 'https://gitlab.com/-/user_settings/personal_access_tokens',
              },
            },
            {
              text: 'Name it Manyplug, set an expiry date and, under **Select scopes**, tick **api**.',
            },
            {
              text: 'Click **Create token** at the bottom (**Create personal access token** in older versions) and copy the token, it starts with glpat-.',
              fills: ['token'],
            },
            {
              text: 'On a company GitLab server, enter its address in the form without https://, for example gitlab.acme.com. For gitlab.com, leave the field as it is.',
              fills: ['host'],
            },
          ],
          tips: [
            'For read-only access, tick **read_api** instead of **api**.',
            'To cut access, click **Revoke** next to the token on the same page.',
          ],
          problems: [
            {
              problem: 'Error 401 or “Unauthorized”',
              fix: 'The token expired, was revoked or was copied with a space. Create a new one and click **Reconnect**.',
            },
            {
              problem: 'Error 403 when creating an issue or a comment',
              fix: 'The token has **read_api** instead of **api**. Create a token with **api** and paste it with **Reconnect**.',
            },
            {
              problem: 'Your own GitLab server does not answer',
              fix: 'Check the address in the GitLab server field (no https:// and no path). The server must be reachable from the internet, not only from the company network.',
            },
          ],
        },
      },
      prompts: [
        'Which GitLab merge requests are waiting for my review?',
        'What issues are assigned to me?',
        'File an issue in acme/web: “CSV export fails”, labels bug and backend.',
        'Summarize MR !128 in acme/api and its pipeline status.',
      ],
      fields: {
        host: { label: 'GitLab server', hint: 'gitlab.com or your server, e.g. gitlab.acme.com.' },
        token: { label: 'Personal access token', hint: 'Edit profile → Access tokens, api scope.' },
      },
      actions: {
        list_projects: { title: 'List projects', description: 'Projects you are a member of.' },
        search_issues: {
          title: 'Search issues',
          description: 'Finds issues in all projects, by default your open ones.',
        },
        get_issue: { title: 'Get an issue', description: 'Shows an issue with its description.' },
        list_notes: { title: 'List comments', description: 'Comments of an issue.' },
        create_issue: { title: 'Create an issue', description: 'Opens an issue in a project.' },
        update_issue: { title: 'Update an issue', description: 'Changes an issue, or closes or reopens it.' },
        add_note: { title: 'Add a comment', description: 'Adds a comment to an issue.' },
        list_merge_requests: {
          title: 'List merge requests',
          description: 'Your open merge requests, or the ones waiting for your review.',
        },
        get_merge_request: {
          title: 'Get a merge request',
          description: 'Shows a merge request with its description and pipeline status.',
        },
      },
    },
  },
};

export default withUi(manifest, ui);
