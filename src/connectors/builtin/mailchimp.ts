import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Mailchimp Marketing API v3 with an API key (basic auth; the data center is the key's suffix). */

const listId = {
  type: 'string',
  pattern: '^[a-z0-9]+$',
  description: 'Audience id from mailchimp_list_audiences',
};
const email = { type: 'string', format: 'email' };
const count = { type: 'integer', minimum: 1, maximum: 1000, default: 20 };
const MEMBER_FIELDS = [
  'id',
  'email_address',
  'full_name',
  'status',
  'list_id',
  'tags',
  'member_rating',
  'last_changed',
];

const manifest = defineManifestConnector({
  id: 'mailchimp',
  name: 'Mailchimp',
  description: 'Mailchimp audiences, subscribers, tags and campaign reports.',
  version: '1.0.0',
  homepage: 'https://mailchimp.com/developer/marketing/api/',
  instructions:
    'Members are addressed by email within an audience. New subscribers get status "pending" (a confirmation email) unless they already agreed to receive mail.',
  baseUrl: 'https://{{config.dc}}.api.mailchimp.com/3.0',
  config: {
    type: 'object',
    properties: {
      dc: {
        type: 'string',
        pattern: '^[a-z]{2}[0-9]{1,3}$',
        description: 'Data center: the end of the API key after the dash, e.g. "us21"',
      },
    },
    required: ['dc'],
  },
  credentials: {
    type: 'object',
    properties: {
      apiKey: {
        type: 'string',
        pattern: '^[0-9a-f]{32}-[a-z]{2}[0-9]{1,3}$',
        description: 'Profile → Extras → API keys',
      },
    },
    required: ['apiKey'],
  },
  auth: { type: 'basic', username: 'manyplug', password: '{{credentials.apiKey}}' },
  rateLimit: { requests: 10, perSeconds: 1 },
  errorMessagePaths: ['detail', 'title'],
  pagination: { type: 'offset', param: 'offset', limitParam: 'count', defaultLimit: 20 },
  test: {
    request: { method: 'GET', path: '/', query: { fields: 'account_name,email' } },
    identity: '{{response.email}}',
  },
  actions: [
    {
      name: 'list_audiences',
      title: 'List audiences',
      description: 'Audiences (lists) with their ids and subscriber counts.',
      input: { type: 'object', properties: { count } },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/lists' },
      response: {
        root: 'lists',
        fields: [
          'id',
          'name',
          'stats.member_count',
          'stats.unsubscribe_count',
          'stats.open_rate',
          'date_created',
        ],
      },
      pagination: true,
    },
    {
      name: 'search_members',
      title: 'Search subscribers',
      description: 'Finds subscribers by email or name across audiences.',
      input: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1 }, list_id: listId },
        required: ['query'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/search-members' },
      response: { root: 'full_search.members', fields: MEMBER_FIELDS },
    },
    {
      name: 'get_member',
      title: 'Get subscriber',
      description: 'Returns one subscriber of an audience with merge fields, tags and stats.',
      input: {
        type: 'object',
        properties: { list_id: listId, email },
        required: ['list_id', 'email'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/lists/{list_id}/members/{email}' },
      response: { fields: [...MEMBER_FIELDS, 'merge_fields', 'stats', 'location.country_code'] },
    },
    {
      name: 'add_member',
      title: 'Add subscriber',
      description: 'Adds or updates a subscriber; "pending" sends a confirmation email first.',
      input: {
        type: 'object',
        properties: {
          list_id: listId,
          email,
          status: { type: 'string', enum: ['pending', 'subscribed'], default: 'pending' },
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['list_id', 'email'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: {
        method: 'PUT',
        path: '/lists/{list_id}/members/{email}',
        body: {
          email_address: '{{input.email}}',
          status_if_new: '{{input.status}}',
          merge_fields: { FNAME: '{{input.first_name}}', LNAME: '{{input.last_name}}' },
          tags: '{{input.tags}}',
        },
      },
      response: { fields: MEMBER_FIELDS },
    },
    {
      name: 'unsubscribe_member',
      title: 'Unsubscribe',
      description: 'Unsubscribes a member from an audience (they stay in it as unsubscribed).',
      input: { type: 'object', properties: { list_id: listId, email }, required: ['list_id', 'email'] },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: {
        method: 'PATCH',
        path: '/lists/{list_id}/members/{email}',
        body: { status: 'unsubscribed' },
      },
      response: { fields: MEMBER_FIELDS },
    },
    {
      name: 'tag_member',
      title: 'Tag subscriber',
      description: 'Adds tags to a subscriber and removes others.',
      input: {
        type: 'object',
        properties: {
          list_id: listId,
          email,
          tags: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', minLength: 1 },
                status: {
                  type: 'string',
                  enum: ['active', 'inactive'],
                  description: 'inactive removes the tag',
                },
              },
              required: ['name', 'status'],
            },
          },
        },
        required: ['list_id', 'email', 'tags'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: {
        method: 'POST',
        path: '/lists/{list_id}/members/{email}/tags',
        body: { tags: '{{input.tags}}' },
      },
      response: { empty: 'Tags updated.' },
    },
    {
      name: 'list_campaigns',
      title: 'List campaigns',
      description: 'Campaigns, most recently sent first, with subject, audience and send time.',
      input: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['save', 'paused', 'schedule', 'sending', 'sent'] },
          count,
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/campaigns',
        query: {
          status: '{{input.status}}',
          count: '{{input.count}}',
          sort_field: 'send_time',
          sort_dir: 'DESC',
        },
      },
      response: {
        root: 'campaigns',
        fields: [
          'id',
          'status',
          'send_time',
          'emails_sent',
          'settings.subject_line',
          'settings.title',
          'recipients.list_name',
        ],
      },
      pagination: true,
    },
    {
      name: 'get_campaign_report',
      title: 'Campaign report',
      description: 'Opens, clicks, bounces and unsubscribes of a sent campaign.',
      input: {
        type: 'object',
        properties: { campaign_id: { type: 'string', pattern: '^[a-z0-9]+$' } },
        required: ['campaign_id'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/reports/{campaign_id}' },
      response: {
        fields: [
          'id',
          'campaign_title',
          'subject_line',
          'send_time',
          'emails_sent',
          'unsubscribed',
          'bounces',
          'opens.unique_opens',
          'opens.open_rate',
          'clicks.unique_subscriber_clicks',
          'clicks.click_rate',
        ],
      },
    },
  ],
});

const ui: ConnectorUi = {
  primaryFields: ['apiKey', 'dc'],
  locales: {
    ru: {
      description: 'Аудитории и подписчики Mailchimp, теги и отчёты по рассылкам.',
      setup: {
        form: {
          summary: 'Вы создаёте ключ API в Mailchimp и вставляете его сюда вместе с дата-центром.',
          minutes: 2,
          needs: ['Аккаунт Mailchimp с ролью Manager, Admin или Owner'],
          steps: [
            {
              text: 'В Mailchimp нажмите на аватар → **Profile** → **Extras** → **API keys**.',
              link: {
                label: 'Открыть ключи API Mailchimp',
                url: 'https://us1.admin.mailchimp.com/account/api/',
              },
            },
            { text: 'Нажмите **Create A Key**, назовите ключ Manyplug и нажмите **Generate Key**.' },
            { text: 'Скопируйте ключ: Mailchimp показывает его только один раз.', fills: ['apiKey'] },
            {
              text: 'В поле «Дата-центр» впишите окончание ключа после дефиса. Для ключа …-us21 это us21.',
              fills: ['dc'],
            },
          ],
          tips: [
            'Ключ даёт полный доступ к аккаунту. Отозвать его можно на той же странице.',
            'Новые подписчики сначала получают письмо с подтверждением, если вы не скажете ИИ иное.',
          ],
          problems: [
            {
              problem: '«API Key Invalid» или ключ не принимается',
              fix: 'Скопируйте ключ целиком, вместе с окончанием после дефиса. Если ключ потерян, создайте новый на той же странице.',
            },
            {
              problem: 'Ошибка «Resource Not Found» при проверке',
              fix: 'Дата-центр не совпадает с ключом. Впишите ровно то, что стоит после дефиса в конце ключа, например us21.',
            },
            {
              problem: 'В **Extras** нет пункта **API keys**',
              fix: 'Ваша роль не даёт создавать ключи. Попросите владельца аккаунта выдать вам роль Manager или выше либо создать ключ самому.',
            },
          ],
        },
      },
      prompts: [
        'Как прошла последняя рассылка в Mailchimp: открытия и клики?',
        'Есть ли anna@acme.com среди подписчиков? С какими тегами?',
        'Добавь подписчика ben@acme.com в аудиторию «Новости» с тегом webinar.',
        'Отпиши ann@acme.com от рассылки.',
      ],
      fields: {
        apiKey: { label: 'Ключ API', hint: 'Profile → Extras → API keys.' },
        dc: { label: 'Дата-центр', hint: 'Окончание ключа после дефиса, например us21.' },
      },
      actions: {
        list_audiences: { title: 'Аудитории', description: 'Аудитории с числом подписчиков.' },
        search_members: { title: 'Поиск подписчиков', description: 'Ищет по почте или имени.' },
        get_member: { title: 'Подписчик', description: 'Данные, теги и статистика подписчика.' },
        add_member: { title: 'Новый подписчик', description: 'Добавляет или обновляет подписчика.' },
        unsubscribe_member: { title: 'Отписка', description: 'Отписывает от аудитории.' },
        tag_member: { title: 'Теги', description: 'Добавляет и снимает теги.' },
        list_campaigns: { title: 'Рассылки', description: 'Рассылки, сначала последние.' },
        get_campaign_report: { title: 'Отчёт', description: 'Открытия, клики, отписки рассылки.' },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'You create an API key in Mailchimp and paste it here together with its data center.',
          minutes: 2,
          needs: ['A Mailchimp account where you are a Manager, Admin or Owner'],
          steps: [
            {
              text: 'In Mailchimp, click your avatar → **Profile** → **Extras** → **API keys**.',
              link: { label: 'Open Mailchimp API keys', url: 'https://us1.admin.mailchimp.com/account/api/' },
            },
            { text: 'Click **Create A Key**, name it Manyplug and click **Generate Key**.' },
            { text: 'Copy the key: Mailchimp shows it only once.', fills: ['apiKey'] },
            {
              text: 'In Data center, type the end of the key after the dash. For a key ending in -us21 that is us21.',
              fills: ['dc'],
            },
          ],
          tips: [
            'The key gives full access to the account. You can revoke it on the same page.',
            'New subscribers get a confirmation email first unless you tell the AI otherwise.',
          ],
          problems: [
            {
              problem: '“API Key Invalid”, or the key is not accepted',
              fix: 'Copy the whole key, including the part after the dash. If the key is lost, create a new one on the same page.',
            },
            {
              problem: '“Resource Not Found” during the check',
              fix: 'The data center does not match the key. Type exactly what follows the last dash of the key, for example us21.',
            },
            {
              problem: 'There is no **API keys** item under **Extras**',
              fix: 'Your role cannot create keys. Ask the account owner for the Manager role or higher, or to create the key.',
            },
          ],
        },
      },
      prompts: [
        'How did the last Mailchimp campaign do: opens and clicks?',
        'Is anna@acme.com a subscriber? With which tags?',
        'Add ben@acme.com to the “Newsletter” audience with the webinar tag.',
        'Unsubscribe ann@acme.com from the newsletter.',
      ],
      fields: {
        apiKey: { label: 'API key', hint: 'Profile → Extras → API keys.' },
        dc: { label: 'Data center', hint: 'The end of the key after the dash, e.g. us21.' },
      },
      actions: {
        list_audiences: { title: 'Audiences', description: 'Audiences with subscriber counts.' },
        search_members: { title: 'Search subscribers', description: 'Finds by email or name.' },
        get_member: { title: 'Get a subscriber', description: 'Details, tags and stats of a subscriber.' },
        add_member: { title: 'Add a subscriber', description: 'Adds or updates a subscriber.' },
        unsubscribe_member: { title: 'Unsubscribe', description: 'Unsubscribes from an audience.' },
        tag_member: { title: 'Tags', description: 'Adds and removes tags.' },
        list_campaigns: { title: 'Campaigns', description: 'Campaigns, latest first.' },
        get_campaign_report: { title: 'Campaign report', description: 'Opens, clicks and unsubscribes.' },
      },
    },
  },
};

export default withUi(manifest, ui);
