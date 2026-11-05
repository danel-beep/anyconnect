import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Netlify API with a personal access token: sites, deploys, builds and form submissions. */

const siteId = { type: 'string', minLength: 1, description: 'Site id or domain, e.g. acme.netlify.app' };
const deployId = { type: 'string', minLength: 1, description: 'Deploy id from netlify_list_deploys' };
const perPage = { type: 'integer', minimum: 1, maximum: 100, default: 20 };
const deployFields = [
  'id',
  'state',
  'context',
  'branch',
  'commit_ref',
  'title',
  'error_message',
  'created_at',
  'published_at',
  'deploy_ssl_url',
];

const manifest = defineManifestConnector({
  id: 'netlify',
  name: 'Netlify',
  description: 'Netlify hosting: sites, deploys and their status, new builds, rollbacks, form submissions.',
  version: '1.0.0',
  homepage: 'https://docs.netlify.com/api/get-started/',
  instructions:
    'A site is addressed by its id or its domain (acme.netlify.app). Publishing an older deploy rolls the live site back to it.',
  baseUrl: 'https://api.netlify.com/api/v1',
  credentials: {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        minLength: 20,
        description: 'User settings → Applications → Personal access tokens',
      },
    },
    required: ['token'],
  },
  auth: { type: 'bearer', token: '{{credentials.token}}' },
  rateLimit: { requests: 500, perSeconds: 60 },
  errorMessagePaths: ['message', 'errors'],
  pagination: { type: 'page', param: 'page', start: 1 },
  test: { request: { method: 'GET', path: '/user' }, identity: '{{response.email}}' },
  actions: [
    {
      name: 'list_sites',
      title: 'List sites',
      description: 'Your sites with their live URL and repository.',
      input: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Filters by site name' }, per_page: perPage },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/sites',
        query: { name: '{{input.name}}', per_page: '{{input.per_page}}' },
      },
      response: {
        fields: ['id', 'name', 'ssl_url', 'custom_domain', 'updated_at', 'build_settings.repo_url'],
      },
      pagination: true,
    },
    {
      name: 'get_site',
      title: 'Get site',
      description: 'A site with its domains, build settings and current published deploy.',
      input: { type: 'object', properties: { site_id: siteId }, required: ['site_id'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/sites/{site_id}' },
      response: {
        fields: [
          'id',
          'name',
          'ssl_url',
          'custom_domain',
          'domain_aliases',
          'published_deploy.id',
          'published_deploy.published_at',
          'build_settings.repo_url',
          'build_settings.repo_branch',
          'build_settings.cmd',
        ],
      },
    },
    {
      name: 'list_deploys',
      title: 'List deploys',
      description: 'A site’s deploys, newest first, with their state and branch.',
      input: { type: 'object', properties: { site_id: siteId, per_page: perPage }, required: ['site_id'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/sites/{site_id}/deploys' },
      response: { fields: deployFields },
      pagination: true,
    },
    {
      name: 'get_deploy',
      title: 'Get deploy',
      description: 'One deploy with its state and error message.',
      input: { type: 'object', properties: { deploy_id: deployId }, required: ['deploy_id'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/deploys/{deploy_id}' },
      response: { fields: [...deployFields, 'site_id', 'summary'] },
    },
    {
      name: 'start_build',
      title: 'Start build',
      description: 'Builds and deploys the site again from its repository.',
      input: {
        type: 'object',
        properties: { site_id: siteId, clear_cache: { type: 'boolean', default: false } },
        required: ['site_id'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: {
        method: 'POST',
        path: '/sites/{site_id}/builds',
        body: { clear_cache: '{{input.clear_cache}}' },
      },
      response: { fields: ['id', 'deploy_id', 'done', 'created_at'] },
    },
    {
      name: 'publish_deploy',
      title: 'Publish deploy',
      description: 'Makes an existing deploy the live version of the site (rollback or roll forward).',
      input: {
        type: 'object',
        properties: { site_id: siteId, deploy_id: deployId },
        required: ['site_id', 'deploy_id'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'dangerous',
      request: { method: 'POST', path: '/sites/{site_id}/deploys/{deploy_id}/restore', body: {} },
      response: { fields: ['id', 'state', 'published_at', 'deploy_ssl_url'] },
    },
    {
      name: 'list_submissions',
      title: 'Form submissions',
      description: 'Submissions of a site’s Netlify Forms, newest first.',
      input: { type: 'object', properties: { site_id: siteId, per_page: perPage }, required: ['site_id'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/sites/{site_id}/submissions' },
      response: { fields: ['id', 'form_name', 'email', 'name', 'summary', 'data', 'created_at'] },
      pagination: true,
    },
  ],
});

const ui: ConnectorUi = {
  locales: {
    ru: {
      description: 'Хостинг Netlify: сайты, деплои и их статус, новые сборки, откат, заявки из форм.',
      setup: {
        form: {
          summary: 'Вы создаёте личный токен в настройках Netlify и вставляете его сюда.',
          minutes: 2,
          needs: ['Аккаунт Netlify с доступом к нужным сайтам'],
          steps: [
            {
              text: 'Откройте Netlify → **User settings** → **Applications** → **Personal access tokens** и нажмите **New access token**.',
              link: {
                label: 'Открыть токены Netlify',
                url: 'https://app.netlify.com/user/applications#personal-access-tokens',
              },
            },
            { text: 'Назовите токен Manyplug, выберите срок действия и нажмите **Generate token**.' },
            { text: 'Скопируйте токен: Netlify показывает его только один раз.', fills: ['token'] },
          ],
          tips: [
            'Токен видит все команды и сайты вашего пользователя.',
            'Откат на старый деплой выполняется только после вашего подтверждения.',
          ],
          problems: [
            {
              problem: 'Токен перестал работать',
              fix: 'Скорее всего, истёк его срок. Создайте новый токен с более долгим сроком и вставьте его через **Переподключить**.',
            },
            {
              problem: 'Сайта команды нет в списке',
              fix: 'Токен видит только команды, где вы состоите. Попросите владельца команды добавить вас.',
            },
          ],
        },
      },
      prompts: [
        'Почему упал последний деплой сайта acme на Netlify?',
        'Пересобери сайт acme.netlify.app с очисткой кэша.',
        'Какие заявки пришли из формы «Контакты» за неделю?',
      ],
      fields: { token: { label: 'Токен', hint: 'User settings → Applications.' } },
      actions: {
        list_sites: { title: 'Сайты', description: 'Ваши сайты.' },
        get_site: { title: 'Сайт', description: 'Домены и настройки сборки.' },
        list_deploys: { title: 'Деплои', description: 'Деплои сайта.' },
        get_deploy: { title: 'Деплой', description: 'Статус и ошибка деплоя.' },
        start_build: { title: 'Сборка', description: 'Запускает новую сборку.' },
        publish_deploy: { title: 'Публикация деплоя', description: 'Делает деплой живым (откат).' },
        list_submissions: { title: 'Заявки', description: 'Заявки из форм.' },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'You create a personal access token in Netlify settings and paste it here.',
          minutes: 2,
          needs: ['A Netlify account with access to the sites you need'],
          steps: [
            {
              text: 'Open Netlify → **User settings** → **Applications** → **Personal access tokens** and click **New access token**.',
              link: {
                label: 'Open Netlify tokens',
                url: 'https://app.netlify.com/user/applications#personal-access-tokens',
              },
            },
            { text: 'Name it Manyplug, pick an expiry and click **Generate token**.' },
            { text: 'Copy the token: Netlify shows it only once.', fills: ['token'] },
          ],
          tips: [
            'The token sees every team and site of your user.',
            'Rolling back to an older deploy only happens after you confirm.',
          ],
          problems: [
            {
              problem: 'The token stopped working',
              fix: 'It has most likely expired. Create a new token with a longer expiry and paste it with **Reconnect**.',
            },
            {
              problem: 'A team’s site is missing',
              fix: 'The token only sees teams you are a member of. Ask the team owner to add you.',
            },
          ],
        },
      },
      prompts: [
        'Why did the last Netlify deploy of the acme site fail?',
        'Rebuild acme.netlify.app with a clear cache.',
        'Which Contact form submissions came in this week?',
      ],
      fields: { token: { label: 'Token', hint: 'User settings → Applications.' } },
      actions: {
        list_sites: { title: 'Sites', description: 'Your sites.' },
        get_site: { title: 'Site', description: 'Domains and build settings.' },
        list_deploys: { title: 'Deploys', description: 'A site’s deploys.' },
        get_deploy: { title: 'Deploy', description: 'State and error of a deploy.' },
        start_build: { title: 'Build', description: 'Starts a new build.' },
        publish_deploy: { title: 'Publish a deploy', description: 'Makes a deploy live (rollback).' },
        list_submissions: { title: 'Submissions', description: 'Form submissions.' },
      },
    },
  },
};

export default withUi(manifest, ui);
