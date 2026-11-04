import { z } from 'zod';
import { HttpClient, type QueryValue } from '../http/client.js';
import {
  type AccountContext,
  type CapabilityOutput,
  ConnectorError,
  compact,
  defineConnector,
  page,
} from '../sdk.js';

/**
 * Calendly API v2 with a personal access token. Every list is scoped by the user's URI, which the
 * connector looks up itself, and events are referred to by their short id instead of full URIs.
 */

const Credentials = z.object({
  token: z
    .string()
    .trim()
    .min(20)
    .describe('Personal access token: Calendly → Integrations → API & Webhooks'),
});

type Ctx = AccountContext<Record<string, never>, z.output<typeof Credentials>>;

const BASE = 'https://api.calendly.com';

const client = (ctx: Ctx) =>
  new HttpClient(ctx, {
    baseUrl: BASE,
    headers: { authorization: `Bearer ${ctx.credentials.token}` },
    errorMessagePaths: ['message', 'title', 'details.0.message'],
  });

async function get<T>(ctx: Ctx, url: string, query: Record<string, QueryValue> = {}): Promise<T> {
  const clean = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined));
  return (await client(ctx).request<T>({ method: 'GET', url, query: clean })).data;
}

async function post<T>(ctx: Ctx, url: string, json: unknown): Promise<T> {
  return (await client(ctx).request<T>({ method: 'POST', url, json })).data;
}

interface Me {
  uri: string;
  name?: string;
  email?: string;
  scheduling_url?: string;
  timezone?: string;
}

async function me(ctx: Ctx): Promise<Me> {
  return (await get<{ resource: Me }>(ctx, '/users/me')).resource;
}

/** The last segment of a Calendly URI, e.g. the event uuid. */
const shortId = (uri: string) => uri.split('/').pop() ?? uri;

interface ScheduledEvent {
  uri: string;
  name: string;
  status: string;
  start_time: string;
  end_time: string;
  location?: { type?: string; location?: string; join_url?: string };
  invitees_counter?: { active?: number };
  event_type?: string;
}

const eventItem = (e: ScheduledEvent) =>
  compact({
    id: shortId(e.uri),
    name: e.name,
    status: e.status,
    start: e.start_time,
    end: e.end_time,
    location: e.location?.join_url ?? e.location?.location ?? e.location?.type,
    invitees: e.invitees_counter?.active,
  });

const nextToken = (pagination?: { next_page_token?: string | null }) =>
  pagination?.next_page_token ?? undefined;

const EventId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]+$/, 'an event id from calendly_list_events');
type EventOut = CapabilityOutput<'calendar.list_events'>;

export default defineConnector({
  id: 'calendly',
  name: 'Calendly',
  description:
    'Calendly: event types and booking links, scheduled meetings and their invitees, cancel meetings.',
  version: '1.0.0',
  homepage: 'https://developer.calendly.com/api-docs',
  credentials: Credentials,
  rateLimit: { requests: 60, perSeconds: 60 },
  async test(ctx) {
    const user = await me(ctx);
    return { ok: true, identity: user.email ?? user.name ?? 'Calendly' };
  },
  ui: {
    locales: {
      ru: {
        description:
          'Calendly: типы встреч и ссылки для записи, назначенные встречи и их участники, отмена встреч.',
        setup: {
          form: {
            summary: 'Личный токен доступа Calendly. Около минуты.',
            steps: [
              {
                text: 'Откройте Calendly → Integrations → API & Webhooks.',
                link: {
                  label: 'Открыть API & Webhooks',
                  url: 'https://calendly.com/integrations/api_webhooks',
                },
              },
              {
                text: 'В Personal Access Tokens нажмите Generate New Token, назовите его Manyplug и нажмите Create Token.',
              },
              { text: 'Скопируйте токен (Calendly покажет его один раз) и вставьте в форму.' },
            ],
            tips: ['Отозвать токен можно на той же странице.'],
          },
        },
        prompts: [
          'Какие встречи у меня записаны в Calendly на завтра?',
          'Кто записан на звонок в четверг и что они написали в анкете?',
          'Дай одноразовую ссылку на 30-минутную встречу для Анны.',
          'Отмени встречу в пятницу в 15:00 и напиши причину: «Перенесём на следующую неделю».',
        ],
        fields: {
          token: { label: 'Личный токен доступа', hint: 'Calendly → Integrations → API & Webhooks.' },
        },
        actions: {
          list_event_types: { title: 'Типы встреч', description: 'Ваши типы встреч со ссылками для записи.' },
          list_events: { title: 'Встречи', description: 'Назначенные встречи за период.' },
          get_event: { title: 'Встреча', description: 'Показывает встречу с участниками и ответами анкеты.' },
          create_booking_link: {
            title: 'Одноразовая ссылка',
            description: 'Создаёт ссылку, по которой можно записаться один раз.',
          },
          cancel_event: {
            title: 'Отмена встречи',
            description: 'Отменяет встречу, участники получат письмо.',
          },
        },
      },
      en: {
        setup: {
          form: {
            summary: 'A Calendly personal access token. Takes about a minute.',
            steps: [
              {
                text: 'Open Calendly → Integrations → API & Webhooks.',
                link: { label: 'Open API & Webhooks', url: 'https://calendly.com/integrations/api_webhooks' },
              },
              {
                text: 'Under Personal Access Tokens, click Generate New Token, name it Manyplug and click Create Token.',
              },
              { text: 'Copy the token (Calendly shows it only once) and paste it into the form.' },
            ],
            tips: ['You can revoke the token on the same page.'],
          },
        },
        prompts: [
          'What Calendly meetings do I have tomorrow?',
          'Who booked the Thursday call and what did they answer in the form?',
          'Give me a one-time link for a 30-minute meeting to send to Anna.',
          'Cancel the Friday 3 pm meeting with the reason “Let’s move it to next week”.',
        ],
        fields: {
          token: { label: 'Personal access token', hint: 'Calendly → Integrations → API & Webhooks.' },
        },
        actions: {
          list_event_types: { title: 'Event types', description: 'Your event types with booking links.' },
          list_events: { title: 'List meetings', description: 'Scheduled meetings in a time range.' },
          get_event: {
            title: 'Get a meeting',
            description: 'Shows a meeting with its invitees and their answers.',
          },
          create_booking_link: {
            title: 'One-time link',
            description: 'Creates a link that can be booked once.',
          },
          cancel_event: {
            title: 'Cancel a meeting',
            description: 'Cancels a meeting; invitees get an email.',
          },
        },
      },
    },
  },
  actions: (action) => [
    action({
      name: 'list_event_types',
      title: 'List event types',
      description: 'Lists your active event types with their booking links.',
      input: z.object({}),
      hints: { readOnly: true, idempotent: true },
      run: async (_input, ctx) => {
        const user = await me(ctx);
        const result = await get<{
          collection: {
            uri: string;
            name: string;
            duration?: number;
            scheduling_url?: string;
            kind?: string;
          }[];
        }>(ctx, '/event_types', { user: user.uri, active: true, count: 100 });
        return result.collection.map((t) =>
          compact({
            id: shortId(t.uri),
            name: t.name,
            minutes: t.duration,
            url: t.scheduling_url,
            kind: t.kind,
          }),
        );
      },
    }),
    action({
      name: 'list_events',
      title: 'List meetings',
      description: 'Lists scheduled meetings in a time range, earliest first (default: from now on).',
      input: z.object({
        from: z.string().max(40).optional().describe('RFC 3339; default now'),
        to: z.string().max(40).optional().describe('RFC 3339'),
        status: z.enum(['active', 'canceled']).default('active'),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().max(500).optional().describe('nextCursor from the previous result'),
      }),
      hints: { readOnly: true, idempotent: true },
      capability: {
        id: 'calendar.list_events',
        mapInput: ({ from, to, limit }) => ({ from, to, limit }),
        mapOutput: (result, input) => {
          const { items, nextCursor } = result as {
            items: ReturnType<typeof eventItem>[];
            nextCursor?: string;
          };
          const words = typeof input.query === 'string' ? input.query.toLowerCase() : undefined;
          return {
            items: items
              .filter((e) => !words || String(e.name).toLowerCase().includes(words))
              .map(
                (e): EventOut => ({
                  id: String(e.id),
                  title: String(e.name),
                  start: String(e.start),
                  ...(e.end ? { end: String(e.end) } : {}),
                  ...(e.location ? { location: String(e.location) } : {}),
                  calendar: 'Calendly',
                }),
              ),
            ...(nextCursor ? { nextCursor } : {}),
          };
        },
      },
      run: async ({ from, to, status, limit, cursor }, ctx) => {
        const user = await me(ctx);
        const result = await get<{
          collection: ScheduledEvent[];
          pagination?: { next_page_token?: string | null };
        }>(ctx, '/scheduled_events', {
          user: user.uri,
          min_start_time: from ?? new Date().toISOString(),
          max_start_time: to,
          status,
          count: limit,
          sort: 'start_time:asc',
          page_token: cursor,
        });
        return page(result.collection.map(eventItem), { nextCursor: nextToken(result.pagination) });
      },
    }),
    action({
      name: 'get_event',
      title: 'Get meeting',
      description: 'Returns a meeting with its invitees and their answers to the booking questions.',
      input: z.object({ id: EventId }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ id }, ctx) => {
        const [event, invitees] = await Promise.all([
          get<{ resource: ScheduledEvent }>(ctx, `/scheduled_events/${id}`),
          get<{
            collection: {
              name?: string;
              email?: string;
              status?: string;
              timezone?: string;
              questions_and_answers?: { question: string; answer: string }[];
            }[];
          }>(ctx, `/scheduled_events/${id}/invitees`, { count: 50 }),
        ]);
        return compact({
          ...eventItem(event.resource),
          invitees: invitees.collection.map((i) =>
            compact({
              name: i.name,
              email: i.email,
              status: i.status,
              timezone: i.timezone,
              answers: i.questions_and_answers?.map((qa) => `${qa.question}: ${qa.answer}`),
            }),
          ),
        });
      },
    }),
    action({
      name: 'create_booking_link',
      title: 'Create one-time link',
      description: 'Creates a booking link for an event type that can be used once.',
      input: z.object({
        event_type: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe('Event type id or name from calendly_list_event_types'),
      }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      run: async ({ event_type }, ctx) => {
        const user = await me(ctx);
        const types = await get<{ collection: { uri: string; name: string }[] }>(ctx, '/event_types', {
          user: user.uri,
          active: true,
          count: 100,
        });
        const wanted = event_type.toLowerCase();
        const type = types.collection.find(
          (t) => shortId(t.uri) === event_type || t.name.toLowerCase() === wanted,
        );
        if (!type) {
          throw new ConnectorError(
            'not_found',
            `No event type "${event_type}". Types: ${types.collection.map((t) => t.name).join(', ')}.`,
          );
        }
        const link = await post<{ resource: { booking_url: string } }>(ctx, '/scheduling_links', {
          max_event_count: 1,
          owner: type.uri,
          owner_type: 'EventType',
        });
        return { url: link.resource.booking_url, event_type: type.name };
      },
    }),
    action({
      name: 'cancel_event',
      title: 'Cancel meeting',
      description: 'Cancels a scheduled meeting; Calendly emails the invitees with the reason.',
      input: z.object({ id: EventId, reason: z.string().max(10_000).optional() }),
      hints: { readOnly: false, destructive: true },
      risk: 'dangerous',
      run: async ({ id, reason }, ctx) => {
        await post(ctx, `/scheduled_events/${id}/cancellation`, reason ? { reason } : {});
        return { canceled: id };
      },
    }),
  ],
});
