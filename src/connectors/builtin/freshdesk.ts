import { defineManifestConnector } from '../manifest/compile.js';
import type { CapabilityBinding, CapabilityOutput } from '../sdk.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Freshdesk API v2 with an agent's API key (basic auth, the key as the user name). */

const ticketId = { type: 'integer', minimum: 1, description: 'Ticket number' };
const status = {
  type: 'integer',
  enum: [2, 3, 4, 5],
  description: '2 open, 3 pending, 4 resolved, 5 closed',
};
const priority = { type: 'integer', enum: [1, 2, 3, 4], description: '1 low, 2 medium, 3 high, 4 urgent' };
const TICKET_FIELDS = [
  'id',
  'subject',
  'status',
  'priority',
  'type',
  'requester_id',
  'responder_id',
  'group_id',
  'tags',
  'due_by',
  'created_at',
  'updated_at',
];

interface FreshdeskContact {
  id: number;
  name: string;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
}

const searchContacts: CapabilityBinding = {
  id: 'contacts.search',
  mapInput: ({ query }) => ({ query }),
  mapOutput: (result, input) =>
    (result as FreshdeskContact[])
      .slice(0, Number(input.limit ?? 20))
      .map((c): CapabilityOutput<'contacts.search'> => {
        const phones = [c.phone, c.mobile].filter((p): p is string => Boolean(p));
        return {
          id: String(c.id),
          name: c.name,
          ...(c.email ? { emails: [c.email] } : {}),
          ...(phones.length ? { phones } : {}),
        };
      }),
};

const manifest = defineManifestConnector(
  {
    id: 'freshdesk',
    name: 'Freshdesk',
    description: 'Freshdesk tickets and contacts: search, read conversations, reply, add notes, update.',
    version: '1.0.0',
    homepage: 'https://developers.freshdesk.com/api/',
    instructions:
      'freshdesk_search_tickets takes Freshdesk filter syntax: "status:2 AND priority:4", "tag:\'refund\'", "created_at:>\'2026-11-01\'". Status: 2 open, 3 pending, 4 resolved, 5 closed. Replies email the customer; notes are private by default.',
    baseUrl: 'https://{{config.domain}}.freshdesk.com/api/v2',
    config: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          pattern: '^[a-zA-Z0-9][a-zA-Z0-9-]*$',
          description: 'The part before .freshdesk.com, e.g. "acme"',
        },
      },
      required: ['domain'],
    },
    credentials: {
      type: 'object',
      properties: {
        apiKey: {
          type: 'string',
          minLength: 10,
          description: 'Profile settings → View API key',
        },
      },
      required: ['apiKey'],
    },
    auth: { type: 'basic', username: '{{credentials.apiKey}}', password: 'X' },
    rateLimit: { requests: 100, perSeconds: 60 },
    errorMessagePaths: ['errors.0.message', 'description', 'message'],
    pagination: { type: 'link' },
    test: { request: { method: 'GET', path: '/agents/me' }, identity: '{{response.contact.email}}' },
    actions: [
      {
        name: 'list_tickets',
        title: 'List tickets',
        description: 'Lists tickets of a built-in view, most recently updated first.',
        input: {
          type: 'object',
          properties: {
            filter: {
              type: 'string',
              enum: ['new_and_my_open', 'watching', 'spam', 'deleted'],
              default: 'new_and_my_open',
            },
            per_page: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
          },
        },
        hints: { readOnly: true, idempotent: true },
        request: {
          method: 'GET',
          path: '/tickets',
          query: { filter: '{{input.filter}}', per_page: '{{input.per_page}}', order_by: 'updated_at' },
        },
        response: { fields: TICKET_FIELDS },
        pagination: true,
      },
      {
        name: 'search_tickets',
        title: 'Search tickets',
        description: 'Finds tickets with Freshdesk filter syntax (30 per page, up to 10 pages).',
        input: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1, description: 'e.g. "status:2 AND priority:4"' },
          },
          required: ['query'],
        },
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/search/tickets', query: { query: '"{{input.query}}"' } },
        response: { root: 'results', fields: TICKET_FIELDS },
        pagination: { type: 'page', param: 'page', start: 1 },
      },
      {
        name: 'get_ticket',
        title: 'Get ticket',
        description: 'Returns a ticket with its first message as text.',
        input: { type: 'object', properties: { ticket_id: ticketId }, required: ['ticket_id'] },
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/tickets/{ticket_id}' },
        response: { fields: [...TICKET_FIELDS, 'description_text', 'source'] },
      },
      {
        name: 'list_conversations',
        title: 'List conversation',
        description: 'Lists replies and notes of a ticket, oldest first; private true marks internal notes.',
        input: { type: 'object', properties: { ticket_id: ticketId }, required: ['ticket_id'] },
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/tickets/{ticket_id}/conversations' },
        response: {
          fields: ['id', 'user_id', 'incoming', 'private', 'from_email', 'body_text', 'created_at'],
        },
        pagination: true,
      },
      {
        name: 'reply',
        title: 'Reply to customer',
        description: 'Sends a public reply on a ticket; Freshdesk emails it to the requester.',
        input: {
          type: 'object',
          properties: {
            ticket_id: ticketId,
            body: { type: 'string', minLength: 1, description: 'Text; simple HTML allowed' },
            cc_emails: { type: 'array', items: { type: 'string', format: 'email' } },
          },
          required: ['ticket_id', 'body'],
        },
        hints: { readOnly: false, destructive: false },
        risk: 'dangerous',
        request: { method: 'POST', path: '/tickets/{ticket_id}/reply' },
        response: { fields: ['id', 'ticket_id', 'created_at'] },
      },
      {
        name: 'add_note',
        title: 'Add note',
        description: 'Adds a note to a ticket; private (agents only) unless private is false.',
        input: {
          type: 'object',
          properties: {
            ticket_id: ticketId,
            body: { type: 'string', minLength: 1 },
            private: { type: 'boolean', default: true },
          },
          required: ['ticket_id', 'body'],
        },
        hints: { readOnly: false, destructive: false },
        risk: 'write',
        request: { method: 'POST', path: '/tickets/{ticket_id}/notes' },
        response: { fields: ['id', 'ticket_id', 'private', 'created_at'] },
      },
      {
        name: 'update_ticket',
        title: 'Update ticket',
        description: 'Changes status, priority, agent, group, type or tags of a ticket.',
        input: {
          type: 'object',
          properties: {
            ticket_id: ticketId,
            status,
            priority,
            type: { type: 'string', description: 'One of the ticket types set up in Freshdesk' },
            responder_id: { type: 'integer', description: 'Agent id' },
            group_id: { type: 'integer' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Replaces all tags' },
          },
          required: ['ticket_id'],
        },
        hints: { readOnly: false, destructive: false, idempotent: true },
        risk: 'write',
        request: { method: 'PUT', path: '/tickets/{ticket_id}' },
        response: { fields: TICKET_FIELDS },
      },
      {
        name: 'search_contacts',
        title: 'Search contacts',
        description: 'Finds customers by name, email or phone.',
        input: {
          type: 'object',
          properties: { query: { type: 'string', minLength: 2 } },
          required: ['query'],
        },
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/contacts/autocomplete', query: { term: '{{input.query}}' } },
        response: { fields: ['id', 'name', 'email', 'phone', 'mobile', 'company_id'] },
      },
    ],
  },
  { actions: { search_contacts: { capability: searchContacts } } },
);

const ui: ConnectorUi = {
  primaryFields: ['domain', 'apiKey'],
  locales: {
    ru: {
      description:
        'Тикеты и контакты Freshdesk: поиск, переписка, ответы клиентам, заметки, изменение тикетов.',
      setup: {
        form: {
          summary: 'Адрес Freshdesk и ваш ключ API. Около минуты.',
          steps: [
            {
              text: 'Войдите в Freshdesk, нажмите на аватар справа вверху и откройте Profile settings.',
              link: { label: 'Открыть Freshdesk', url: 'https://www.freshworks.com/freshdesk/login/' },
            },
            { text: 'Справа нажмите View API key, пройдите проверку и скопируйте ключ.' },
            { text: 'В форме укажите поддомен (из адреса acme.freshdesk.com — это acme) и ключ.' },
          ],
          tips: [
            'ИИ действует от вашего имени агента. Ответ клиенту уходит только после вашего подтверждения.',
            'Ключ меняется при смене пароля Freshdesk: тогда вставьте новый.',
          ],
        },
      },
      prompts: [
        'Какие новые и мои открытые тикеты в Freshdesk?',
        'Перескажи переписку по тикету 1207 и предложи ответ.',
        'Ответь клиенту в тикете 1207, что заказ отправлен, и отметь тикет решённым.',
        'Найди срочные открытые тикеты с тегом refund.',
      ],
      fields: {
        domain: {
          label: 'Поддомен Freshdesk',
          hint: 'Часть адреса до .freshdesk.com: для acme.freshdesk.com — acme.',
        },
        apiKey: { label: 'Ключ API', hint: 'Profile settings → View API key.' },
      },
      actions: {
        list_tickets: {
          title: 'Список тикетов',
          description: 'Новые и мои открытые или другое представление.',
        },
        search_tickets: { title: 'Поиск тикетов', description: 'Ищет тикеты по статусу, приоритету, тегам.' },
        get_ticket: { title: 'Тикет', description: 'Показывает тикет с первым сообщением.' },
        list_conversations: { title: 'Переписка', description: 'Ответы и заметки тикета по порядку.' },
        reply: { title: 'Ответ клиенту', description: 'Публичный ответ, Freshdesk отправит его письмом.' },
        add_note: { title: 'Заметка', description: 'Внутренняя заметка для агентов.' },
        update_ticket: {
          title: 'Изменение тикета',
          description: 'Меняет статус, приоритет, агента, группу, тип или теги.',
        },
        search_contacts: {
          title: 'Поиск контактов',
          description: 'Находит клиентов по имени, почте или телефону.',
        },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'Your Freshdesk address and your API key. Takes about a minute.',
          steps: [
            {
              text: 'Sign in to Freshdesk, click your avatar at the top right and open Profile settings.',
              link: { label: 'Open Freshdesk', url: 'https://www.freshworks.com/freshdesk/login/' },
            },
            { text: 'On the right, click View API key, pass the check and copy the key.' },
            { text: 'In the form, enter your subdomain (acme for acme.freshdesk.com) and the key.' },
          ],
          tips: [
            'The AI acts as you, the agent. Replies to customers go out only after you confirm.',
            'The key changes when you change your Freshdesk password: paste the new one then.',
          ],
        },
      },
      prompts: [
        'Which new and open Freshdesk tickets are mine?',
        'Summarize the conversation in ticket 1207 and suggest a reply.',
        'Reply in ticket 1207 that the order has shipped, and mark it resolved.',
        'Find urgent open tickets tagged refund.',
      ],
      fields: {
        domain: {
          label: 'Freshdesk subdomain',
          hint: 'The part before .freshdesk.com: for acme.freshdesk.com, acme.',
        },
        apiKey: { label: 'API key', hint: 'Profile settings → View API key.' },
      },
      actions: {
        list_tickets: { title: 'List tickets', description: 'New and my open tickets, or another view.' },
        search_tickets: {
          title: 'Search tickets',
          description: 'Finds tickets by status, priority or tags.',
        },
        get_ticket: { title: 'Get a ticket', description: 'Shows a ticket with its first message.' },
        list_conversations: { title: 'Conversation', description: 'Replies and notes of a ticket in order.' },
        reply: {
          title: 'Reply to customer',
          description: 'A public reply that Freshdesk emails to the customer.',
        },
        add_note: { title: 'Add a note', description: 'An internal note for agents.' },
        update_ticket: {
          title: 'Update a ticket',
          description: 'Changes status, priority, agent, group, type or tags.',
        },
        search_contacts: {
          title: 'Search contacts',
          description: 'Finds customers by name, email or phone.',
        },
      },
    },
  },
};

export default withUi(manifest, ui);
