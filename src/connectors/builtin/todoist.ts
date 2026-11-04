import { defineManifestConnector } from '../manifest/compile.js';

const TASK_FIELDS = [
  'id',
  'content',
  'description',
  'project_id',
  'due.string',
  'due.date',
  'priority',
  'labels',
  'checked',
];
const taskId = { type: 'string', minLength: 1, description: 'Task id' };
const taskFields = {
  content: { type: 'string', description: 'Task title; supports Markdown' },
  description: { type: 'string' },
  project_id: { type: 'string', description: 'From todoist_list_projects; default is Inbox' },
  due_string: {
    type: 'string',
    description: 'Natural language, e.g. "tomorrow 10am", "every monday", "завтра"',
  },
  due_lang: { type: 'string', description: 'Language of due_string, e.g. "ru"' },
  priority: { type: 'integer', minimum: 1, maximum: 4, description: '4 = urgent (p1), 1 = normal' },
  labels: { type: 'array', items: { type: 'string' } },
};

/** Todoist API v1. API token from Settings → Integrations → Developer, or OAuth. */
export default defineManifestConnector({
  id: 'todoist',
  name: 'Todoist',
  description: 'Todoist tasks and projects: find, add, update, complete tasks.',
  version: '1.0.0',
  homepage: 'https://developer.todoist.com/api/v1',
  instructions:
    'todoist_find_tasks takes a Todoist filter: "today", "overdue", "7 days", "#Work & p1", "@label", "search: text".',
  baseUrl: 'https://api.todoist.com/api/v1',
  // OAuth through the hub's Todoist app, or the personal API token without one.
  auth: {
    type: 'oauth2',
    provider: 'todoist',
    scopes: ['data:read_write', 'data:delete'],
    token: '{{credentials.token}}',
  },
  credentials: {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        minLength: 1,
        description: 'API token (only without OAuth): Todoist → Settings → Integrations → Developer',
      },
    },
  },
  rateLimit: { requests: 300, perSeconds: 60 },
  errorMessagePaths: ['error'],
  pagination: { type: 'cursor', param: 'cursor', nextPath: 'next_cursor' },
  test: { request: { method: 'GET', path: '/user' }, identity: '{{response.email}}' },
  actions: [
    {
      name: 'find_tasks',
      title: 'Find tasks',
      description: 'Finds open tasks matching a Todoist filter query.',
      input: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Filter, e.g. "today | overdue"' },
          lang: { type: 'string', description: 'Language of the query, e.g. "ru"' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
        required: ['query'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/tasks/filter' },
      response: { root: 'results', fields: TASK_FIELDS },
      pagination: true,
    },
    {
      name: 'list_projects',
      title: 'List projects',
      description: 'Lists projects with their ids.',
      input: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/projects' },
      response: { root: 'results', fields: ['id', 'name', 'parent_id', 'is_inbox_project'] },
      pagination: true,
    },
    {
      name: 'add_task',
      title: 'Add task',
      description: 'Creates a task.',
      input: { type: 'object', properties: taskFields, required: ['content'] },
      hints: { readOnly: false, destructive: false },
      request: { method: 'POST', path: '/tasks' },
      response: { fields: TASK_FIELDS },
    },
    {
      name: 'update_task',
      title: 'Update task',
      description: 'Changes a task: title, description, due date, priority, labels.',
      input: { type: 'object', properties: { task_id: taskId, ...taskFields }, required: ['task_id'] },
      hints: { readOnly: false, destructive: false, idempotent: true },
      request: { method: 'POST', path: '/tasks/{task_id}' },
      response: { fields: TASK_FIELDS },
    },
    {
      name: 'complete_task',
      title: 'Complete task',
      description: 'Marks a task as done (a recurring task moves to its next date).',
      input: { type: 'object', properties: { task_id: taskId }, required: ['task_id'] },
      hints: { readOnly: false, destructive: false, idempotent: true },
      request: { method: 'POST', path: '/tasks/{task_id}/close', body: {} },
      response: { empty: 'Completed.' },
    },
    {
      name: 'reopen_task',
      title: 'Reopen task',
      description: 'Reopens a completed task.',
      input: { type: 'object', properties: { task_id: taskId }, required: ['task_id'] },
      hints: { readOnly: false, destructive: false, idempotent: true },
      request: { method: 'POST', path: '/tasks/{task_id}/reopen', body: {} },
      response: { empty: 'Reopened.' },
    },
    {
      name: 'delete_task',
      title: 'Delete task',
      description: 'Deletes a task permanently.',
      input: { type: 'object', properties: { task_id: taskId }, required: ['task_id'] },
      hints: { readOnly: false, destructive: true, idempotent: true },
      request: { method: 'DELETE', path: '/tasks/{task_id}' },
      response: { empty: 'Deleted.' },
    },
  ],
});
