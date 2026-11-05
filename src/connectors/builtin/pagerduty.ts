import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** PagerDuty REST API v2 with an API key: incidents, notes, services, who is on call. */

const incidentId = { type: 'string', minLength: 1, description: 'Incident id, e.g. PT4KHLK' };
const incidentFields = [
  'id',
  'incident_number',
  'title',
  'status',
  'urgency',
  'created_at',
  'service.summary',
  'assignments',
  'html_url',
];

const manifest = defineManifestConnector({
  id: 'pagerduty',
  name: 'PagerDuty',
  description:
    'PagerDuty incidents: list and read incidents, acknowledge, resolve, add notes, open incidents, see who is on call.',
  version: '1.0.0',
  homepage: 'https://developer.pagerduty.com/api-reference/',
  instructions:
    'Opening an incident pages the on-call people of its service. Ids such as PT4KHLK come from the list tools.',
  baseUrl: 'https://{{config.host}}',
  config: {
    type: 'object',
    properties: {
      host: {
        type: 'string',
        enum: ['api.pagerduty.com', 'api.eu.pagerduty.com'],
        default: 'api.pagerduty.com',
        description: 'api.eu.pagerduty.com for accounts in the EU service region',
      },
      fromEmail: {
        type: 'string',
        format: 'email',
        description: 'Email of a PagerDuty user that changes are made as (needed with a general access key)',
      },
    },
  },
  credentials: {
    type: 'object',
    properties: {
      apiKey: { type: 'string', minLength: 20, description: 'Integrations → API Access Keys, or a user key' },
    },
    required: ['apiKey'],
  },
  auth: { type: 'api_key', in: 'header', name: 'Authorization', value: 'Token token={{credentials.apiKey}}' },
  headers: { Accept: 'application/vnd.pagerduty+json;version=2', From: '{{config.fromEmail}}' },
  rateLimit: { requests: 900, perSeconds: 60 },
  errorMessagePaths: ['error.errors.0', 'error.message'],
  pagination: { type: 'offset', param: 'offset', limitParam: 'limit', defaultLimit: 25 },
  test: { request: { method: 'GET', path: '/services', query: { limit: 1 } } },
  actions: [
    {
      name: 'list_incidents',
      title: 'List incidents',
      description: 'Incidents, newest first; by default those still triggered or acknowledged.',
      input: {
        type: 'object',
        properties: {
          statuses: {
            type: 'array',
            items: { type: 'string', enum: ['triggered', 'acknowledged', 'resolved'] },
            default: ['triggered', 'acknowledged'],
          },
          service_ids: { type: 'array', items: { type: 'string' } },
          since: { type: 'string', description: 'ISO date-time' },
          until: { type: 'string', description: 'ISO date-time' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/incidents',
        query: {
          'statuses[]': '{{input.statuses}}',
          'service_ids[]': '{{input.service_ids}}',
          since: '{{input.since}}',
          until: '{{input.until}}',
          limit: '{{input.limit}}',
          sort_by: 'created_at:desc',
        },
      },
      response: { root: 'incidents', fields: incidentFields },
      pagination: true,
    },
    {
      name: 'get_incident',
      title: 'Get incident',
      description: 'One incident with its service, assignees and description.',
      input: { type: 'object', properties: { id: incidentId }, required: ['id'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/incidents/{id}' },
      response: { root: 'incident', fields: [...incidentFields, 'body.details', 'last_status_change_at'] },
    },
    {
      name: 'list_notes',
      title: 'List notes',
      description: 'Notes left on an incident.',
      input: { type: 'object', properties: { id: incidentId }, required: ['id'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/incidents/{id}/notes' },
      response: { root: 'notes', fields: ['id', 'content', 'created_at', 'user.summary'] },
    },
    {
      name: 'set_status',
      title: 'Acknowledge or resolve',
      description: 'Acknowledges or resolves an incident.',
      input: {
        type: 'object',
        properties: { id: incidentId, status: { type: 'string', enum: ['acknowledged', 'resolved'] } },
        required: ['id', 'status'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: {
        method: 'PUT',
        path: '/incidents/{id}',
        body: { incident: { type: 'incident_reference', status: '{{input.status}}' } },
      },
      response: { root: 'incident', fields: ['id', 'status', 'html_url'] },
    },
    {
      name: 'add_note',
      title: 'Add note',
      description: 'Adds a note to an incident’s timeline.',
      input: {
        type: 'object',
        properties: { id: incidentId, content: { type: 'string', minLength: 1 } },
        required: ['id', 'content'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: {
        method: 'POST',
        path: '/incidents/{id}/notes',
        body: { note: { content: '{{input.content}}' } },
      },
      response: { root: 'note', fields: ['id', 'content', 'created_at'] },
    },
    {
      name: 'create_incident',
      title: 'Open incident',
      description: 'Opens an incident on a service, which pages its on-call people.',
      input: {
        type: 'object',
        properties: {
          service_id: { type: 'string', minLength: 1, description: 'From pagerduty_list_services' },
          title: { type: 'string', minLength: 1 },
          urgency: { type: 'string', enum: ['high', 'low'] },
          details: { type: 'string', description: 'Description shown in the incident' },
        },
        required: ['service_id', 'title'],
      },
      hints: { readOnly: false, destructive: false, openWorld: true },
      risk: 'dangerous',
      request: {
        method: 'POST',
        path: '/incidents',
        body: {
          incident: {
            type: 'incident',
            title: '{{input.title}}',
            service: { id: '{{input.service_id}}', type: 'service_reference' },
            urgency: '{{input.urgency}}',
            body: { type: 'incident_body', details: '{{input.details}}' },
          },
        },
      },
      response: { root: 'incident', fields: ['id', 'incident_number', 'status', 'html_url'] },
    },
    {
      name: 'list_services',
      title: 'List services',
      description: 'Services with their ids and status.',
      input: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Filters by name' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/services' },
      response: { root: 'services', fields: ['id', 'name', 'status', 'description', 'html_url'] },
      pagination: true,
    },
    {
      name: 'list_oncalls',
      title: 'Who is on call',
      description: 'Who is on call now, per escalation policy and level.',
      input: {
        type: 'object',
        properties: {
          escalation_policy_ids: { type: 'array', items: { type: 'string' } },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/oncalls',
        query: {
          'escalation_policy_ids[]': '{{input.escalation_policy_ids}}',
          earliest: true,
          limit: '{{input.limit}}',
        },
      },
      response: {
        root: 'oncalls',
        fields: ['user.summary', 'escalation_policy.summary', 'escalation_level', 'schedule.summary', 'end'],
      },
      pagination: true,
    },
  ],
});

const fields = (ru: boolean) => ({
  apiKey: {
    label: ru ? 'Ключ API' : 'API key',
    hint: ru ? 'Integrations → API Access Keys.' : 'Integrations → API Access Keys.',
  },
  fromEmail: {
    label: ru ? 'Email пользователя' : 'User email',
    hint: ru
      ? 'Нужен для общего ключа: от имени этого пользователя PagerDuty вносятся изменения.'
      : 'Needed with a general key: changes are made as this PagerDuty user.',
  },
  host: {
    label: ru ? 'Регион' : 'Region',
    hint: ru ? 'Регион обслуживания вашего аккаунта.' : 'Your account’s service region.',
    options: {
      'api.pagerduty.com': ru ? 'США (api.pagerduty.com)' : 'US (api.pagerduty.com)',
      'api.eu.pagerduty.com': ru ? 'ЕС (api.eu.pagerduty.com)' : 'EU (api.eu.pagerduty.com)',
    },
  },
});

const ui: ConnectorUi = {
  locales: {
    ru: {
      description:
        'Инциденты PagerDuty: список и детали, подтверждение, закрытие, заметки, новые инциденты, кто дежурит.',
      setup: {
        form: {
          summary:
            'Вы создаёте ключ API в PagerDuty и вставляете его сюда вместе со своим email в PagerDuty.',
          minutes: 3,
          needs: ['Аккаунт PagerDuty с ролью Admin или Account Owner: только они создают общие ключи API'],
          steps: [
            {
              text: 'В PagerDuty откройте **Integrations** → **API Access Keys** и нажмите **Create New API Key**.',
              link: {
                label: 'Как создать ключ',
                url: 'https://support.pagerduty.com/main/docs/api-access-keys',
              },
            },
            {
              text: 'Назовите ключ Manyplug. Если инциденты нужно только читать, отметьте **Read-only API Key**.',
            },
            {
              text: 'Нажмите **Create Key** и скопируйте ключ: PagerDuty показывает его только один раз.',
              fills: ['apiKey'],
            },
            {
              text: 'Впишите email, с которым вы входите в PagerDuty: изменения будут сделаны от этого пользователя.',
              fills: ['fromEmail'],
            },
          ],
          tips: ['Новый инцидент будит дежурных, поэтому он создаётся только после вашего подтверждения.'],
          problems: [
            {
              problem: 'Проверка не проходит: «Unauthorized» или неверный ключ',
              fix: 'Скопируйте ключ целиком. Если окно с ключом закрыто, создайте новый ключ — старый показать снова нельзя.',
            },
            {
              problem: 'Чтение работает, а изменения падают с ошибкой про заголовок **From**',
              fix: 'Впишите в поле «Email пользователя» точный email существующего пользователя PagerDuty.',
            },
            {
              problem: 'Ваш PagerDuty открывается на адресе **eu.pagerduty.com**, а проверка не проходит',
              fix: 'Аккаунт в регионе ЕС. В поле «Регион» выберите **ЕС (api.eu.pagerduty.com)**.',
            },
          ],
        },
      },
      prompts: [
        'Какие инциденты в PagerDuty сейчас открыты?',
        'Кто сегодня дежурит в PagerDuty?',
        'Подтверди инцидент про базу данных и добавь заметку «Смотрю».',
      ],
      fields: fields(true),
      actions: {
        list_incidents: { title: 'Инциденты', description: 'Открытые и закрытые инциденты.' },
        get_incident: { title: 'Инцидент', description: 'Детали инцидента.' },
        list_notes: { title: 'Заметки', description: 'Заметки инцидента.' },
        set_status: { title: 'Статус', description: 'Подтверждает или закрывает инцидент.' },
        add_note: { title: 'Заметка', description: 'Добавляет заметку.' },
        create_incident: { title: 'Новый инцидент', description: 'Открывает инцидент.' },
        list_services: { title: 'Сервисы', description: 'Сервисы аккаунта.' },
        list_oncalls: { title: 'Дежурные', description: 'Кто сейчас дежурит.' },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'You create an API key in PagerDuty and paste it here with your PagerDuty email.',
          minutes: 3,
          needs: [
            'A PagerDuty account with the Admin or Account Owner role: only they can create general API keys',
          ],
          steps: [
            {
              text: 'In PagerDuty, open **Integrations** → **API Access Keys** and click **Create New API Key**.',
              link: {
                label: 'How to create a key',
                url: 'https://support.pagerduty.com/main/docs/api-access-keys',
              },
            },
            { text: 'Name it Manyplug. Tick **Read-only API Key** if you only want to read incidents.' },
            {
              text: 'Click **Create Key** and copy the key: PagerDuty shows it only once.',
              fills: ['apiKey'],
            },
            {
              text: 'Type the email you sign in to PagerDuty with: changes are made as that user.',
              fills: ['fromEmail'],
            },
          ],
          tips: ['Opening an incident wakes the on-call people, so it only happens after you confirm.'],
          problems: [
            {
              problem: 'The check fails with “Unauthorized” or an invalid key',
              fix: 'Copy the whole key. If the key window is closed, create a new key: PagerDuty cannot show the old one again.',
            },
            {
              problem: 'Reading works, but changes fail with an error about the **From** header',
              fix: 'In User email, type the exact email of an existing PagerDuty user.',
            },
            {
              problem: 'Your PagerDuty opens at **eu.pagerduty.com** and the check fails',
              fix: 'The account is in the EU region. Under Region, pick **EU (api.eu.pagerduty.com)**.',
            },
          ],
        },
      },
      prompts: [
        'Which PagerDuty incidents are open right now?',
        'Who is on call in PagerDuty today?',
        'Acknowledge the database incident and add the note “Looking into it”.',
      ],
      fields: fields(false),
      actions: {
        list_incidents: { title: 'Incidents', description: 'Open and resolved incidents.' },
        get_incident: { title: 'Incident', description: 'Incident details.' },
        list_notes: { title: 'Notes', description: 'An incident’s notes.' },
        set_status: { title: 'Status', description: 'Acknowledges or resolves an incident.' },
        add_note: { title: 'Add a note', description: 'Adds a note.' },
        create_incident: { title: 'Open an incident', description: 'Opens an incident.' },
        list_services: { title: 'Services', description: 'The account’s services.' },
        list_oncalls: { title: 'On call', description: 'Who is on call now.' },
      },
    },
  },
};

export default withUi(manifest, ui);
