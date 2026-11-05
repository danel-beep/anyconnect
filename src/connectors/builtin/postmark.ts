import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Postmark with a server API token: transactional email, templates, outbound activity, stats. */

const recipients = {
  type: 'string',
  minLength: 3,
  description: 'One address or several separated by commas, e.g. "Ann <ann@acme.com>, ben@acme.com"',
};
const sender = {
  type: 'string',
  minLength: 3,
  description: 'A confirmed sender signature or an address on a verified domain',
};
const stream = {
  type: 'string',
  default: 'outbound',
  description: 'Message stream id; "outbound" is the default transactional stream',
};
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' };
const sent = ['To', 'SubmittedAt', 'MessageID', 'ErrorCode', 'Message'];

const manifest = defineManifestConnector({
  id: 'postmark',
  name: 'Postmark',
  description:
    'Postmark transactional email: send messages and templates, look up sent messages and delivery stats.',
  version: '1.0.0',
  homepage: 'https://postmarkapp.com/developer',
  instructions:
    'The token belongs to one Postmark server: templates and messages are that server’s. Emails go out only from confirmed senders.',
  baseUrl: 'https://api.postmarkapp.com',
  credentials: {
    type: 'object',
    properties: {
      token: { type: 'string', minLength: 20, description: 'Server → API Tokens' },
    },
    required: ['token'],
  },
  auth: { type: 'api_key', in: 'header', name: 'X-Postmark-Server-Token', value: '{{credentials.token}}' },
  rateLimit: { requests: 10, perSeconds: 1 },
  errorMessagePaths: ['Message'],
  pagination: { type: 'offset', param: 'offset', limitParam: 'count', defaultLimit: 50 },
  test: { request: { method: 'GET', path: '/server' }, identity: '{{response.Name}}' },
  actions: [
    {
      name: 'send_email',
      title: 'Send email',
      description: 'Sends an email with an HTML and/or plain-text body.',
      input: {
        type: 'object',
        properties: {
          from: sender,
          to: recipients,
          cc: recipients,
          subject: { type: 'string', minLength: 1 },
          html: { type: 'string', description: 'HTML body' },
          text: { type: 'string', description: 'Plain-text body' },
          reply_to: { type: 'string' },
          tag: { type: 'string', maxLength: 1000 },
          stream,
        },
        required: ['from', 'to', 'subject'],
      },
      hints: { readOnly: false, destructive: false, openWorld: true },
      risk: 'dangerous',
      request: {
        method: 'POST',
        path: '/email',
        body: {
          From: '{{input.from}}',
          To: '{{input.to}}',
          Cc: '{{input.cc}}',
          Subject: '{{input.subject}}',
          HtmlBody: '{{input.html}}',
          TextBody: '{{input.text}}',
          ReplyTo: '{{input.reply_to}}',
          Tag: '{{input.tag}}',
          MessageStream: '{{input.stream}}',
        },
      },
      response: { fields: sent },
    },
    {
      name: 'send_template',
      title: 'Send template',
      description: 'Sends an email from a server template with its variables.',
      input: {
        type: 'object',
        properties: {
          template_id: { type: 'integer', minimum: 1, description: 'From postmark_list_templates' },
          from: sender,
          to: recipients,
          model: { type: 'object', additionalProperties: true, description: 'Template variables' },
          tag: { type: 'string', maxLength: 1000 },
          stream,
        },
        required: ['template_id', 'from', 'to'],
      },
      hints: { readOnly: false, destructive: false, openWorld: true },
      risk: 'dangerous',
      request: {
        method: 'POST',
        path: '/email/withTemplate',
        body: {
          TemplateId: '{{input.template_id}}',
          TemplateModel: '{{input.model}}',
          From: '{{input.from}}',
          To: '{{input.to}}',
          Tag: '{{input.tag}}',
          MessageStream: '{{input.stream}}',
        },
      },
      response: { fields: sent },
    },
    {
      name: 'list_templates',
      title: 'List templates',
      description: 'The server’s templates with their ids and aliases.',
      input: {
        type: 'object',
        properties: { count: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/templates',
        query: { count: '{{input.count}}', offset: 0, TemplateType: 'Standard' },
      },
      response: { root: 'Templates', fields: ['TemplateId', 'Name', 'Alias', 'Active'] },
      pagination: true,
    },
    {
      name: 'search_messages',
      title: 'Search sent messages',
      description: 'Sent messages, newest first, by recipient, tag, status or date.',
      input: {
        type: 'object',
        properties: {
          recipient: { type: 'string' },
          tag: { type: 'string' },
          status: { type: 'string', enum: ['queued', 'sent', 'processed'] },
          from_date: date,
          to_date: date,
          count: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/messages/outbound',
        query: {
          count: '{{input.count}}',
          offset: 0,
          recipient: '{{input.recipient}}',
          tag: '{{input.tag}}',
          status: '{{input.status}}',
          fromdate: '{{input.from_date}}',
          todate: '{{input.to_date}}',
        },
      },
      response: {
        root: 'Messages',
        fields: ['MessageID', 'To', 'Subject', 'Status', 'Tag', 'ReceivedAt', 'MessageStream'],
      },
      pagination: true,
    },
    {
      name: 'get_message',
      title: 'Get message',
      description: 'One sent message with its delivery, open and click events.',
      input: {
        type: 'object',
        properties: { message_id: { type: 'string', minLength: 1, description: 'MessageID' } },
        required: ['message_id'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/messages/outbound/{message_id}/details' },
      response: { fields: ['MessageID', 'From', 'To', 'Subject', 'Status', 'ReceivedAt', 'MessageEvents'] },
    },
    {
      name: 'get_stats',
      title: 'Delivery stats',
      description: 'Sent, bounced, spam complaint, open and click totals for a period.',
      input: {
        type: 'object',
        properties: { from_date: date, to_date: date, tag: { type: 'string' }, stream },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/stats/outbound',
        query: {
          fromdate: '{{input.from_date}}',
          todate: '{{input.to_date}}',
          tag: '{{input.tag}}',
          messagestream: '{{input.stream}}',
        },
      },
      response: {
        fields: [
          'Sent',
          'Bounced',
          'BounceRate',
          'SpamComplaints',
          'SpamComplaintsRate',
          'Opens',
          'UniqueOpens',
          'TotalClicks',
          'UniqueLinksClicked',
        ],
      },
    },
  ],
});

const ui: ConnectorUi = {
  locales: {
    ru: {
      description:
        'Транзакционная почта Postmark: письма и шаблоны, отправленные письма, статистика доставки.',
      setup: {
        form: {
          summary: 'Токен сервера Postmark. Около минуты.',
          steps: [
            {
              text: 'Откройте Postmark → Servers, выберите сервер и вкладку API Tokens.',
              link: { label: 'Открыть серверы Postmark', url: 'https://account.postmarkapp.com/servers' },
            },
            { text: 'Скопируйте Server API token (или нажмите Generate another token).' },
            { text: 'Вставьте токен в форму. Для другого сервера подключите ещё один аккаунт.' },
          ],
          tips: [
            'Письма уходят только с подтверждённых отправителей и только после вашего подтверждения.',
            'Токен видит лишь свой сервер, а не весь аккаунт Postmark.',
          ],
        },
      },
      prompts: [
        'Сколько писем отправлено и сколько вернулось через Postmark за неделю?',
        'Дошло ли письмо со сбросом пароля до ben@acme.com?',
        'Отправь шаблон «Счёт готов» на ann@acme.com с суммой $120.',
      ],
      fields: { token: { label: 'Токен сервера', hint: 'Servers → сервер → API Tokens.' } },
      actions: {
        send_email: { title: 'Письмо', description: 'Отправляет письмо.' },
        send_template: { title: 'Письмо по шаблону', description: 'Отправляет письмо по шаблону.' },
        list_templates: { title: 'Шаблоны', description: 'Шаблоны сервера.' },
        search_messages: { title: 'Отправленные', description: 'Ищет отправленные письма.' },
        get_message: { title: 'Письмо', description: 'Письмо и события доставки.' },
        get_stats: { title: 'Статистика', description: 'Отправки, отказы, открытия, клики.' },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'Your Postmark server token. Takes about a minute.',
          steps: [
            {
              text: 'Open Postmark → Servers, pick the server and open its API Tokens tab.',
              link: { label: 'Open Postmark servers', url: 'https://account.postmarkapp.com/servers' },
            },
            { text: 'Copy the Server API token (or click Generate another token).' },
            { text: 'Paste the token into the form. Connect another account for another server.' },
          ],
          tips: [
            'Emails go out only from confirmed senders and only after you confirm.',
            'The token sees only its own server, not your whole Postmark account.',
          ],
        },
      },
      prompts: [
        'How many emails did Postmark send and bounce this week?',
        'Did the password reset email reach ben@acme.com?',
        'Send the “Invoice ready” template to ann@acme.com with the amount $120.',
      ],
      fields: { token: { label: 'Server token', hint: 'Servers → your server → API Tokens.' } },
      actions: {
        send_email: { title: 'Send an email', description: 'Sends an email.' },
        send_template: { title: 'Send a template', description: 'Sends a templated email.' },
        list_templates: { title: 'Templates', description: 'The server’s templates.' },
        search_messages: { title: 'Sent messages', description: 'Finds sent emails.' },
        get_message: { title: 'Message', description: 'An email and its delivery events.' },
        get_stats: { title: 'Stats', description: 'Sends, bounces, opens, clicks.' },
      },
    },
  },
};

export default withUi(manifest, ui);
