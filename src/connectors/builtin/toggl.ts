import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Toggl Track API v9 with the user's API token: timers, time entries, projects. */

const workspaceId = {
  type: 'integer',
  minimum: 1,
  description: 'Workspace id; toggl_me returns default_workspace_id',
};
const entryId = { type: 'integer', minimum: 1, description: 'Time entry id' };
const entryFields = [
  'id',
  'description',
  'start',
  'stop',
  'duration',
  'project_id',
  'workspace_id',
  'tags',
  'billable',
];

const manifest = defineManifestConnector({
  id: 'toggl',
  name: 'Toggl Track',
  description: 'Toggl Track time tracking: start and stop timers, the running timer, time entries, projects.',
  version: '1.0.0',
  homepage: 'https://engineering.toggl.com/docs/',
  instructions:
    'Call toggl_me first for the default workspace id. A running entry has a negative duration; durations are in seconds. Times are ISO 8601 in UTC.',
  baseUrl: 'https://api.track.toggl.com/api/v9',
  credentials: {
    type: 'object',
    properties: {
      token: { type: 'string', minLength: 20, description: 'Profile settings → API Token' },
    },
    required: ['token'],
  },
  auth: { type: 'basic', username: '{{credentials.token}}', password: 'api_token' },
  rateLimit: { requests: 3, perSeconds: 3 },
  errorMessagePaths: ['message', 'error'],
  test: { request: { method: 'GET', path: '/me' }, identity: '{{response.email}}' },
  actions: [
    {
      name: 'me',
      title: 'Me',
      description: 'Your profile with the default workspace id and time zone.',
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/me' },
      response: { fields: ['id', 'email', 'fullname', 'default_workspace_id', 'timezone'] },
    },
    {
      name: 'current_timer',
      title: 'Running timer',
      description: 'The timer that is running now, if any.',
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/me/time_entries/current' },
      response: { fields: entryFields, empty: 'No timer is running.' },
    },
    {
      name: 'list_time_entries',
      title: 'List time entries',
      description: 'Your time entries between two dates, newest first.',
      input: {
        type: 'object',
        properties: {
          start_date: { type: 'string', description: 'YYYY-MM-DD or ISO date-time' },
          end_date: { type: 'string', description: 'YYYY-MM-DD or ISO date-time' },
        },
        required: ['start_date', 'end_date'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/me/time_entries' },
      response: { fields: entryFields },
    },
    {
      name: 'start_timer',
      title: 'Start timer',
      description: 'Starts a timer now (stopping the running one) with a description and optional project.',
      input: {
        type: 'object',
        properties: {
          workspace_id: workspaceId,
          start: { type: 'string', description: 'The current time, ISO 8601 in UTC' },
          description: { type: 'string' },
          project_id: { type: 'integer', minimum: 1 },
          tags: { type: 'array', items: { type: 'string' } },
          billable: { type: 'boolean' },
        },
        required: ['workspace_id', 'start'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: {
        method: 'POST',
        path: '/workspaces/{workspace_id}/time_entries',
        body: {
          created_with: 'Manyplug',
          workspace_id: '{{input.workspace_id}}',
          start: '{{input.start}}',
          duration: -1,
          description: '{{input.description}}',
          project_id: '{{input.project_id}}',
          tags: '{{input.tags}}',
          billable: '{{input.billable}}',
        },
      },
      response: { fields: entryFields },
    },
    {
      name: 'stop_timer',
      title: 'Stop timer',
      description: 'Stops a running timer.',
      input: {
        type: 'object',
        properties: { workspace_id: workspaceId, id: entryId },
        required: ['workspace_id', 'id'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: { method: 'PATCH', path: '/workspaces/{workspace_id}/time_entries/{id}/stop', body: {} },
      response: { fields: entryFields },
    },
    {
      name: 'log_time',
      title: 'Log time',
      description: 'Adds a finished time entry with a start and a duration.',
      input: {
        type: 'object',
        properties: {
          workspace_id: workspaceId,
          start: { type: 'string', description: 'ISO 8601 in UTC' },
          duration: { type: 'integer', minimum: 1, description: 'Seconds' },
          description: { type: 'string' },
          project_id: { type: 'integer', minimum: 1 },
          tags: { type: 'array', items: { type: 'string' } },
          billable: { type: 'boolean' },
        },
        required: ['workspace_id', 'start', 'duration'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: {
        method: 'POST',
        path: '/workspaces/{workspace_id}/time_entries',
        body: {
          created_with: 'Manyplug',
          workspace_id: '{{input.workspace_id}}',
          start: '{{input.start}}',
          duration: '{{input.duration}}',
          description: '{{input.description}}',
          project_id: '{{input.project_id}}',
          tags: '{{input.tags}}',
          billable: '{{input.billable}}',
        },
      },
      response: { fields: entryFields },
    },
    {
      name: 'update_time_entry',
      title: 'Update time entry',
      description: 'Changes the description, project, tags or times of an entry.',
      input: {
        type: 'object',
        properties: {
          workspace_id: workspaceId,
          id: entryId,
          description: { type: 'string' },
          project_id: { type: 'integer', minimum: 1 },
          tags: { type: 'array', items: { type: 'string' } },
          start: { type: 'string' },
          stop: { type: 'string' },
          billable: { type: 'boolean' },
        },
        required: ['workspace_id', 'id'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: { method: 'PUT', path: '/workspaces/{workspace_id}/time_entries/{id}' },
      response: { fields: entryFields },
    },
    {
      name: 'delete_time_entry',
      title: 'Delete time entry',
      description: 'Deletes a time entry for good.',
      input: {
        type: 'object',
        properties: { workspace_id: workspaceId, id: entryId },
        required: ['workspace_id', 'id'],
      },
      hints: { readOnly: false, destructive: true, idempotent: true },
      risk: 'dangerous',
      request: { method: 'DELETE', path: '/workspaces/{workspace_id}/time_entries/{id}' },
      response: { empty: 'Time entry deleted.' },
    },
    {
      name: 'list_projects',
      title: 'List projects',
      description: 'Active projects of a workspace with their ids and clients.',
      input: {
        type: 'object',
        properties: { workspace_id: workspaceId, name: { type: 'string', description: 'Filters by name' } },
        required: ['workspace_id'],
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/workspaces/{workspace_id}/projects',
        query: { active: true, name: '{{input.name}}', per_page: 200 },
      },
      response: { fields: ['id', 'name', 'client_id', 'billable', 'color'] },
    },
  ],
});

const ui: ConnectorUi = {
  locales: {
    ru: {
      description: 'Учёт времени Toggl Track: запуск и остановка таймеров, текущий таймер, записи, проекты.',
      setup: {
        form: {
          summary: 'Токен API Toggl Track. Около минуты.',
          steps: [
            {
              text: 'Откройте Toggl Track → Profile settings и прокрутите до блока API Token.',
              link: { label: 'Открыть профиль Toggl', url: 'https://track.toggl.com/profile' },
            },
            { text: 'Нажмите Click to reveal и скопируйте токен.' },
            { text: 'Вставьте токен в форму.' },
          ],
          tips: [
            'Токен действует от вашего имени во всех ваших пространствах.',
            'Удаление записи времени выполняется только после вашего подтверждения.',
          ],
        },
      },
      prompts: [
        'Запусти таймер в Toggl: «Созвон с ACME», проект «Продажи».',
        'Останови текущий таймер в Toggl.',
        'Сколько часов я записал в Toggl за эту неделю по проектам?',
      ],
      fields: { token: { label: 'Токен API', hint: 'Profile settings → API Token.' } },
      actions: {
        me: { title: 'Профиль', description: 'Профиль и пространство по умолчанию.' },
        current_timer: { title: 'Текущий таймер', description: 'Запущенный сейчас таймер.' },
        list_time_entries: { title: 'Записи времени', description: 'Записи за период.' },
        start_timer: { title: 'Запустить таймер', description: 'Запускает таймер.' },
        stop_timer: { title: 'Остановить таймер', description: 'Останавливает таймер.' },
        log_time: { title: 'Записать время', description: 'Добавляет готовую запись.' },
        update_time_entry: { title: 'Изменить запись', description: 'Меняет запись.' },
        delete_time_entry: { title: 'Удалить запись', description: 'Удаляет запись.' },
        list_projects: { title: 'Проекты', description: 'Проекты пространства.' },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'Your Toggl Track API token. Takes about a minute.',
          steps: [
            {
              text: 'Open Toggl Track → Profile settings and scroll to API Token.',
              link: { label: 'Open your Toggl profile', url: 'https://track.toggl.com/profile' },
            },
            { text: 'Click to reveal the token and copy it.' },
            { text: 'Paste the token into the form.' },
          ],
          tips: [
            'The token acts as you in all of your workspaces.',
            'Deleting a time entry only happens after you confirm.',
          ],
        },
      },
      prompts: [
        'Start a Toggl timer: “Call with ACME”, Sales project.',
        'Stop my running Toggl timer.',
        'How many hours did I track in Toggl this week, per project?',
      ],
      fields: { token: { label: 'API token', hint: 'Profile settings → API Token.' } },
      actions: {
        me: { title: 'Profile', description: 'Profile and default workspace.' },
        current_timer: { title: 'Running timer', description: 'The timer running now.' },
        list_time_entries: { title: 'Time entries', description: 'Entries for a period.' },
        start_timer: { title: 'Start timer', description: 'Starts a timer.' },
        stop_timer: { title: 'Stop timer', description: 'Stops a timer.' },
        log_time: { title: 'Log time', description: 'Adds a finished entry.' },
        update_time_entry: { title: 'Update an entry', description: 'Changes an entry.' },
        delete_time_entry: { title: 'Delete an entry', description: 'Deletes an entry.' },
        list_projects: { title: 'Projects', description: 'Projects of a workspace.' },
      },
    },
  },
};

export default withUi(manifest, ui);
