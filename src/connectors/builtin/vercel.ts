import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Vercel REST API with an access token, for a personal account or one team. */

const team = { teamId: '{{config.team_id}}' };
const limit = { type: 'integer', minimum: 1, maximum: 100, default: 20 };
const deploymentId = { type: 'string', minLength: 1, description: 'Deployment id (dpl_…) or its URL host' };
const DEPLOYMENT_FIELDS = [
  'uid',
  'name',
  'url',
  'state',
  'target',
  'created',
  'ready',
  'creator.username',
  'meta.githubCommitRef',
  'meta.githubCommitMessage',
  'inspectorUrl',
];

const manifest = defineManifestConnector({
  id: 'vercel',
  name: 'Vercel',
  description:
    'Vercel projects and deployments: status, build logs, domains; cancel builds, promote to production.',
  version: '1.0.0',
  homepage: 'https://vercel.com/docs/rest-api',
  instructions:
    'Find a project with vercel_list_projects, then its deployments with vercel_list_deployments. A failed build is explained by vercel_get_build_logs.',
  baseUrl: 'https://api.vercel.com',
  config: {
    type: 'object',
    properties: {
      team_id: {
        type: 'string',
        pattern: '^team_[A-Za-z0-9]+$',
        description: 'Team id (team_…) from Team Settings; empty for a personal account',
      },
    },
  },
  credentials: {
    type: 'object',
    properties: {
      token: { type: 'string', minLength: 20, description: 'Account Settings → Tokens' },
    },
    required: ['token'],
  },
  auth: { type: 'bearer', token: '{{credentials.token}}' },
  rateLimit: { requests: 100, perSeconds: 60 },
  errorMessagePaths: ['error.message'],
  pagination: { type: 'cursor', param: 'until', nextPath: 'pagination.next' },
  test: { request: { method: 'GET', path: '/v2/user' }, identity: '{{response.user.email}}' },
  actions: [
    {
      name: 'list_projects',
      title: 'List projects',
      description: 'Projects, most recently updated first, optionally by name.',
      input: { type: 'object', properties: { search: { type: 'string' }, limit } },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/v10/projects',
        query: { ...team, search: '{{input.search}}', limit: '{{input.limit}}' },
      },
      response: {
        root: 'projects',
        fields: ['id', 'name', 'framework', 'updatedAt', 'link.type', 'link.repo', 'targets.production.url'],
      },
      pagination: true,
    },
    {
      name: 'list_deployments',
      title: 'List deployments',
      description: 'Deployments, newest first, of one project or all, by state and target.',
      input: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project id or name' },
          state: {
            type: 'string',
            enum: ['BUILDING', 'ERROR', 'INITIALIZING', 'QUEUED', 'READY', 'CANCELED'],
          },
          target: { type: 'string', enum: ['production', 'preview'] },
          limit,
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/v6/deployments',
        query: {
          ...team,
          projectId: '{{input.project_id}}',
          state: '{{input.state}}',
          target: '{{input.target}}',
          limit: '{{input.limit}}',
        },
      },
      response: { root: 'deployments', fields: DEPLOYMENT_FIELDS },
      pagination: true,
    },
    {
      name: 'get_deployment',
      title: 'Get deployment',
      description: 'Returns a deployment with its state, error, aliases and commit.',
      input: { type: 'object', properties: { deployment_id: deploymentId }, required: ['deployment_id'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/v13/deployments/{deployment_id}', query: team },
      response: {
        fields: [
          'id',
          'name',
          'url',
          'readyState',
          'target',
          'createdAt',
          'ready',
          'errorCode',
          'errorMessage',
          'alias',
          'meta.githubCommitRef',
          'meta.githubCommitMessage',
          'inspectorUrl',
        ],
      },
    },
    {
      name: 'get_build_logs',
      title: 'Build logs',
      description: 'The build output of a deployment, oldest line first (last 200 lines by default).',
      input: {
        type: 'object',
        properties: {
          deployment_id: deploymentId,
          limit: { type: 'integer', minimum: 1, maximum: 2000, default: 200 },
        },
        required: ['deployment_id'],
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/v3/deployments/{deployment_id}/events',
        query: { ...team, limit: '{{input.limit}}', direction: 'backward', builds: '1' },
      },
      response: { fields: ['type', 'created', 'text'] },
    },
    {
      name: 'list_domains',
      title: 'List domains',
      description: 'Domains of the account with their verification and renewal status.',
      input: { type: 'object', properties: { limit } },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/v5/domains', query: { ...team, limit: '{{input.limit}}' } },
      response: {
        root: 'domains',
        fields: ['name', 'verified', 'serviceType', 'expiresAt', 'renew', 'createdAt'],
      },
      pagination: true,
    },
    {
      name: 'cancel_deployment',
      title: 'Cancel deployment',
      description: 'Stops a deployment that is still building or queued.',
      input: { type: 'object', properties: { deployment_id: deploymentId }, required: ['deployment_id'] },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: { method: 'PATCH', path: '/v12/deployments/{deployment_id}/cancel', query: team },
      response: { fields: ['id', 'readyState'] },
    },
    {
      name: 'promote_deployment',
      title: 'Promote to production',
      description: 'Points the production domains of a project at an existing deployment (also rolls back).',
      input: {
        type: 'object',
        properties: {
          project_id: { type: 'string', minLength: 1, description: 'Project id or name' },
          deployment_id: { type: 'string', pattern: '^dpl_', description: 'Deployment id (dpl_…)' },
        },
        required: ['project_id', 'deployment_id'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'dangerous',
      request: { method: 'POST', path: '/v10/projects/{project_id}/promote/{deployment_id}', query: team },
      response: { empty: 'Promotion started.' },
    },
  ],
});

const ui: ConnectorUi = {
  primaryFields: ['token', 'team_id'],
  locales: {
    ru: {
      description:
        'Проекты и деплои Vercel: статус, логи сборки, домены; отмена сборки, перевод в продакшен.',
      setup: {
        form: {
          summary:
            'Вы создаёте токен доступа в Vercel и вставляете его сюда, а для проектов команды ещё и её ID.',
          minutes: 2,
          needs: ['Аккаунт Vercel', 'Для проектов команды: членство в этой команде'],
          steps: [
            {
              text: 'Откройте Vercel → **Account Settings → Tokens** и нажмите **Create**.',
              link: { label: 'Открыть токены Vercel', url: 'https://vercel.com/account/tokens' },
            },
            {
              text: 'Назовите токен Manyplug, выберите **Scope** (ваш аккаунт или команда) и срок действия, нажмите **Create** и скопируйте токен: Vercel показывает его только один раз.',
              fills: ['token'],
            },
            {
              text: 'Для команды откройте **Team Settings → General** и скопируйте **Team ID** (team_…). Для личных проектов оставьте поле пустым.',
              fills: ['team_id'],
            },
          ],
          tips: [
            'Каждую команду подключайте отдельным аккаунтом.',
            'Продвижение деплоя меняет живой сайт, поэтому ИИ сначала спросит вас.',
          ],
          problems: [
            {
              problem: 'ИИ не видит проекты или видит не те',
              fix: 'Проектам команды нужен её **Team ID** в форме, а у токена должна быть эта команда в **Scope**. Исправьте оба и нажмите **Переподключить**.',
            },
            {
              problem: 'Проверка пишет, что токен неверный или истёк',
              fix: 'Создайте новый токен в **Account Settings → Tokens** с более долгим сроком и вставьте его через **Переподключить**.',
            },
          ],
        },
      },
      prompts: [
        'Почему упал последний деплой в Vercel? Покажи ошибку из логов.',
        'Какие деплои шли сегодня в продакшен?',
        'Откати продакшен проекта landing на предыдущий удачный деплой.',
        'Какие домены истекают в ближайший месяц?',
      ],
      fields: {
        token: { label: 'Токен', hint: 'Account Settings → Tokens.' },
        team_id: { label: 'Team ID', hint: 'Team Settings → General. Пусто — личный аккаунт.' },
      },
      actions: {
        list_projects: { title: 'Проекты', description: 'Проекты, с поиском по названию.' },
        list_deployments: { title: 'Деплои', description: 'Деплои проекта по статусу и окружению.' },
        get_deployment: { title: 'Деплой', description: 'Статус, ошибка, домены и коммит.' },
        get_build_logs: { title: 'Логи сборки', description: 'Вывод сборки деплоя.' },
        list_domains: { title: 'Домены', description: 'Домены, проверка и продление.' },
        cancel_deployment: { title: 'Отмена сборки', description: 'Останавливает идущую сборку.' },
        promote_deployment: { title: 'В продакшен', description: 'Переводит или откатывает продакшен.' },
      },
    },
    en: {
      setup: {
        form: {
          summary:
            'You create an access token in Vercel and paste it here, with the team’s ID if the projects belong to a team.',
          minutes: 2,
          needs: ['A Vercel account', 'For team projects: membership in that team'],
          steps: [
            {
              text: 'Open Vercel → **Account Settings → Tokens** and click **Create**.',
              link: { label: 'Open Vercel tokens', url: 'https://vercel.com/account/tokens' },
            },
            {
              text: 'Name it Manyplug, pick the **Scope** (your account or a team) and an expiry, click **Create** and copy the token: Vercel shows it only once.',
              fills: ['token'],
            },
            {
              text: 'For a team, open **Team Settings → General** and copy the **Team ID** (team_…). For personal projects, leave it empty.',
              fills: ['team_id'],
            },
          ],
          tips: [
            'Connect each team as its own account.',
            'Promoting a deployment changes the live site, so the AI asks you first.',
          ],
          problems: [
            {
              problem: 'The AI sees no projects or the wrong ones',
              fix: 'Team projects need that team’s **Team ID** in the form, and the token’s scope must include the team. Fix both and click **Reconnect**.',
            },
            {
              problem: 'The check says the token is invalid or expired',
              fix: 'Create a new token in **Account Settings → Tokens** with a longer expiry and paste it with **Reconnect**.',
            },
          ],
        },
      },
      prompts: [
        'Why did the last Vercel deployment fail? Show the error from the logs.',
        'Which deployments went to production today?',
        'Roll production of the landing project back to the previous good deployment.',
        'Which domains expire within a month?',
      ],
      fields: {
        token: { label: 'Token', hint: 'Account Settings → Tokens.' },
        team_id: { label: 'Team ID', hint: 'Team Settings → General. Empty for a personal account.' },
      },
      actions: {
        list_projects: { title: 'Projects', description: 'Projects, with a name search.' },
        list_deployments: { title: 'Deployments', description: 'Deployments by state and target.' },
        get_deployment: { title: 'Get a deployment', description: 'State, error, domains and commit.' },
        get_build_logs: { title: 'Build logs', description: 'The build output of a deployment.' },
        list_domains: { title: 'Domains', description: 'Domains, verification and renewal.' },
        cancel_deployment: { title: 'Cancel a build', description: 'Stops a running build.' },
        promote_deployment: { title: 'Promote', description: 'Promotes or rolls back production.' },
      },
    },
  },
};

export default withUi(manifest, ui);
