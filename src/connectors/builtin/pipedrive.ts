import { defineManifestConnector } from '../manifest/compile.js';
import type { CapabilityBinding, CapabilityOutput } from '../sdk.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Pipedrive API v1 with a personal API token (sent in a header, not the URL). */

const limit = { type: 'integer', minimum: 1, maximum: 100, default: 20 };
const term = { type: 'string', minLength: 2, description: 'At least 2 characters' };
const DEAL_FIELDS = [
  'id',
  'title',
  'value',
  'currency',
  'status',
  'stage_id',
  'person_name',
  'org_name',
  'expected_close_date',
  'update_time',
];
const dealFields = {
  title: { type: 'string', minLength: 1 },
  value: { type: 'number' },
  currency: { type: 'string', description: 'ISO code, e.g. USD' },
  stage_id: { type: 'integer', description: 'From pipedrive_list_stages' },
  expected_close_date: { type: 'string', description: 'YYYY-MM-DD' },
};
const dealBody = (extra: string[] = []) =>
  Object.fromEntries([...Object.keys(dealFields), ...extra].map((k) => [k, `{{input.${k}}}`]));

interface PersonHit {
  item: {
    id: number;
    name: string;
    emails?: string[];
    phones?: string[];
    organization?: { name?: string } | null;
  };
}

const searchPersons: CapabilityBinding = {
  id: 'contacts.search',
  mapInput: ({ query, limit: max }) => ({ term: query, limit: max }),
  mapOutput: (result) =>
    (result as { items: PersonHit[] }).items.map(
      ({ item }): CapabilityOutput<'contacts.search'> => ({
        id: String(item.id),
        name: item.name,
        ...(item.emails?.length ? { emails: item.emails } : {}),
        ...(item.phones?.length ? { phones: item.phones } : {}),
        ...(item.organization?.name ? { company: item.organization.name } : {}),
      }),
    ),
};

const manifest = defineManifestConnector(
  {
    id: 'pipedrive',
    name: 'Pipedrive',
    description: 'Pipedrive CRM: find people, organizations and deals, create and move deals, add notes.',
    version: '1.0.0',
    homepage: 'https://developers.pipedrive.com/docs/api/v1',
    instructions:
      'Deal stages are ids: get them from pipedrive_list_stages. Searches need at least 2 characters.',
    baseUrl: 'https://api.pipedrive.com/v1',
    credentials: {
      type: 'object',
      properties: {
        apiToken: {
          type: 'string',
          pattern: '^[0-9a-f]{40}$',
          description: 'Personal API token: Pipedrive → Personal preferences → API',
        },
      },
      required: ['apiToken'],
    },
    auth: { type: 'api_key', in: 'header', name: 'x-api-token', value: '{{credentials.apiToken}}' },
    rateLimit: { requests: 80, perSeconds: 2 },
    errorMessagePaths: ['error', 'error_info'],
    pagination: { type: 'cursor', param: 'start', nextPath: 'additional_data.pagination.next_start' },
    test: { request: { method: 'GET', path: '/users/me' }, identity: '{{response.data.email}}' },
    actions: [
      {
        name: 'search_persons',
        title: 'Search people',
        description: 'Finds people by name, email or phone.',
        input: { type: 'object', properties: { term, limit }, required: ['term'] },
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/persons/search' },
        response: {
          root: 'data.items',
          fields: ['item.id', 'item.name', 'item.emails', 'item.phones', 'item.organization.name'],
        },
        pagination: true,
      },
      {
        name: 'search_organizations',
        title: 'Search organizations',
        description: 'Finds organizations by name or address.',
        input: { type: 'object', properties: { term, limit }, required: ['term'] },
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/organizations/search' },
        response: { root: 'data.items', fields: ['item.id', 'item.name', 'item.address'] },
        pagination: true,
      },
      {
        name: 'search_deals',
        title: 'Search deals',
        description: 'Finds deals by title.',
        input: {
          type: 'object',
          properties: { term, status: { type: 'string', enum: ['open', 'won', 'lost'] }, limit },
          required: ['term'],
        },
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/deals/search' },
        response: {
          root: 'data.items',
          fields: [
            'item.id',
            'item.title',
            'item.value',
            'item.currency',
            'item.status',
            'item.stage.name',
            'item.person.name',
            'item.organization.name',
          ],
        },
        pagination: true,
      },
      {
        name: 'list_deals',
        title: 'List deals',
        description: 'Lists deals by status, optionally of one stage.',
        input: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['open', 'won', 'lost', 'all_not_deleted'], default: 'open' },
            stage_id: { type: 'integer' },
            limit,
          },
        },
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/deals' },
        response: { root: 'data', fields: DEAL_FIELDS },
        pagination: true,
      },
      {
        name: 'list_stages',
        title: 'List stages',
        description: 'Pipeline stages with their ids, in order.',
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/stages' },
        response: { root: 'data', fields: ['id', 'name', 'pipeline_id', 'pipeline_name', 'order_nr'] },
      },
      {
        name: 'create_person',
        title: 'Create person',
        description: 'Adds a person, optionally linked to an organization.',
        input: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            email: { type: 'string', format: 'email' },
            phone: { type: 'string' },
            org_id: { type: 'integer', description: 'Organization id' },
          },
          required: ['name'],
        },
        hints: { readOnly: false, destructive: false },
        risk: 'write',
        request: { method: 'POST', path: '/persons' },
        response: { root: 'data', fields: ['id', 'name', 'email', 'phone', 'org_id'] },
      },
      {
        name: 'create_deal',
        title: 'Create deal',
        description: 'Creates a deal, optionally linked to a person and an organization.',
        input: {
          type: 'object',
          properties: {
            ...dealFields,
            person_id: { type: 'integer' },
            org_id: { type: 'integer' },
          },
          required: ['title'],
        },
        hints: { readOnly: false, destructive: false },
        risk: 'write',
        request: { method: 'POST', path: '/deals', body: dealBody(['person_id', 'org_id']) },
        response: { root: 'data', fields: DEAL_FIELDS },
      },
      {
        name: 'update_deal',
        title: 'Update deal',
        description: 'Changes a deal: moves it to another stage, marks it won or lost, changes its value.',
        input: {
          type: 'object',
          properties: {
            deal_id: { type: 'integer', minimum: 1 },
            ...dealFields,
            status: { type: 'string', enum: ['open', 'won', 'lost'] },
            lost_reason: { type: 'string' },
          },
          required: ['deal_id'],
        },
        hints: { readOnly: false, destructive: false, idempotent: true },
        risk: 'write',
        request: { method: 'PUT', path: '/deals/{deal_id}', body: dealBody(['status', 'lost_reason']) },
        response: { root: 'data', fields: DEAL_FIELDS },
      },
      {
        name: 'add_note',
        title: 'Add note',
        description: 'Adds a note to a deal, person or organization.',
        input: {
          type: 'object',
          properties: {
            content: { type: 'string', minLength: 1, description: 'Text; simple HTML allowed' },
            deal_id: { type: 'integer' },
            person_id: { type: 'integer' },
            org_id: { type: 'integer' },
          },
          required: ['content'],
        },
        hints: { readOnly: false, destructive: false },
        risk: 'write',
        request: { method: 'POST', path: '/notes' },
        response: { root: 'data', fields: ['id', 'deal_id', 'person_id', 'org_id', 'add_time'] },
      },
    ],
  },
  { actions: { search_persons: { capability: searchPersons } } },
);

const ui: ConnectorUi = {
  locales: {
    ru: {
      description: 'CRM Pipedrive: поиск людей, организаций и сделок, создание и перенос сделок, заметки.',
      setup: {
        form: {
          summary: 'Вы копируете свой личный токен API в Pipedrive и вставляете его сюда.',
          minutes: 1,
          needs: ['Аккаунт Pipedrive'],
          steps: [
            {
              text: 'В Pipedrive нажмите на аватар → **Personal preferences** → вкладка **API**.',
              link: {
                label: 'Открыть настройки API Pipedrive',
                url: 'https://app.pipedrive.com/settings/api',
              },
            },
            { text: 'Скопируйте **Your personal API token** кнопкой **Copy**.', fills: ['apiToken'] },
            { text: 'Вставьте токен в форму и нажмите **Подключить**.' },
          ],
          tips: ['Токен действует от вашего имени. Кнопка **Generate new token** отключает старый токен.'],
          problems: [
            {
              problem: 'Pipedrive отвечает «unauthorized access»',
              fix: 'Скопируйте токен ещё раз. Если его перевыпустили через **Generate new token**, вставьте новый через **Переподключить**.',
            },
            {
              problem: 'Нет вкладки **API**',
              fix: 'Администратор Pipedrive мог закрыть доступ к API. Попросите его отметить **Access their own API token** в вашем наборе прав (**Manage users → Permission sets**).',
            },
          ],
        },
      },
      prompts: [
        'Какие открытые сделки у меня в Pipedrive и на каких они этапах?',
        'Найди Анну Смит в Pipedrive и покажи её сделки.',
        'Переведи сделку «ACME — годовой контракт» на этап «Переговоры».',
        'Добавь к сделке ACME заметку о сегодняшнем звонке.',
      ],
      fields: { apiToken: { label: 'Токен API', hint: 'Personal preferences → API в Pipedrive.' } },
      actions: {
        search_persons: { title: 'Поиск людей', description: 'Находит людей по имени, почте или телефону.' },
        search_organizations: {
          title: 'Поиск организаций',
          description: 'Находит организации по названию или адресу.',
        },
        search_deals: { title: 'Поиск сделок', description: 'Находит сделки по названию.' },
        list_deals: { title: 'Список сделок', description: 'Сделки по статусу или этапу.' },
        list_stages: { title: 'Этапы воронки', description: 'Этапы с их идентификаторами.' },
        create_person: { title: 'Новый человек', description: 'Добавляет человека.' },
        create_deal: { title: 'Новая сделка', description: 'Создаёт сделку.' },
        update_deal: {
          title: 'Изменение сделки',
          description: 'Переносит на другой этап, отмечает выигранной или проигранной, меняет сумму.',
        },
        add_note: {
          title: 'Новая заметка',
          description: 'Добавляет заметку к сделке, человеку или организации.',
        },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'You copy your personal API token in Pipedrive and paste it here.',
          minutes: 1,
          needs: ['A Pipedrive account'],
          steps: [
            {
              text: 'In Pipedrive, click your avatar → **Personal preferences** → the **API** tab.',
              link: { label: 'Open Pipedrive API settings', url: 'https://app.pipedrive.com/settings/api' },
            },
            { text: 'Copy **Your personal API token** with **Copy**.', fills: ['apiToken'] },
            { text: 'Paste the token into the form and click **Connect**.' },
          ],
          tips: ['The token acts as you. **Generate new token** makes the old one stop working.'],
          problems: [
            {
              problem: 'Pipedrive answers “unauthorized access”',
              fix: 'Copy the token again. If someone clicked **Generate new token**, paste the new token with **Reconnect**.',
            },
            {
              problem: 'There is no **API** tab',
              fix: 'Your Pipedrive admin may have turned off API access. Ask them to tick **Access their own API token** in your permission set (**Manage users → Permission sets**).',
            },
          ],
        },
      },
      prompts: [
        'Which open deals do I have in Pipedrive, and at what stages?',
        'Find Anna Smith in Pipedrive and show her deals.',
        'Move the deal “ACME annual contract” to Negotiation.',
        'Add a note about today’s call to the ACME deal.',
      ],
      fields: { apiToken: { label: 'API token', hint: 'Personal preferences → API in Pipedrive.' } },
      actions: {
        search_persons: { title: 'Search people', description: 'Finds people by name, email or phone.' },
        search_organizations: {
          title: 'Search organizations',
          description: 'Finds organizations by name or address.',
        },
        search_deals: { title: 'Search deals', description: 'Finds deals by title.' },
        list_deals: { title: 'List deals', description: 'Deals by status or stage.' },
        list_stages: { title: 'Pipeline stages', description: 'Stages with their ids.' },
        create_person: { title: 'Create a person', description: 'Adds a person.' },
        create_deal: { title: 'Create a deal', description: 'Creates a deal.' },
        update_deal: {
          title: 'Update a deal',
          description: 'Moves a deal to another stage, marks it won or lost, or changes its value.',
        },
        add_note: { title: 'Add a note', description: 'Adds a note to a deal, person or organization.' },
      },
    },
  },
};

export default withUi(manifest, ui);
