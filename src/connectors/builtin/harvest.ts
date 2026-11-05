import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Harvest API v2 with a personal access token: time entries, timers, projects, time reports. */

const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' };
const reportDate = { type: 'string', pattern: '^\\d{8}$', description: 'YYYYMMDD' };
const entryId = { type: 'integer', minimum: 1, description: 'Time entry id' };
const entryFields = [
  'id',
  'spent_date',
  'hours',
  'notes',
  'is_running',
  'billable',
  'project.id',
  'project.name',
  'task.name',
  'client.name',
  'user.name',
];

const manifest = defineManifestConnector({
  id: 'harvest',
  name: 'Harvest',
  description:
    'Harvest time tracking: time entries, start and stop timers, your projects and tasks, time reports.',
  version: '1.0.0',
  homepage: 'https://help.getharvest.com/api-v2/',
  instructions:
    'A time entry needs a project and one of its task ids: harvest_list_projects lists both. Logging without hours starts a running timer.',
  baseUrl: 'https://api.harvestapp.com/v2',
  config: {
    type: 'object',
    properties: {
      accountId: {
        type: 'string',
        pattern: '^\\d+$',
        description: 'Developers → Personal access tokens → Account ID',
      },
    },
    required: ['accountId'],
  },
  credentials: {
    type: 'object',
    properties: {
      token: { type: 'string', minLength: 20, description: 'Developers → Personal access tokens' },
    },
    required: ['token'],
  },
  auth: { type: 'bearer', token: '{{credentials.token}}' },
  headers: { 'Harvest-Account-Id': '{{config.accountId}}', 'User-Agent': 'Manyplug (https://manyplug.com)' },
  rateLimit: { requests: 100, perSeconds: 15 },
  errorMessagePaths: ['message', 'error_description'],
  pagination: { type: 'next_url', nextPath: 'links.next' },
  test: { request: { method: 'GET', path: '/users/me' }, identity: '{{response.email}}' },
  actions: [
    {
      name: 'list_time_entries',
      title: 'List time entries',
      description: 'Time entries, newest first, by date range, project, user or running state.',
      input: {
        type: 'object',
        properties: {
          from: date,
          to: date,
          project_id: { type: 'integer', minimum: 1 },
          user_id: { type: 'integer', minimum: 1 },
          is_running: { type: 'boolean' },
          per_page: { type: 'integer', minimum: 1, maximum: 2000, default: 100 },
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/time_entries' },
      response: { root: 'time_entries', fields: entryFields },
      pagination: true,
    },
    {
      name: 'log_time',
      title: 'Log time',
      description: 'Logs hours on a project task, or starts a running timer when hours are left out.',
      input: {
        type: 'object',
        properties: {
          project_id: { type: 'integer', minimum: 1 },
          task_id: { type: 'integer', minimum: 1, description: 'A task of the project' },
          spent_date: date,
          hours: { type: 'number', exclusiveMinimum: 0, maximum: 24 },
          notes: { type: 'string' },
        },
        required: ['project_id', 'task_id', 'spent_date'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: { method: 'POST', path: '/time_entries' },
      response: { fields: entryFields },
    },
    {
      name: 'update_time_entry',
      title: 'Update time entry',
      description: 'Changes the hours, notes, date or task of a time entry.',
      input: {
        type: 'object',
        properties: {
          id: entryId,
          hours: { type: 'number', minimum: 0, maximum: 24 },
          notes: { type: 'string' },
          spent_date: date,
          task_id: { type: 'integer', minimum: 1 },
        },
        required: ['id'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: { method: 'PATCH', path: '/time_entries/{id}' },
      response: { fields: entryFields },
    },
    {
      name: 'stop_timer',
      title: 'Stop timer',
      description: 'Stops a running timer.',
      input: { type: 'object', properties: { id: entryId }, required: ['id'] },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: { method: 'PATCH', path: '/time_entries/{id}/stop', body: {} },
      response: { fields: entryFields },
    },
    {
      name: 'restart_timer',
      title: 'Restart timer',
      description: 'Starts the timer of a stopped time entry again.',
      input: { type: 'object', properties: { id: entryId }, required: ['id'] },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: { method: 'PATCH', path: '/time_entries/{id}/restart', body: {} },
      response: { fields: entryFields },
    },
    {
      name: 'list_projects',
      title: 'List my projects',
      description: 'Projects you are assigned to, with their client and task ids.',
      input: {
        type: 'object',
        properties: { per_page: { type: 'integer', minimum: 1, maximum: 2000, default: 100 } },
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/users/me/project_assignments' },
      response: {
        root: 'project_assignments',
        fields: ['project.id', 'project.name', 'project.code', 'client.name', 'task_assignments'],
      },
      pagination: true,
    },
    {
      name: 'time_report',
      title: 'Time report',
      description: 'Total and billable hours per project for a period.',
      input: { type: 'object', properties: { from: reportDate, to: reportDate }, required: ['from', 'to'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/reports/time/projects' },
      response: {
        root: 'results',
        fields: [
          'project_id',
          'project_name',
          'client_name',
          'total_hours',
          'billable_hours',
          'billable_amount',
          'currency',
        ],
      },
      pagination: true,
    },
  ],
});

const ui: ConnectorUi = {
  locales: {
    ru: {
      description:
        'Учёт времени Harvest: записи времени, запуск и остановка таймеров, проекты и задачи, отчёты.',
      setup: {
        form: {
          summary: 'Личный токен Harvest и Account ID. Около минуты.',
          steps: [
            {
              text: 'Откройте Harvest Developers → Personal access tokens и нажмите Create new personal access token.',
              link: { label: 'Открыть токены Harvest', url: 'https://id.getharvest.com/developers' },
            },
            { text: 'Назовите токен Manyplug и создайте его.' },
            { text: 'Скопируйте Your Token и Account ID со страницы токена и вставьте их в форму.' },
          ],
          tips: ['Токен действует от вашего имени и видит те же проекты и записи, что и вы.'],
        },
      },
      prompts: [
        'Сколько часов я записал в Harvest на этой неделе?',
        'Запусти таймер в Harvest на проекте «Сайт ACME», задача «Дизайн».',
        'Сколько оплачиваемых часов по каждому проекту в октябре?',
      ],
      fields: {
        accountId: { label: 'Account ID', hint: 'Есть на странице токена.' },
        token: { label: 'Токен', hint: 'Developers → Personal access tokens.' },
      },
      actions: {
        list_time_entries: { title: 'Записи времени', description: 'Записи за период.' },
        log_time: { title: 'Записать время', description: 'Записывает часы или запускает таймер.' },
        update_time_entry: { title: 'Изменить запись', description: 'Меняет часы или заметку.' },
        stop_timer: { title: 'Остановить таймер', description: 'Останавливает таймер.' },
        restart_timer: { title: 'Продолжить таймер', description: 'Снова запускает таймер.' },
        list_projects: { title: 'Мои проекты', description: 'Проекты и их задачи.' },
        time_report: { title: 'Отчёт', description: 'Часы по проектам за период.' },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'Your Harvest personal access token and Account ID. Takes about a minute.',
          steps: [
            {
              text: 'Open Harvest Developers → Personal access tokens and click Create new personal access token.',
              link: { label: 'Open Harvest tokens', url: 'https://id.getharvest.com/developers' },
            },
            { text: 'Name it Manyplug and create it.' },
            { text: 'Copy Your Token and the Account ID from the token page into the form.' },
          ],
          tips: ['The token acts as you and sees the same projects and entries you do.'],
        },
      },
      prompts: [
        'How many hours did I log in Harvest this week?',
        'Start a Harvest timer on the “ACME website” project, Design task.',
        'How many billable hours per project did we log in October?',
      ],
      fields: {
        accountId: { label: 'Account ID', hint: 'Shown on the token page.' },
        token: { label: 'Token', hint: 'Developers → Personal access tokens.' },
      },
      actions: {
        list_time_entries: { title: 'Time entries', description: 'Entries for a period.' },
        log_time: { title: 'Log time', description: 'Logs hours or starts a timer.' },
        update_time_entry: { title: 'Update an entry', description: 'Changes hours or notes.' },
        stop_timer: { title: 'Stop timer', description: 'Stops a timer.' },
        restart_timer: { title: 'Restart timer', description: 'Starts a timer again.' },
        list_projects: { title: 'My projects', description: 'Projects and their tasks.' },
        time_report: { title: 'Report', description: 'Hours per project for a period.' },
      },
    },
  },
};

export default withUi(manifest, ui);
