import { z } from 'zod';
import { HttpClient } from '../http/client.js';
import {
  type AccountContext,
  type CapabilityOutput,
  compact,
  defineConnector,
  htmlToText,
  page,
  truncateText,
} from '../sdk.js';

/**
 * Intercom REST API with an access token from a private app. Replies are sent as the admin who
 * owns the token, conversation parts come as HTML, and searches use nested query objects, so this
 * is a code connector.
 */

const REGIONS = {
  us: 'https://api.intercom.io',
  eu: 'https://api.eu.intercom.io',
  au: 'https://api.au.intercom.io',
};

const Config = z.object({
  region: z.enum(['us', 'eu', 'au']).default('us').describe('Where your Intercom workspace is hosted'),
});
const Credentials = z.object({
  token: z
    .string()
    .trim()
    .min(20)
    .describe('Access token of an Intercom app (Developer Hub → your app → Authentication)'),
});

type Ctx = AccountContext<z.output<typeof Config>, z.output<typeof Credentials>>;

const client = (ctx: Ctx) =>
  new HttpClient(ctx, {
    baseUrl: REGIONS[ctx.config.region],
    headers: {
      authorization: `Bearer ${ctx.credentials.token}`,
      accept: 'application/json',
      'intercom-version': '2.11',
    },
    errorMessagePaths: ['errors.0.message', 'message'],
  });

async function call<T>(
  ctx: Ctx,
  method: string,
  url: string,
  json?: unknown,
  query?: Record<string, string>,
) {
  return (
    await client(ctx).request<T>({
      method,
      url,
      ...(json !== undefined ? { json } : {}),
      ...(query ? { query } : {}),
    })
  ).data;
}

async function adminId(ctx: Ctx): Promise<string> {
  return (await call<{ id: string }>(ctx, 'GET', '/me')).id;
}

interface Contact {
  id: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  role?: string;
  companies?: { data?: { name?: string }[] };
}

const contactItem = (c: Contact) =>
  compact({
    id: c.id,
    name: c.name ?? undefined,
    email: c.email ?? undefined,
    phone: c.phone ?? undefined,
    role: c.role,
  });

interface Conversation {
  id: string;
  title?: string | null;
  state?: string;
  open?: boolean;
  read?: boolean;
  updated_at?: number;
  source?: { body?: string; author?: { name?: string; email?: string; type?: string } };
  admin_assignee_id?: number | null;
}

const isoOf = (unix?: number) => (unix ? new Date(unix * 1000).toISOString() : undefined);
const plain = (html: string | undefined, max: number) =>
  html ? truncateText(htmlToText(html), max) : undefined;

const conversationItem = (c: Conversation) =>
  compact({
    id: c.id,
    title: c.title ?? undefined,
    state: c.state,
    from: c.source?.author?.name ?? c.source?.author?.email,
    preview: plain(c.source?.body, 200),
    updated: isoOf(c.updated_at),
    assigned: c.admin_assignee_id ? String(c.admin_assignee_id) : undefined,
  });

const ConversationId = z.string().trim().regex(/^\d+$/, 'a conversation id is a number');
const Cursor = z.string().max(500).optional().describe('nextCursor from the previous result');

export default defineConnector({
  id: 'intercom',
  name: 'Intercom',
  description: 'Intercom conversations and contacts: find, read, reply, add notes, close; search contacts.',
  version: '1.0.0',
  homepage: 'https://developers.intercom.com/docs/references/rest-api/api.intercom.io',
  instructions: 'Replies go to the customer as the admin who owns the token; notes stay internal.',
  config: Config,
  credentials: Credentials,
  rateLimit: { requests: 160, perSeconds: 10 },
  async test(ctx) {
    const admin = await call<{ email?: string; name?: string; app?: { name?: string } }>(ctx, 'GET', '/me');
    return { ok: true, identity: [admin.email ?? admin.name, admin.app?.name].filter(Boolean).join(' @ ') };
  },
  ui: {
    primaryFields: ['token', 'region'],
    locales: {
      ru: {
        description:
          'Разговоры и контакты Intercom: поиск, чтение, ответы, заметки, закрытие, поиск контактов.',
        setup: {
          form: {
            summary: 'Вы создаёте приложение в Developer Hub Intercom и вставляете сюда его токен доступа.',
            minutes: 4,
            needs: ['Рабочее пространство Intercom с правами администратора'],
            steps: [
              {
                text: 'Откройте Developer Hub Intercom, нажмите **New app**, назовите приложение Manyplug и выберите своё рабочее пространство.',
                link: {
                  label: 'Открыть Developer Hub',
                  url: 'https://app.intercom.com/a/apps/_/developer-hub',
                },
              },
              {
                text: 'Откройте **Authentication**, нажмите **Edit scopes** и разрешите чтение и запись разговоров, чтение контактов и админов. Сохраните.',
              },
              {
                text: 'Скопируйте **Access token** на той же странице и вставьте его в форму.',
                fills: ['token'],
              },
              {
                text: 'Посмотрите адрес Intercom в браузере: app.eu.intercom.com — выберите регион «Европа», app.au.intercom.com — «Австралия», иначе оставьте США.',
                fills: ['region'],
              },
            ],
            tips: [
              'ИИ отвечает от имени владельца приложения. Ответ клиенту уходит только после вашего подтверждения.',
              'Чтобы отозвать доступ, удалите приложение в Developer Hub.',
            ],
            problems: [
              {
                problem: 'Ошибка 401 или «Unauthorized» при подключении',
                fix: 'Чаще всего выбран не тот регион. Сверьте его с адресом Intercom в браузере (шаг 4) и проверьте, что токен скопирован целиком.',
              },
              {
                problem: 'ИИ читает разговоры, но не может ответить или закрыть их',
                fix: 'В **Authentication → Edit scopes** не включена запись разговоров. Включите её, сохраните и нажмите **Проверить** на странице аккаунта.',
              },
            ],
          },
        },
        prompts: [
          'Какие разговоры в Intercom сейчас открыты?',
          'Перескажи разговор с Анной из ACME и предложи ответ.',
          'Ответь в этом разговоре, что мы починили вход, и закрой его.',
          'Найди контакт с почтой anna@acme.com.',
        ],
        fields: {
          region: {
            label: 'Регион',
            hint: 'Где размещён ваш Intercom.',
            options: { us: 'США', eu: 'Европа', au: 'Австралия' },
          },
          token: { label: 'Токен доступа', hint: 'Developer Hub → ваше приложение → Authentication.' },
        },
        actions: {
          search_conversations: {
            title: 'Поиск разговоров',
            description: 'Открытые или закрытые разговоры, сначала свежие.',
          },
          get_conversation: { title: 'Разговор', description: 'Показывает разговор целиком.' },
          reply: { title: 'Ответ клиенту', description: 'Отправляет ответ клиенту.' },
          add_note: { title: 'Заметка', description: 'Добавляет внутреннюю заметку.' },
          close_conversation: { title: 'Закрыть разговор', description: 'Закрывает разговор.' },
          search_contacts: { title: 'Поиск контактов', description: 'Находит контакты по имени или почте.' },
        },
      },
      en: {
        setup: {
          form: {
            summary: 'You create an app on Intercom’s developer page and paste its access token here.',
            minutes: 4,
            needs: ['An Intercom workspace where you are an admin'],
            steps: [
              {
                text: 'Open Intercom’s developer page, click **New app**, name it Manyplug and pick your workspace.',
                link: {
                  label: 'Open the Developer Hub',
                  url: 'https://app.intercom.com/a/apps/_/developer-hub',
                },
              },
              {
                text: 'Open **Authentication**, click **Edit scopes** and allow reading and writing conversations and reading contacts and admins. Save.',
              },
              {
                text: 'Copy the **Access token** on the same page and paste it into the form.',
                fills: ['token'],
              },
              {
                text: 'Look at the Intercom address in your browser: app.eu.intercom.com means region Europe, app.au.intercom.com means Australia, anything else stays US.',
                fills: ['region'],
              },
            ],
            tips: [
              'The AI replies as the app owner. Replies to customers go out only after you confirm.',
              'To cut access, delete the app on the same developer page.',
            ],
            problems: [
              {
                problem: 'Error 401 or “Unauthorized” when connecting',
                fix: 'Most often the region is wrong. Match it to the Intercom address in your browser (step 4) and check that the token was copied in full.',
              },
              {
                problem: 'The AI reads conversations but cannot reply to or close them',
                fix: 'Writing conversations is not allowed under **Authentication → Edit scopes**. Turn it on, save and click **Check** on the account page.',
              },
            ],
          },
        },
        prompts: [
          'Which Intercom conversations are open right now?',
          'Summarize the conversation with Anna from ACME and suggest a reply.',
          'Reply in that conversation that login is fixed, and close it.',
          'Find the contact with email anna@acme.com.',
        ],
        fields: {
          region: {
            label: 'Region',
            hint: 'Where your Intercom is hosted.',
            options: { us: 'United States', eu: 'Europe', au: 'Australia' },
          },
          token: { label: 'Access token', hint: 'Developer Hub → your app → Authentication.' },
        },
        actions: {
          search_conversations: {
            title: 'Search conversations',
            description: 'Open or closed conversations, latest first.',
          },
          get_conversation: { title: 'Get a conversation', description: 'Shows a whole conversation.' },
          reply: { title: 'Reply to customer', description: 'Sends a reply to the customer.' },
          add_note: { title: 'Add a note', description: 'Adds an internal note.' },
          close_conversation: { title: 'Close conversation', description: 'Closes a conversation.' },
          search_contacts: { title: 'Search contacts', description: 'Finds contacts by name or email.' },
        },
      },
    },
  },
  actions: (action) => [
    action({
      name: 'search_conversations',
      title: 'Search conversations',
      description: 'Lists conversations by state, most recently updated first.',
      input: z.object({
        state: z.enum(['open', 'closed', 'snoozed']).default('open'),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: Cursor,
      }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ state, limit, cursor }, ctx) => {
        const result = await call<{
          conversations: Conversation[];
          pages?: { next?: { starting_after?: string } };
        }>(ctx, 'POST', '/conversations/search', {
          query: { field: 'state', operator: '=', value: state },
          sort: { field: 'updated_at', order: 'descending' },
          pagination: { per_page: limit, ...(cursor ? { starting_after: cursor } : {}) },
        });
        return page(result.conversations.map(conversationItem), {
          nextCursor: result.pages?.next?.starting_after,
        });
      },
    }),
    action({
      name: 'get_conversation',
      title: 'Get conversation',
      description: 'Returns a conversation with its messages and notes as text, oldest first.',
      input: z.object({ id: ConversationId }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ id }, ctx) => {
        const c = await call<
          Conversation & {
            conversation_parts?: {
              conversation_parts?: {
                part_type: string;
                body?: string | null;
                created_at?: number;
                author?: { name?: string; type?: string };
              }[];
            };
          }
        >(ctx, 'GET', `/conversations/${id}`, undefined, { display_as: 'plaintext' });
        const parts = (c.conversation_parts?.conversation_parts ?? [])
          .filter((p) => p.body)
          .slice(-40)
          .map((p) =>
            compact({
              from: p.author?.name ?? p.author?.type,
              kind: p.part_type === 'note' ? 'note' : undefined,
              date: isoOf(p.created_at),
              text: plain(p.body ?? '', 1500),
            }),
          );
        return compact({
          ...conversationItem(c),
          preview: undefined,
          first_message: plain(c.source?.body, 3000),
          messages: parts,
        });
      },
    }),
    action({
      name: 'reply',
      title: 'Reply to customer',
      description: 'Sends a reply to the customer in a conversation.',
      input: z.object({ id: ConversationId, body: z.string().trim().min(1).max(20_000) }),
      hints: { readOnly: false, destructive: false },
      risk: 'dangerous',
      run: async ({ id, body }, ctx) => {
        await call(ctx, 'POST', `/conversations/${id}/reply`, {
          message_type: 'comment',
          type: 'admin',
          admin_id: await adminId(ctx),
          body,
        });
        return { replied: id };
      },
    }),
    action({
      name: 'add_note',
      title: 'Add note',
      description: 'Adds an internal note to a conversation (not visible to the customer).',
      input: z.object({ id: ConversationId, body: z.string().trim().min(1).max(20_000) }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      run: async ({ id, body }, ctx) => {
        await call(ctx, 'POST', `/conversations/${id}/reply`, {
          message_type: 'note',
          type: 'admin',
          admin_id: await adminId(ctx),
          body,
        });
        return { noted: id };
      },
    }),
    action({
      name: 'close_conversation',
      title: 'Close conversation',
      description: 'Closes a conversation, optionally with a last message to the customer.',
      input: z.object({
        id: ConversationId,
        body: z.string().max(20_000).optional().describe('Closing message to the customer'),
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      assessRisk: (input) =>
        (input as { body?: string }).body
          ? { risk: 'dangerous', reason: 'The closing message is sent to the customer' }
          : undefined,
      run: async ({ id, body }, ctx) => {
        await call(ctx, 'POST', `/conversations/${id}/parts`, {
          message_type: 'close',
          type: 'admin',
          admin_id: await adminId(ctx),
          ...(body ? { body } : {}),
        });
        return { closed: id };
      },
    }),
    action({
      name: 'search_contacts',
      title: 'Search contacts',
      description: 'Finds contacts (users and leads) whose name or email contains the words.',
      input: z.object({
        query: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: Cursor,
      }),
      hints: { readOnly: true, idempotent: true },
      capability: {
        id: 'contacts.search',
        mapInput: ({ query, limit }) => ({ query, limit }),
        mapOutput: (result) =>
          (result as { items: ReturnType<typeof contactItem>[] }).items.map(
            (c): CapabilityOutput<'contacts.search'> => ({
              id: String(c.id),
              name: String(c.name ?? c.email ?? c.id),
              ...(c.email ? { emails: [String(c.email)] } : {}),
              ...(c.phone ? { phones: [String(c.phone)] } : {}),
            }),
          ),
      },
      run: async ({ query, limit, cursor }, ctx) => {
        const result = await call<{ data: Contact[]; pages?: { next?: { starting_after?: string } } }>(
          ctx,
          'POST',
          '/contacts/search',
          {
            query: {
              operator: 'OR',
              value: [
                { field: 'name', operator: '~', value: query },
                { field: 'email', operator: '~', value: query },
              ],
            },
            pagination: { per_page: limit, ...(cursor ? { starting_after: cursor } : {}) },
          },
        );
        return page(result.data.map(contactItem), { nextCursor: result.pages?.next?.starting_after });
      },
    }),
  ],
});
