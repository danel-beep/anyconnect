import { describe, expect, it } from 'vitest';
import gmail from '../../src/connectors/builtin/gmail.js';
import gcal from '../../src/connectors/builtin/google-calendar.js';
import gdrive from '../../src/connectors/builtin/google-drive.js';
import http from '../../src/connectors/builtin/http.js';
import notion from '../../src/connectors/builtin/notion/index.js';
import outlook, { rfc3339 } from '../../src/connectors/builtin/outlook.js';
import slack from '../../src/connectors/builtin/slack.js';
import todoist from '../../src/connectors/builtin/todoist.js';
import { createBuiltinRegistry } from '../../src/connectors/index.js';
import { defineManifestConnector } from '../../src/connectors/manifest/compile.js';
import { actionCapabilities } from '../../src/connectors/sdk.js';
import { fakeRoutes, json, type RecordedRequest, testAccount } from './harness.js';

/**
 * The shared capabilities (mail.*, calendar.*, files.*, tasks.*, messages.*) of every built-in
 * connector, called the way the hub calls them: canonical input in, canonical output out, checked
 * strictly against the capability schemas. IMAP is covered against real servers in imap.test.ts.
 */

const oauth = { accessToken: 'token' };

describe('built-in connectors and the core rules', () => {
  const connectors = createBuiltinRegistry().all();

  it('declare an explicit risk on every write action', () => {
    const missing = connectors.flatMap((c) =>
      c.actions.filter((a) => !a.hints?.readOnly && !a.risk).map((a) => `${c.id}.${a.name}`),
    );
    expect(missing).toEqual([]);
  });

  it('implement the expected capabilities', () => {
    const map = Object.fromEntries(
      connectors.map((c) => [c.id, c.actions.flatMap((a) => actionCapabilities(a).map((b) => b.id)).sort()]),
    );
    expect(map).toMatchObject({
      imap: ['mail.read', 'mail.search', 'mail.send'],
      gmail: ['mail.read', 'mail.search', 'mail.send'],
      outlook: ['calendar.create_event', 'calendar.list_events', 'mail.read', 'mail.search', 'mail.send'],
      gcal: ['calendar.create_event', 'calendar.list_events'],
      gdrive: ['files.read', 'files.search'],
      notion: ['files.read', 'files.search'],
      todoist: ['tasks.create', 'tasks.list'],
      jira: ['tasks.create', 'tasks.list'],
      linear: ['tasks.create', 'tasks.list'],
      asana: ['tasks.create', 'tasks.list'],
      trello: ['tasks.list'],
      hubspot: ['contacts.search'],
      confluence: ['files.read', 'files.search'],
      clickup: ['tasks.create', 'tasks.list'],
      calendly: ['calendar.list_events'],
      zendesk: ['contacts.search'],
      intercom: ['contacts.search'],
      pipedrive: ['contacts.search'],
      freshdesk: ['contacts.search'],
      calcom: ['calendar.list_events'],
      slack: ['messages.list_chats', 'messages.read_chat', 'messages.search', 'messages.send'],
    });
  });

  it('refuse manifest extensions for unknown actions', () => {
    expect(() =>
      defineManifestConnector(
        {
          id: 'x_test',
          name: 'X',
          description: 'x',
          version: '1.0.0',
          baseUrl: 'https://x.test',
          auth: { type: 'none' },
          actions: [{ name: 'a', description: 'a', request: { method: 'GET', path: '/' } }],
        },
        { actions: { b: { risk: 'write' } } },
      ),
    ).toThrow(/unknown action "x_test.b"/);
  });

  it('raise the risk of DELETE requests of the generic HTTP connector', async () => {
    const request = http.actions.find((a) => a.name === 'request')!;
    const ctx = testAccount(http, { config: { baseUrl: 'https://api.test' } }).ctx;
    expect(await request.assessRisk!({ method: 'DELETE', path: '/x' }, ctx as never)).toMatchObject({
      risk: 'dangerous',
    });
    expect(await request.assessRisk!({ method: 'POST', path: '/x' }, ctx as never)).toBeUndefined();
  });
});

describe('gmail capabilities', () => {
  const raw = Buffer.from(
    [
      'From: Ivan <ivan@example.test>',
      'To: me@gmail.com',
      'Subject: Contract',
      'Message-ID: <c1@example.test>',
      'Date: Mon, 02 Nov 2026 10:00:00 +0000',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Please sign.',
    ].join('\r\n'),
  ).toString('base64url');
  const service = fakeRoutes({
    'GET /gmail/v1/users/me/messages': { messages: [{ id: 'm1' }] },
    'GET /gmail/v1/users/me/messages/m1': (req: RecordedRequest) =>
      json(
        req.url.searchParams.get('format') === 'raw'
          ? { id: 'm1', threadId: 't1', labelIds: ['INBOX'], raw }
          : {
              id: 'm1',
              threadId: 't1',
              labelIds: ['INBOX', 'UNREAD'],
              snippet: 'Please sign.',
              internalDate: '1793613600000',
              payload: {
                headers: [
                  { name: 'From', value: 'Ivan <ivan@example.test>' },
                  { name: 'To', value: 'Me <me@gmail.com>, team@example.test' },
                  { name: 'Subject', value: 'Contract' },
                ],
              },
            },
      ),
    'POST /gmail/v1/users/me/messages/send': (req: RecordedRequest) =>
      json({ id: 'sent1', threadId: JSON.parse(req.body!).threadId }),
  });
  const acc = testAccount(gmail, { fetch: service.fetch, oauth });

  it('turns a canonical search into Gmail syntax', async () => {
    const result = await acc.runCapability('mail.search', {
      query: 'contract',
      from: 'Ivan Petrov',
      since: '2026-11-01T00:00:00Z',
      unread_only: true,
    });
    expect(service.calls[0]!.url.searchParams.get('q')).toBe(
      'contract from:"Ivan Petrov" after:1793491200 is:unread',
    );
    expect(result.items).toEqual([
      {
        id: 'm1',
        thread_id: 't1',
        from: 'Ivan <ivan@example.test>',
        to: ['Me <me@gmail.com>', 'team@example.test'],
        subject: 'Contract',
        date: '2026-11-02T10:00:00Z',
        snippet: 'Please sign.',
        unread: true,
        has_attachments: false,
      },
    ]);
  });

  it('reads and replies in the thread through mail.send', async () => {
    expect(await acc.runCapability('mail.read', { id: 'm1' })).toMatchObject({
      id: 'm1',
      thread_id: 't1',
      body: 'Please sign.',
    });
    const sent = await acc.runCapability('mail.send', {
      to: ['ivan@example.test'],
      subject: '',
      body: 'Signed.',
      reply_to_id: 'm1',
    });
    expect(sent).toEqual({ id: 'sent1' });
    expect(JSON.parse(service.calls.at(-1)!.body!).threadId).toBe('t1');
  });
});

describe('outlook capabilities', () => {
  const service = fakeRoutes({
    'GET /v1.0/me/messages': {
      value: [
        {
          id: 'AAMk1',
          conversationId: 'conv1',
          subject: 'Contract',
          from: { emailAddress: { name: 'Ivan', address: 'ivan@example.test' } },
          receivedDateTime: '2026-11-02T10:00:00Z',
          bodyPreview: 'Please sign.',
          isRead: true,
          hasAttachments: false,
        },
      ],
    },
    'GET /v1.0/me/messages/AAMk1': {
      id: 'AAMk1',
      subject: 'Contract',
      from: { emailAddress: { address: 'ivan@example.test' } },
      body: { content: 'Please sign.' },
      webLink: 'https://outlook.office.com/mail/AAMk1',
    },
    'GET /v1.0/me/calendarView': {
      value: [
        {
          id: 'ev1',
          subject: 'Standup',
          start: { dateTime: '2026-11-05T07:00:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-11-05T07:15:00.0000000', timeZone: 'UTC' },
        },
        {
          id: 'ev2',
          subject: 'Lunch',
          start: { dateTime: '2026-11-05T10:00:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-11-05T11:00:00.0000000', timeZone: 'UTC' },
        },
      ],
    },
    'POST /v1.0/me/events': (req: RecordedRequest) =>
      json({ id: 'new1', webLink: 'https://outlook.office.com/calendar/new1', ...JSON.parse(req.body!) }),
  });
  const acc = testAccount(outlook, { fetch: service.fetch, oauth });

  it('searches all mail with KQL and reads', async () => {
    const result = await acc.runCapability('mail.search', {
      from: 'ivan',
      since: '2026-11-01',
      until: '2026-11-03T12:00:00Z',
    });
    expect(service.calls[0]!.url.searchParams.get('$search')).toBe(
      '"from:ivan received>=2026-11-01 received<2026-11-04"',
    );
    expect(result.items[0]).toMatchObject({ id: 'AAMk1', thread_id: 'conv1', unread: false });
    expect(await acc.runCapability('mail.read', { id: 'AAMk1' })).toMatchObject({
      body: 'Please sign.',
      url: 'https://outlook.office.com/mail/AAMk1',
    });
  });

  it('lists events filtered by the query and creates events', async () => {
    const listed = await acc.runCapability('calendar.list_events', {
      from: '2026-11-05',
      to: '2026-11-06',
      query: 'lunch',
    });
    const view = service.calls.find((c) => c.url.pathname.endsWith('/calendarView'))!;
    expect(view.url.searchParams.get('startDateTime')).toBe('2026-11-05T00:00:00Z');
    expect(listed.items).toEqual([
      { id: 'ev2', title: 'Lunch', start: '2026-11-05T10:00:00Z', end: '2026-11-05T11:00:00Z' },
    ]);
    const created = await acc.runCapability('calendar.create_event', {
      title: 'Call',
      start: '2026-11-05T15:00:00+03:00',
      end: '2026-11-05T15:30:00+03:00',
      attendees: ['ann@example.test'],
    });
    expect(created).toEqual({ id: 'new1', url: 'https://outlook.office.com/calendar/new1' });
    expect(JSON.parse(service.calls.at(-1)!.body!)).toMatchObject({
      subject: 'Call',
      end: { dateTime: '2026-11-05T12:30:00', timeZone: 'UTC' },
    });
  });

  it('gives calendar times the offset of their zone, including daylight saving', () => {
    expect(rfc3339({ dateTime: '2026-11-05T10:00:00.0000000', timeZone: 'Europe/Moscow' }, false)).toBe(
      '2026-11-05T10:00:00+03:00',
    );
    expect(rfc3339({ dateTime: '2026-07-01T09:00:00', timeZone: 'America/New_York' }, false)).toBe(
      '2026-07-01T09:00:00-04:00',
    );
    expect(rfc3339({ dateTime: '2026-12-01T09:00:00', timeZone: 'America/New_York' }, false)).toBe(
      '2026-12-01T09:00:00-05:00',
    );
    expect(rfc3339({ dateTime: '2026-12-01T00:00:00', timeZone: 'UTC' }, true)).toBe('2026-12-01');
  });
});

describe('google calendar and drive capabilities', () => {
  const service = fakeRoutes({
    'GET /calendar/v3/calendars/primary/events': {
      items: [
        {
          id: 'e1',
          summary: 'Trip',
          start: { date: '2026-11-07' },
          end: { date: '2026-11-08' },
          htmlLink: 'https://calendar.google.com/e1',
        },
      ],
    },
    'POST /calendar/v3/calendars/primary/events': (req: RecordedRequest) =>
      json({ id: 'new1', htmlLink: 'https://calendar.google.com/new1', ...JSON.parse(req.body!) }),
    'GET /drive/v3/files': {
      files: [{ id: 'd1', name: 'Plan', mimeType: 'application/vnd.google-apps.document', size: '10' }],
    },
    'GET /drive/v3/files/d1': { id: 'd1', name: 'Plan', mimeType: 'application/vnd.google-apps.document' },
    'GET /drive/v3/files/d1/export': () =>
      new Response('Plan text', { headers: { 'content-type': 'text/plain' } }),
  });
  const cal = testAccount(gcal, { fetch: service.fetch, oauth });
  const drive = testAccount(gdrive, { fetch: service.fetch, oauth });

  it('maps Google events to canonical items and creates all-day events', async () => {
    const listed = await cal.runCapability('calendar.list_events', { from: '2026-11-07', to: '2026-11-09' });
    expect(service.calls[0]!.url.searchParams.get('timeMin')).toBe('2026-11-07T00:00:00Z');
    expect(listed.items).toEqual([
      {
        id: 'e1',
        title: 'Trip',
        start: '2026-11-07',
        end: '2026-11-08',
        all_day: true,
        url: 'https://calendar.google.com/e1',
      },
    ]);
    expect(
      await cal.runCapability('calendar.create_event', {
        title: 'Holiday',
        start: '2026-12-31',
        end: '2027-01-01',
      }),
    ).toEqual({ id: 'new1', url: 'https://calendar.google.com/new1' });
    expect(JSON.parse(service.calls[1]!.body!)).toEqual({
      summary: 'Holiday',
      start: { date: '2026-12-31' },
      end: { date: '2027-01-01' },
    });
  });

  it('searches and reads Drive files with real MIME types', async () => {
    const found = await drive.runCapability('files.search', { query: 'plan' });
    expect(found.items).toEqual([
      { id: 'd1', name: 'Plan', mime_type: 'application/vnd.google-apps.document', size: 10 },
    ]);
    const read = await drive.runCapability('files.read', { id: 'd1', max_chars: 100 });
    expect(read).toMatchObject({ id: 'd1', text: 'Plan text' });
  });
});

describe('notion capabilities', () => {
  const PAGE_ID = '1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9';
  const page = {
    object: 'page',
    id: PAGE_ID,
    url: 'https://www.notion.so/p1',
    last_edited_time: '2026-11-03T10:00:00.000Z',
    properties: { Name: { type: 'title', title: [{ plain_text: 'Plan' }] } },
  };
  const service = fakeRoutes({
    'POST /v1/search': { results: [page], has_more: false },
    [`GET /v1/pages/${PAGE_ID}`]: page,
    [`GET /v1/blocks/${PAGE_ID}/children`]: {
      results: [{ id: 'b1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Hello' }] } }],
      has_more: false,
    },
  });
  const acc = testAccount(notion, { credentials: { token: 'secret_x' }, fetch: service.fetch });

  it('searches pages only and reads them as text', async () => {
    const found = await acc.runCapability('files.search', { query: 'plan' });
    expect(JSON.parse(service.calls[0]!.body!).filter).toEqual({ property: 'object', value: 'page' });
    expect(found.items).toEqual([
      {
        id: PAGE_ID,
        name: 'Plan',
        mime_type: 'application/vnd.notion.page',
        modified: '2026-11-03T10:00:00.000Z',
        url: 'https://www.notion.so/p1',
      },
    ]);
    expect(await acc.runCapability('files.read', { id: PAGE_ID })).toMatchObject({
      name: 'Plan',
      text: 'Hello',
    });
  });
});

describe('todoist capabilities', () => {
  const task = {
    id: 't1',
    content: 'Pay invoice',
    project_id: 'p1',
    due: { date: '2026-11-04', string: 'today' },
    priority: 4,
    checked: false,
  };
  const service = fakeRoutes({
    'GET /api/v1/tasks/filter': { results: [task], next_cursor: null },
    'POST /api/v1/tasks': (req: RecordedRequest) => json({ ...task, ...JSON.parse(req.body!), id: 't2' }),
  });
  const acc = testAccount(todoist, { credentials: { token: 't' }, fetch: service.fetch });

  it('builds Todoist filters and maps tasks', async () => {
    const listed = await acc.runCapability('tasks.list', { query: 'invoice', due_before: '2026-11-10' });
    expect(service.calls[0]!.url.searchParams.get('query')).toBe('search: invoice & due before: 2026-11-10');
    expect(listed.items).toEqual([
      {
        id: 't1',
        title: 'Pay invoice',
        status: 'open',
        due: '2026-11-04',
        priority: 4,
        project: 'p1',
        url: 'https://app.todoist.com/app/task/t1',
      },
    ]);
    await acc.runCapability('tasks.list', {});
    expect(service.calls[1]!.url.searchParams.get('query')).toBe('p1 | p2 | p3 | p4');
    expect((await acc.runCapability('tasks.list', { status: 'done' })).items).toEqual([]);
  });

  it('creates tasks with a due date or moment', async () => {
    expect(
      await acc.runCapability('tasks.create', { title: 'Call', due: '2026-11-05T10:00:00+03:00' }),
    ).toEqual({
      id: 't2',
      url: 'https://app.todoist.com/app/task/t2',
    });
    expect(JSON.parse(service.calls.at(-1)!.body!)).toEqual({
      content: 'Call',
      due_datetime: '2026-11-05T10:00:00+03:00',
    });
  });
});

describe('slack capabilities', () => {
  const service = fakeRoutes({
    'GET /api/users.info': { ok: true, user: { id: 'U1', name: 'ann', real_name: 'Ann' } },
    'GET /api/search.messages': {
      ok: true,
      messages: {
        total: 2,
        matches: [
          {
            ts: '1793613600.000100',
            user: 'U1',
            text: 'invoice paid',
            channel: { id: 'C0GENERAL', name: 'general' },
          },
          {
            ts: '1793440800.000100',
            user: 'U1',
            text: 'old invoice',
            channel: { id: 'C0GENERAL', name: 'general' },
          },
        ],
      },
    },
    'GET /api/users.conversations': {
      ok: true,
      channels: [
        { id: 'C0GENERAL', name: 'general' },
        { id: 'D0ANN', is_im: true, user: 'U1' },
      ],
      response_metadata: { next_cursor: '' },
    },
    'GET /api/conversations.history': {
      ok: true,
      messages: [
        { ts: '1793613700.000200', user: 'U1', text: 'second' },
        { ts: '1793613600.000100', user: 'U1', text: 'first' },
      ],
      response_metadata: { next_cursor: 'older' },
    },
    'POST /api/chat.postMessage': (req: RecordedRequest) => {
      const form = new URLSearchParams(req.body);
      return json({ ok: true, channel: form.get('channel'), ts: '1793613800.000300' });
    },
  });
  const acc = testAccount(slack, { credentials: { token: 'xoxp-1' }, fetch: service.fetch });

  it('searches with Slack modifiers and exact time bounds', async () => {
    const found = await acc.runCapability('messages.search', {
      query: 'invoice',
      from: 'ann',
      since: '2026-11-02T00:00:00Z',
    });
    expect(service.calls[0]!.url.searchParams.get('query')).toBe('invoice from:@ann after:2026-11-01');
    expect(found).toEqual([
      {
        id: '1793613600.000100',
        chat_id: 'C0GENERAL',
        chat: '#general',
        from: 'Ann',
        date: '2026-11-02T10:00:00Z',
        text: 'invoice paid',
      },
    ]);
  });

  it('lists chats, reads one oldest first and replies in a thread', async () => {
    const chats = await acc.runCapability('messages.list_chats', { query: 'gen' });
    expect(chats.items).toEqual([{ id: 'C0GENERAL', title: '#general', kind: 'channel' }]);
    const history = await acc.runCapability('messages.read_chat', { chat: 'C0GENERAL' });
    expect(history.messages.map((m: { text: string }) => m.text)).toEqual(['first', 'second']);
    expect(history.nextCursor).toBe('older');
    const sent = await acc.runCapability('messages.send', {
      chat: 'C0GENERAL',
      text: 'Thanks',
      reply_to: '1793613600.000100',
    });
    expect(sent).toEqual({ id: '1793613800.000300', status: 'sent' });
    expect(new URLSearchParams(service.calls.at(-1)!.body).get('thread_ts')).toBe('1793613600.000100');
  });
});
