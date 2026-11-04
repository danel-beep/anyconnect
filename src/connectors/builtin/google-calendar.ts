import { defineManifestConnector } from '../manifest/compile.js';
import type { CapabilityBinding, CapabilityOutput } from '../sdk.js';
import { type ConnectorUi, withUi } from '../sdk.js';

const calendarId = {
  type: 'string',
  default: 'primary',
  description: 'Calendar id from gcal_list_calendars; "primary" is the main calendar',
};
const eventId = { type: 'string', minLength: 1, description: 'Event id' };
const when = (what: string) => ({
  type: 'object',
  description: `${what}: {"dateTime":"2026-11-05T15:00:00+03:00"} or {"date":"2026-11-05"} for all-day`,
  properties: {
    dateTime: { type: 'string', description: 'RFC 3339 with offset' },
    date: { type: 'string', description: 'YYYY-MM-DD (all-day events)' },
    timeZone: { type: 'string', description: 'IANA zone, e.g. Europe/Moscow' },
  },
});
const eventFields = {
  summary: { type: 'string', description: 'Title' },
  description: { type: 'string' },
  location: { type: 'string' },
  start: when('Start'),
  end: when('End'),
  attendees: {
    type: 'array',
    items: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
    description: 'e.g. [{"email":"ann@example.com"}]',
  },
  sendUpdates: {
    type: 'string',
    enum: ['all', 'externalOnly', 'none'],
    default: 'none',
    description: 'Email invitations',
  },
};
const eventBody = {
  summary: '{{input.summary}}',
  description: '{{input.description}}',
  location: '{{input.location}}',
  start: '{{input.start}}',
  end: '{{input.end}}',
  attendees: '{{input.attendees}}',
};
const EVENT_FIELDS = [
  'id',
  'summary',
  'start.dateTime',
  'start.date',
  'end.dateTime',
  'end.date',
  'location',
  'status',
  'hangoutLink',
  'htmlLink',
];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Canonical time → Google's {date} (all-day) or {dateTime}. */
const googleTime = (value: unknown) =>
  typeof value === 'string' && DATE.test(value) ? { date: value } : { dateTime: value };
/** Range bounds must be RFC 3339; a bare date is midnight UTC. */
const rangeBound = (value: unknown) =>
  typeof value === 'string' && DATE.test(value) ? `${value}T00:00:00Z` : value;

interface GoogleEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  htmlLink?: string;
}

const listEvents: CapabilityBinding = {
  id: 'calendar.list_events',
  mapInput: ({ from, to, query, limit }) => ({
    timeMin: rangeBound(from),
    timeMax: rangeBound(to),
    ...(query ? { q: query } : {}),
    maxResults: limit,
  }),
  mapOutput: (result) => {
    const { items, nextCursor } = result as { items: GoogleEvent[]; nextCursor?: string };
    return {
      items: items.map(
        (e): CapabilityOutput<'calendar.list_events'> => ({
          id: e.id,
          title: e.summary ?? '',
          start: e.start?.dateTime ?? e.start?.date ?? '',
          ...(e.end?.dateTime || e.end?.date ? { end: e.end.dateTime ?? e.end.date } : {}),
          ...(e.start?.date ? { all_day: true } : {}),
          ...(e.location ? { location: e.location } : {}),
          ...(e.htmlLink ? { url: e.htmlLink } : {}),
        }),
      ),
      ...(nextCursor ? { nextCursor } : {}),
    };
  },
};

const createEvent: CapabilityBinding = {
  id: 'calendar.create_event',
  mapInput: ({ title, start, end, description, location, attendees }) => ({
    summary: title,
    start: googleTime(start),
    end: googleTime(end),
    ...(description ? { description } : {}),
    ...(location ? { location } : {}),
    ...(Array.isArray(attendees) && attendees.length
      ? { attendees: attendees.map((email) => ({ email })) }
      : {}),
  }),
  mapOutput: (result) => {
    const e = result as GoogleEvent;
    return { id: e.id, ...(e.htmlLink ? { url: e.htmlLink } : {}) };
  },
};

/** Google Calendar API v3 over OAuth (the Google provider is shared with Gmail and Drive). */
const manifest = defineManifestConnector(
  {
    id: 'gcal',
    name: 'Google Calendar',
    description: 'Google Calendar: events, free/busy, create, update and delete events.',
    version: '1.0.0',
    homepage: 'https://developers.google.com/workspace/calendar/api',
    instructions:
      'Times are RFC 3339 with an offset (2026-11-05T15:00:00+03:00). Recurring events are expanded into single instances in gcal_list_events.',
    baseUrl: 'https://www.googleapis.com/calendar/v3',
    auth: { type: 'oauth2', provider: 'google', scopes: ['https://www.googleapis.com/auth/calendar'] },
    errorMessagePaths: ['error.message'],
    pagination: { type: 'cursor', param: 'pageToken', nextPath: 'nextPageToken' },
    test: {
      request: { method: 'GET', path: '/users/me/calendarList/primary' },
      identity: '{{response.id}}',
    },
    actions: [
      {
        name: 'list_calendars',
        title: 'List calendars',
        description: 'Lists calendars of the account with ids and access role.',
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/users/me/calendarList', query: { maxResults: 250 } },
        response: { root: 'items', fields: ['id', 'summary', 'primary', 'accessRole', 'timeZone'] },
      },
      {
        name: 'list_events',
        title: 'List events',
        description: 'Events in a time range, ordered by start. Optional text search.',
        input: {
          type: 'object',
          properties: {
            calendar_id: calendarId,
            timeMin: { type: 'string', description: 'Range start, RFC 3339' },
            timeMax: { type: 'string', description: 'Range end, RFC 3339' },
            q: { type: 'string', description: 'Free-text search in title, description, location, attendees' },
            maxResults: { type: 'integer', minimum: 1, maximum: 250, default: 50 },
          },
          required: ['timeMin', 'timeMax'],
        },
        hints: { readOnly: true, idempotent: true },
        request: {
          method: 'GET',
          path: '/calendars/{calendar_id}/events',
          query: {
            timeMin: '{{input.timeMin}}',
            timeMax: '{{input.timeMax}}',
            q: '{{input.q}}',
            maxResults: '{{input.maxResults}}',
            singleEvents: true,
            orderBy: 'startTime',
          },
        },
        response: { root: 'items', fields: EVENT_FIELDS },
        pagination: true,
      },
      {
        name: 'get_event',
        title: 'Get event',
        description: 'One event with description, attendees and their responses.',
        input: {
          type: 'object',
          properties: { calendar_id: calendarId, event_id: eventId },
          required: ['event_id'],
        },
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/calendars/{calendar_id}/events/{event_id}' },
        response: {
          fields: [...EVENT_FIELDS, 'description', 'attendees', 'organizer.email', 'recurringEventId'],
        },
      },
      {
        name: 'create_event',
        title: 'Create event',
        description: 'Creates an event; invitations are emailed only if sendUpdates is "all".',
        input: {
          type: 'object',
          properties: { calendar_id: calendarId, ...eventFields },
          required: ['summary', 'start', 'end'],
        },
        hints: { readOnly: false, destructive: false },
        risk: 'write',
        undo: { kind: 'action', action: 'delete_event' },
        request: {
          method: 'POST',
          path: '/calendars/{calendar_id}/events',
          query: { sendUpdates: '{{input.sendUpdates}}' },
          body: eventBody,
        },
        response: { fields: EVENT_FIELDS },
      },
      {
        name: 'quick_add',
        title: 'Quick add',
        description: 'Creates an event from a short English phrase, e.g. "Lunch with Ann tomorrow 1pm".',
        input: {
          type: 'object',
          properties: { calendar_id: calendarId, text: { type: 'string', minLength: 1 } },
          required: ['text'],
        },
        hints: { readOnly: false, destructive: false },
        risk: 'write',
        request: {
          method: 'POST',
          path: '/calendars/{calendar_id}/events/quickAdd',
          query: { text: '{{input.text}}' },
        },
        response: { fields: EVENT_FIELDS },
      },
      {
        name: 'update_event',
        title: 'Update event',
        description: 'Changes only the given fields of an event (time, title, place, attendees).',
        input: {
          type: 'object',
          properties: { calendar_id: calendarId, event_id: eventId, ...eventFields },
          required: ['event_id'],
        },
        hints: { readOnly: false, destructive: false, idempotent: true },
        risk: 'write',
        request: {
          method: 'PATCH',
          path: '/calendars/{calendar_id}/events/{event_id}',
          query: { sendUpdates: '{{input.sendUpdates}}' },
          body: eventBody,
        },
        response: { fields: EVENT_FIELDS },
      },
      {
        name: 'delete_event',
        title: 'Delete event',
        description: 'Deletes (cancels) an event.',
        input: {
          type: 'object',
          properties: { calendar_id: calendarId, event_id: eventId, sendUpdates: eventFields.sendUpdates },
          required: ['event_id'],
        },
        hints: { readOnly: false, destructive: true, idempotent: true },
        risk: 'dangerous',
        request: {
          method: 'DELETE',
          path: '/calendars/{calendar_id}/events/{event_id}',
          query: { sendUpdates: '{{input.sendUpdates}}' },
        },
        response: { empty: 'Deleted.' },
      },
      {
        name: 'free_busy',
        title: 'Free/busy',
        description: 'Busy intervals of one or more calendars in a time range, to find a free slot.',
        input: {
          type: 'object',
          properties: {
            timeMin: { type: 'string', description: 'RFC 3339' },
            timeMax: { type: 'string', description: 'RFC 3339' },
            timeZone: { type: 'string' },
            items: {
              type: 'array',
              items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
              default: [{ id: 'primary' }],
              description: 'Calendars, e.g. [{"id":"primary"},{"id":"ann@example.com"}]',
            },
          },
          required: ['timeMin', 'timeMax'],
        },
        hints: { readOnly: true, idempotent: true },
        request: { method: 'POST', path: '/freeBusy' },
        response: { root: 'calendars' },
      },
    ],
  },
  {
    actions: {
      list_events: { capability: listEvents },
      create_event: { capability: createEvent },
    },
  },
);

/** How the service reads on the website; the AI keeps the English texts of the manifest. */
const ui: ConnectorUi = {
  locales: {
    ru: {
      setup: {
        oauth: {
          summary: 'Ваш аккаунт Google. Меньше минуты.',
          steps: [
            {
              text: 'Нажмите «Подключить» и выберите аккаунт Google с нужными календарями.',
            },
            {
              text: 'Google попросит разрешить AnyConnect смотреть и менять события в календарях. Нажмите «Продолжить».',
            },
            {
              text: 'Готово: ИИ видит все календари этого аккаунта, в том числе общие.',
            },
          ],
          tips: [
            'Удаление событий по умолчанию ждёт вашего подтверждения (см. «Правила»).',
            'Рабочий и личный календари в разных аккаунтах Google? Подключите оба.',
          ],
        },
      },
      prompts: [
        'Что у меня в календаре на завтра?',
        'Найди свободный час в четверг после обеда и поставь «Созвон с Алексом».',
        'Перенеси сегодняшнюю встречу в 15:00 на пятницу на то же время.',
        'Сколько часов встреч у меня было на прошлой неделе?',
      ],
      name: 'Google Календарь',
      description: 'Google Календарь: события, занятость, создание, изменение и удаление встреч.',
      actions: {
        list_calendars: {
          title: 'Список календарей',
          description: 'Календари аккаунта и права доступа к ним.',
        },
        list_events: {
          title: 'События',
          description: 'События за период в порядке начала. Можно искать по тексту.',
        },
        get_event: { title: 'Событие', description: 'Одно событие с описанием, участниками и их ответами.' },
        create_event: {
          title: 'Новое событие',
          description: 'Создаёт событие. Приглашения участникам уходят, только если об этом попросить.',
        },
        quick_add: {
          title: 'Быстрое создание',
          description:
            'Создаёт событие по короткой фразе на английском, например «Lunch with Ann tomorrow 1pm».',
        },
        update_event: {
          title: 'Изменение события',
          description: 'Меняет только то, что указано: время, название, место или участников.',
        },
        delete_event: { title: 'Удаление события', description: 'Удаляет (отменяет) событие.' },
        free_busy: {
          title: 'Занятость',
          description: 'Когда заняты один или несколько календарей за период — чтобы найти свободное время.',
        },
      },
    },
    en: {
      setup: {
        oauth: {
          summary: 'Your Google account. Takes under a minute.',
          steps: [
            {
              text: 'Click Connect and choose the Google account whose calendars you want to add.',
            },
            {
              text: 'Google asks to let AnyConnect see and edit events in your calendars. Click Continue.',
            },
            {
              text: 'Done: the AI sees every calendar of that account, including shared ones.',
            },
          ],
          tips: [
            'Deleting events waits for your confirmation by default (see Rules).',
            'Work and personal calendars in different Google accounts? Connect each account.',
          ],
        },
      },
      prompts: [
        'What is on my calendar tomorrow?',
        'Find a free hour on Thursday afternoon and book “Call with Alex”.',
        'Move my 3 pm meeting today to Friday at the same time.',
        'How many hours of meetings did I have last week?',
      ],
      actions: {
        list_calendars: {
          title: 'List calendars',
          description: 'Calendars of the account and your access to them.',
        },
        list_events: {
          title: 'Events',
          description: 'Events in a time range, by start time. Optional text search.',
        },
        get_event: {
          title: 'Event',
          description: 'One event with its description, attendees and their responses.',
        },
        create_event: {
          title: 'Create an event',
          description: 'Creates an event. Attendees get invitations only when asked to.',
        },
        quick_add: {
          title: 'Quick add',
          description: 'Creates an event from a short English phrase, e.g. “Lunch with Ann tomorrow 1pm”.',
        },
        update_event: {
          title: 'Update an event',
          description: 'Changes only the given details: time, title, place or attendees.',
        },
        delete_event: { title: 'Delete an event', description: 'Deletes (cancels) an event.' },
        free_busy: {
          title: 'Free/busy',
          description: 'When one or more calendars are busy in a time range, to find a free slot.',
        },
      },
    },
  },
};

export default withUi(manifest, ui);
