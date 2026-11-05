import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Airtable Web API with a personal access token. */

const baseId = { type: 'string', pattern: '^app[A-Za-z0-9]+$', description: 'Base id (app…)' };
const table = { type: 'string', minLength: 1, description: 'Table name or id (tbl…)' };
const recordId = { type: 'string', pattern: '^rec[A-Za-z0-9]+$', description: 'Record id (rec…)' };
const values = {
  type: 'object',
  description: 'Field values by field name, e.g. {"Name": "ACME", "Status": "Lead"}',
  additionalProperties: true,
};
const RECORD_FIELDS = ['id', 'createdTime', 'fields'];

const manifest = defineManifestConnector({
  id: 'airtable',
  name: 'Airtable',
  description: 'Airtable bases: tables and fields, find, add, update and delete records.',
  version: '1.0.0',
  homepage: 'https://airtable.com/developers/web/api/introduction',
  instructions:
    'Call airtable_get_base_schema first to learn table and field names. formula uses Airtable formulas, e.g. "AND({Status} = \'Open\', IS_AFTER({Due}, TODAY()))".',
  baseUrl: 'https://api.airtable.com/v0',
  credentials: {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        pattern: '^pat',
        description: 'Personal access token: https://airtable.com/create/tokens',
      },
    },
    required: ['token'],
  },
  auth: { type: 'bearer', token: '{{credentials.token}}' },
  // Airtable allows 5 requests per second per base.
  rateLimit: { requests: 5, perSeconds: 1 },
  errorMessagePaths: ['error.message', 'error.type', 'error'],
  pagination: { type: 'cursor', param: 'offset', nextPath: 'offset' },
  test: { request: { method: 'GET', path: '/meta/whoami' }, identity: '{{response.email}}' },
  actions: [
    {
      name: 'list_bases',
      title: 'List bases',
      description: 'Lists the bases the token can access.',
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/meta/bases' },
      response: { root: 'bases', fields: ['id', 'name', 'permissionLevel'] },
      pagination: true,
    },
    {
      name: 'get_base_schema',
      title: 'Get base schema',
      description: 'Tables of a base with their fields and field types.',
      input: { type: 'object', properties: { base_id: baseId }, required: ['base_id'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/meta/bases/{base_id}/tables' },
      response: { root: 'tables', fields: ['id', 'name', 'description', 'primaryFieldId', 'fields'] },
    },
    {
      name: 'list_records',
      title: 'List records',
      description: 'Lists records of a table, optionally filtered by a formula, a view or sorted by a field.',
      input: {
        type: 'object',
        properties: {
          base_id: baseId,
          table,
          formula: { type: 'string', description: 'filterByFormula, e.g. "{Status} = \'Open\'"' },
          view: { type: 'string', description: 'View name or id' },
          sort_field: { type: 'string', description: 'Field name to sort by' },
          sort_direction: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
        },
        required: ['base_id', 'table'],
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/{base_id}/{table}',
        query: {
          filterByFormula: '{{input.formula}}',
          view: '{{input.view}}',
          'sort[0][field]': '{{input.sort_field}}',
          'sort[0][direction]': '{{input.sort_direction}}',
          pageSize: '{{input.limit}}',
        },
      },
      response: { root: 'records', fields: RECORD_FIELDS },
      pagination: true,
    },
    {
      name: 'get_record',
      title: 'Get record',
      description: 'Returns one record with all its fields.',
      input: {
        type: 'object',
        properties: { base_id: baseId, table, record_id: recordId },
        required: ['base_id', 'table', 'record_id'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/{base_id}/{table}/{record_id}' },
      response: { fields: RECORD_FIELDS },
    },
    {
      name: 'create_records',
      title: 'Create records',
      description: 'Adds up to 10 records. Select and link values are created when missing (typecast).',
      input: {
        type: 'object',
        properties: {
          base_id: baseId,
          table,
          records: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            items: { type: 'object', properties: { fields: values }, required: ['fields'] },
          },
        },
        required: ['base_id', 'table', 'records'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: {
        method: 'POST',
        path: '/{base_id}/{table}',
        body: { records: '{{input.records}}', typecast: true },
      },
      response: { root: 'records', fields: RECORD_FIELDS },
    },
    {
      name: 'update_records',
      title: 'Update records',
      description: 'Changes the given fields of up to 10 records; other fields stay as they are.',
      input: {
        type: 'object',
        properties: {
          base_id: baseId,
          table,
          records: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            items: {
              type: 'object',
              properties: { id: recordId, fields: values },
              required: ['id', 'fields'],
            },
          },
        },
        required: ['base_id', 'table', 'records'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: {
        method: 'PATCH',
        path: '/{base_id}/{table}',
        body: { records: '{{input.records}}', typecast: true },
      },
      response: { root: 'records', fields: RECORD_FIELDS },
    },
    {
      name: 'delete_record',
      title: 'Delete record',
      description: 'Deletes a record (restorable from the base trash for 7 days on free plans).',
      input: {
        type: 'object',
        properties: { base_id: baseId, table, record_id: recordId },
        required: ['base_id', 'table', 'record_id'],
      },
      hints: { readOnly: false, destructive: true, idempotent: true },
      risk: 'dangerous',
      request: { method: 'DELETE', path: '/{base_id}/{table}/{record_id}' },
      response: { fields: ['id', 'deleted'] },
    },
  ],
});

const ui: ConnectorUi = {
  locales: {
    ru: {
      description: 'Базы Airtable: таблицы и поля, поиск, добавление, изменение и удаление записей.',
      setup: {
        form: {
          summary: 'Вы создаёте личный токен доступа в Airtable и вставляете его сюда.',
          minutes: 2,
          needs: ['Аккаунт Airtable с доступом к базам, с которыми будет работать ИИ'],
          steps: [
            {
              text: 'Откройте страницу токенов Airtable и нажмите **Create new token**.',
              link: { label: 'Открыть токены Airtable', url: 'https://airtable.com/create/tokens' },
            },
            {
              text: 'Назовите токен Manyplug. В разделе **Scopes** добавьте **data.records:read**, **data.records:write** и **schema.bases:read**.',
            },
            {
              text: 'В разделе **Access** добавьте базы, с которыми будет работать ИИ, или выберите **All current and future bases in all current and future workspaces**.',
            },
            {
              text: 'Нажмите **Create token** и скопируйте его (начинается с pat). Airtable показывает его только один раз.',
              fills: ['token'],
            },
          ],
          tips: [
            'Чтобы ИИ только читал, не добавляйте data.records:write.',
            'Отозвать токен можно на той же странице в любой момент.',
          ],
          problems: [
            {
              problem: 'Форма пишет, что токен не подходит',
              fix: 'Скопируйте токен целиком ещё раз: он длинный и начинается с pat. Если окно уже закрыто, создайте новый токен на той же странице.',
            },
            {
              problem: 'ИИ пишет, что база или таблица не найдена',
              fix: 'У токена нет доступа к этой базе. Откройте токен на странице токенов, добавьте базу в **Access** и сохраните.',
            },
            {
              problem: 'ИИ читает записи, но не может добавлять и менять их',
              fix: 'Добавьте токену право **data.records:write** и сохраните.',
            },
          ],
        },
      },
      prompts: [
        'Какие сделки в базе CRM в статусе «Переговоры»?',
        'Добавь в таблицу «Контакты» Анну Смит из ACME с почтой anna@acme.com.',
        'Отметь все заказы ACME за октябрь как оплаченные.',
        'Какие поля есть в базе «Контент-план»?',
      ],
      fields: {
        token: { label: 'Личный токен доступа', hint: 'Создаётся на airtable.com/create/tokens.' },
      },
      actions: {
        list_bases: { title: 'Список баз', description: 'Базы, к которым есть доступ у токена.' },
        get_base_schema: { title: 'Структура базы', description: 'Таблицы базы с полями и их типами.' },
        list_records: {
          title: 'Записи таблицы',
          description: 'Записи таблицы с фильтром по формуле, по представлению или с сортировкой.',
        },
        get_record: { title: 'Запись', description: 'Показывает одну запись со всеми полями.' },
        create_records: { title: 'Новые записи', description: 'Добавляет до 10 записей.' },
        update_records: { title: 'Изменение записей', description: 'Меняет указанные поля у до 10 записей.' },
        delete_record: { title: 'Удаление записи', description: 'Удаляет запись.' },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'You create a personal access token in Airtable and paste it here.',
          minutes: 2,
          needs: ['An Airtable account with access to the bases the AI should work with'],
          steps: [
            {
              text: 'Open the Airtable tokens page and click **Create new token**.',
              link: { label: 'Open Airtable tokens', url: 'https://airtable.com/create/tokens' },
            },
            {
              text: 'Name it Manyplug. Under **Scopes**, add **data.records:read**, **data.records:write** and **schema.bases:read**.',
            },
            {
              text: 'Under **Access**, add the bases the AI may use, or pick **All current and future bases in all current and future workspaces**.',
            },
            {
              text: 'Click **Create token** and copy it (it starts with pat). Airtable shows it only once.',
              fills: ['token'],
            },
          ],
          tips: [
            'For read-only access, leave out data.records:write.',
            'You can revoke the token on the same page at any time.',
          ],
          problems: [
            {
              problem: 'The form says the token is not valid',
              fix: 'Copy the whole token again: it is long and starts with pat. If you closed the window, create a new token on the same page.',
            },
            {
              problem: 'The AI says a base or table is not found',
              fix: 'The token has no access to that base. Open the token on the tokens page, add the base under **Access** and save.',
            },
            {
              problem: 'The AI can read records but cannot add or change them',
              fix: 'Add the **data.records:write** scope to the token and save.',
            },
          ],
        },
      },
      prompts: [
        'Which deals in the CRM base are in Negotiation?',
        'Add Anna Smith from ACME, anna@acme.com, to the Contacts table.',
        'Mark all ACME orders from October as paid.',
        'What fields does the Content plan base have?',
      ],
      fields: {
        token: { label: 'Personal access token', hint: 'Create it at airtable.com/create/tokens.' },
      },
      actions: {
        list_bases: { title: 'List bases', description: 'Bases the token can access.' },
        get_base_schema: {
          title: 'Base structure',
          description: 'Tables of a base with their fields and types.',
        },
        list_records: {
          title: 'List records',
          description: 'Records of a table, filtered by a formula or a view, or sorted.',
        },
        get_record: { title: 'Get a record', description: 'Shows one record with all its fields.' },
        create_records: { title: 'Create records', description: 'Adds up to 10 records.' },
        update_records: {
          title: 'Update records',
          description: 'Changes the given fields of up to 10 records.',
        },
        delete_record: { title: 'Delete a record', description: 'Deletes a record.' },
      },
    },
  },
};

export default withUi(manifest, ui);
