import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Twilio Programmable Messaging with the account SID and auth token: SMS, numbers, call log. */

const phone = { type: 'string', pattern: '^\\+[1-9]\\d{6,14}$', description: 'E.164, e.g. +14155550123' };
const pageSize = { type: 'integer', minimum: 1, maximum: 100, default: 20 };

const manifest = defineManifestConnector({
  id: 'twilio',
  name: 'Twilio',
  description: 'Twilio SMS: send text messages, read sent and received messages, phone numbers, call log.',
  version: '1.0.0',
  homepage: 'https://www.twilio.com/docs/usage/api',
  instructions:
    'Messages go out from one of the account’s numbers (twilio_list_numbers). Phone numbers are in E.164 format, e.g. +14155550123.',
  baseUrl: 'https://api.twilio.com/2010-04-01/Accounts/{{config.accountSid}}',
  config: {
    type: 'object',
    properties: {
      accountSid: { type: 'string', pattern: '^AC[0-9a-f]{32}$', description: 'Console → Account Info' },
    },
    required: ['accountSid'],
  },
  credentials: {
    type: 'object',
    properties: {
      authToken: { type: 'string', minLength: 32, description: 'Console → Account Info → Auth Token' },
    },
    required: ['authToken'],
  },
  auth: { type: 'basic', username: '{{config.accountSid}}', password: '{{credentials.authToken}}' },
  rateLimit: { requests: 20, perSeconds: 1 },
  errorMessagePaths: ['message'],
  pagination: { type: 'next_url', nextPath: 'next_page_uri' },
  test: { request: { method: 'GET', path: '/IncomingPhoneNumbers.json', query: { PageSize: 1 } } },
  actions: [
    {
      name: 'send_sms',
      title: 'Send SMS',
      description: 'Sends a text message from one of your Twilio numbers.',
      input: {
        type: 'object',
        properties: {
          to: phone,
          from: { ...phone, description: 'Your Twilio number, from twilio_list_numbers' },
          body: { type: 'string', minLength: 1, maxLength: 1600 },
        },
        required: ['to', 'from', 'body'],
      },
      hints: { readOnly: false, destructive: false, openWorld: true },
      risk: 'dangerous',
      request: {
        method: 'POST',
        path: '/Messages.json',
        bodyType: 'form',
        body: { To: '{{input.to}}', From: '{{input.from}}', Body: '{{input.body}}' },
      },
      response: { fields: ['sid', 'status', 'to', 'from', 'date_created'] },
    },
    {
      name: 'list_messages',
      title: 'List messages',
      description: 'Sent and received messages, newest first, optionally to or from a number or on a day.',
      input: {
        type: 'object',
        properties: {
          to: phone,
          from: phone,
          date_sent: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' },
          page_size: pageSize,
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/Messages.json',
        query: {
          To: '{{input.to}}',
          From: '{{input.from}}',
          DateSent: '{{input.date_sent}}',
          PageSize: '{{input.page_size}}',
        },
      },
      response: {
        root: 'messages',
        fields: ['sid', 'from', 'to', 'body', 'status', 'direction', 'date_sent', 'error_message'],
      },
      pagination: true,
    },
    {
      name: 'get_message',
      title: 'Get message',
      description: 'One message with its delivery status and price.',
      input: {
        type: 'object',
        properties: { sid: { type: 'string', pattern: '^(SM|MM)[0-9a-f]{32}$' } },
        required: ['sid'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/Messages/{sid}.json' },
      response: {
        fields: [
          'sid',
          'from',
          'to',
          'body',
          'status',
          'direction',
          'date_sent',
          'num_segments',
          'price',
          'price_unit',
          'error_code',
          'error_message',
        ],
      },
    },
    {
      name: 'list_numbers',
      title: 'List numbers',
      description: 'Phone numbers on the account and what they can do (SMS, MMS, voice).',
      input: { type: 'object', properties: { page_size: pageSize } },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/IncomingPhoneNumbers.json',
        query: { PageSize: '{{input.page_size}}' },
      },
      response: {
        root: 'incoming_phone_numbers',
        fields: ['sid', 'phone_number', 'friendly_name', 'capabilities'],
      },
      pagination: true,
    },
    {
      name: 'list_calls',
      title: 'List calls',
      description: 'The call log, newest first, optionally to or from a number.',
      input: { type: 'object', properties: { to: phone, from: phone, page_size: pageSize } },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/Calls.json',
        query: { To: '{{input.to}}', From: '{{input.from}}', PageSize: '{{input.page_size}}' },
      },
      response: {
        root: 'calls',
        fields: ['sid', 'from', 'to', 'status', 'direction', 'start_time', 'duration'],
      },
      pagination: true,
    },
  ],
});

const ui: ConnectorUi = {
  locales: {
    ru: {
      description: 'SMS через Twilio: отправка, входящие и отправленные сообщения, номера, журнал звонков.',
      setup: {
        form: {
          summary: 'Account SID и Auth Token из консоли Twilio. Около минуты.',
          steps: [
            {
              text: 'Откройте консоль Twilio: на главной странице, в блоке Account Info, есть Account SID и Auth Token.',
              link: { label: 'Открыть консоль Twilio', url: 'https://console.twilio.com/' },
            },
            { text: 'Скопируйте Account SID (AC…) и вставьте в первое поле.' },
            { text: 'Нажмите Show у Auth Token, скопируйте его и вставьте во второе поле.' },
          ],
          tips: [
            'SMS уходят только с номеров вашего аккаунта и только после вашего подтверждения.',
            'На пробном аккаунте Twilio отправляет SMS лишь на подтверждённые номера.',
          ],
        },
      },
      prompts: [
        'Какие SMS пришли на мой номер Twilio сегодня?',
        'Отправь клиенту +14155550123 SMS: «Курьер будет в 15:00».',
        'Дошло ли последнее SMS на +14155550123?',
      ],
      fields: {
        accountSid: { label: 'Account SID', hint: 'Начинается с AC, блок Account Info.' },
        authToken: { label: 'Auth Token', hint: 'Account Info → Auth Token → Show.' },
      },
      actions: {
        send_sms: { title: 'SMS', description: 'Отправляет SMS.' },
        list_messages: { title: 'Сообщения', description: 'Входящие и отправленные SMS.' },
        get_message: { title: 'Сообщение', description: 'Статус доставки SMS.' },
        list_numbers: { title: 'Номера', description: 'Номера аккаунта.' },
        list_calls: { title: 'Звонки', description: 'Журнал звонков.' },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'Your Account SID and Auth Token from the Twilio Console. Takes about a minute.',
          steps: [
            {
              text: 'Open the Twilio Console: the Account Info box on the home page shows the Account SID and Auth Token.',
              link: { label: 'Open the Twilio Console', url: 'https://console.twilio.com/' },
            },
            { text: 'Copy the Account SID (AC…) into the first field.' },
            { text: 'Click Show next to Auth Token, copy it and paste it into the second field.' },
          ],
          tips: [
            'Messages go out only from your account’s numbers and only after you confirm.',
            'A Twilio trial account can only text verified numbers.',
          ],
        },
      },
      prompts: [
        'Which texts came in to my Twilio number today?',
        'Text +14155550123: “The courier arrives at 3 pm.”',
        'Was the last text to +14155550123 delivered?',
      ],
      fields: {
        accountSid: { label: 'Account SID', hint: 'Starts with AC, in Account Info.' },
        authToken: { label: 'Auth Token', hint: 'Account Info → Auth Token → Show.' },
      },
      actions: {
        send_sms: { title: 'Send a text', description: 'Sends an SMS.' },
        list_messages: { title: 'Messages', description: 'Sent and received texts.' },
        get_message: { title: 'Message', description: 'Delivery status of a text.' },
        list_numbers: { title: 'Numbers', description: 'Numbers on the account.' },
        list_calls: { title: 'Calls', description: 'The call log.' },
      },
    },
  },
};

export default withUi(manifest, ui);
