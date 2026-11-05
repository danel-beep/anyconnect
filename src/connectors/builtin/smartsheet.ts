import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Smartsheet API 2.0 with a personal access token: sheets, rows and comments. */

const sheetId = { type: 'integer', minimum: 1, description: 'Sheet id from smartsheet_list_sheets' };
const cells = {
  type: 'array',
  minItems: 1,
  items: {
    type: 'object',
    properties: {
      columnId: { type: 'integer', description: 'Column id from smartsheet_get_sheet' },
      value: { description: 'Text, number or boolean' },
    },
    required: ['columnId', 'value'],
  },
};

const manifest = defineManifestConnector({
  id: 'smartsheet',
  name: 'Smartsheet',
  description: 'Smartsheet sheets: find sheets, read columns and rows, add and update rows, comment on rows.',
  version: '1.0.0',
  homepage: 'https://developers.smartsheet.com/api/smartsheet/introduction',
  instructions:
    'Cells are set by column id: read the sheet with smartsheet_get_sheet first to see column ids and titles.',
  baseUrl: 'https://{{config.host}}/2.0',
  config: {
    type: 'object',
    properties: {
      host: {
        type: 'string',
        enum: ['api.smartsheet.com', 'api.smartsheet.eu', 'api.smartsheet.au'],
        default: 'api.smartsheet.com',
        description: 'The region of your Smartsheet account',
      },
    },
  },
  credentials: {
    type: 'object',
    properties: {
      token: { type: 'string', minLength: 20, description: 'Account → Apps & Integrations → API Access' },
    },
    required: ['token'],
  },
  auth: { type: 'bearer', token: '{{credentials.token}}' },
  rateLimit: { requests: 300, perSeconds: 60 },
  errorMessagePaths: ['message'],
  pagination: { type: 'page', param: 'page', start: 1 },
  test: { request: { method: 'GET', path: '/users/me' }, identity: '{{response.email}}' },
  actions: [
    {
      name: 'list_sheets',
      title: 'List sheets',
      description: 'Sheets you can access, with their ids and last change.',
      input: {
        type: 'object',
        properties: { pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/sheets' },
      response: { root: 'data', fields: ['id', 'name', 'accessLevel', 'modifiedAt', 'permalink'] },
      pagination: true,
    },
    {
      name: 'search',
      title: 'Search',
      description: 'Searches sheet names and cell contents across everything you can access.',
      input: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/search' },
      response: {
        root: 'results',
        fields: ['objectType', 'objectId', 'parentObjectName', 'text', 'contextData'],
      },
    },
    {
      name: 'get_sheet',
      title: 'Get sheet',
      description: 'Returns a sheet’s columns and a page of its rows (cells with column ids and values).',
      input: {
        type: 'object',
        properties: {
          sheet_id: sheetId,
          pageSize: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        },
        required: ['sheet_id'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/sheets/{sheet_id}' },
      response: { fields: ['id', 'name', 'totalRowCount', 'permalink', 'columns', 'rows'] },
    },
    {
      name: 'add_rows',
      title: 'Add rows',
      description: 'Adds rows to the bottom of a sheet.',
      input: {
        type: 'object',
        properties: {
          sheet_id: sheetId,
          rows: {
            type: 'array',
            minItems: 1,
            maxItems: 500,
            items: {
              type: 'object',
              properties: { toBottom: { type: 'boolean', const: true }, cells },
              required: ['toBottom', 'cells'],
            },
            description: 'e.g. [{"toBottom":true,"cells":[{"columnId":1,"value":"Ann"}]}]',
          },
        },
        required: ['sheet_id', 'rows'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: { method: 'POST', path: '/sheets/{sheet_id}/rows', body: '{{input.rows}}' },
      response: { root: 'result', fields: ['id', 'rowNumber'] },
    },
    {
      name: 'update_rows',
      title: 'Update rows',
      description: 'Changes cells of existing rows.',
      input: {
        type: 'object',
        properties: {
          sheet_id: sheetId,
          rows: {
            type: 'array',
            minItems: 1,
            maxItems: 500,
            items: {
              type: 'object',
              properties: { id: { type: 'integer', description: 'Row id' }, cells },
              required: ['id', 'cells'],
            },
          },
        },
        required: ['sheet_id', 'rows'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: { method: 'PUT', path: '/sheets/{sheet_id}/rows', body: '{{input.rows}}' },
      response: { root: 'result', fields: ['id', 'rowNumber'] },
    },
    {
      name: 'add_comment',
      title: 'Comment on row',
      description: 'Starts a discussion on a row with a comment.',
      input: {
        type: 'object',
        properties: {
          sheet_id: sheetId,
          row_id: { type: 'integer', minimum: 1 },
          text: { type: 'string', minLength: 1 },
        },
        required: ['sheet_id', 'row_id', 'text'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: {
        method: 'POST',
        path: '/sheets/{sheet_id}/rows/{row_id}/discussions',
        body: { comment: { text: '{{input.text}}' } },
      },
      response: { root: 'result', fields: ['id', 'title'] },
    },
  ],
});

const ui: ConnectorUi = {
  locales: {
    ru: {
      description:
        'Таблицы Smartsheet: поиск, чтение столбцов и строк, добавление и изменение строк, комментарии.',
      setup: {
        form: {
          summary: 'Вы создаёте токен доступа к API в Smartsheet и вставляете его сюда.',
          minutes: 2,
          needs: [
            'Аккаунт Smartsheet',
            'Знать, где ваш аккаунт: smartsheet.com, smartsheet.eu или smartsheet.au',
          ],
          steps: [
            {
              text: 'В Smartsheet откройте **Account** (аватар) → **Apps & Integrations** → **API Access**.',
              link: {
                label: 'Как получить токен',
                url: 'https://help.smartsheet.com/articles/2482389-generate-API-key',
              },
            },
            {
              text: 'Нажмите **Generate new access token**, назовите токен Manyplug и скопируйте его: Smartsheet показывает его только один раз.',
              fills: ['token'],
            },
            {
              text: 'Если аккаунт на smartsheet.eu или smartsheet.au, выберите этот **Регион** в форме и нажмите **Подключить**.',
              fills: ['host'],
            },
          ],
          tips: [
            'Токен действует от вашего имени и видит те же таблицы, что и вы.',
            'Чтобы отозвать доступ, удалите токен на той же странице **API Access**.',
          ],
          problems: [
            {
              problem: 'Проверка пишет, что токен неверный',
              fix: 'Скопируйте токен целиком ещё раз или создайте новый, если старый потерян. Проверьте и **Регион**: токен со smartsheet.eu не работает с сервером США.',
            },
            {
              problem: 'Нет пункта **API Access**',
              fix: 'Ваш тариф или администратор Smartsheet не разрешает токены API. Попросите администратора включить вам доступ к API.',
            },
          ],
        },
      },
      prompts: [
        'Какие задачи в таблице «План запуска» в Smartsheet просрочены?',
        'Добавь в «Лиды» строку: ACME, Анна Смит, anna@acme.com.',
        'Отметь строку «Лендинг» выполненной и оставь комментарий.',
      ],
      fields: {
        token: { label: 'Токен', hint: 'Apps & Integrations → API Access.' },
        host: {
          label: 'Регион',
          hint: 'Где находится ваш аккаунт Smartsheet.',
          options: {
            'api.smartsheet.com': 'США (smartsheet.com)',
            'api.smartsheet.eu': 'Европа (smartsheet.eu)',
            'api.smartsheet.au': 'Австралия (smartsheet.au)',
          },
        },
      },
      actions: {
        list_sheets: { title: 'Таблицы', description: 'Доступные таблицы.' },
        search: { title: 'Поиск', description: 'Ищет по названиям и ячейкам.' },
        get_sheet: { title: 'Таблица', description: 'Столбцы и строки таблицы.' },
        add_rows: { title: 'Новые строки', description: 'Добавляет строки в конец.' },
        update_rows: { title: 'Изменение строк', description: 'Меняет ячейки строк.' },
        add_comment: { title: 'Комментарий', description: 'Комментарий к строке.' },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'You create an API access token in Smartsheet and paste it here.',
          minutes: 2,
          needs: [
            'A Smartsheet account',
            'To know where your account lives: smartsheet.com, smartsheet.eu or smartsheet.au',
          ],
          steps: [
            {
              text: 'In Smartsheet, open **Account** (your avatar) → **Apps & Integrations** → **API Access**.',
              link: {
                label: 'How to get a token',
                url: 'https://help.smartsheet.com/articles/2482389-generate-API-key',
              },
            },
            {
              text: 'Click **Generate new access token**, name it Manyplug and copy the token: Smartsheet shows it only once.',
              fills: ['token'],
            },
            {
              text: 'If your account is on smartsheet.eu or smartsheet.au, pick that **Region** in the form, then click **Connect**.',
              fills: ['host'],
            },
          ],
          tips: [
            'The token acts as you and sees the same sheets you do.',
            'To cut access, revoke the token on the same **API Access** page.',
          ],
          problems: [
            {
              problem: 'The check says the token is invalid',
              fix: 'Copy the whole token again, or make a new one if you lost it. Also check the **Region**: a token from smartsheet.eu does not work on the US server.',
            },
            {
              problem: 'There is no **API Access** item',
              fix: 'Your plan or your Smartsheet admin does not allow API tokens. Ask the admin to turn on API access for you.',
            },
          ],
        },
      },
      prompts: [
        'Which tasks in the “Launch plan” Smartsheet are overdue?',
        'Add a row to Leads: ACME, Anna Smith, anna@acme.com.',
        'Mark the “Landing page” row done and leave a comment.',
      ],
      fields: {
        token: { label: 'Token', hint: 'Apps & Integrations → API Access.' },
        host: {
          label: 'Region',
          hint: 'Where your Smartsheet account lives.',
          options: {
            'api.smartsheet.com': 'US (smartsheet.com)',
            'api.smartsheet.eu': 'Europe (smartsheet.eu)',
            'api.smartsheet.au': 'Australia (smartsheet.au)',
          },
        },
      },
      actions: {
        list_sheets: { title: 'Sheets', description: 'Sheets you can access.' },
        search: { title: 'Search', description: 'Searches names and cells.' },
        get_sheet: { title: 'Get a sheet', description: 'Columns and rows of a sheet.' },
        add_rows: { title: 'Add rows', description: 'Adds rows at the bottom.' },
        update_rows: { title: 'Update rows', description: 'Changes cells of rows.' },
        add_comment: { title: 'Comment', description: 'A comment on a row.' },
      },
    },
  },
};

export default withUi(manifest, ui);
