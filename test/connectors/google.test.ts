import { describe, expect, it } from 'vitest';
import gcal from '../../src/connectors/builtin/google-calendar.js';
import gdrive, { buildQuery } from '../../src/connectors/builtin/google-drive.js';
import { fakeRoutes, json, type RecordedRequest, testAccount } from './harness.js';

const oauth = { accessToken: 'ya29.token' };

describe('google calendar', () => {
  const event = {
    id: 'e1',
    summary: 'Standup',
    start: { dateTime: '2026-11-05T10:00:00+03:00' },
    end: { dateTime: '2026-11-05T10:15:00+03:00' },
    status: 'confirmed',
    htmlLink: 'https://calendar.google.com/event?eid=e1',
    etag: '"3"',
    creator: { email: 'me@gmail.com' },
    reminders: { useDefault: true },
  };

  function setup() {
    const service = fakeRoutes({
      'GET /calendar/v3/users/me/calendarList/primary': { id: 'me@gmail.com' },
      'GET /calendar/v3/calendars/primary/events': (req: RecordedRequest) =>
        json(
          req.url.searchParams.get('pageToken')
            ? { items: [{ ...event, id: 'e2' }] }
            : { items: [event], nextPageToken: 'tok2' },
        ),
      'POST /calendar/v3/calendars/ann%40example.com/events': (req: RecordedRequest) =>
        json({ ...event, ...JSON.parse(req.body!), id: 'new1' }),
      'PATCH /calendar/v3/calendars/primary/events/e1': (req: RecordedRequest) =>
        json({ ...event, ...JSON.parse(req.body!) }),
      'DELETE /calendar/v3/calendars/primary/events/e1': () => new Response(null, { status: 204 }),
      'POST /calendar/v3/freeBusy': {
        calendars: { primary: { busy: [{ start: '2026-11-05T07:00:00Z', end: '2026-11-05T08:00:00Z' }] } },
      },
    });
    return { service, acc: testAccount(gcal, { fetch: service.fetch, oauth }) };
  }

  it('reports the account identity and needs OAuth', async () => {
    const { acc, service } = setup();
    expect(await gcal.test!(acc.ctx)).toMatchObject({ ok: true, identity: 'me@gmail.com' });
    expect(service.calls[0]!.headers.get('authorization')).toBe('Bearer ya29.token');
    await expect(testAccount(gcal, {}).run('list_calendars')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('lists single events of the primary calendar with compact fields and a cursor', async () => {
    const { acc, service } = setup();
    const first = (await acc.run('list_events', {
      timeMin: '2026-11-05T00:00:00+03:00',
      timeMax: '2026-11-06T00:00:00+03:00',
    })) as { items: Record<string, unknown>[]; nextCursor?: string };
    const query = service.calls[0]!.url.searchParams;
    expect(query.get('singleEvents')).toBe('true');
    expect(query.get('orderBy')).toBe('startTime');
    expect(query.has('q')).toBe(false);
    expect(first.items[0]).toEqual({
      id: 'e1',
      summary: 'Standup',
      start: { dateTime: '2026-11-05T10:00:00+03:00' },
      end: { dateTime: '2026-11-05T10:15:00+03:00' },
      status: 'confirmed',
      htmlLink: 'https://calendar.google.com/event?eid=e1',
    });
    expect(first.nextCursor).toBeTypeOf('string');
    const second = (await acc.run('list_events', {
      timeMin: '2026-11-05T00:00:00+03:00',
      timeMax: '2026-11-06T00:00:00+03:00',
      cursor: first.nextCursor,
    })) as { items: { id: string }[]; nextCursor?: string };
    expect(service.calls[1]!.url.searchParams.get('pageToken')).toBe('tok2');
    expect(second.items.map((e) => e.id)).toEqual(['e2']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('creates an event in another calendar without emailing guests by default', async () => {
    const { acc, service } = setup();
    const created = (await acc.run('create_event', {
      calendar_id: 'ann@example.com',
      summary: 'Lunch',
      start: { dateTime: '2026-11-05T13:00:00+03:00' },
      end: { dateTime: '2026-11-05T14:00:00+03:00' },
      attendees: [{ email: 'ann@example.com' }],
    })) as Record<string, unknown>;
    const req = service.calls[0]!;
    expect(req.url.searchParams.get('sendUpdates')).toBe('none');
    expect(JSON.parse(req.body!)).toEqual({
      summary: 'Lunch',
      start: { dateTime: '2026-11-05T13:00:00+03:00' },
      end: { dateTime: '2026-11-05T14:00:00+03:00' },
      attendees: [{ email: 'ann@example.com' }],
    });
    expect(created).toMatchObject({ id: 'new1', summary: 'Lunch' });
  });

  it('patches only the given fields and deletes', async () => {
    const { acc, service } = setup();
    await acc.run('update_event', { event_id: 'e1', location: 'Room 5' });
    expect(JSON.parse(service.calls[0]!.body!)).toEqual({ location: 'Room 5' });
    expect(await acc.run('delete_event', { event_id: 'e1' })).toBe('Deleted.');
  });

  it('asks free/busy for the primary calendar by default', async () => {
    const { acc, service } = setup();
    const result = await acc.run('free_busy', {
      timeMin: '2026-11-05T00:00:00Z',
      timeMax: '2026-11-06T00:00:00Z',
    });
    expect(JSON.parse(service.calls[0]!.body!)).toMatchObject({ items: [{ id: 'primary' }] });
    expect(result).toMatchObject({ primary: { busy: [{ start: '2026-11-05T07:00:00Z' }] } });
  });
});

describe('google drive', () => {
  const doc = {
    id: 'd1',
    name: 'Plan',
    mimeType: 'application/vnd.google-apps.document',
    modifiedTime: '2026-11-03T10:00:00.000Z',
    webViewLink: 'https://docs.google.com/document/d/d1',
    parents: ['root1'],
  };
  const notes = { id: 'n1', name: 'notes.md', mimeType: 'text/markdown', size: '12', parents: ['root1'] };
  const pdf = { id: 'p1', name: 'scan.pdf', mimeType: 'application/pdf', size: '999', parents: ['root1'] };

  function setup() {
    const service = fakeRoutes({
      'GET /drive/v3/about': { user: { emailAddress: 'me@gmail.com' } },
      'GET /drive/v3/files': { files: [doc, notes], nextPageToken: 'next' },
      'GET /drive/v3/files/d1': doc,
      'GET /drive/v3/files/d1/export': () =>
        new Response(`Plan\n${'x'.repeat(2000)}`, { headers: { 'content-type': 'text/plain' } }),
      'GET /drive/v3/files/n1': (req: RecordedRequest) =>
        req.url.searchParams.get('alt') === 'media'
          ? new Response('# Notes\n- one', { headers: { 'content-type': 'text/markdown' } })
          : json(notes),
      'GET /drive/v3/files/p1': pdf,
      'POST /upload/drive/v3/files': { ...doc, id: 'new1', name: 'Report' },
      'POST /drive/v3/files': { id: 'f1', name: 'Folder', mimeType: 'application/vnd.google-apps.folder' },
      'PATCH /drive/v3/files/d1': (req: RecordedRequest) =>
        json({
          ...doc,
          ...JSON.parse(req.body!),
          parents: [req.url.searchParams.get('addParents') ?? 'root1'],
        }),
    });
    return { service, acc: testAccount(gdrive, { fetch: service.fetch, oauth }) };
  }

  it('builds Drive queries with escaped literals and short type names', () => {
    expect(buildQuery({})).toBe('trashed = false');
    expect(buildQuery({ name: "Ann's \\ plan", type: 'google_sheet', folderId: 'F1' })).toBe(
      "trashed = false and name contains 'Ann\\'s \\\\ plan' and 'F1' in parents and mimeType = 'application/vnd.google-apps.spreadsheet'",
    );
    expect(buildQuery({ type: 'application/pdf', q: "modifiedTime > '2026-11-01'" })).toBe(
      "trashed = false and mimeType = 'application/pdf' and (modifiedTime > '2026-11-01')",
    );
  });

  it('reports the identity and needs OAuth', async () => {
    const { acc } = setup();
    expect(await gdrive.test!(acc.ctx)).toEqual({ ok: true, identity: 'me@gmail.com' });
    await expect(testAccount(gdrive, {}).run('search')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('searches newest first, but by relevance for full-text search', async () => {
    const { acc, service } = setup();
    const result = (await acc.run('search', { name: 'Plan' })) as { files: unknown[]; nextCursor: string };
    const q = service.calls[0]!.url.searchParams;
    expect(q.get('orderBy')).toBe('modifiedTime desc');
    expect(q.get('includeItemsFromAllDrives')).toBe('true');
    expect(result.files[0]).toEqual({
      id: 'd1',
      name: 'Plan',
      type: 'google_doc',
      modified: '2026-11-03T10:00:00.000Z',
      url: 'https://docs.google.com/document/d/d1',
    });
    expect(result.files[1]).toMatchObject({ type: 'text/markdown', size: 12 });
    expect(result.nextCursor).toBe('next');
    await acc.run('search', { text: 'budget', cursor: 'next' });
    expect(service.calls[1]!.url.searchParams.has('orderBy')).toBe(false);
    expect(service.calls[1]!.url.searchParams.get('pageToken')).toBe('next');
  });

  it('reads Google Docs through export and text files as is, cutting long text', async () => {
    const { acc, service } = setup();
    const read = (await acc.run('read', { id: 'd1', maxChars: 500 })) as Record<string, unknown>;
    expect(service.calls[1]!.url.searchParams.get('mimeType')).toBe('text/plain');
    expect(read).toMatchObject({ id: 'd1', type: 'google_doc', truncated: true, totalChars: 2005 });
    expect((read.text as string).length).toBe(501);
    expect(await acc.run('read', { id: 'n1' })).toMatchObject({ text: '# Notes\n- one' });
    await expect(acc.run('read', { id: 'p1' })).rejects.toMatchObject({ kind: 'invalid_input' });
  });

  it('creates a Google Doc with a multipart upload and a folder with metadata only', async () => {
    const { acc, service } = setup();
    expect(await acc.run('create', { name: 'Report', content: 'Hello', folderId: 'F1' })).toMatchObject({
      id: 'new1',
      type: 'google_doc',
    });
    const upload = service.calls[0]!;
    expect(upload.url.searchParams.get('uploadType')).toBe('multipart');
    const boundary = upload.headers.get('content-type')!.match(/boundary=(.+)$/)![1]!;
    const parts = upload.body!.split(`--${boundary}`);
    expect(JSON.parse(parts[1]!.split('\r\n\r\n')[1]!)).toEqual({
      name: 'Report',
      parents: ['F1'],
      mimeType: 'application/vnd.google-apps.document',
    });
    expect(parts[2]).toContain('\r\n\r\nHello\r\n');
    expect(await acc.run('create', { name: 'Folder', kind: 'folder' })).toMatchObject({ type: 'folder' });
    expect(service.calls[1]!.url.pathname).toBe('/drive/v3/files');
  });

  it('moves a file by replacing its parents, renames and trashes', async () => {
    const { acc, service } = setup();
    await expect(acc.run('update', { id: 'd1' })).rejects.toMatchObject({ kind: 'invalid_input' });
    const moved = await acc.run('update', { id: 'd1', moveToFolderId: 'F2', name: 'Plan v2' });
    const patch = service.calls[1]!;
    expect(patch.url.searchParams.get('addParents')).toBe('F2');
    expect(patch.url.searchParams.get('removeParents')).toBe('root1');
    expect(JSON.parse(patch.body!)).toEqual({ name: 'Plan v2' });
    expect(moved).toMatchObject({ name: 'Plan v2' });
    expect(await acc.run('update', { id: 'd1', trash: true })).toMatchObject({ trashed: true });
  });
});
