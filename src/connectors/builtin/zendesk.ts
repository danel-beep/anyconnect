import { defineManifestConnector } from '../manifest/compile.js';
import type { CapabilityBinding, CapabilityOutput } from '../sdk.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Zendesk Support API with an agent's email and API token. */

const ticketId = { type: 'integer', minimum: 1, description: 'Ticket number' };
const TICKET_FIELDS = [
  'id',
  'subject',
  'status',
  'priority',
  'type',
  'requester_id',
  'assignee_id',
  'tags',
  'created_at',
  'updated_at',
];

interface ZendeskUser {
  id: number;
  name: string;
  email?: string | null;
  phone?: string | null;
}

const searchUsers: CapabilityBinding = {
  id: 'contacts.search',
  mapInput: ({ query }) => ({ query }),
  mapOutput: (result, input) =>
    (result as ZendeskUser[]).slice(0, Number(input.limit ?? 20)).map(
      (u): CapabilityOutput<'contacts.search'> => ({
        id: String(u.id),
        name: u.name,
        ...(u.email ? { emails: [u.email] } : {}),
        ...(u.phone ? { phones: [u.phone] } : {}),
      }),
    ),
};

const manifest = defineManifestConnector(
  {
    id: 'zendesk',
    name: 'Zendesk',
    description: 'Zendesk Support tickets and users: search, read conversations, reply, add notes, update.',
    version: '1.0.0',
    homepage: 'https://developer.zendesk.com/api-reference/',
    instructions:
      'zendesk_search_tickets takes Zendesk search syntax: "status<solved assignee:me", "requester:ann@acme.com", "tags:refund created>7days". Public replies email the customer; internal notes do not.',
    baseUrl: 'https://{{config.subdomain}}.zendesk.com/api/v2',
    config: {
      type: 'object',
      properties: {
        subdomain: {
          type: 'string',
          pattern: '^[a-zA-Z0-9][a-zA-Z0-9-]*$',
          description: 'The part before .zendesk.com, e.g. "acme"',
        },
        email: { type: 'string', format: 'email', description: 'Your Zendesk agent email' },
      },
      required: ['subdomain', 'email'],
    },
    credentials: {
      type: 'object',
      properties: {
        apiToken: {
          type: 'string',
          minLength: 10,
          description: 'Admin Center → Apps and integrations → Zendesk API',
        },
      },
      required: ['apiToken'],
    },
    auth: { type: 'basic', username: '{{config.email}}/token', password: '{{credentials.apiToken}}' },
    rateLimit: { requests: 200, perSeconds: 60 },
    errorMessagePaths: ['description', 'error.message', 'error.title', 'error'],
    pagination: { type: 'next_url', nextPath: 'next_page' },
    test: { request: { method: 'GET', path: '/users/me.json' }, identity: '{{response.user.email}}' },
    actions: [
      {
        name: 'search_tickets',
        title: 'Search tickets',
        description: 'Finds tickets with Zendesk search syntax, newest first.',
        input: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1, description: 'e.g. "status<solved assignee:me"' },
            per_page: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          },
          required: ['query'],
        },
        hints: { readOnly: true, idempotent: true },
        request: {
          method: 'GET',
          path: '/search.json',
          query: {
            query: 'type:ticket {{input.query}}',
            sort_by: 'created_at',
            sort_order: 'desc',
            per_page: '{{input.per_page}}',
          },
        },
        response: { root: 'results', fields: TICKET_FIELDS },
        pagination: true,
      },
      {
        name: 'get_ticket',
        title: 'Get ticket',
        description: 'Returns a ticket with its first message.',
        input: { type: 'object', properties: { ticket_id: ticketId }, required: ['ticket_id'] },
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/tickets/{ticket_id}.json' },
        response: { root: 'ticket', fields: [...TICKET_FIELDS, 'description', 'via.channel'] },
      },
      {
        name: 'list_comments',
        title: 'List conversation',
        description: 'Lists the messages of a ticket, oldest first; public false marks internal notes.',
        input: { type: 'object', properties: { ticket_id: ticketId }, required: ['ticket_id'] },
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/tickets/{ticket_id}/comments.json' },
        response: { root: 'comments', fields: ['id', 'author_id', 'public', 'plain_body', 'created_at'] },
        pagination: true,
      },
      {
        name: 'reply',
        title: 'Reply to customer',
        description: 'Adds a public reply to a ticket; Zendesk emails it to the requester.',
        input: {
          type: 'object',
          properties: {
            ticket_id: ticketId,
            body: { type: 'string', minLength: 1 },
            status: {
              type: 'string',
              enum: ['open', 'pending', 'on-hold', 'solved'],
              description: 'Set at the same time',
            },
          },
          required: ['ticket_id', 'body'],
        },
        hints: { readOnly: false, destructive: false },
        risk: 'dangerous',
        request: {
          method: 'PUT',
          path: '/tickets/{ticket_id}.json',
          body: { ticket: { comment: { body: '{{input.body}}', public: true }, status: '{{input.status}}' } },
        },
        response: { root: 'ticket', fields: ['id', 'status', 'updated_at'] },
      },
      {
        name: 'add_note',
        title: 'Add internal note',
        description: 'Adds an internal note to a ticket (visible to agents only).',
        input: {
          type: 'object',
          properties: { ticket_id: ticketId, body: { type: 'string', minLength: 1 } },
          required: ['ticket_id', 'body'],
        },
        hints: { readOnly: false, destructive: false },
        risk: 'write',
        request: {
          method: 'PUT',
          path: '/tickets/{ticket_id}.json',
          body: { ticket: { comment: { body: '{{input.body}}', public: false } } },
        },
        response: { root: 'ticket', fields: ['id', 'status', 'updated_at'] },
      },
      {
        name: 'update_ticket',
        title: 'Update ticket',
        description: 'Changes status, priority, assignee, type or tags of a ticket.',
        input: {
          type: 'object',
          properties: {
            ticket_id: ticketId,
            status: { type: 'string', enum: ['open', 'pending', 'on-hold', 'solved', 'closed'] },
            priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
            type: { type: 'string', enum: ['problem', 'incident', 'question', 'task'] },
            assignee_id: { type: 'integer', description: 'Agent user id' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Replaces all tags' },
          },
          required: ['ticket_id'],
        },
        hints: { readOnly: false, destructive: false, idempotent: true },
        risk: 'write',
        request: {
          method: 'PUT',
          path: '/tickets/{ticket_id}.json',
          body: {
            ticket: {
              status: '{{input.status}}',
              priority: '{{input.priority}}',
              type: '{{input.type}}',
              assignee_id: '{{input.assignee_id}}',
              tags: '{{input.tags}}',
            },
          },
        },
        response: { root: 'ticket', fields: TICKET_FIELDS },
      },
      {
        name: 'search_users',
        title: 'Search users',
        description: 'Finds customers and agents by name, email or phone.',
        input: {
          type: 'object',
          properties: { query: { type: 'string', minLength: 1 } },
          required: ['query'],
        },
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/users/search.json' },
        response: { root: 'users', fields: ['id', 'name', 'email', 'phone', 'role', 'organization_id'] },
      },
    ],
  },
  { actions: { search_users: { capability: searchUsers } } },
);

const ui: ConnectorUi = {
  primaryFields: ['subdomain', 'email', 'apiToken'],
  locales: {
    ru: {
      description:
        'Тикеты и пользователи Zendesk Support: поиск, переписка, ответы клиентам, заметки, изменение тикетов.',
      setup: {
        form: {
          summary: 'Адрес Zendesk, почта агента и токен API. Около двух минут, нужен доступ администратора.',
          steps: [
            {
              text: 'Откройте Admin Center → Apps and integrations → APIs → API tokens (раньше — Zendesk API).',
              link: {
                label: 'Открыть Zendesk',
                url: 'https://www.zendesk.com/login/',
              },
            },
            { text: 'Включите доступ по токену (Token access), если он выключен, и нажмите Add API token.' },
            { text: 'Назовите токен Manyplug, скопируйте его и нажмите Save.' },
            {
              text: 'В форме укажите поддомен (из адреса acme.zendesk.com — это acme), свою почту агента и токен.',
            },
          ],
          tips: [
            'ИИ действует от имени агента с этой почтой. Ответ клиенту уходит только после вашего подтверждения.',
            'Удалить токен можно на той же странице Admin Center.',
          ],
        },
      },
      prompts: [
        'Какие открытые тикеты на мне в Zendesk?',
        'Перескажи переписку по тикету 4821 и предложи ответ.',
        'Ответь клиенту в тикете 4821, что возврат оформлен, и отметь тикет решённым.',
        'Добавь внутреннюю заметку к 4810: «Ждём ответ от склада».',
      ],
      fields: {
        subdomain: {
          label: 'Поддомен Zendesk',
          hint: 'Часть адреса до .zendesk.com: для acme.zendesk.com — acme.',
        },
        email: { label: 'Почта агента', hint: 'С которой вы входите в Zendesk.' },
        apiToken: { label: 'Токен API', hint: 'Admin Center → Apps and integrations → APIs → API tokens.' },
      },
      actions: {
        search_tickets: { title: 'Поиск тикетов', description: 'Ищет тикеты, сначала новые.' },
        get_ticket: { title: 'Тикет', description: 'Показывает тикет с первым сообщением.' },
        list_comments: {
          title: 'Переписка',
          description: 'Сообщения тикета по порядку, включая внутренние заметки.',
        },
        reply: {
          title: 'Ответ клиенту',
          description: 'Публичный ответ, Zendesk отправит его клиенту письмом.',
        },
        add_note: { title: 'Внутренняя заметка', description: 'Заметка, которую видят только агенты.' },
        update_ticket: {
          title: 'Изменение тикета',
          description: 'Меняет статус, приоритет, исполнителя, тип или теги.',
        },
        search_users: {
          title: 'Поиск пользователей',
          description: 'Находит клиентов и агентов по имени, почте или телефону.',
        },
      },
    },
    en: {
      setup: {
        form: {
          summary:
            'Your Zendesk address, agent email and an API token. Takes about two minutes and needs admin access.',
          steps: [
            {
              text: 'Open Admin Center → Apps and integrations → APIs → API tokens (formerly Zendesk API).',
              link: { label: 'Open Zendesk', url: 'https://www.zendesk.com/login/' },
            },
            { text: 'Turn on Token access if it is off, then click Add API token.' },
            { text: 'Name it Manyplug, copy the token and click Save.' },
            {
              text: 'In the form, enter your subdomain (acme for acme.zendesk.com), your agent email and the token.',
            },
          ],
          tips: [
            'The AI acts as the agent with this email. Replies to customers go out only after you confirm.',
            'You can delete the token on the same Admin Center page.',
          ],
        },
      },
      prompts: [
        'Which open Zendesk tickets are assigned to me?',
        'Summarize the conversation in ticket 4821 and suggest a reply.',
        'Reply in ticket 4821 that the refund is done, and mark it solved.',
        'Add an internal note to 4810: “Waiting on the warehouse”.',
      ],
      fields: {
        subdomain: {
          label: 'Zendesk subdomain',
          hint: 'The part before .zendesk.com: for acme.zendesk.com, acme.',
        },
        email: { label: 'Agent email', hint: 'The one you sign in to Zendesk with.' },
        apiToken: { label: 'API token', hint: 'Admin Center → Apps and integrations → APIs → API tokens.' },
      },
      actions: {
        search_tickets: { title: 'Search tickets', description: 'Finds tickets, newest first.' },
        get_ticket: { title: 'Get a ticket', description: 'Shows a ticket with its first message.' },
        list_comments: {
          title: 'Conversation',
          description: 'Messages of a ticket in order, internal notes included.',
        },
        reply: {
          title: 'Reply to customer',
          description: 'A public reply that Zendesk emails to the customer.',
        },
        add_note: { title: 'Internal note', description: 'A note only agents can see.' },
        update_ticket: {
          title: 'Update a ticket',
          description: 'Changes status, priority, assignee, type or tags.',
        },
        search_users: {
          title: 'Search users',
          description: 'Finds customers and agents by name, email or phone.',
        },
      },
    },
  },
};

export default withUi(manifest, ui);
