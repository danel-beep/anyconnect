import { defineManifestConnector } from '../manifest/compile.js';
import type { CapabilityBinding, CapabilityOutput } from '../sdk.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/**
 * Zendesk Support API through the customer's own OAuth client (client credentials grant). Zendesk
 * stopped issuing API tokens on 27 Oct 2026 and turns the remaining ones off on 30 Apr 2027, so
 * the connector no longer takes them. The token acts as the admin who created the OAuth client.
 */

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
      },
      required: ['subdomain'],
    },
    credentials: {
      type: 'object',
      properties: {
        clientId: {
          type: 'string',
          minLength: 1,
          description:
            'Identifier of the OAuth client: Admin Center → Apps and integrations → APIs → OAuth clients',
        },
        clientSecret: { type: 'string', minLength: 10, description: 'Secret of the same OAuth client' },
      },
      required: ['clientId', 'clientSecret'],
    },
    auth: {
      type: 'client_credentials',
      tokenUrl: 'https://{{config.subdomain}}.zendesk.com/oauth/tokens',
      scopes: ['read', 'write'],
      // Clients made after 30 Apr 2026 default to 30-minute tokens; two hours means fewer exchanges.
      params: { expires_in: 7200 },
    },
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
  primaryFields: ['subdomain', 'clientId', 'clientSecret'],
  locales: {
    ru: {
      description:
        'Тикеты и пользователи Zendesk Support: поиск, переписка, ответы клиентам, заметки, изменение тикетов.',
      setup: {
        form: {
          summary:
            'Вы создаёте OAuth-клиент в Zendesk Admin Center и вставляете сюда его идентификатор и секрет вместе с адресом Zendesk.',
          notice:
            'Токены API Zendesk больше не выдаёт и 30 апреля 2027 отключит совсем, поэтому Manyplug подключается через OAuth-клиент.',
          minutes: 4,
          needs: ['Аккаунт Zendesk с правами администратора: только администраторы создают OAuth-клиенты'],
          steps: [
            {
              text: 'Войдите в Zendesk и откройте **Admin Center → Apps and integrations → APIs → OAuth clients**.',
              link: { label: 'Открыть Zendesk', url: 'https://www.zendesk.com/login/' },
            },
            { text: 'Нажмите **Add OAuth client** и в поле **Name** напишите Manyplug.' },
            {
              text: 'В **Client kind** выберите **Confidential**. Поле **Scopes** оставьте пустым, а **Redirect URLs** не заполняйте.',
            },
            {
              text: 'Скопируйте значение поля **Identifier** и нажмите **Save**.',
              fills: ['clientId'],
            },
            {
              text: 'Скопируйте появившийся **Secret** и ещё раз нажмите **Save**: Zendesk показывает секрет целиком только один раз.',
              fills: ['clientSecret'],
            },
            {
              text: 'В форме укажите поддомен: acme для acme.zendesk.com.',
              fills: ['subdomain'],
            },
          ],
          tips: [
            'ИИ действует от имени администратора, который создал OAuth-клиент. Ответы клиентам уходят только после вашего подтверждения.',
            'Чтобы закрыть доступ, удалите клиент Manyplug на той же странице **OAuth clients**.',
          ],
          problems: [
            {
              problem: 'Проверка пишет, что Zendesk не принял идентификатор и секрет',
              fix: 'Скопируйте **Identifier** и **Secret** ещё раз. Если секрет потерян, создайте новый клиент и вставьте его данные через **Переподключить**.',
            },
            {
              problem: 'Ошибка «invalid_scope» или 403',
              fix: 'Откройте клиент Manyplug в **OAuth clients** и очистите поле **Scopes**, чтобы клиент мог читать и писать.',
            },
            {
              problem: 'Проверка не находит адрес Zendesk',
              fix: 'Укажите только поддомен: acme для acme.zendesk.com, без https:// и .zendesk.com.',
            },
            {
              problem: 'Подключение перестало работать после смены прав',
              fix: 'Клиент работает, пока у его создателя есть права администратора. Создайте новый клиент от имени действующего администратора.',
            },
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
        clientId: { label: 'Идентификатор клиента', hint: 'Поле Identifier OAuth-клиента.' },
        clientSecret: { label: 'Секрет клиента', hint: 'Поле Secret, Zendesk показывает его после Save.' },
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
            'You create an OAuth client in Zendesk Admin Center and paste its identifier and secret here with your Zendesk address.',
          notice:
            'Zendesk no longer issues API tokens and turns the remaining ones off on 30 April 2027, so Manyplug connects through an OAuth client.',
          minutes: 4,
          needs: ['A Zendesk account with admin access: only admins can create OAuth clients'],
          steps: [
            {
              text: 'Sign in to Zendesk and open **Admin Center → Apps and integrations → APIs → OAuth clients**.',
              link: { label: 'Open Zendesk', url: 'https://www.zendesk.com/login/' },
            },
            { text: 'Click **Add OAuth client** and type Manyplug in **Name**.' },
            {
              text: 'Under **Client kind**, choose **Confidential**. Leave **Scopes** empty and **Redirect URLs** blank.',
            },
            {
              text: 'Copy the value of **Identifier** and click **Save**.',
              fills: ['clientId'],
            },
            {
              text: 'Copy the **Secret** that appears and click **Save** again: Zendesk shows the whole secret only once.',
              fills: ['clientSecret'],
            },
            {
              text: 'In the form, enter your subdomain: acme for acme.zendesk.com.',
              fills: ['subdomain'],
            },
          ],
          tips: [
            'The AI acts as the admin who created the OAuth client. Replies to customers go out only after you confirm.',
            'To cut access, delete the Manyplug client on the same **OAuth clients** page.',
          ],
          problems: [
            {
              problem: 'The check says Zendesk did not accept the client id and secret',
              fix: 'Copy **Identifier** and **Secret** again. If the secret is lost, create a new client and paste its values with **Reconnect**.',
            },
            {
              problem: 'An “invalid_scope” or 403 error',
              fix: 'Open the Manyplug client in **OAuth clients** and clear **Scopes**, so the client can read and write.',
            },
            {
              problem: 'The check cannot find the Zendesk address',
              fix: 'Enter only the subdomain: acme for acme.zendesk.com, without https:// and .zendesk.com.',
            },
            {
              problem: 'The connection stopped working after a role change',
              fix: 'The client works while its creator stays an admin. Create a new client as a current admin.',
            },
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
        clientId: { label: 'Client identifier', hint: 'The Identifier field of the OAuth client.' },
        clientSecret: { label: 'Client secret', hint: 'The Secret field, shown after Save.' },
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
