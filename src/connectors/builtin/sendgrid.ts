import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Twilio SendGrid v3 with an API key: send email, marketing contacts and lists, templates, stats. */

const email = { type: 'string', format: 'email' };
const recipients = {
  type: 'array',
  minItems: 1,
  maxItems: 50,
  items: { type: 'object', properties: { email, name: { type: 'string' } }, required: ['email'] },
};

const manifest = defineManifestConnector({
  id: 'sendgrid',
  name: 'SendGrid',
  description:
    'SendGrid email: send messages and templated emails, marketing contacts and lists, delivery stats.',
  version: '1.0.0',
  homepage: 'https://www.twilio.com/docs/sendgrid/api-reference',
  instructions:
    "Emails go out from a sender verified in SendGrid. sendgrid_search_contacts takes SGQL, e.g. email LIKE '%@acme.com'. Contact changes are applied asynchronously.",
  baseUrl: 'https://{{config.host}}/v3',
  config: {
    type: 'object',
    properties: {
      host: {
        type: 'string',
        enum: ['api.sendgrid.com', 'api.eu.sendgrid.com'],
        default: 'api.sendgrid.com',
        description: 'api.eu.sendgrid.com for EU regional subusers',
      },
    },
  },
  credentials: {
    type: 'object',
    properties: {
      apiKey: { type: 'string', pattern: '^SG\\.', description: 'Settings → API Keys' },
    },
    required: ['apiKey'],
  },
  auth: { type: 'bearer', token: '{{credentials.apiKey}}' },
  rateLimit: { requests: 10, perSeconds: 1 },
  errorMessagePaths: ['errors.0.message'],
  test: { request: { method: 'GET', path: '/scopes' } },
  actions: [
    {
      name: 'send_email',
      title: 'Send email',
      description: 'Sends an HTML email from a verified sender.',
      input: {
        type: 'object',
        properties: {
          from_email: { ...email, description: 'Verified sender address' },
          from_name: { type: 'string' },
          to: recipients,
          subject: { type: 'string', minLength: 1 },
          html: { type: 'string', minLength: 1 },
        },
        required: ['from_email', 'to', 'subject', 'html'],
      },
      hints: { readOnly: false, destructive: false, openWorld: true },
      risk: 'dangerous',
      request: {
        method: 'POST',
        path: '/mail/send',
        body: {
          personalizations: [{ to: '{{input.to}}' }],
          from: { email: '{{input.from_email}}', name: '{{input.from_name}}' },
          subject: '{{input.subject}}',
          content: [{ type: 'text/html', value: '{{input.html}}' }],
        },
      },
      response: { empty: 'Accepted for delivery.' },
    },
    {
      name: 'send_template',
      title: 'Send template',
      description: 'Sends a dynamic template email with its variables.',
      input: {
        type: 'object',
        properties: {
          template_id: {
            type: 'string',
            pattern: '^d-[0-9a-f]+$',
            description: 'From sendgrid_list_templates',
          },
          from_email: { ...email, description: 'Verified sender address' },
          to: recipients,
          data: { type: 'object', additionalProperties: true, description: 'Template variables' },
        },
        required: ['template_id', 'from_email', 'to'],
      },
      hints: { readOnly: false, destructive: false, openWorld: true },
      risk: 'dangerous',
      request: {
        method: 'POST',
        path: '/mail/send',
        body: {
          personalizations: [{ to: '{{input.to}}', dynamic_template_data: '{{input.data}}' }],
          from: { email: '{{input.from_email}}' },
          template_id: '{{input.template_id}}',
        },
      },
      response: { empty: 'Accepted for delivery.' },
    },
    {
      name: 'list_templates',
      title: 'List templates',
      description: 'Dynamic templates with their ids and active version.',
      input: {
        type: 'object',
        properties: { page_size: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/templates',
        query: { generations: 'dynamic', page_size: '{{input.page_size}}' },
      },
      response: { root: 'result', fields: ['id', 'name', 'updated_at', 'versions'] },
    },
    {
      name: 'search_contacts',
      title: 'Search contacts',
      description: 'Finds marketing contacts with an SGQL query (up to 50).',
      input: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1, description: "e.g. email LIKE '%@acme.com'" } },
        required: ['query'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'POST', path: '/marketing/contacts/search', body: { query: '{{input.query}}' } },
      response: {
        root: 'result',
        fields: ['id', 'email', 'first_name', 'last_name', 'list_ids', 'updated_at'],
      },
    },
    {
      name: 'add_contacts',
      title: 'Add contacts',
      description: 'Adds or updates marketing contacts, optionally into lists.',
      input: {
        type: 'object',
        properties: {
          contacts: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: {
              type: 'object',
              properties: { email, first_name: { type: 'string' }, last_name: { type: 'string' } },
              required: ['email'],
            },
          },
          list_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['contacts'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: { method: 'PUT', path: '/marketing/contacts' },
      response: { fields: ['job_id'] },
    },
    {
      name: 'list_lists',
      title: 'List lists',
      description: 'Marketing lists with their ids and contact counts.',
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/marketing/lists', query: { page_size: '100' } },
      response: { root: 'result', fields: ['id', 'name', 'contact_count'] },
    },
    {
      name: 'get_stats',
      title: 'Delivery stats',
      description: 'Daily delivery, open, click, bounce and spam report counts.',
      input: {
        type: 'object',
        properties: {
          start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' },
          end_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          aggregated_by: { type: 'string', enum: ['day', 'week', 'month'], default: 'day' },
        },
        required: ['start_date'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/stats' },
      response: { fields: ['date', 'stats'] },
    },
  ],
});

const ui: ConnectorUi = {
  locales: {
    ru: {
      description: 'Почта SendGrid: отправка писем и шаблонов, контакты и списки, статистика доставки.',
      setup: {
        form: {
          summary: 'Вы создаёте ключ API в SendGrid и вставляете его сюда.',
          minutes: 3,
          needs: [
            'Аккаунт Twilio SendGrid',
            'Подтверждённый отправитель или домен в SendGrid, чтобы отправлять письма',
          ],
          steps: [
            {
              text: 'Откройте SendGrid → **Settings** → **API Keys** и нажмите **Create API Key**.',
              link: { label: 'Открыть ключи SendGrid', url: 'https://app.sendgrid.com/settings/api_keys' },
            },
            {
              text: 'Назовите ключ Manyplug, выберите **Restricted Access** и дайте доступ к Mail Send, Marketing, Stats и Template Engine (чтение). Или выберите **Full Access**.',
            },
            {
              text: 'Нажмите **Create & View** и скопируйте ключ (SG.…): SendGrid показывает его только один раз.',
              fills: ['apiKey'],
            },
          ],
          tips: [
            'Письма уходят только с подтверждённого отправителя и только после вашего подтверждения.',
            'Для субаккаунта в регионе ЕС выберите в поле «Сервер» **ЕС (api.eu.sendgrid.com)**.',
          ],
          problems: [
            {
              problem: '«The provided authorization grant is invalid, expired, or revoked»',
              fix: 'Ключ скопирован не целиком или удалён. Создайте новый ключ и вставьте его через **Переподключить**.',
            },
            {
              problem: '«The from address does not match a verified Sender Identity»',
              fix: 'Подтвердите адрес отправителя или домен: **Settings** → **Sender Authentication**.',
            },
            {
              problem: 'Часть действий падает с «access forbidden»',
              fix: 'У ключа нет нужного доступа. В **API Keys** откройте ключ через **•••** → **Edit API Key** и добавьте доступ.',
            },
          ],
        },
      },
      prompts: [
        'Сколько писем доставлено и открыто через SendGrid за неделю?',
        'Отправь шаблон «Добро пожаловать» на ben@acme.com с именем Бен.',
        'Добавь этих троих в список «Бета» в SendGrid.',
      ],
      fields: {
        apiKey: { label: 'Ключ API', hint: 'Settings → API Keys.' },
        host: {
          label: 'Сервер',
          hint: 'api.eu.sendgrid.com — для субаккаунтов в ЕС.',
          options: {
            'api.sendgrid.com': 'Основной (api.sendgrid.com)',
            'api.eu.sendgrid.com': 'ЕС (api.eu.sendgrid.com)',
          },
        },
      },
      actions: {
        send_email: { title: 'Письмо', description: 'Отправляет письмо.' },
        send_template: { title: 'Письмо по шаблону', description: 'Отправляет письмо по шаблону.' },
        list_templates: { title: 'Шаблоны', description: 'Динамические шаблоны.' },
        search_contacts: { title: 'Поиск контактов', description: 'Ищет контакты по SGQL.' },
        add_contacts: { title: 'Контакты', description: 'Добавляет или обновляет контакты.' },
        list_lists: { title: 'Списки', description: 'Списки контактов.' },
        get_stats: { title: 'Статистика', description: 'Доставка, открытия, клики, отказы.' },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'You create an API key in SendGrid and paste it here.',
          minutes: 3,
          needs: ['A Twilio SendGrid account', 'A verified sender or domain in SendGrid, to send email'],
          steps: [
            {
              text: 'Open SendGrid → **Settings** → **API Keys** and click **Create API Key**.',
              link: { label: 'Open SendGrid API keys', url: 'https://app.sendgrid.com/settings/api_keys' },
            },
            {
              text: 'Name it Manyplug, pick **Restricted Access** and allow Mail Send, Marketing, Stats and Template Engine (read). Or pick **Full Access**.',
            },
            {
              text: 'Click **Create & View** and copy the key (SG.…): SendGrid shows it only once.',
              fills: ['apiKey'],
            },
          ],
          tips: [
            'Emails go out only from a verified sender and only after you confirm.',
            'For an EU regional subuser, pick **EU (api.eu.sendgrid.com)** under Server.',
          ],
          problems: [
            {
              problem: '“The provided authorization grant is invalid, expired, or revoked”',
              fix: 'The key was not copied whole, or it was deleted. Create a new key and paste it with **Reconnect**.',
            },
            {
              problem: '“The from address does not match a verified Sender Identity”',
              fix: 'Verify the sender address or domain: **Settings** → **Sender Authentication**.',
            },
            {
              problem: 'Some actions fail with “access forbidden”',
              fix: 'The key lacks that access. In **API Keys**, open the key with **•••** → **Edit API Key** and add it.',
            },
          ],
        },
      },
      prompts: [
        'How many emails were delivered and opened through SendGrid this week?',
        'Send the “Welcome” template to ben@acme.com with the name Ben.',
        'Add these three people to the Beta list in SendGrid.',
      ],
      fields: {
        apiKey: { label: 'API key', hint: 'Settings → API Keys.' },
        host: {
          label: 'Server',
          hint: 'api.eu.sendgrid.com for EU regional subusers.',
          options: {
            'api.sendgrid.com': 'Global (api.sendgrid.com)',
            'api.eu.sendgrid.com': 'EU (api.eu.sendgrid.com)',
          },
        },
      },
      actions: {
        send_email: { title: 'Send an email', description: 'Sends an email.' },
        send_template: { title: 'Send a template', description: 'Sends a templated email.' },
        list_templates: { title: 'Templates', description: 'Dynamic templates.' },
        search_contacts: { title: 'Search contacts', description: 'Finds contacts with SGQL.' },
        add_contacts: { title: 'Add contacts', description: 'Adds or updates contacts.' },
        list_lists: { title: 'Lists', description: 'Contact lists.' },
        get_stats: { title: 'Stats', description: 'Deliveries, opens, clicks, bounces.' },
      },
    },
  },
};

export default withUi(manifest, ui);
