/**
 * A realistic synthetic workspace for the efficiency eval: ~20 services in the categories of the
 * stage-2 list, several accounts each, deterministic in-memory data. Tool descriptions are
 * written like real connectors (length matters: we measure tokens).
 *
 * Nothing here talks to the network. Writes go to `outbox`, so tasks can check what was done.
 */
import { z } from 'zod';
import { ConnectorRegistry } from '../src/connectors/registry.js';
import { type ConnectorDefinition, ConnectorError, defineConnector, page } from '../src/connectors/sdk.js';

export interface SentRecord {
  service: string;
  account: string;
  action: string;
  input: Record<string, unknown>;
}

export const outbox: SentRecord[] = [];
export function resetOutbox(): void {
  outbox.length = 0;
}

const record = (service: string, account: string, action: string, input: Record<string, unknown>) => {
  outbox.push({ service, account, action, input });
  return { id: `${action}_${outbox.length}`, status: 'sent' };
};

const words = (text: string) => text.toLowerCase();
const matches = (query: string | undefined, ...fields: Array<string | undefined>) =>
  !query || fields.some((f) => f && words(f).includes(words(query)));

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const MAIL: Record<string, Array<Record<string, unknown>>> = {
  'gmail:work': [
    {
      id: 'g1',
      from: 'billing@acme.com',
      subject: 'Invoice #1042 for October',
      date: '2026-11-02T09:15:00Z',
      body: 'Hello, please find invoice #1042 for 1 200 EUR attached. Due 2026-11-15.',
      unread: true,
    },
    {
      id: 'g2',
      from: 'boss@company.com',
      subject: 'Quarterly plan',
      date: '2026-11-01T12:00:00Z',
      body: 'Draft attached.',
    },
  ],
  'gmail:personal': [
    {
      id: 'p1',
      from: 'mom@family.org',
      subject: 'Sunday dinner',
      date: '2026-11-03T18:00:00Z',
      body: 'Come at 6!',
    },
  ],
  'outlook:corp': [
    {
      id: 'o1',
      from: 'it@corp.example',
      subject: 'Password expires soon',
      date: '2026-10-30T08:00:00Z',
      body: 'Change it this week.',
    },
    {
      id: 'o2',
      from: 'accounts@supplier.example',
      subject: 'Overdue invoice reminder',
      date: '2026-10-28T08:00:00Z',
      body: 'Invoice 77 is overdue.',
    },
  ],
};

const CHATS: Record<string, Array<{ id: string; title: string; unread: number; messages: string[] }>> = {
  'telegram:main': [
    { id: 'tg_ivan', title: 'Ivan Petrov', unread: 2, messages: ['Did you get the invoice?', 'Ping me'] },
    { id: 'tg_team', title: 'Team chat', unread: 0, messages: ['Release on Friday'] },
  ],
  'telegram:shop': [{ id: 'tg_c1', title: 'Customer Anna', unread: 1, messages: ['Where is my order #55?'] }],
  'whatsapp:personal': [{ id: 'wa_mom', title: 'Mom', unread: 1, messages: ['Call me'] }],
  'slack:company': [{ id: 'C01', title: '#general', unread: 4, messages: ['Standup moved to 11:00'] }],
};

const EVENTS: Record<string, Array<Record<string, unknown>>> = {
  'gcal:work': [
    { id: 'e1', title: 'Standup', start: '2026-11-05T08:00:00Z', end: '2026-11-05T08:15:00Z' },
    { id: 'e2', title: 'Call with ACME', start: '2026-11-05T13:00:00Z', end: '2026-11-05T14:00:00Z' },
  ],
  'outlook_calendar:corp': [{ id: 'oe1', title: 'Security training', start: '2026-11-05T10:00:00Z' }],
};

const TASKS: Record<string, Array<Record<string, unknown>>> = {
  'todoist:personal': [{ id: 't1', title: 'Pay invoice #1042', due: '2026-11-15', status: 'open' }],
  'linear:company': [
    { id: 'LIN-12', title: 'Fix login bug', due: '2026-11-06', status: 'open', priority: 3 },
  ],
  'jira:client': [{ id: 'CL-3', title: 'Prepare demo', due: '2026-11-08', status: 'open' }],
};

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

function mailService(id: string, name: string, description: string): ConnectorDefinition {
  return defineConnector({
    id,
    name,
    description,
    version: '1.0.0',
    actions: (action) => [
      action({
        name: 'search',
        title: 'Search mail',
        description:
          'Searches emails in this mailbox by words, sender, recipient and date range. Returns subject, sender, date and a snippet; open one with read_message.',
        input: z.object({
          query: z.string().optional().describe('Words in the subject or body'),
          from: z.string().optional().describe('Sender address or name'),
          to: z.string().optional(),
          since: z.string().optional(),
          until: z.string().optional(),
          unread_only: z.boolean().optional(),
          folder: z.string().optional(),
          limit: z.number().int().min(1).max(50).default(20),
        }),
        hints: { readOnly: true },
        capability: [
          'mail.search',
          {
            id: 'messages.search',
            mapInput: (i) => ({
              query: i.query,
              from: i.from,
              since: i.since,
              until: i.until,
              limit: i.limit,
            }),
            mapOutput: (items) =>
              (items as Array<Record<string, unknown>>).map((m) => ({
                id: m.id,
                chat: 'Inbox',
                from: m.from,
                date: m.date,
                text: `${m.subject}: ${m.snippet}`,
              })),
          },
        ],
        run: (input, ctx) =>
          (MAIL[`${id}:${ctx.account.name}`] ?? [])
            .filter((m) => matches(input.query, m.subject as string, m.body as string))
            .filter((m) => matches(input.from, m.from as string))
            .slice(0, input.limit)
            .map(({ body, ...m }) => ({ ...m, snippet: String(body).slice(0, 80) })),
      }),
      action({
        name: 'read_message',
        title: 'Read email',
        description: 'Returns one email with its plain-text body and the list of attachments.',
        input: z.object({ id: z.string().describe('Email id from search') }),
        hints: { readOnly: true },
        capability: 'mail.read',
        run: ({ id: messageId }, ctx) => {
          const message = (MAIL[`${id}:${ctx.account.name}`] ?? []).find((m) => m.id === messageId);
          if (!message) throw new ConnectorError('not_found', `No email ${messageId}`);
          return message;
        },
      }),
      action({
        name: 'send',
        title: 'Send email',
        description: 'Sends an email from this mailbox. Pass reply_to_id to reply in the same thread.',
        input: z.object({
          to: z.array(z.string()).min(1),
          cc: z.array(z.string()).optional(),
          bcc: z.array(z.string()).optional(),
          subject: z.string(),
          body: z.string(),
          reply_to_id: z.string().optional(),
        }),
        risk: 'write',
        capability: 'mail.send',
        run: (input, ctx) => record(id, ctx.account.name, 'send', input),
      }),
      action({
        name: 'archive',
        title: 'Archive email',
        description: 'Moves an email out of the inbox into the archive.',
        input: z.object({ id: z.string() }),
        risk: 'write',
        hints: { idempotent: true },
        run: (input, ctx) => record(id, ctx.account.name, 'archive', input),
      }),
      action({
        name: 'list_labels',
        title: 'List folders',
        description: 'Lists the folders or labels of the mailbox with unread counts.',
        input: z.object({}),
        hints: { readOnly: true },
        run: () => [
          { name: 'INBOX', unread: 1 },
          { name: 'Archive', unread: 0 },
        ],
      }),
    ],
  });
}

function messengerService(id: string, name: string, description: string): ConnectorDefinition {
  const chatsOf = (account: string) => CHATS[`${id}:${account}`] ?? [];
  return defineConnector({
    id,
    name,
    description,
    version: '1.0.0',
    rateLimit: { requests: 30, perSeconds: 60 },
    actions: (action) => [
      action({
        name: 'list_chats',
        title: 'List chats',
        description: 'Lists recent chats with unread counts, most recent first.',
        input: z.object({
          query: z.string().optional(),
          unread_only: z.boolean().optional(),
          limit: z.number().int().min(1).max(100).default(30),
        }),
        hints: { readOnly: true },
        capability: 'messages.list_chats',
        run: (input, ctx) =>
          chatsOf(ctx.account.name)
            .filter((c) => matches(input.query, c.title) && (!input.unread_only || c.unread > 0))
            .slice(0, input.limit)
            .map(({ messages, ...c }) => ({ ...c, kind: 'direct', last_message_at: '2026-11-03T20:00:00Z' })),
      }),
      action({
        name: 'search',
        title: 'Search messages',
        description: 'Searches messages in all chats of this account by words, sender and date.',
        input: z.object({
          query: z.string(),
          chat: z.string().optional(),
          from: z.string().optional(),
          since: z.string().optional(),
          until: z.string().optional(),
          limit: z.number().int().min(1).max(50).default(20),
        }),
        hints: { readOnly: true },
        capability: 'messages.search',
        run: (input, ctx) =>
          chatsOf(ctx.account.name).flatMap((c) =>
            c.messages
              .filter((m) => matches(input.query, m))
              .map((text, i) => ({
                id: `${c.id}_${i}`,
                chat_id: c.id,
                chat: c.title,
                text,
                date: '2026-11-03T19:00:00Z',
              })),
          ),
      }),
      action({
        name: 'read_chat',
        title: 'Read chat',
        description: 'Returns the latest messages of one chat.',
        input: z.object({ chat: z.string(), before: z.string().optional(), limit: z.number().default(30) }),
        hints: { readOnly: true },
        capability: 'messages.read_chat',
        run: ({ chat }, ctx) => {
          const found = chatsOf(ctx.account.name).find((c) => c.id === chat || c.title === chat);
          if (!found) throw new ConnectorError('not_found', `No chat ${chat}`);
          return {
            chat: { id: found.id, title: found.title },
            messages: found.messages.map((text, i) => ({ id: `${found.id}_${i}`, text, direction: 'in' })),
          };
        },
      }),
      action({
        name: 'send',
        title: 'Send message',
        description: 'Sends a text message to a chat, optionally as a reply.',
        input: z.object({ chat: z.string(), text: z.string(), reply_to: z.string().optional() }),
        risk: 'write',
        capability: 'messages.send',
        assessRisk: ({ chat }, ctx) =>
          chatsOf(ctx.account.name).some((c) => c.id === chat || c.title === chat)
            ? undefined
            : { risk: 'dangerous', reason: 'First message to a new contact' },
        run: (input, ctx) => record(id, ctx.account.name, 'send', input),
      }),
      action({
        name: 'mark_read',
        title: 'Mark as read',
        description: 'Marks all messages of a chat as read.',
        input: z.object({ chat: z.string() }),
        risk: 'write',
        hints: { idempotent: true },
        run: (input, ctx) => record(id, ctx.account.name, 'mark_read', input),
      }),
    ],
  });
}

function calendarService(id: string, name: string): ConnectorDefinition {
  return defineConnector({
    id,
    name,
    description: `${name}: events of the user's calendars.`,
    version: '1.0.0',
    actions: (action) => [
      action({
        name: 'list_events',
        title: 'List events',
        description: 'Lists events between two moments, optionally filtered by words.',
        input: z.object({
          from: z.string(),
          to: z.string(),
          query: z.string().optional(),
          limit: z.number().default(50),
        }),
        hints: { readOnly: true },
        capability: 'calendar.list_events',
        run: (input, ctx) =>
          (EVENTS[`${id}:${ctx.account.name}`] ?? []).filter(
            (e) =>
              String(e.start) >= input.from &&
              String(e.start) <= input.to &&
              matches(input.query, e.title as string),
          ),
      }),
      action({
        name: 'create_event',
        title: 'Create event',
        description: 'Creates an event and optionally invites attendees by email.',
        input: z.object({
          title: z.string(),
          start: z.string(),
          end: z.string(),
          description: z.string().optional(),
          location: z.string().optional(),
          attendees: z.array(z.string()).optional(),
        }),
        risk: 'write',
        capability: 'calendar.create_event',
        run: (input, ctx) => record(id, ctx.account.name, 'create_event', input),
      }),
      action({
        name: 'delete_event',
        title: 'Delete event',
        description: 'Deletes an event and notifies the attendees.',
        input: z.object({ id: z.string() }),
        hints: { destructive: true },
        run: (input, ctx) => record(id, ctx.account.name, 'delete_event', input),
      }),
    ],
  });
}

function taskService(id: string, name: string, description: string): ConnectorDefinition {
  return defineConnector({
    id,
    name,
    description,
    version: '1.0.0',
    actions: (action) => [
      action({
        name: 'list_tasks',
        title: 'List tasks',
        description: 'Lists tasks, open by default, optionally due before a date or matching words.',
        input: z.object({
          query: z.string().optional(),
          status: z.enum(['open', 'done', 'all']).default('open'),
          due_before: z.string().optional(),
          limit: z.number().default(30),
        }),
        hints: { readOnly: true },
        capability: 'tasks.list',
        run: (input, ctx) =>
          (TASKS[`${id}:${ctx.account.name}`] ?? []).filter(
            (t) =>
              matches(input.query, t.title as string) &&
              (!input.due_before || String(t.due) <= input.due_before),
          ),
      }),
      action({
        name: 'create_task',
        title: 'Create task',
        description: 'Creates a task with an optional due date, project and priority.',
        input: z.object({
          title: z.string(),
          description: z.string().optional(),
          due: z.string().optional(),
          project: z.string().optional(),
          priority: z.number().optional(),
        }),
        risk: 'write',
        capability: 'tasks.create',
        run: (input, ctx) => record(id, ctx.account.name, 'create_task', input),
      }),
      action({
        name: 'complete_task',
        title: 'Complete task',
        description: 'Marks a task as done.',
        input: z.object({ id: z.string() }),
        risk: 'write',
        hints: { idempotent: true },
        undo: { kind: 'action', action: 'reopen_task' },
        run: (input, ctx) => record(id, ctx.account.name, 'complete_task', input),
      }),
      action({
        name: 'reopen_task',
        title: 'Reopen task',
        description: 'Reopens a completed task.',
        input: z.object({ id: z.string() }),
        risk: 'write',
        hints: { idempotent: true },
        run: (input, ctx) => record(id, ctx.account.name, 'reopen_task', input),
      }),
      action({
        name: 'add_comment',
        title: 'Comment on task',
        description: 'Adds a comment to a task.',
        input: z.object({ id: z.string(), text: z.string() }),
        risk: 'write',
        run: (input, ctx) => record(id, ctx.account.name, 'add_comment', input),
      }),
    ],
  });
}

/** Services without a shared interface: plain REST-style actions. */
function plainService(
  id: string,
  name: string,
  description: string,
  actions: Array<{
    name: string;
    description: string;
    risk?: 'read' | 'write' | 'dangerous';
    fields?: string[];
  }>,
): ConnectorDefinition {
  return defineConnector({
    id,
    name,
    description,
    version: '1.0.0',
    actions: (action) =>
      actions.map((spec) =>
        action({
          name: spec.name,
          description: spec.description,
          input: z.object(
            Object.fromEntries(
              (spec.fields ?? ['id']).map((f) => [f, z.string().optional().describe(`The ${f}`)]),
            ),
          ),
          risk: spec.risk ?? 'read',
          ...(spec.risk === undefined || spec.risk === 'read' ? { hints: { readOnly: true } } : {}),
          run: (input, ctx) =>
            spec.risk && spec.risk !== 'read'
              ? record(id, ctx.account.name, spec.name, input)
              : page([{ id: `${spec.name}_1`, title: `${name} ${spec.name.replace(/_/g, ' ')} result` }]),
        }),
      ),
  });
}

export const CONNECTORS: ConnectorDefinition[] = [
  mailService('gmail', 'Gmail', 'Google mail: search, read and send email.'),
  mailService('outlook', 'Outlook', 'Microsoft 365 / Outlook mail.'),
  messengerService('telegram', 'Telegram', 'Telegram as a user account: chats, groups and channels.'),
  messengerService('whatsapp', 'WhatsApp', 'Personal WhatsApp linked as a device.'),
  messengerService('slack', 'Slack', 'Slack workspace channels and direct messages.'),
  calendarService('gcal', 'Google Calendar'),
  calendarService('outlook_calendar', 'Outlook Calendar'),
  taskService('todoist', 'Todoist', 'Personal task manager.'),
  taskService('linear', 'Linear', 'Issue tracker of the product team.'),
  taskService('jira', 'Jira', 'Client project tracker.'),
  plainService('stripe', 'Stripe', 'Payments: customers, charges, invoices, refunds.', [
    {
      name: 'list_charges',
      description: 'Lists recent charges with amount, currency, customer and status.',
      fields: ['customer', 'limit'],
    },
    {
      name: 'list_invoices',
      description: 'Lists invoices, optionally only unpaid ones.',
      fields: ['status', 'customer'],
    },
    { name: 'get_customer', description: 'Returns a customer by id or email.', fields: ['id', 'email'] },
    {
      name: 'refund_charge',
      description: 'Refunds a charge fully or partially. Money leaves the account.',
      risk: 'dangerous',
      fields: ['charge', 'amount'],
    },
    {
      name: 'create_invoice',
      description: 'Creates and sends an invoice to a customer.',
      risk: 'write',
      fields: ['customer', 'amount', 'description'],
    },
  ]),
  plainService('github', 'GitHub', 'Repositories, issues, pull requests and notifications.', [
    {
      name: 'list_notifications',
      description: 'Lists unread notifications (reviews requested, mentions, CI failures).',
    },
    {
      name: 'list_pull_requests',
      description: 'Lists open pull requests of a repository.',
      fields: ['repo', 'state'],
    },
    {
      name: 'get_pull_request',
      description: 'Returns a pull request with its checks and review status.',
      fields: ['repo', 'number'],
    },
    {
      name: 'create_issue',
      description: 'Creates an issue in a repository.',
      risk: 'write',
      fields: ['repo', 'title', 'body'],
    },
    {
      name: 'merge_pull_request',
      description: 'Merges a pull request.',
      risk: 'dangerous',
      fields: ['repo', 'number'],
    },
    { name: 'search_code', description: 'Searches code across repositories.', fields: ['query'] },
  ]),
  plainService('notion', 'Notion', 'Notes and wiki pages.', [
    {
      name: 'search_pages',
      description: 'Searches pages and databases by title and content.',
      fields: ['query'],
    },
    { name: 'get_page', description: 'Returns the content of a page as text.', fields: ['id'] },
    {
      name: 'create_page',
      description: 'Creates a page under a parent page.',
      risk: 'write',
      fields: ['parent', 'title', 'content'],
    },
    {
      name: 'append_to_page',
      description: 'Appends text to a page.',
      risk: 'write',
      fields: ['id', 'content'],
    },
  ]),
  plainService('gdrive', 'Google Drive', 'Files in Google Drive.', [
    { name: 'search_files', description: 'Searches files by name and content.', fields: ['query'] },
    { name: 'read_file', description: 'Returns the text of a document or spreadsheet.', fields: ['id'] },
    {
      name: 'share_file',
      description: 'Shares a file with someone by email.',
      risk: 'dangerous',
      fields: ['id', 'email', 'role'],
    },
  ]),
  plainService('hubspot', 'HubSpot', 'CRM: contacts, companies and deals.', [
    { name: 'search_contacts', description: 'Finds contacts by name, email or company.', fields: ['query'] },
    {
      name: 'list_deals',
      description: 'Lists deals in the pipeline with stage and amount.',
      fields: ['stage'],
    },
    {
      name: 'update_deal',
      description: 'Moves a deal to another stage or changes its amount.',
      risk: 'write',
      fields: ['id', 'stage', 'amount'],
    },
    {
      name: 'log_activity',
      description: 'Logs a call, email or meeting on a contact.',
      risk: 'write',
      fields: ['contact', 'type', 'note'],
    },
  ]),
  plainService('shopify', 'Shopify', 'Online store: orders, products, customers.', [
    { name: 'list_orders', description: 'Lists recent orders with status and totals.', fields: ['status'] },
    {
      name: 'get_order',
      description: 'Returns one order with items, shipping and payment status.',
      fields: ['id'],
    },
    {
      name: 'update_inventory',
      description: 'Sets the stock level of a product variant.',
      risk: 'write',
      fields: ['variant', 'quantity'],
    },
    { name: 'refund_order', description: 'Refunds an order.', risk: 'dangerous', fields: ['id', 'amount'] },
  ]),
  plainService('sentry', 'Sentry', 'Error monitoring.', [
    {
      name: 'list_issues',
      description: 'Lists unresolved error issues of a project, most frequent first.',
      fields: ['project'],
    },
    {
      name: 'resolve_issue',
      description: 'Marks an error issue as resolved.',
      risk: 'write',
      fields: ['id'],
    },
  ]),
  plainService('vercel', 'Vercel', 'Deployments of web projects.', [
    { name: 'list_deployments', description: 'Lists recent deployments with status.', fields: ['project'] },
    {
      name: 'redeploy',
      description: 'Redeploys the latest production deployment.',
      risk: 'write',
      fields: ['project'],
    },
  ]),
  plainService('openweather', 'Weather', 'Weather forecasts.', [
    {
      name: 'forecast',
      description: 'Weather forecast for a city for the next days.',
      fields: ['city', 'days'],
    },
  ]),
  plainService('ozon', 'Ozon Seller', 'Marketplace seller account.', [
    { name: 'list_postings', description: 'Lists orders (postings) awaiting shipment.', fields: ['status'] },
    { name: 'list_returns', description: 'Lists customer returns.', fields: ['since'] },
    {
      name: 'update_prices',
      description: 'Changes product prices.',
      risk: 'write',
      fields: ['sku', 'price'],
    },
  ]),
];

/** Accounts per service: `connectorId -> [name, label, identity]`. */
export const ACCOUNTS: Record<string, Array<[string, string, string]>> = {
  gmail: [
    ['work', 'Work mail', 'me@company.com'],
    ['personal', 'Personal mail', 'me@gmail.com'],
  ],
  outlook: [['corp', 'Corporate', 'me@corp.example']],
  telegram: [
    ['main', 'Personal Telegram', '@me'],
    ['shop', 'Shop support', '@shop_support'],
  ],
  whatsapp: [['personal', 'Personal WhatsApp', '+7 900 000-00-00']],
  slack: [['company', 'Company Slack', 'me@company.com']],
  gcal: [['work', 'Work calendar', 'me@company.com']],
  outlook_calendar: [['corp', 'Corporate calendar', 'me@corp.example']],
  todoist: [['personal', 'Personal tasks', 'me']],
  linear: [['company', 'Product team', 'me']],
  jira: [['client', 'Client project', 'me']],
  stripe: [
    ['main', 'Main business', 'acct_1'],
    ['eu', 'EU entity', 'acct_2'],
  ],
  github: [['me', 'Personal GitHub', '@me']],
  notion: [['work', 'Work wiki', 'me']],
  gdrive: [
    ['work', 'Work drive', 'me@company.com'],
    ['personal', 'Personal drive', 'me@gmail.com'],
  ],
  hubspot: [['sales', 'Sales CRM', 'me']],
  shopify: [['store', 'Online store', 'store.example']],
  sentry: [['company', 'Company', 'me']],
  vercel: [['me', 'Personal', 'me']],
  openweather: [['default', 'Weather', 'api']],
  ozon: [['shop', 'Ozon shop', 'seller 1']],
};

export function evalRegistry(services: readonly string[] = CONNECTORS.map((c) => c.id)): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  for (const connector of CONNECTORS) if (services.includes(connector.id)) registry.register(connector);
  return registry;
}
