import { describe, expect, it } from 'vitest';
import outlook, { graphTime, recipients } from '../../src/connectors/builtin/outlook.js';
import { fakeRoutes, json, type RecordedRequest, testAccount } from './harness.js';

const G = '/v1.0/me';
const message = {
  id: 'AAMk1',
  conversationId: 'conv1',
  subject: 'Contract',
  from: { emailAddress: { name: 'Ivan', address: 'ivan@example.test' } },
  toRecipients: [{ emailAddress: { name: 'Me', address: 'me@outlook.com' } }],
  receivedDateTime: '2026-11-02T10:00:00Z',
  bodyPreview: 'Please sign and return. ',
  isRead: false,
  hasAttachments: true,
  flag: { flagStatus: 'notFlagged' },
};

function setup(config: Record<string, unknown> = {}) {
  const service = fakeRoutes({
    [`GET ${G}`]: { mail: 'me@outlook.com', userPrincipalName: 'me@outlook.com' },
    [`GET ${G}/mailFolders/inbox/messages`]: {
      value: [message],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=15&$top=15',
    },
    [`GET ${G}/messages/AAMk1`]: {
      ...message,
      body: { contentType: 'text', content: 'Please sign and return.\r\n\r\nFrom: Bob\r\nold text' },
      uniqueBody: { contentType: 'text', content: 'Please sign and return.' },
      webLink: 'https://outlook.office.com/mail/AAMk1',
    },
    [`PATCH ${G}/messages/AAMk1`]: (req: RecordedRequest) => json({ ...message, ...JSON.parse(req.body!) }),
    [`GET ${G}/messages/AAMk1/attachments`]: {
      value: [
        { name: 'contract.pdf', contentType: 'application/pdf', size: 1234, isInline: false },
        { name: 'logo.png', contentType: 'image/png', size: 99, isInline: true },
      ],
    },
    [`POST ${G}/messages/AAMk1/replyAll`]: () => new Response(null, { status: 202 }),
    [`POST ${G}/messages/AAMk1/forward`]: () => new Response(null, { status: 202 }),
    [`POST ${G}/messages/AAMk1/move`]: { ...message, id: 'AAMk1-moved' },
    [`POST ${G}/messages/AAMk1/createReply`]: { id: 'draft1' },
    [`POST ${G}/messages`]: { id: 'draft2', webLink: 'https://outlook.office.com/mail/draft2' },
    [`POST ${G}/messages/draft1/send`]: () => new Response(null, { status: 202 }),
    [`POST ${G}/messages/draft2/send`]: () => new Response(null, { status: 202 }),
    [`GET ${G}/calendarView`]: {
      value: [
        {
          id: 'ev1',
          subject: 'Standup',
          start: { dateTime: '2026-11-05T10:00:00.0000000', timeZone: 'Europe/Moscow' },
          end: { dateTime: '2026-11-05T10:15:00.0000000', timeZone: 'Europe/Moscow' },
          isAllDay: false,
          showAs: 'busy',
          onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/1' },
          webLink: 'https://outlook.office.com/calendar/ev1',
        },
        {
          id: 'ev2',
          subject: 'Vacation',
          start: { dateTime: '2026-11-06T00:00:00.0000000', timeZone: 'Europe/Moscow' },
          end: { dateTime: '2026-11-07T00:00:00.0000000', timeZone: 'Europe/Moscow' },
          isAllDay: true,
          showAs: 'oof',
        },
      ],
    },
    [`POST ${G}/events`]: (req: RecordedRequest) => json({ id: 'new1', ...JSON.parse(req.body!) }),
    [`POST ${G}/events/ev1/cancel`]: () => new Response(null, { status: 202 }),
  });
  return {
    service,
    acc: testAccount(outlook, { config, fetch: service.fetch, oauth: { accessToken: 'eyJ.token' } }),
  };
}

describe('outlook', () => {
  it('parses recipients and converts times for Graph', () => {
    expect(recipients(['Ann <ann@example.test>', 'bob@example.test', 'junk'])).toEqual([
      { emailAddress: { address: 'ann@example.test', name: 'Ann' } },
      { emailAddress: { address: 'bob@example.test' } },
    ]);
    expect(graphTime('2026-11-05T15:00:00+03:00', 'Europe/Moscow')).toEqual({
      dateTime: '2026-11-05T12:00:00',
      timeZone: 'UTC',
    });
    expect(graphTime('2026-11-05T15:00', 'Europe/Moscow')).toEqual({
      dateTime: '2026-11-05T15:00',
      timeZone: 'Europe/Moscow',
    });
    expect(graphTime('2026-11-05', 'UTC')).toEqual({ dateTime: '2026-11-05T00:00:00', timeZone: 'UTC' });
    expect(() => graphTime('tomorrow', 'UTC')).toThrow(/Invalid time/);
  });

  it('identifies the account and needs OAuth', async () => {
    const { acc, service } = setup();
    expect(await outlook.test!(acc.ctx)).toEqual({ ok: true, identity: 'me@outlook.com' });
    expect(service.calls[0]!.headers.get('authorization')).toBe('Bearer eyJ.token');
    await expect(testAccount(outlook, {}).run('search')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('lists the inbox newest first and pages with a Graph-only cursor', async () => {
    const { acc, service } = setup();
    const page = (await acc.run('search', { unreadOnly: true })) as {
      messages: unknown[];
      nextCursor: string;
    };
    const q = service.calls[0]!.url.searchParams;
    expect(q.get('$orderby')).toBe('receivedDateTime desc');
    expect(q.get('$filter')).toBe('isRead eq false');
    expect(page.messages[0]).toEqual({
      id: 'AAMk1',
      threadId: 'conv1',
      date: '2026-11-02T10:00:00Z',
      from: 'Ivan <ivan@example.test>',
      to: ['Me <me@outlook.com>'],
      subject: 'Contract',
      snippet: 'Please sign and return.',
      unread: true,
      attachments: true,
    });
    await acc.run('search', { cursor: page.nextCursor });
    expect(service.calls[1]!.url.toString()).toBe(
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=15&$top=15',
    );
    for (const bad of ['https://evil.test/x?a', '//evil.test/x?a', '../../x?a']) {
      await expect(
        acc.run('search', { cursor: Buffer.from(bad).toString('base64url') }),
      ).rejects.toMatchObject({ kind: 'invalid_input' });
    }
  });

  it('searches with KQL, without ordering or filters Graph refuses', async () => {
    const { acc, service } = setup();
    await acc.run('search', { query: 'from:ivan "signed contract"', unreadOnly: true });
    const q = service.calls[0]!.url.searchParams;
    expect(q.get('$search')).toBe('"from:ivan \\"signed contract\\" isread:false"');
    expect(q.has('$orderby')).toBe(false);
    expect(q.has('$filter')).toBe(false);
  });

  it('reads the new part of a message as text with real attachments, with immutable ids', async () => {
    const { acc, service } = setup();
    const read = (await acc.run('read', { id: 'AAMk1' })) as Record<string, unknown>;
    expect(service.calls[0]!.headers.get('prefer')).toBe(
      'IdType="ImmutableId", outlook.body-content-type="text"',
    );
    expect(read).toMatchObject({
      id: 'AAMk1',
      from: 'Ivan <ivan@example.test>',
      to: ['Me <me@outlook.com>'],
      text: 'Please sign and return.',
      quotedHistoryRemoved: true,
      attachments: [{ filename: 'contract.pdf', contentType: 'application/pdf', size: 1234 }],
      url: 'https://outlook.office.com/mail/AAMk1',
    });
    expect(read.unread).toBe(true);
    expect(service.calls.some((c) => c.method === 'PATCH')).toBe(false);
    const full = (await acc.run('read', { id: 'AAMk1', includeQuoted: true, maxChars: 500 })) as {
      text: string;
    };
    expect(full.text).toContain('old text');
  });

  it('sends, replies to all with extra copies, forwards and drafts replies', async () => {
    const { acc, service } = setup();
    expect(
      await acc.run('send', {
        to: ['Ann <ann@example.test>'],
        subject: 'Hi',
        body: 'Hello',
        bcc: ['b@x.test'],
      }),
    ).toEqual({ sent: true, id: 'draft2', to: ['Ann <ann@example.test>'] });
    // A draft, then send: the sent message keeps the draft's immutable id.
    expect(JSON.parse(service.calls[0]!.body!)).toEqual({
      subject: 'Hi',
      body: { contentType: 'Text', content: 'Hello' },
      toRecipients: [{ emailAddress: { address: 'ann@example.test', name: 'Ann' } }],
      bccRecipients: [{ emailAddress: { address: 'b@x.test' } }],
    });
    expect(service.calls[1]!.url.pathname).toBe(`${G}/messages/draft2/send`);
    await acc.run('send', { to: ['ivan@example.test'], body: 'Signed.', replyToId: 'AAMk1' });
    expect(service.calls[2]!.url.pathname).toBe(`${G}/messages/AAMk1/createReply`);
    expect(JSON.parse(service.calls[2]!.body!)).toEqual({
      message: { toRecipients: [{ emailAddress: { address: 'ivan@example.test' } }] },
      comment: 'Signed.',
    });
    expect(service.calls[3]!.url.pathname).toBe(`${G}/messages/draft1/send`);
    await acc.run('reply', { id: 'AAMk1', body: 'Signed.', replyAll: true, cc: ['boss@example.test'] });
    expect(JSON.parse(service.calls[4]!.body!)).toEqual({
      comment: 'Signed.',
      message: { ccRecipients: [{ emailAddress: { address: 'boss@example.test' } }] },
    });
    await acc.run('forward', { id: 'AAMk1', to: ['lawyer@example.test'], body: 'FYI' });
    expect(JSON.parse(service.calls[5]!.body!)).toMatchObject({ comment: 'FYI' });
    expect(await acc.run('create_draft', { body: 'Draft reply', replyToId: 'AAMk1' })).toEqual({
      draftId: 'draft1',
    });
  });

  it('moves by friendly folder names', async () => {
    const { acc, service } = setup();
    expect(await acc.run('move', { ids: ['AAMk1'], folder: 'trash' })).toEqual({ moved: 1, folder: 'trash' });
    expect(JSON.parse(service.calls[0]!.body!)).toEqual({ destinationId: 'deleteditems' });
    await acc.run('mark', { ids: ['AAMk1'], flagged: true });
    expect(JSON.parse(service.calls[1]!.body!)).toEqual({ flag: { flagStatus: 'flagged' } });
    await expect(acc.run('mark', { ids: ['AAMk1'] })).rejects.toMatchObject({ kind: 'invalid_input' });
  });

  it('lists events in the account time zone with compact fields', async () => {
    const { acc, service } = setup({ timeZone: 'Europe/Moscow' });
    const result = (await acc.run('list_events', {
      from: '2026-11-05T00:00:00+03:00',
      to: '2026-11-08T00:00:00+03:00',
    })) as { timeZone: string; events: unknown[] };
    const call = service.calls[0]!;
    expect(call.headers.get('prefer')).toBe('IdType="ImmutableId", outlook.timezone="Europe/Moscow"');
    expect(call.url.searchParams.get('startDateTime')).toBe('2026-11-05T00:00:00+03:00');
    expect(result.timeZone).toBe('Europe/Moscow');
    expect(result.events).toEqual([
      {
        id: 'ev1',
        subject: 'Standup',
        start: '2026-11-05T10:00:00+03:00',
        end: '2026-11-05T10:15:00+03:00',
        meetingUrl: 'https://teams.microsoft.com/l/meetup-join/1',
        url: 'https://outlook.office.com/calendar/ev1',
      },
      { id: 'ev2', subject: 'Vacation', start: '2026-11-06', end: '2026-11-07', allDay: true, showAs: 'oof' },
    ]);
  });

  it('creates timed and all-day events with sensible default ends, and cancels meetings', async () => {
    const { acc, service } = setup();
    await acc.run('create_event', {
      subject: 'Call',
      start: '2026-11-05T15:00:00+03:00',
      attendees: ['ann@example.test'],
      online: true,
    });
    expect(JSON.parse(service.calls[0]!.body!)).toEqual({
      subject: 'Call',
      isAllDay: false,
      start: { dateTime: '2026-11-05T12:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-11-05T13:00:00', timeZone: 'UTC' },
      attendees: [{ emailAddress: { address: 'ann@example.test' }, type: 'required' }],
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
    });
    await acc.run('create_event', { subject: 'Trip', start: '2026-12-31' });
    expect(JSON.parse(service.calls[1]!.body!)).toMatchObject({
      isAllDay: true,
      start: { dateTime: '2026-12-31T00:00:00', timeZone: 'UTC' },
      end: { dateTime: '2027-01-01T00:00:00', timeZone: 'UTC' },
    });
    await expect(
      acc.run('create_event', { subject: 'Bad', start: '2026-12-31', end: '2027-01-01T10:00:00Z' }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(await acc.run('delete_event', { id: 'ev1', cancel: true, comment: 'Sorry' })).toEqual({
      cancelled: true,
    });
  });
});
