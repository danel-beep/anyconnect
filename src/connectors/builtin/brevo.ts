import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Brevo (formerly Sendinblue) API v3 with an API key: contacts, lists, campaigns, transactional email. */

const email = { type: 'string', format: 'email' };
const limit = { type: 'integer', minimum: 1, maximum: 50, default: 20 };
const CONTACT_FIELDS = ['id', 'email', 'attributes', 'listIds', 'emailBlacklisted', 'modifiedAt'];

const manifest = defineManifestConnector({
  id: 'brevo',
  name: 'Brevo',
  description: 'Brevo contacts, lists and email campaigns; send one-off transactional emails.',
  version: '1.0.0',
  homepage: 'https://developers.brevo.com/reference',
  instructions:
    'Contact attributes are upper-case names such as FIRSTNAME, LASTNAME, SMS. brevo_send_email needs a sender address verified in Brevo.',
  baseUrl: 'https://api.brevo.com/v3',
  credentials: {
    type: 'object',
    properties: {
      apiKey: { type: 'string', pattern: '^xkeysib-', description: 'SMTP & API → API keys' },
    },
    required: ['apiKey'],
  },
  auth: { type: 'api_key', in: 'header', name: 'api-key', value: '{{credentials.apiKey}}' },
  rateLimit: { requests: 10, perSeconds: 1 },
  errorMessagePaths: ['message'],
  pagination: { type: 'offset', param: 'offset', limitParam: 'limit', defaultLimit: 20 },
  test: { request: { method: 'GET', path: '/account' }, identity: '{{response.email}}' },
  actions: [
    {
      name: 'get_contact',
      title: 'Get contact',
      description: 'Returns a contact by email with attributes, lists and email statistics.',
      input: { type: 'object', properties: { email }, required: ['email'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/contacts/{email}' },
      response: {
        fields: [...CONTACT_FIELDS, 'statistics.messagesSent', 'statistics.opened', 'statistics.clicked'],
      },
    },
    {
      name: 'list_contacts',
      title: 'List contacts',
      description: 'Contacts, most recently changed first, optionally changed since a date.',
      input: {
        type: 'object',
        properties: { modified_since: { type: 'string', description: 'ISO date-time' }, limit },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/contacts',
        query: { modifiedSince: '{{input.modified_since}}', limit: '{{input.limit}}', sort: 'desc' },
      },
      response: { root: 'contacts', fields: CONTACT_FIELDS },
      pagination: true,
    },
    {
      name: 'save_contact',
      title: 'Add or update contact',
      description: 'Creates a contact or updates it when the email exists, optionally adding it to lists.',
      input: {
        type: 'object',
        properties: {
          email,
          attributes: {
            type: 'object',
            additionalProperties: true,
            description: 'e.g. {"FIRSTNAME":"Ann","LASTNAME":"Smith"}',
          },
          list_ids: { type: 'array', items: { type: 'integer' } },
        },
        required: ['email'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: {
        method: 'POST',
        path: '/contacts',
        body: {
          email: '{{input.email}}',
          attributes: '{{input.attributes}}',
          listIds: '{{input.list_ids}}',
          updateEnabled: true,
        },
      },
      response: { empty: 'Contact updated.', fields: ['id'] },
    },
    {
      name: 'list_lists',
      title: 'List lists',
      description: 'Contact lists with their ids and subscriber counts.',
      input: { type: 'object', properties: { limit } },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/contacts/lists', query: { limit: '{{input.limit}}', sort: 'desc' } },
      response: { root: 'lists', fields: ['id', 'name', 'uniqueSubscribers', 'folderId'] },
      pagination: true,
    },
    {
      name: 'list_campaigns',
      title: 'List campaigns',
      description: 'Email campaigns by status with their subject, send date and statistics.',
      input: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['draft', 'sent', 'queued', 'suspended', 'inProcess', 'archive'] },
          limit,
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/emailCampaigns',
        query: {
          status: '{{input.status}}',
          limit: '{{input.limit}}',
          sort: 'desc',
          statistics: 'globalStats',
        },
      },
      response: {
        root: 'campaigns',
        fields: ['id', 'name', 'subject', 'status', 'sentDate', 'statistics.globalStats'],
      },
      pagination: true,
    },
    {
      name: 'send_email',
      title: 'Send email',
      description: 'Sends a one-off transactional email from a verified sender.',
      input: {
        type: 'object',
        properties: {
          from_email: { ...email, description: 'Verified sender address' },
          from_name: { type: 'string' },
          to: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: {
              type: 'object',
              properties: { email, name: { type: 'string' } },
              required: ['email'],
            },
          },
          subject: { type: 'string', minLength: 1 },
          html: { type: 'string', minLength: 1, description: 'HTML body' },
        },
        required: ['from_email', 'to', 'subject', 'html'],
      },
      hints: { readOnly: false, destructive: false, openWorld: true },
      risk: 'dangerous',
      request: {
        method: 'POST',
        path: '/smtp/email',
        body: {
          sender: { email: '{{input.from_email}}', name: '{{input.from_name}}' },
          to: '{{input.to}}',
          subject: '{{input.subject}}',
          htmlContent: '{{input.html}}',
        },
      },
      response: { fields: ['messageId'] },
    },
  ],
});

const ui: ConnectorUi = {
  locales: {
    ru: {
      description: 'Контакты, списки и рассылки Brevo; отправка отдельных транзакционных писем.',
      setup: {
        form: {
          summary: 'Вы создаёте API-ключ в Brevo и вставляете его сюда.',
          minutes: 2,
          needs: [
            'Аккаунт Brevo',
            'Подтверждённый адрес отправителя в Brevo, если ИИ будет отправлять письма',
          ],
          steps: [
            {
              text: 'В Brevo откройте меню профиля → **SMTP & API** → вкладку **API keys**.',
              link: { label: 'Открыть API-ключи Brevo', url: 'https://app.brevo.com/settings/keys/api' },
            },
            { text: 'Нажмите **Generate a new API key**, назовите ключ Manyplug и нажмите **Generate**.' },
            {
              text: 'Скопируйте ключ (начинается с xkeysib-). Brevo показывает его только один раз.',
              fills: ['apiKey'],
            },
          ],
          tips: [
            'Письма ИИ отправляет только после вашего подтверждения.',
            'Удалить ключ можно на той же странице в любой момент.',
          ],
          problems: [
            {
              problem: 'Форма пишет, что ключ не подходит',
              fix: 'Проверьте, что скопирован API-ключ (xkeysib-…), а не SMTP-ключ (xsmtpsib-…). При необходимости создайте новый.',
            },
            {
              problem: 'Brevo блокирует запрос с незнакомого IP-адреса',
              fix: 'В Brevo откройте **Security → Authorized IPs** и отключите ограничение по IP для API-ключей: запросы идут из облака, а не с вашего компьютера.',
            },
            {
              problem: 'ИИ не может отправить письмо',
              fix: 'Отправляйте с адреса, подтверждённого в Brevo в разделе **Senders, Domains & Dedicated IPs**.',
            },
          ],
        },
      },
      prompts: [
        'Как прошла последняя рассылка в Brevo?',
        'Добавь ann@acme.com в список «Клиенты» с именем Анна.',
        'Есть ли ben@acme.com среди контактов и открывал ли он письма?',
      ],
      fields: { apiKey: { label: 'Ключ API', hint: 'SMTP & API → API keys.' } },
      actions: {
        get_contact: { title: 'Контакт', description: 'Контакт по почте со статистикой.' },
        list_contacts: { title: 'Контакты', description: 'Контакты, сначала изменённые недавно.' },
        save_contact: { title: 'Сохранить контакт', description: 'Создаёт или обновляет контакт.' },
        list_lists: { title: 'Списки', description: 'Списки контактов.' },
        list_campaigns: { title: 'Рассылки', description: 'Рассылки и их статистика.' },
        send_email: { title: 'Отправить письмо', description: 'Отдельное письмо с подтверждённого адреса.' },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'You create an API key in Brevo and paste it here.',
          minutes: 2,
          needs: ['A Brevo account', 'A verified sender address in Brevo, if the AI should send emails'],
          steps: [
            {
              text: 'In Brevo, open the profile menu → **SMTP & API** → the **API keys** tab.',
              link: { label: 'Open Brevo API keys', url: 'https://app.brevo.com/settings/keys/api' },
            },
            { text: 'Click **Generate a new API key**, name it Manyplug and click **Generate**.' },
            { text: 'Copy the key (it starts with xkeysib-). Brevo shows it only once.', fills: ['apiKey'] },
          ],
          tips: [
            'The AI sends emails only after you confirm.',
            'You can delete the key on the same page at any time.',
          ],
          problems: [
            {
              problem: 'The form says the key is not valid',
              fix: 'Check that you copied an API key (xkeysib-…), not an SMTP key (xsmtpsib-…). Generate a new one if needed.',
            },
            {
              problem: 'Brevo blocks the call from an unrecognised IP address',
              fix: 'In Brevo, open **Security → Authorized IPs** and turn off the IP restriction for API keys: calls come from the cloud, not from your computer.',
            },
            {
              problem: 'The AI cannot send an email',
              fix: 'Send from an address that is verified in Brevo under **Senders, Domains & Dedicated IPs**.',
            },
          ],
        },
      },
      prompts: [
        'How did the last Brevo campaign do?',
        'Add ann@acme.com to the Customers list with the first name Ann.',
        'Is ben@acme.com a contact, and has he opened our emails?',
      ],
      fields: { apiKey: { label: 'API key', hint: 'SMTP & API → API keys.' } },
      actions: {
        get_contact: { title: 'Get a contact', description: 'A contact by email with stats.' },
        list_contacts: { title: 'Contacts', description: 'Contacts, recently changed first.' },
        save_contact: { title: 'Save a contact', description: 'Creates or updates a contact.' },
        list_lists: { title: 'Lists', description: 'Contact lists.' },
        list_campaigns: { title: 'Campaigns', description: 'Campaigns and their statistics.' },
        send_email: { title: 'Send an email', description: 'A one-off email from a verified sender.' },
      },
    },
  },
};

export default withUi(manifest, ui);
