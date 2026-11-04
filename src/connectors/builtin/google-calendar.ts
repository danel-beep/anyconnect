import { defineManifestConnector } from '../manifest/compile.js';

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

/** Google Calendar API v3 over OAuth (the Google provider is shared with Gmail and Drive). */
export default defineManifestConnector({
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
});
