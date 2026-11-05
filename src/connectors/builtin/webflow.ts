import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Webflow Data API v2 with a site API token: sites, CMS collections and items, form submissions. */

const siteId = { type: 'string', pattern: '^[0-9a-f]{24}$', description: 'Site id from webflow_list_sites' };
const collectionId = {
  type: 'string',
  pattern: '^[0-9a-f]{24}$',
  description: 'Collection id from webflow_list_collections',
};
const itemId = { type: 'string', pattern: '^[0-9a-f]{24}$' };
const fieldData = {
  type: 'object',
  additionalProperties: true,
  description: 'Field values by field slug (see webflow_get_collection), e.g. {"name":"…","slug":"…"}',
};
const ITEM_FIELDS = ['id', 'isDraft', 'isArchived', 'lastPublished', 'lastUpdated', 'fieldData'];

const manifest = defineManifestConnector({
  id: 'webflow',
  name: 'Webflow',
  description:
    'Webflow sites and CMS: read collections, draft, edit and publish items, read form submissions.',
  version: '1.0.0',
  homepage: 'https://developers.webflow.com/data/reference',
  instructions:
    'CMS items are created as drafts; webflow_publish_items puts them live. Field values are keyed by field slug from webflow_get_collection.',
  baseUrl: 'https://api.webflow.com/v2',
  credentials: {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        minLength: 30,
        description: 'Site settings → Apps & integrations → API access → Generate API token',
      },
    },
    required: ['token'],
  },
  auth: { type: 'bearer', token: '{{credentials.token}}' },
  rateLimit: { requests: 60, perSeconds: 60 },
  errorMessagePaths: ['message'],
  pagination: { type: 'offset', param: 'offset', limitParam: 'limit', defaultLimit: 50 },
  test: { request: { method: 'GET', path: '/sites' }, identity: '{{response.sites.0.displayName}}' },
  actions: [
    {
      name: 'list_sites',
      title: 'List sites',
      description: 'Sites the token can reach, with their ids and domains.',
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/sites' },
      response: {
        root: 'sites',
        fields: ['id', 'displayName', 'shortName', 'lastPublished', 'customDomains'],
      },
    },
    {
      name: 'list_collections',
      title: 'List collections',
      description: 'CMS collections of a site.',
      input: { type: 'object', properties: { site_id: siteId }, required: ['site_id'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/sites/{site_id}/collections' },
      response: { root: 'collections', fields: ['id', 'displayName', 'singularName', 'slug', 'lastUpdated'] },
    },
    {
      name: 'get_collection',
      title: 'Get collection',
      description: 'A collection’s fields: slugs, types and whether they are required.',
      input: { type: 'object', properties: { collection_id: collectionId }, required: ['collection_id'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/collections/{collection_id}' },
      response: { fields: ['id', 'displayName', 'slug', 'fields'] },
    },
    {
      name: 'list_items',
      title: 'List items',
      description: 'Items of a collection, newest first.',
      input: {
        type: 'object',
        properties: {
          collection_id: collectionId,
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
        required: ['collection_id'],
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/collections/{collection_id}/items',
        query: { limit: '{{input.limit}}', sortBy: 'createdOn', sortOrder: 'desc' },
      },
      response: { root: 'items', fields: ITEM_FIELDS },
      pagination: true,
    },
    {
      name: 'create_item',
      title: 'Create draft item',
      description: 'Creates a draft CMS item; it is not live until published.',
      input: {
        type: 'object',
        properties: { collection_id: collectionId, field_data: fieldData },
        required: ['collection_id', 'field_data'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: {
        method: 'POST',
        path: '/collections/{collection_id}/items',
        body: { isDraft: true, isArchived: false, fieldData: '{{input.field_data}}' },
      },
      response: { fields: ITEM_FIELDS },
    },
    {
      name: 'update_item',
      title: 'Update item',
      description: 'Changes fields of a CMS item (the staged version; publish to make it live).',
      input: {
        type: 'object',
        properties: { collection_id: collectionId, item_id: itemId, field_data: fieldData },
        required: ['collection_id', 'item_id', 'field_data'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: {
        method: 'PATCH',
        path: '/collections/{collection_id}/items/{item_id}',
        body: { fieldData: '{{input.field_data}}' },
      },
      response: { fields: ITEM_FIELDS },
    },
    {
      name: 'publish_items',
      title: 'Publish items',
      description: 'Puts CMS items live on the site.',
      input: {
        type: 'object',
        properties: {
          collection_id: collectionId,
          item_ids: { type: 'array', items: itemId, minItems: 1, maxItems: 100 },
        },
        required: ['collection_id', 'item_ids'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'dangerous',
      request: {
        method: 'POST',
        path: '/collections/{collection_id}/items/publish',
        body: { itemIds: '{{input.item_ids}}' },
      },
      response: { fields: ['publishedItemIds', 'errors'] },
    },
    {
      name: 'list_form_submissions',
      title: 'Form submissions',
      description: 'Submissions of the site’s forms, newest first.',
      input: {
        type: 'object',
        properties: { site_id: siteId, limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
        required: ['site_id'],
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/sites/{site_id}/form_submissions',
        query: { limit: '{{input.limit}}' },
      },
      response: { root: 'formSubmissions', fields: ['id', 'displayName', 'dateSubmitted', 'formResponse'] },
      pagination: true,
    },
  ],
});

const ui: ConnectorUi = {
  locales: {
    ru: {
      description: 'Сайты и CMS Webflow: коллекции, черновики, правка и публикация записей, заявки из форм.',
      setup: {
        form: {
          summary: 'Вы создаёте токен API в настройках сайта Webflow и вставляете его сюда.',
          minutes: 2,
          needs: ['Сайт в Webflow, в котором вы можете менять настройки'],
          steps: [
            {
              text: 'Откройте сайт в Webflow → **Site settings → Apps & integrations** и прокрутите вниз до **API access**.',
              link: { label: 'Открыть Webflow', url: 'https://webflow.com/dashboard' },
            },
            {
              text: 'Нажмите **Generate API token**, назовите токен Manyplug и разрешите **CMS** (чтение и запись), **Sites** (чтение и запись) и **Forms** (чтение).',
            },
            {
              text: 'Нажмите **Generate token** и скопируйте его: Webflow показывает токен только один раз.',
              fills: ['token'],
            },
          ],
          tips: [
            'Токен работает только для этого сайта. Для другого сайта подключите ещё один аккаунт.',
            'ИИ публикует записи только после вашего подтверждения.',
          ],
          problems: [
            {
              problem: 'ИИ не может менять записи CMS',
              fix: 'У токена нет записи в **CMS**. Создайте новый токен с этим правом и вставьте его через **Переподключить**.',
            },
            {
              problem: 'ИИ не видит мой другой сайт',
              fix: 'Токен работает только для одного сайта. Подключите каждый сайт отдельным аккаунтом со своим токеном.',
            },
          ],
        },
      },
      prompts: [
        'Какие статьи в блоге на Webflow ещё в черновиках?',
        'Создай черновик статьи «Итоги ноября» в коллекции Blog Posts.',
        'Покажи заявки из формы на сайте за неделю.',
      ],
      fields: { token: { label: 'API-токен', hint: 'Site settings → Apps & integrations → API access.' } },
      actions: {
        list_sites: { title: 'Сайты', description: 'Сайты с id и доменами.' },
        list_collections: { title: 'Коллекции', description: 'Коллекции CMS сайта.' },
        get_collection: { title: 'Коллекция', description: 'Поля коллекции.' },
        list_items: { title: 'Записи', description: 'Записи коллекции, сначала новые.' },
        create_item: { title: 'Новый черновик', description: 'Создаёт запись-черновик.' },
        update_item: { title: 'Правка записи', description: 'Меняет поля записи.' },
        publish_items: { title: 'Публикация', description: 'Публикует записи на сайте.' },
        list_form_submissions: { title: 'Заявки', description: 'Заявки из форм сайта.' },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'You generate an API token in your Webflow site settings and paste it here.',
          minutes: 2,
          needs: ['A Webflow site where you can change the site settings'],
          steps: [
            {
              text: 'Open the site in Webflow → **Site settings → Apps & integrations** and scroll down to **API access**.',
              link: { label: 'Open Webflow', url: 'https://webflow.com/dashboard' },
            },
            {
              text: 'Click **Generate API token**, name it Manyplug and allow **CMS** (read and write), **Sites** (read and write) and **Forms** (read).',
            },
            { text: 'Click **Generate token** and copy it: Webflow shows it only once.', fills: ['token'] },
          ],
          tips: [
            'The token works for this one site. Connect another account for another site.',
            'The AI publishes items only after you confirm.',
          ],
          problems: [
            {
              problem: 'The AI cannot change CMS items',
              fix: 'The token lacks write access to **CMS**. Generate a new token with it and paste it with **Reconnect**.',
            },
            {
              problem: 'The AI does not see my other site',
              fix: 'A token works for one site only. Connect each site as its own account with its own token.',
            },
          ],
        },
      },
      prompts: [
        'Which blog posts on Webflow are still drafts?',
        'Create a draft post “November recap” in the Blog Posts collection.',
        'Show this week’s form submissions from the site.',
      ],
      fields: { token: { label: 'API token', hint: 'Site settings → Apps & integrations → API access.' } },
      actions: {
        list_sites: { title: 'Sites', description: 'Sites with ids and domains.' },
        list_collections: { title: 'Collections', description: 'CMS collections of a site.' },
        get_collection: { title: 'Get a collection', description: 'Fields of a collection.' },
        list_items: { title: 'Items', description: 'Items of a collection, newest first.' },
        create_item: { title: 'New draft', description: 'Creates a draft item.' },
        update_item: { title: 'Edit an item', description: 'Changes fields of an item.' },
        publish_items: { title: 'Publish', description: 'Puts items live on the site.' },
        list_form_submissions: { title: 'Form submissions', description: 'Submissions of the site’s forms.' },
      },
    },
  },
};

export default withUi(manifest, ui);
