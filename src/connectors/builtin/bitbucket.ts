import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Bitbucket Cloud API 2.0 for one workspace, with an Atlassian API token (basic auth with the email). */

const repo = {
  type: 'string',
  pattern: '^[A-Za-z0-9._-]+$',
  description: 'Repository slug from bitbucket_list_repositories',
};
const prId = { type: 'integer', minimum: 1, description: 'Pull request number' };
const pagelen = { type: 'integer', minimum: 1, maximum: 50, default: 20 };
const PR_FIELDS = [
  'id',
  'title',
  'state',
  'author.display_name',
  'source.branch.name',
  'destination.branch.name',
  'comment_count',
  'task_count',
  'created_on',
  'updated_on',
  'links.html.href',
];

const manifest = defineManifestConnector({
  id: 'bitbucket',
  name: 'Bitbucket',
  description: 'Bitbucket Cloud repositories, pull requests and pipelines: review, comment, approve, merge.',
  version: '1.0.0',
  homepage: 'https://developer.atlassian.com/cloud/bitbucket/rest/',
  instructions:
    'Repositories are addressed by slug within the connected workspace. Filters use Bitbucket query syntax, e.g. q=\'title ~ "login"\'.',
  baseUrl: 'https://api.bitbucket.org/2.0/repositories/{{config.workspace}}',
  config: {
    type: 'object',
    properties: {
      workspace: {
        type: 'string',
        pattern: '^[a-z0-9_-]+$',
        description: 'Workspace id from bitbucket.org/<workspace>/',
      },
      email: { type: 'string', format: 'email', description: 'Your Atlassian account email' },
    },
    required: ['workspace', 'email'],
  },
  credentials: {
    type: 'object',
    properties: {
      apiToken: {
        type: 'string',
        minLength: 20,
        description: 'Atlassian API token with Bitbucket scopes',
      },
    },
    required: ['apiToken'],
  },
  auth: { type: 'basic', username: '{{config.email}}', password: '{{credentials.apiToken}}' },
  rateLimit: { requests: 60, perSeconds: 60 },
  errorMessagePaths: ['error.message'],
  pagination: { type: 'next_url', nextPath: 'next' },
  test: { request: { method: 'GET', path: '/', query: { pagelen: '1' } } },
  actions: [
    {
      name: 'list_repositories',
      title: 'List repositories',
      description: 'Repositories of the workspace, most recently updated first.',
      input: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'e.g. name ~ "api"' },
          pagelen,
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/',
        query: { q: '{{input.q}}', pagelen: '{{input.pagelen}}', sort: '-updated_on' },
      },
      response: {
        root: 'values',
        fields: ['slug', 'name', 'is_private', 'language', 'mainbranch.name', 'updated_on', 'project.name'],
      },
      pagination: true,
    },
    {
      name: 'list_pull_requests',
      title: 'List pull requests',
      description: 'Pull requests of a repository by state, newest activity first.',
      input: {
        type: 'object',
        properties: {
          repo,
          state: { type: 'string', enum: ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'], default: 'OPEN' },
          q: { type: 'string', description: 'e.g. author.nickname = "ann"' },
          pagelen,
        },
        required: ['repo'],
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/{repo}/pullrequests',
        query: {
          state: '{{input.state}}',
          q: '{{input.q}}',
          pagelen: '{{input.pagelen}}',
          sort: '-updated_on',
        },
      },
      response: { root: 'values', fields: PR_FIELDS },
      pagination: true,
    },
    {
      name: 'get_pull_request',
      title: 'Get pull request',
      description: 'Returns a pull request with its description, reviewers and approvals.',
      input: { type: 'object', properties: { repo, pr_id: prId }, required: ['repo', 'pr_id'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/{repo}/pullrequests/{pr_id}' },
      response: { fields: [...PR_FIELDS, 'description', 'participants', 'merge_commit.hash'] },
    },
    {
      name: 'list_comments',
      title: 'List comments',
      description: 'Comments of a pull request, including inline ones with their file and line.',
      input: {
        type: 'object',
        properties: { repo, pr_id: prId, pagelen },
        required: ['repo', 'pr_id'],
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/{repo}/pullrequests/{pr_id}/comments',
        query: { pagelen: '{{input.pagelen}}' },
      },
      response: {
        root: 'values',
        fields: [
          'id',
          'user.display_name',
          'content.raw',
          'inline.path',
          'inline.to',
          'created_on',
          'deleted',
        ],
      },
      pagination: true,
    },
    {
      name: 'add_comment',
      title: 'Add comment',
      description: 'Adds a comment to a pull request.',
      input: {
        type: 'object',
        properties: { repo, pr_id: prId, text: { type: 'string', minLength: 1, description: 'Markdown' } },
        required: ['repo', 'pr_id', 'text'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: {
        method: 'POST',
        path: '/{repo}/pullrequests/{pr_id}/comments',
        body: { content: { raw: '{{input.text}}' } },
      },
      response: { fields: ['id', 'content.raw', 'links.html.href'] },
    },
    {
      name: 'add_inline_comment',
      title: 'Comment on a line',
      description: 'Adds a comment on a line of a changed file in a pull request.',
      input: {
        type: 'object',
        properties: {
          repo,
          pr_id: prId,
          file: { type: 'string', minLength: 1, description: 'File path in the repository' },
          line: { type: 'integer', minimum: 1, description: 'Line in the new version of the file' },
          text: { type: 'string', minLength: 1, description: 'Markdown' },
        },
        required: ['repo', 'pr_id', 'file', 'line', 'text'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: {
        method: 'POST',
        path: '/{repo}/pullrequests/{pr_id}/comments',
        body: {
          content: { raw: '{{input.text}}' },
          inline: { path: '{{input.file}}', to: '{{input.line}}' },
        },
      },
      response: { fields: ['id', 'content.raw', 'inline.path', 'inline.to', 'links.html.href'] },
    },
    {
      name: 'approve',
      title: 'Approve',
      description: 'Approves a pull request as you.',
      input: { type: 'object', properties: { repo, pr_id: prId }, required: ['repo', 'pr_id'] },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: { method: 'POST', path: '/{repo}/pullrequests/{pr_id}/approve' },
      response: { fields: ['approved', 'user.display_name'] },
    },
    {
      name: 'merge',
      title: 'Merge',
      description: 'Merges a pull request into its destination branch.',
      input: {
        type: 'object',
        properties: {
          repo,
          pr_id: prId,
          strategy: { type: 'string', enum: ['merge_commit', 'squash', 'fast_forward'] },
          close_source_branch: { type: 'boolean' },
          message: { type: 'string' },
        },
        required: ['repo', 'pr_id'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'dangerous',
      request: {
        method: 'POST',
        path: '/{repo}/pullrequests/{pr_id}/merge',
        body: {
          merge_strategy: '{{input.strategy}}',
          close_source_branch: '{{input.close_source_branch}}',
          message: '{{input.message}}',
        },
      },
      response: { fields: ['id', 'state', 'merge_commit.hash'] },
    },
    {
      name: 'list_pipelines',
      title: 'List pipelines',
      description: 'Pipeline runs of a repository, newest first, with their branch and result.',
      input: { type: 'object', properties: { repo, pagelen }, required: ['repo'] },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/{repo}/pipelines',
        query: { pagelen: '{{input.pagelen}}', sort: '-created_on' },
      },
      response: {
        root: 'values',
        fields: [
          'uuid',
          'build_number',
          'state.name',
          'state.result.name',
          'target.ref_name',
          'trigger.name',
          'created_on',
          'completed_on',
          'duration_in_seconds',
        ],
      },
      pagination: true,
    },
  ],
});

const ui: ConnectorUi = {
  primaryFields: ['workspace', 'email', 'apiToken'],
  locales: {
    ru: {
      description:
        'Репозитории, pull request’ы и пайплайны Bitbucket Cloud: ревью, комментарии, одобрение, мерж.',
      setup: {
        form: {
          summary:
            'Вы создаёте API-токен Atlassian для Bitbucket и вставляете его сюда вместе с именем рабочего пространства и почтой.',
          minutes: 3,
          needs: [
            'Аккаунт Bitbucket Cloud с доступом к рабочему пространству',
            'Почта, с которой вы входите в Atlassian',
          ],
          steps: [
            {
              text: 'Откройте страницу API-токенов Atlassian и нажмите **Create API token with scopes**.',
              link: {
                label: 'Открыть токены Atlassian',
                url: 'https://id.atlassian.com/manage-profile/security/api-tokens',
              },
            },
            { text: 'Назовите токен Manyplug, выберите срок действия и приложение **Bitbucket**.' },
            {
              text: 'Отметьте права **read:repository:bitbucket**, **read:pullrequest:bitbucket**, **write:pullrequest:bitbucket** и **read:pipeline:bitbucket**, нажмите **Create token** и скопируйте токен.',
              fills: ['apiToken'],
            },
            {
              text: 'В форме укажите рабочее пространство (acme для bitbucket.org/acme/) и почту, с которой входите в Atlassian.',
              fills: ['workspace', 'email'],
            },
          ],
          tips: [
            'Пароли приложений Bitbucket больше не выдаются: используйте API-токен Atlassian.',
            'Сливает ветки ИИ только после вашего подтверждения.',
          ],
          problems: [
            {
              problem: 'Форма пишет, что почта или токен не подходят',
              fix: 'Укажите почту аккаунта Atlassian, а не имя пользователя Bitbucket. Проверьте, что токен создан через **Create API token with scopes** для приложения **Bitbucket**.',
            },
            {
              problem: 'ИИ пишет, что репозиторий не найден',
              fix: 'Проверьте имя рабочего пространства: это часть адреса репозитория после bitbucket.org/.',
            },
            {
              problem: 'ИИ не может комментировать или одобрять пул-реквесты',
              fix: 'Создайте новый токен с правом **write:pullrequest:bitbucket** и вставьте его через **Переподключить**.',
            },
          ],
        },
      },
      prompts: [
        'Какие открытые pull request’ы в репозитории api в Bitbucket?',
        'Перескажи PR #42 и комментарии к нему.',
        'Почему упал последний пайплайн в main?',
        'Одобри PR #42 и оставь комментарий «LGTM».',
      ],
      fields: {
        workspace: { label: 'Рабочее пространство', hint: 'Из адреса bitbucket.org/<workspace>/.' },
        email: { label: 'Почта Atlassian', hint: 'С которой вы входите в Bitbucket.' },
        apiToken: { label: 'API-токен', hint: 'Atlassian → Security → API tokens, права Bitbucket.' },
      },
      actions: {
        list_repositories: { title: 'Репозитории', description: 'Репозитории пространства.' },
        list_pull_requests: { title: 'Pull request’ы', description: 'PR репозитория по статусу.' },
        get_pull_request: { title: 'Pull request', description: 'Описание, ревьюеры, одобрения.' },
        list_comments: { title: 'Комментарии', description: 'Комментарии PR, включая построчные.' },
        add_comment: { title: 'Комментарий', description: 'Комментарий к PR.' },
        add_inline_comment: {
          title: 'Комментарий к строке',
          description: 'Комментарий к строке изменённого файла.',
        },
        approve: { title: 'Одобрить', description: 'Одобряет PR от вашего имени.' },
        merge: { title: 'Мерж', description: 'Вливает PR в целевую ветку.' },
        list_pipelines: { title: 'Пайплайны', description: 'Запуски пайплайнов и их результат.' },
      },
    },
    en: {
      setup: {
        form: {
          summary:
            'You create an Atlassian API token for Bitbucket and paste it here with your workspace name and email.',
          minutes: 3,
          needs: [
            'A Bitbucket Cloud account with access to the workspace',
            'The email you sign in to Atlassian with',
          ],
          steps: [
            {
              text: 'Open your Atlassian API tokens page and click **Create API token with scopes**.',
              link: {
                label: 'Open Atlassian API tokens',
                url: 'https://id.atlassian.com/manage-profile/security/api-tokens',
              },
            },
            { text: 'Name it Manyplug, pick an expiry date and choose the app **Bitbucket**.' },
            {
              text: 'Tick the scopes **read:repository:bitbucket**, **read:pullrequest:bitbucket**, **write:pullrequest:bitbucket** and **read:pipeline:bitbucket**, then click **Create token** and copy it.',
              fills: ['apiToken'],
            },
            {
              text: 'In the form, enter the workspace (acme for bitbucket.org/acme/) and the email you sign in to Atlassian with.',
              fills: ['workspace', 'email'],
            },
          ],
          tips: [
            'Bitbucket app passwords are no longer issued: use an Atlassian API token.',
            'The AI merges only after you confirm.',
          ],
          problems: [
            {
              problem: 'The form says the email or token is wrong',
              fix: 'Use the email of your Atlassian account, not your Bitbucket username. Check that the token was made with **Create API token with scopes** and the app **Bitbucket**.',
            },
            {
              problem: 'The AI says a repository is not found',
              fix: 'Check the workspace name: it is the part after bitbucket.org/ in the repository address.',
            },
            {
              problem: 'The AI cannot comment on or approve a pull request',
              fix: 'Create a new token with the **write:pullrequest:bitbucket** scope and paste it with **Reconnect**.',
            },
          ],
        },
      },
      prompts: [
        'Which pull requests are open in the api repository on Bitbucket?',
        'Summarize PR #42 and its comments.',
        'Why did the last pipeline on main fail?',
        'Approve PR #42 and comment “LGTM”.',
      ],
      fields: {
        workspace: { label: 'Workspace', hint: 'From bitbucket.org/<workspace>/.' },
        email: { label: 'Atlassian email', hint: 'The one you sign in to Bitbucket with.' },
        apiToken: { label: 'API token', hint: 'Atlassian → Security → API tokens, Bitbucket scopes.' },
      },
      actions: {
        list_repositories: { title: 'Repositories', description: 'Repositories of the workspace.' },
        list_pull_requests: { title: 'Pull requests', description: 'Pull requests by state.' },
        get_pull_request: { title: 'Get a pull request', description: 'Description, reviewers, approvals.' },
        list_comments: { title: 'Comments', description: 'Comments of a PR, inline ones included.' },
        add_comment: { title: 'Comment', description: 'A comment on a PR.' },
        add_inline_comment: {
          title: 'Comment on a line',
          description: 'A comment on a line of a changed file.',
        },
        approve: { title: 'Approve', description: 'Approves a PR as you.' },
        merge: { title: 'Merge', description: 'Merges a PR into its destination.' },
        list_pipelines: { title: 'Pipelines', description: 'Pipeline runs and their results.' },
      },
    },
  },
};

export default withUi(manifest, ui);
