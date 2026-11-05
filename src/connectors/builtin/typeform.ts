import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Typeform Create and Responses APIs with a personal access token. */

const formId = {
  type: 'string',
  pattern: '^[A-Za-z0-9]+$',
  description: 'Form id: the part after /to/ in the form link, or from typeform_list_forms',
};

const manifest = defineManifestConnector({
  id: 'typeform',
  name: 'Typeform',
  description: 'Typeform forms and their responses: list forms, read questions, fetch and search answers.',
  version: '1.0.0',
  homepage: 'https://www.typeform.com/developers/',
  instructions:
    'Responses come newest first. Each answer names its question by field.id and field.ref: read the form with typeform_get_form to see the question texts.',
  baseUrl: 'https://{{config.host}}',
  config: {
    type: 'object',
    properties: {
      host: {
        type: 'string',
        enum: ['api.typeform.com', 'api.eu.typeform.com'],
        default: 'api.typeform.com',
        description: 'api.eu.typeform.com for accounts with EU data residency',
      },
    },
  },
  credentials: {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        minLength: 20,
        description: 'Personal access token: Account → Your settings → Personal tokens',
      },
    },
    required: ['token'],
  },
  auth: { type: 'bearer', token: '{{credentials.token}}' },
  rateLimit: { requests: 2, perSeconds: 1 },
  errorMessagePaths: ['description', 'details.0.description', 'code'],
  test: { request: { method: 'GET', path: '/me' }, identity: '{{response.email}}' },
  actions: [
    {
      name: 'list_forms',
      title: 'List forms',
      description: 'Lists forms, newest first, optionally by title.',
      input: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Words in the title' },
          page_size: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/forms' },
      response: {
        root: 'items',
        fields: ['id', 'title', 'last_updated_at', 'settings.is_public', '_links.display'],
      },
      pagination: { type: 'page', param: 'page', start: 1 },
    },
    {
      name: 'get_form',
      title: 'Get form',
      description: 'Returns a form with its questions (fields), their ids, refs and choices.',
      input: { type: 'object', properties: { form_id: formId }, required: ['form_id'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/forms/{form_id}' },
      response: { fields: ['id', 'title', 'fields', 'hidden', '_links.display'] },
    },
    {
      name: 'list_responses',
      title: 'List responses',
      description:
        'Fetches completed responses of a form, newest first, with optional date range and search.',
      input: {
        type: 'object',
        properties: {
          form_id: formId,
          since: { type: 'string', description: 'ISO date-time or Unix seconds' },
          until: { type: 'string', description: 'ISO date-time or Unix seconds' },
          query: { type: 'string', description: 'Only responses containing this text' },
          before: { type: 'string', description: 'Token of the last response of the previous page' },
          page_size: { type: 'integer', minimum: 1, maximum: 1000, default: 25 },
        },
        required: ['form_id'],
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/forms/{form_id}/responses',
        query: {
          since: '{{input.since}}',
          until: '{{input.until}}',
          query: '{{input.query}}',
          before: '{{input.before}}',
          page_size: '{{input.page_size}}',
          completed: 'true',
        },
      },
      response: {
        root: 'items',
        fields: ['token', 'submitted_at', 'answers', 'hidden', 'calculated.score'],
      },
    },
    {
      name: 'delete_responses',
      title: 'Delete responses',
      description: 'Permanently deletes responses of a form by their tokens.',
      input: {
        type: 'object',
        properties: {
          form_id: formId,
          tokens: {
            type: 'string',
            pattern: '^[A-Za-z0-9]+(,[A-Za-z0-9]+){0,24}$',
            description: 'Response tokens, comma-separated (up to 25)',
          },
        },
        required: ['form_id', 'tokens'],
      },
      hints: { readOnly: false, destructive: true },
      risk: 'dangerous',
      request: {
        method: 'DELETE',
        path: '/forms/{form_id}/responses',
        query: { included_response_ids: '{{input.tokens}}' },
      },
      response: { empty: 'Deleted.' },
    },
  ],
});

const ui: ConnectorUi = {
  locales: {
    ru: {
      description: 'Формы Typeform и ответы на них: список форм, вопросы, выгрузка и поиск ответов.',
      setup: {
        form: {
          summary: 'Вы создаёте личный токен в Typeform и вставляете его сюда.',
          minutes: 2,
          needs: ['Аккаунт Typeform'],
          steps: [
            {
              text: 'Откройте Typeform → аватар → **Your settings** → **Personal tokens** и нажмите **Generate a new token**.',
              link: { label: 'Открыть токены Typeform', url: 'https://admin.typeform.com/user/tokens' },
            },
            {
              text: 'Назовите токен Manyplug и разрешите **Forms: Read** и **Responses: Read**. **Responses: Write** добавляйте, только если ИИ можно удалять ответы.',
            },
            {
              text: 'Нажмите **Generate token** и скопируйте его: Typeform показывает токен только один раз.',
              fills: ['token'],
            },
            {
              text: 'Если данные аккаунта хранятся в ЕС, выберите **api.eu.typeform.com** в поле **Сервер** формы.',
              fills: ['host'],
            },
          ],
          tips: ['Если токен потерян, удалите его и создайте новый.'],
          problems: [
            {
              problem: 'Проверка пишет, что токен неверный',
              fix: 'Скопируйте токен ещё раз или создайте новый. Аккаунту в ЕС нужен ещё сервер api.eu.typeform.com в форме.',
            },
            {
              problem: 'ИИ не может прочитать ответы',
              fix: 'У токена нет **Responses: Read**. Создайте новый токен с этим правом и вставьте его через **Переподключить**.',
            },
          ],
        },
      },
      prompts: [
        'Сколько ответов пришло на форму «Отзыв о вебинаре» за неделю? Сделай сводку.',
        'Найди в ответах анкеты всех, кто упомянул цены.',
        'Какие вопросы в форме заявки на работу?',
      ],
      fields: {
        token: { label: 'Личный токен', hint: 'Your settings → Personal tokens в Typeform.' },
        host: {
          label: 'Сервер',
          hint: 'api.eu.typeform.com — для аккаунтов с данными в ЕС.',
          options: {
            'api.typeform.com': 'Основной (api.typeform.com)',
            'api.eu.typeform.com': 'ЕС (api.eu.typeform.com)',
          },
        },
      },
      actions: {
        list_forms: { title: 'Формы', description: 'Список форм, сначала новые.' },
        get_form: { title: 'Форма', description: 'Вопросы формы и варианты ответов.' },
        list_responses: { title: 'Ответы', description: 'Ответы на форму за период или с поиском.' },
        delete_responses: {
          title: 'Удаление ответов',
          description: 'Безвозвратно удаляет выбранные ответы.',
        },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'You create a personal token in Typeform and paste it here.',
          minutes: 2,
          needs: ['A Typeform account'],
          steps: [
            {
              text: 'Open Typeform → your avatar → **Your settings** → **Personal tokens** and click **Generate a new token**.',
              link: { label: 'Open Typeform tokens', url: 'https://admin.typeform.com/user/tokens' },
            },
            {
              text: 'Name it Manyplug and allow **Forms: Read** and **Responses: Read**. Add **Responses: Write** only if the AI may delete responses.',
            },
            { text: 'Click **Generate token** and copy it: Typeform shows it only once.', fills: ['token'] },
            {
              text: 'If your account keeps data in the EU, pick **api.eu.typeform.com** as **Server** in the form.',
              fills: ['host'],
            },
          ],
          tips: ['If you lose the token, delete it and make a new one.'],
          problems: [
            {
              problem: 'The check says the token is invalid',
              fix: 'Copy the token again or make a new one. An EU account also needs the server api.eu.typeform.com in the form.',
            },
            {
              problem: 'The AI cannot read responses',
              fix: 'The token lacks **Responses: Read**. Make a new token with it and paste it with **Reconnect**.',
            },
          ],
        },
      },
      prompts: [
        'How many responses did the “Webinar feedback” form get this week? Summarize them.',
        'Find everyone who mentioned pricing in the survey answers.',
        'What questions does the job application form ask?',
      ],
      fields: {
        token: { label: 'Personal token', hint: 'Your settings → Personal tokens in Typeform.' },
        host: {
          label: 'Server',
          hint: 'api.eu.typeform.com for EU data residency accounts.',
          options: {
            'api.typeform.com': 'Global (api.typeform.com)',
            'api.eu.typeform.com': 'EU (api.eu.typeform.com)',
          },
        },
      },
      actions: {
        list_forms: { title: 'Forms', description: 'Lists forms, newest first.' },
        get_form: { title: 'Get a form', description: 'The questions of a form and their choices.' },
        list_responses: { title: 'Responses', description: 'Answers to a form for a period or a search.' },
        delete_responses: {
          title: 'Delete responses',
          description: 'Permanently deletes the chosen responses.',
        },
      },
    },
  },
};

export default withUi(manifest, ui);
