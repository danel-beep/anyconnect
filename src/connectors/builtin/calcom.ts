import { defineManifestConnector } from '../manifest/compile.js';
import type { CapabilityBinding, CapabilityOutput } from '../sdk.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Cal.com API v2 with an API key: event types and bookings. */

const BOOKINGS_VERSION = { 'cal-api-version': '2024-08-13' };
const bookingUid = { type: 'string', minLength: 1, description: 'Booking uid from calcom_list_bookings' };
const BOOKING_FIELDS = [
  'uid',
  'title',
  'status',
  'start',
  'end',
  'duration',
  'eventType.slug',
  'attendees',
  'meetingUrl',
  'location',
];

interface Booking {
  uid: string;
  title?: string;
  status?: string;
  start: string;
  end: string;
  meetingUrl?: string | null;
  location?: string | null;
  attendees?: { name?: string; email?: string }[];
}

const listEvents: CapabilityBinding = {
  id: 'calendar.list_events',
  mapInput: ({ from, to, limit }) => ({
    status: 'upcoming',
    ...(typeof from === 'string' ? { after_start: from } : {}),
    ...(typeof to === 'string' ? { before_end: to } : {}),
    take: limit,
  }),
  mapOutput: (result, input) => {
    const { items, nextCursor } = result as { items: Booking[]; nextCursor?: string };
    const words = typeof input.query === 'string' ? input.query.toLowerCase() : undefined;
    return {
      items: items
        .filter(
          (b) =>
            !words ||
            String(b.title ?? '')
              .toLowerCase()
              .includes(words),
        )
        .map((b): CapabilityOutput<'calendar.list_events'> => {
          const location = b.meetingUrl ?? b.location;
          const attendees = (b.attendees ?? []).map((a) => a.email ?? a.name ?? '').filter(Boolean);
          return {
            id: b.uid,
            title: b.title ?? 'Booking',
            start: b.start,
            end: b.end,
            ...(location ? { location } : {}),
            ...(attendees.length ? { attendees } : {}),
            calendar: 'Cal.com',
          };
        }),
      ...(nextCursor ? { nextCursor } : {}),
    };
  },
};

const manifest = defineManifestConnector(
  {
    id: 'calcom',
    name: 'Cal.com',
    description: 'Cal.com bookings and event types: upcoming and past meetings, cancel or confirm them.',
    version: '1.0.0',
    homepage: 'https://cal.com/docs/api-reference/v2',
    instructions: 'Times are ISO 8601 in UTC. Cancelling a booking emails the attendees.',
    baseUrl: 'https://api.cal.com/v2',
    credentials: {
      type: 'object',
      properties: {
        apiKey: { type: 'string', pattern: '^cal_', description: 'Settings → Developer → API keys' },
      },
      required: ['apiKey'],
    },
    auth: { type: 'bearer', token: '{{credentials.apiKey}}' },
    rateLimit: { requests: 100, perSeconds: 60 },
    errorMessagePaths: ['error.message', 'message'],
    pagination: { type: 'offset', param: 'skip', limitParam: 'take', defaultLimit: 20 },
    test: { request: { method: 'GET', path: '/me' }, identity: '{{response.data.email}}' },
    actions: [
      {
        name: 'list_event_types',
        title: 'List event types',
        description: 'Your event types with their slugs, lengths and booking links.',
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/event-types', headers: { 'cal-api-version': '2024-06-14' } },
        response: {
          root: 'data',
          fields: ['id', 'title', 'slug', 'lengthInMinutes', 'hidden', 'bookingUrl'],
        },
      },
      {
        name: 'list_bookings',
        title: 'List bookings',
        description: 'Bookings by status, soonest first, optionally in a time range or with one attendee.',
        input: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['upcoming', 'recurring', 'past', 'cancelled', 'unconfirmed'],
              default: 'upcoming',
            },
            after_start: { type: 'string', description: 'ISO date-time' },
            before_end: { type: 'string', description: 'ISO date-time' },
            attendee_email: { type: 'string', format: 'email' },
            take: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
        hints: { readOnly: true, idempotent: true },
        request: {
          method: 'GET',
          path: '/bookings',
          headers: BOOKINGS_VERSION,
          query: {
            status: '{{input.status}}',
            afterStart: '{{input.after_start}}',
            beforeEnd: '{{input.before_end}}',
            attendeeEmail: '{{input.attendee_email}}',
            take: '{{input.take}}',
            sortStart: 'asc',
          },
        },
        response: { root: 'data', fields: BOOKING_FIELDS },
        pagination: true,
      },
      {
        name: 'get_booking',
        title: 'Get booking',
        description: 'Returns a booking with attendees, location, notes and answers to booking questions.',
        input: { type: 'object', properties: { uid: bookingUid }, required: ['uid'] },
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/bookings/{uid}', headers: BOOKINGS_VERSION },
        response: { root: 'data', fields: [...BOOKING_FIELDS, 'description', 'bookingFieldsResponses'] },
      },
      {
        name: 'cancel_booking',
        title: 'Cancel booking',
        description: 'Cancels a booking; attendees are notified by email.',
        input: {
          type: 'object',
          properties: { uid: bookingUid, reason: { type: 'string', description: 'Shown to attendees' } },
          required: ['uid'],
        },
        hints: { readOnly: false, destructive: true },
        risk: 'dangerous',
        request: {
          method: 'POST',
          path: '/bookings/{uid}/cancel',
          headers: BOOKINGS_VERSION,
          body: { cancellationReason: '{{input.reason}}' },
        },
        response: { root: 'data', fields: ['uid', 'status'] },
      },
      {
        name: 'confirm_booking',
        title: 'Confirm booking',
        description: 'Confirms a booking that waits for your approval.',
        input: { type: 'object', properties: { uid: bookingUid }, required: ['uid'] },
        hints: { readOnly: false, destructive: false, idempotent: true },
        risk: 'write',
        request: { method: 'POST', path: '/bookings/{uid}/confirm', headers: BOOKINGS_VERSION, body: {} },
        response: { root: 'data', fields: ['uid', 'status'] },
      },
    ],
  },
  { actions: { list_bookings: { capability: listEvents } } },
);

const ui: ConnectorUi = {
  locales: {
    ru: {
      description: 'Записи и типы встреч Cal.com: ближайшие и прошедшие встречи, отмена и подтверждение.',
      setup: {
        form: {
          summary: 'Вы создаёте API-ключ в настройках Cal.com и вставляете его сюда.',
          minutes: 2,
          needs: ['Аккаунт Cal.com'],
          steps: [
            {
              text: 'В Cal.com откройте **Settings → Developer → API keys** и нажмите **New**.',
              link: {
                label: 'Открыть API-ключи Cal.com',
                url: 'https://app.cal.com/settings/developer/api-keys',
              },
            },
            {
              text: 'Назовите ключ Manyplug, выберите срок действия (или **Never expires**) и нажмите **Save**.',
            },
            {
              text: 'Скопируйте ключ (начинается с cal_). Cal.com показывает его только один раз.',
              fills: ['apiKey'],
            },
          ],
          tips: ['Встречу ИИ отменяет только после вашего подтверждения: участники получат письмо.'],
          problems: [
            {
              problem: 'Форма пишет, что ключ не подходит',
              fix: 'Возможно, срок ключа истёк или он скопирован не полностью. Создайте новый и скопируйте его целиком.',
            },
            {
              problem: 'Через какое-то время ИИ перестаёт работать с Cal.com',
              fix: 'Срок ключа истёк. Создайте новый с более поздним сроком и вставьте его через **Переподключить**.',
            },
          ],
        },
      },
      prompts: [
        'Какие встречи у меня записаны в Cal.com на этой неделе?',
        'Кто записан на завтра и по какому вопросу?',
        'Подтверди все встречи, которые ждут моего одобрения.',
      ],
      fields: { apiKey: { label: 'Ключ API', hint: 'Settings → Developer → API keys.' } },
      actions: {
        list_event_types: { title: 'Типы встреч', description: 'Типы встреч и ссылки на запись.' },
        list_bookings: { title: 'Записи', description: 'Встречи по статусу и периоду.' },
        get_booking: { title: 'Запись', description: 'Участники, место и ответы на вопросы.' },
        cancel_booking: { title: 'Отмена', description: 'Отменяет встречу и уведомляет участников.' },
        confirm_booking: { title: 'Подтверждение', description: 'Подтверждает ждущую встречу.' },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'You create an API key in Cal.com settings and paste it here.',
          minutes: 2,
          needs: ['A Cal.com account'],
          steps: [
            {
              text: 'In Cal.com, open **Settings → Developer → API keys** and click **New**.',
              link: {
                label: 'Open Cal.com API keys',
                url: 'https://app.cal.com/settings/developer/api-keys',
              },
            },
            { text: 'Name it Manyplug, choose when it expires (or **Never expires**) and click **Save**.' },
            { text: 'Copy the key (it starts with cal_). Cal.com shows it only once.', fills: ['apiKey'] },
          ],
          tips: ['The AI cancels a meeting only after you confirm: attendees get an email.'],
          problems: [
            {
              problem: 'The form says the key is not valid',
              fix: 'The key may have expired or been copied in part. Create a new one and copy it whole.',
            },
            {
              problem: 'The AI stops working with Cal.com after a while',
              fix: 'The key has expired. Create a new one with a later expiry and paste it with **Reconnect**.',
            },
          ],
        },
      },
      prompts: [
        'Which meetings are booked in Cal.com this week?',
        'Who is booked tomorrow, and what about?',
        'Confirm all bookings that wait for my approval.',
      ],
      fields: { apiKey: { label: 'API key', hint: 'Settings → Developer → API keys.' } },
      actions: {
        list_event_types: { title: 'Event types', description: 'Event types and booking links.' },
        list_bookings: { title: 'Bookings', description: 'Meetings by status and period.' },
        get_booking: { title: 'Get a booking', description: 'Attendees, location and answers.' },
        cancel_booking: { title: 'Cancel', description: 'Cancels a meeting and notifies attendees.' },
        confirm_booking: { title: 'Confirm', description: 'Confirms a pending booking.' },
      },
    },
  },
};

export default withUi(manifest, ui);
