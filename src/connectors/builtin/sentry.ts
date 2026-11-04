import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Sentry Web API with a personal auth token, for sentry.io (US or EU) and self-hosted Sentry. */

const issueId = { type: 'string', minLength: 1, description: 'Numeric issue id or short id like WEB-1A2' };
const ISSUE_FIELDS = [
  'id',
  'shortId',
  'title',
  'culprit',
  'level',
  'status',
  'substatus',
  'count',
  'userCount',
  'firstSeen',
  'lastSeen',
  'project.slug',
  'assignedTo.name',
  'permalink',
];

const manifest = defineManifestConnector({
  id: 'sentry',
  name: 'Sentry',
  description: 'Sentry errors: find issues, read the latest stack trace, resolve, ignore or assign issues.',
  version: '1.0.0',
  homepage: 'https://docs.sentry.io/api/',
  instructions:
    'sentry_list_issues takes Sentry search syntax: "is:unresolved", "is:unresolved level:error", "assigned:me", "release:1.4.2". Use sentry_get_latest_event for the stack trace of an issue.',
  baseUrl: 'https://{{config.host}}/api/0/organizations/{{config.organization}}',
  config: {
    type: 'object',
    properties: {
      host: {
        type: 'string',
        default: 'sentry.io',
        pattern: '^[a-zA-Z0-9.-]+(:[0-9]+)?$',
        description: 'sentry.io, de.sentry.io for EU data, or your self-hosted host',
      },
      organization: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9_-]*$',
        description: 'Organization slug, from sentry.io/organizations/<slug>/',
      },
    },
    required: ['organization'],
  },
  credentials: {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        minLength: 20,
        description: 'User auth token: Settings → Account → Personal Tokens',
      },
    },
    required: ['token'],
  },
  auth: { type: 'bearer', token: '{{credentials.token}}' },
  rateLimit: { requests: 40, perSeconds: 1 },
  errorMessagePaths: ['detail'],
  pagination: { type: 'link' },
  test: {
    request: { method: 'GET', path: '/' },
    identity: '{{response.name}}',
  },
  actions: [
    {
      name: 'list_projects',
      title: 'List projects',
      description: 'Projects of the organization with their slugs and platforms.',
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/projects/' },
      response: { fields: ['id', 'slug', 'name', 'platform', 'dateCreated'] },
      pagination: true,
    },
    {
      name: 'list_issues',
      title: 'List issues',
      description: 'Finds issues with Sentry search syntax; newest activity first by default.',
      input: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            default: 'is:unresolved',
            description: 'e.g. "is:unresolved level:error"',
          },
          project: { type: 'integer', description: 'Project id from sentry_list_projects' },
          environment: { type: 'string' },
          period: {
            type: 'string',
            enum: ['24h', '7d', '14d', '30d', '90d'],
            default: '14d',
            description: 'Only issues seen in this period',
          },
          sort: { type: 'string', enum: ['date', 'new', 'freq', 'user'], default: 'date' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/issues/',
        query: {
          query: '{{input.query}}',
          project: '{{input.project}}',
          environment: '{{input.environment}}',
          statsPeriod: '{{input.period}}',
          sort: '{{input.sort}}',
          limit: '{{input.limit}}',
        },
      },
      response: { fields: ISSUE_FIELDS },
      pagination: true,
    },
    {
      name: 'get_issue',
      title: 'Get issue',
      description: 'Returns an issue with counts, first and last release.',
      input: { type: 'object', properties: { issue_id: issueId }, required: ['issue_id'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/issues/{issue_id}/' },
      response: {
        fields: [...ISSUE_FIELDS, 'metadata', 'firstRelease.version', 'lastRelease.version', 'platform'],
      },
    },
    {
      name: 'get_latest_event',
      title: 'Latest event',
      description: 'The latest event of an issue: message, tags, context and stack trace.',
      input: { type: 'object', properties: { issue_id: issueId }, required: ['issue_id'] },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/issues/{issue_id}/events/latest/',
      },
      response: {
        fields: [
          'eventID',
          'dateCreated',
          'message',
          'title',
          'platform',
          'tags',
          'entries',
          'contexts',
          'user',
        ],
      },
    },
    {
      name: 'update_issue',
      title: 'Update issue',
      description: 'Resolves, reopens or ignores an issue, or assigns it.',
      input: {
        type: 'object',
        properties: {
          issue_id: issueId,
          status: { type: 'string', enum: ['resolved', 'unresolved', 'ignored'] },
          assigned_to: {
            type: 'string',
            description: 'Username, email, or "team:<slug>"; empty string unassigns',
          },
          has_seen: { type: 'boolean' },
        },
        required: ['issue_id'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: {
        method: 'PUT',
        path: '/issues/{issue_id}/',
        body: {
          status: '{{input.status}}',
          assignedTo: '{{input.assigned_to}}',
          hasSeen: '{{input.has_seen}}',
        },
      },
      response: { fields: ['id', 'status', 'assignedTo.name', 'hasSeen'] },
    },
    {
      name: 'add_comment',
      title: 'Add comment',
      description: 'Adds a comment to the activity of an issue.',
      input: {
        type: 'object',
        properties: { issue_id: issueId, text: { type: 'string', minLength: 1 } },
        required: ['issue_id', 'text'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: {
        method: 'POST',
        path: '/issues/{issue_id}/comments/',
        body: { text: '{{input.text}}' },
      },
      response: { fields: ['id', 'dateCreated'] },
    },
  ],
});

const ui: ConnectorUi = {
  primaryFields: ['organization', 'token'],
  locales: {
    ru: {
      description: 'Ошибки в Sentry: поиск проблем, последний стек вызовов, решение, игнор и назначение.',
      setup: {
        form: {
          summary: 'Slug организации и личный токен Sentry. Около минуты.',
          steps: [
            {
              text: 'Откройте Sentry → Settings → Account → Personal Tokens и нажмите Create New Token.',
              link: {
                label: 'Открыть токены Sentry',
                url: 'https://sentry.io/settings/account/api/auth-tokens/',
              },
            },
            {
              text: 'Дайте права event:read, project:read, org:read и event:write (для решения и комментариев), создайте токен и скопируйте его.',
            },
            {
              text: 'В форме укажите slug организации (из адреса sentry.io/organizations/acme/ — это acme) и токен.',
            },
          ],
          tips: [
            'Данные в ЕС? Укажите в поле «Адрес Sentry» de.sentry.io. Для своего сервера — его адрес.',
            'Токен действует от вашего имени и только с выбранными правами.',
          ],
        },
      },
      prompts: [
        'Какие новые ошибки появились в Sentry за сутки?',
        'Покажи стек вызовов самой частой нерешённой ошибки.',
        'Отметь проблему WEB-1A2 решённой.',
        'Назначь все ошибки фронтенда за неделю на anna@acme.com.',
      ],
      fields: {
        organization: { label: 'Организация', hint: 'Slug из адреса sentry.io/organizations/<slug>/.' },
        host: { label: 'Адрес Sentry', hint: 'sentry.io, de.sentry.io для ЕС или адрес своего сервера.' },
        token: { label: 'Личный токен', hint: 'Settings → Account → Personal Tokens.' },
      },
      actions: {
        list_projects: { title: 'Проекты', description: 'Проекты организации.' },
        list_issues: { title: 'Поиск проблем', description: 'Ищет ошибки в синтаксисе поиска Sentry.' },
        get_issue: { title: 'Проблема', description: 'Счётчики, первый и последний релиз.' },
        get_latest_event: { title: 'Последнее событие', description: 'Сообщение, теги и стек вызовов.' },
        update_issue: {
          title: 'Изменение проблемы',
          description: 'Решает, открывает заново, игнорирует, назначает.',
        },
        add_comment: { title: 'Комментарий', description: 'Добавляет комментарий к проблеме.' },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'Your Sentry organization slug and a personal token. Takes about a minute.',
          steps: [
            {
              text: 'Open Sentry → Settings → Account → Personal Tokens and click Create New Token.',
              link: {
                label: 'Open Sentry tokens',
                url: 'https://sentry.io/settings/account/api/auth-tokens/',
              },
            },
            {
              text: 'Grant event:read, project:read, org:read and event:write (to resolve and comment), create the token and copy it.',
            },
            {
              text: 'In the form, enter the organization slug (acme for sentry.io/organizations/acme/) and the token.',
            },
          ],
          tips: [
            'Data in the EU? Set Sentry host to de.sentry.io. For self-hosted Sentry, use its host.',
            'The token acts as you, with only the scopes you picked.',
          ],
        },
      },
      prompts: [
        'Which new errors showed up in Sentry in the last day?',
        'Show the stack trace of the most frequent unresolved error.',
        'Mark issue WEB-1A2 as resolved.',
        'Assign this week’s frontend errors to anna@acme.com.',
      ],
      fields: {
        organization: { label: 'Organization', hint: 'The slug from sentry.io/organizations/<slug>/.' },
        host: { label: 'Sentry host', hint: 'sentry.io, de.sentry.io for the EU, or your own server.' },
        token: { label: 'Personal token', hint: 'Settings → Account → Personal Tokens.' },
      },
      actions: {
        list_projects: { title: 'Projects', description: 'Projects of the organization.' },
        list_issues: { title: 'Find issues', description: 'Finds errors with Sentry search syntax.' },
        get_issue: { title: 'Get an issue', description: 'Counts, first and last release.' },
        get_latest_event: { title: 'Latest event', description: 'Message, tags and stack trace.' },
        update_issue: { title: 'Update an issue', description: 'Resolves, reopens, ignores or assigns.' },
        add_comment: { title: 'Comment', description: 'Adds a comment to an issue.' },
      },
    },
  },
};

export default withUi(manifest, ui);
