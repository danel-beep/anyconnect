import addressparser from 'nodemailer/lib/addressparser/index.js';
import { z } from 'zod';
import { HttpClient } from '../http/client.js';
import { type AccountContext, ConnectorError, defineConnector, requireOAuth } from '../sdk.js';
import { Addresses, formatAddress, isoDate, ReadOptions, stripQuotedTail } from './email/message.js';
import { mapLimit } from './shared/concurrency.js';

/**
 * Outlook mail and calendar (Microsoft 365 and personal outlook.com accounts) over Microsoft Graph.
 * Replies and forwards use Graph's own reply/forward so Outlook keeps conversations together.
 */

const Config = z.object({
  timeZone: z
    .string()
    .trim()
    .max(100)
    .default('UTC')
    .describe('IANA time zone for calendar times, e.g. Europe/Moscow'),
});
type Ctx = AccountContext<z.output<typeof Config>, Record<string, never>>;

const GRAPH = 'https://graph.microsoft.com/v1.0/';

const api = (ctx: Ctx, headers: Record<string, string> = {}) => {
  requireOAuth(ctx);
  return new HttpClient(ctx, { baseUrl: GRAPH, headers, errorMessagePaths: ['error.message'] });
};

/** Graph's next pages are full URLs; the cursor only ever points back to Graph. */
const encodeCursor = (nextLink: string | undefined) =>
  nextLink?.startsWith(GRAPH) ? Buffer.from(nextLink.slice(GRAPH.length)).toString('base64url') : undefined;
const decodeCursor = (cursor: string) => {
  const path = Buffer.from(cursor, 'base64url').toString();
  // Relative to the Graph base only: no scheme, host or parent segments.
  const pathname = path.split('?')[0]!;
  if (/^[a-z][\w+.-]*:|^[/\\]|\.\.|\/\/|\\/i.test(pathname)) {
    throw new ConnectorError('invalid_input', 'Invalid cursor');
  }
  return path;
};

interface GraphAddress {
  emailAddress?: { name?: string; address?: string };
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  from?: GraphAddress;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
  replyTo?: GraphAddress[];
  receivedDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  uniqueBody?: { contentType?: string; content?: string };
  isRead?: boolean;
  hasAttachments?: boolean;
  flag?: { flagStatus?: string };
  webLink?: string;
  parentFolderId?: string;
}

const address = (a: GraphAddress | undefined) => formatAddress(a?.emailAddress ?? {});
const addresses = (list: GraphAddress[] | undefined) => (list ?? []).map(address).filter(Boolean);

/** "Name <a@b.com>" strings → Graph recipients. */
export function recipients(list: string[] | undefined): GraphAddress[] {
  return (list ?? []).flatMap((value) =>
    addressparser(value, { flatten: true }).flatMap((a) =>
      'address' in a && a.address
        ? [{ emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) } }]
        : [],
    ),
  );
}

/** Friendly folder names → Graph well-known folder names; anything else is a folder id. */
const FOLDERS: Record<string, string> = {
  inbox: 'inbox',
  sent: 'sentitems',
  drafts: 'drafts',
  trash: 'deleteditems',
  junk: 'junkemail',
  archive: 'archive',
};
const folderId = (folder: string) => FOLDERS[folder.toLowerCase()] ?? folder;

const SUMMARY_FIELDS =
  'id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,flag';

function summary(m: GraphMessage) {
  const date = isoDate(m.receivedDateTime);
  const to = addresses(m.toRecipients);
  return {
    id: m.id,
    threadId: m.conversationId,
    ...(date ? { date } : {}),
    from: address(m.from),
    ...(to.length ? { to: to.join(', ') } : {}),
    subject: m.subject || '(no subject)',
    snippet: (m.bodyPreview ?? '').trim(),
    ...(m.isRead === false ? { unread: true } : {}),
    ...(m.flag?.flagStatus === 'flagged' ? { flagged: true } : {}),
    ...(m.hasAttachments ? { attachments: true } : {}),
  };
}

/** KQL for $search: the whole query is one quoted string. */
const kql = (query: string) => `"${query.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const TEXT_BODY = { prefer: 'outlook.body-content-type="text"' };

// --- Calendar ---

interface GraphTime {
  dateTime: string;
  timeZone: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * An input time → Graph's {dateTime, timeZone}. RFC 3339 with an offset is converted to UTC; a
 * local time without offset is taken in `zone`; a bare date is midnight (all-day events).
 */
export function graphTime(value: string, zone: string): GraphTime {
  if (DATE.test(value)) return { dateTime: `${value}T00:00:00`, timeZone: zone };
  if (OFFSET.test(value)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new ConnectorError('invalid_input', `Invalid time "${value}"`);
    return { dateTime: date.toISOString().replace(/\.\d{3}Z$/, ''), timeZone: 'UTC' };
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) {
    throw new ConnectorError('invalid_input', `Invalid time "${value}"; use RFC 3339 or YYYY-MM-DD`);
  }
  return { dateTime: value, timeZone: zone };
}

/** Shifts a Graph wall-clock time (no offset) by `ms`, keeping its zone. */
const shift = (t: GraphTime, ms: number): GraphTime => ({
  dateTime: new Date(new Date(`${t.dateTime}Z`).getTime() + ms).toISOString().replace(/\.\d{3}Z$/, ''),
  timeZone: t.timeZone,
});
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface GraphEvent {
  id: string;
  subject?: string;
  start?: GraphTime;
  end?: GraphTime;
  isAllDay?: boolean;
  isCancelled?: boolean;
  location?: { displayName?: string };
  organizer?: GraphAddress;
  attendees?: (GraphAddress & { status?: { response?: string } })[];
  onlineMeeting?: { joinUrl?: string } | null;
  showAs?: string;
  webLink?: string;
  bodyPreview?: string;
}

/** Graph returns "2026-11-05T15:00:00.0000000" in the zone asked for with Prefer. */
const localTime = (t: GraphTime | undefined, allDay: boolean) => {
  if (!t) return undefined;
  const value = t.dateTime.replace(/\.\d+$/, '');
  if (allDay) return value.slice(0, 10);
  return t.timeZone === 'UTC' ? `${value}Z` : value;
};

function eventSummary(e: GraphEvent, detailed = false) {
  const allDay = Boolean(e.isAllDay);
  const attendees = (e.attendees ?? []).map((a) => ({
    email: address(a),
    ...(a.status?.response && a.status.response !== 'none' ? { response: a.status.response } : {}),
  }));
  return {
    id: e.id,
    subject: e.subject ?? '',
    start: localTime(e.start, allDay),
    end: localTime(e.end, allDay),
    ...(allDay ? { allDay: true } : {}),
    ...(e.location?.displayName ? { location: e.location.displayName } : {}),
    ...(e.onlineMeeting?.joinUrl ? { meetingUrl: e.onlineMeeting.joinUrl } : {}),
    ...(e.isCancelled ? { cancelled: true } : {}),
    ...(e.showAs && e.showAs !== 'busy' ? { showAs: e.showAs } : {}),
    ...(e.organizer ? { organizer: address(e.organizer) } : {}),
    ...(detailed && attendees.length ? { attendees } : {}),
    ...(detailed && e.bodyPreview ? { description: e.bodyPreview.trim() } : {}),
    ...(e.webLink ? { url: e.webLink } : {}),
  };
}

const EVENT_FIELDS =
  'id,subject,start,end,isAllDay,isCancelled,location,organizer,onlineMeeting,showAs,webLink';

const calendarHeaders = (ctx: Ctx) => ({ prefer: `outlook.timezone="${ctx.config.timeZone}"` });

const calendarBase = (calendarId: string | undefined) =>
  calendarId ? `me/calendars/${encodeURIComponent(calendarId)}` : 'me';

const Time = z.string().trim().min(10).max(40);
const EventFields = {
  subject: z.string().trim().max(500),
  start: Time.describe('2026-11-05T15:00:00+03:00, or 2026-11-05 for an all-day event'),
  end: Time.optional().describe('Default: one hour after start, or the next day for all-day'),
  location: z.string().trim().max(500).optional(),
  description: z.string().max(50_000).optional().describe('Plain-text event body'),
  attendees: Addresses.optional().describe('Invitations are sent to them'),
  online: z.boolean().optional().describe('Add a Teams meeting link'),
};

function eventBody(
  input: Partial<{
    subject: string;
    start: string;
    end: string | undefined;
    location: string | undefined;
    description: string | undefined;
    attendees: string[] | undefined;
    online: boolean | undefined;
  }>,
  zone: string,
) {
  const body: Record<string, unknown> = {};
  if (input.subject !== undefined) body.subject = input.subject;
  if (input.start !== undefined) {
    const allDay = DATE.test(input.start);
    const start = graphTime(input.start, zone);
    if (allDay && input.end !== undefined && !DATE.test(input.end)) {
      throw new ConnectorError('invalid_input', 'An all-day event ends on a date (YYYY-MM-DD)');
    }
    body.isAllDay = allDay;
    body.start = start;
    body.end = input.end !== undefined ? graphTime(input.end, zone) : shift(start, allDay ? DAY : HOUR);
  } else if (input.end !== undefined) {
    body.end = graphTime(input.end, zone);
  }
  if (input.location !== undefined) body.location = { displayName: input.location };
  if (input.description !== undefined) body.body = { contentType: 'text', content: input.description };
  if (input.attendees !== undefined) {
    body.attendees = recipients(input.attendees).map((a) => ({ ...a, type: 'required' }));
  }
  if (input.online !== undefined) {
    body.isOnlineMeeting = input.online;
    if (input.online) body.onlineMeetingProvider = 'teamsForBusiness';
  }
  return body;
}

const MessageId = z.string().trim().min(1).max(500).describe('Message id from outlook_search');
const EventId = z.string().trim().min(1).max(500).describe('Event id from outlook_list_events');
const CalendarId = z
  .string()
  .trim()
  .max(500)
  .optional()
  .describe('Calendar id from outlook_list_calendars; default: the main calendar');

export default defineConnector({
  id: 'outlook',
  name: 'Outlook',
  description: 'Outlook / Microsoft 365 mail and calendar: search, read, send, reply, forward, move; events.',
  version: '1.0.0',
  homepage: 'https://learn.microsoft.com/graph/api/resources/mail-api-overview',
  instructions:
    'outlook_search query uses Outlook search syntax: from:ann subject:invoice hasattachments:true. Folders: inbox, sent, drafts, trash, junk, archive or an id from outlook_list_folders. Moving a message changes its id.',
  config: Config,
  oauth: {
    provider: 'microsoft',
    scopes: ['Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite', 'MailboxSettings.Read'],
  },
  async test(ctx) {
    const { data } = await api(ctx).get<{ mail?: string; userPrincipalName?: string }>('me', {
      $select: 'mail,userPrincipalName',
    });
    const identity = data.mail || data.userPrincipalName;
    return { ok: true, ...(identity ? { identity } : {}) };
  },
  actions: (action) => [
    action({
      name: 'search',
      title: 'Search mail',
      description: 'Finds messages, newest first, with sender, subject and preview. Default: inbox.',
      input: z.object({
        query: z.string().trim().max(1000).optional().describe('e.g. "from:bank subject:card"'),
        folder: z
          .string()
          .trim()
          .max(500)
          .default('inbox')
          .describe('inbox, sent, ..., "all" or a folder id'),
        unreadOnly: z.boolean().default(false),
        limit: z.number().int().min(1).max(50).default(15),
        cursor: z.string().max(4000).optional().describe('nextCursor from the previous page'),
      }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ query, folder, unreadOnly, limit, cursor }, ctx) => {
        const client = api(ctx);
        const path =
          folder.toLowerCase() === 'all'
            ? 'me/messages'
            : `me/mailFolders/${encodeURIComponent(folderId(folder))}/messages`;
        const { data } = cursor
          ? await client.get<{ value: GraphMessage[]; '@odata.nextLink'?: string }>(decodeCursor(cursor))
          : await client.get<{ value: GraphMessage[]; '@odata.nextLink'?: string }>(path, {
              $select: SUMMARY_FIELDS,
              $top: limit,
              // Graph does not combine $search with $orderby/$filter; search results come newest first.
              ...(query
                ? { $search: kql(unreadOnly ? `${query} isread:false` : query) }
                : {
                    $orderby: 'receivedDateTime desc',
                    ...(unreadOnly ? { $filter: 'isRead eq false' } : {}),
                  }),
            });
        const nextCursor = encodeCursor(data['@odata.nextLink']);
        return { messages: data.value.map(summary), ...(nextCursor ? { nextCursor } : {}) };
      },
    }),
    action({
      name: 'read',
      title: 'Read message',
      description:
        'Returns a message as plain text (quoted history removed by default) with the attachment list.',
      input: z.object({
        id: MessageId,
        ...ReadOptions,
        markRead: z.boolean().default(false),
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      run: async ({ id, maxChars, includeQuoted, markRead }, ctx) => {
        const client = api(ctx, TEXT_BODY);
        const path = `me/messages/${encodeURIComponent(id)}`;
        const { data: m } = await client.get<GraphMessage>(path, {
          $select: `${SUMMARY_FIELDS},ccRecipients,replyTo,body,uniqueBody,webLink`,
        });
        const [attachments] = await Promise.all([
          m.hasAttachments
            ? client
                .get<{ value: { name: string; contentType?: string; size?: number; isInline?: boolean }[] }>(
                  `${path}/attachments`,
                  { $select: 'name,contentType,size,isInline' },
                )
                .then(({ data }) => data.value.filter((a) => !a.isInline))
            : Promise.resolve([]),
          markRead && m.isRead === false
            ? client.request({ method: 'PATCH', url: path, json: { isRead: true } })
            : null,
        ]);
        // uniqueBody is the part of the message that is new in the conversation.
        let text = ((includeQuoted ? m.body : (m.uniqueBody ?? m.body))?.content ?? '').trim();
        let quotedRemoved =
          !includeQuoted && Boolean(m.uniqueBody) && text !== (m.body?.content ?? '').trim();
        if (!includeQuoted && !quotedRemoved) {
          const stripped = stripQuotedTail(text);
          text = stripped.text;
          quotedRemoved = stripped.removed;
        }
        const totalChars = text.length;
        const truncated = totalChars > maxChars;
        const cc = addresses(m.ccRecipients);
        const replyTo = addresses(m.replyTo);
        const from = address(m.from);
        const date = isoDate(m.receivedDateTime);
        return {
          id: m.id,
          threadId: m.conversationId,
          ...(date ? { date } : {}),
          from,
          to: addresses(m.toRecipients),
          ...(cc.length ? { cc } : {}),
          ...(replyTo.length && replyTo[0] !== from ? { replyTo } : {}),
          subject: m.subject || '(no subject)',
          ...(m.isRead === false && !markRead ? { unread: true } : {}),
          text: truncated ? `${text.slice(0, maxChars)}…` : text,
          ...(truncated ? { truncated: true, totalChars } : {}),
          ...(quotedRemoved ? { quotedHistoryRemoved: true } : {}),
          ...(attachments.length
            ? {
                attachments: attachments.map((a) => ({
                  filename: a.name,
                  ...(a.contentType ? { contentType: a.contentType } : {}),
                  ...(a.size !== undefined ? { size: a.size } : {}),
                })),
              }
            : {}),
          ...(m.webLink ? { url: m.webLink } : {}),
        };
      },
    }),
    action({
      name: 'send',
      title: 'Send email',
      description: 'Sends a new email (plain text); a copy is saved to Sent Items.',
      input: z.object({
        to: Addresses.min(1),
        cc: Addresses.optional(),
        bcc: Addresses.optional(),
        subject: z.string().trim().max(998),
        body: z.string().max(200_000),
      }),
      hints: { readOnly: false, destructive: false },
      run: async ({ to, cc, bcc, subject, body }, ctx) => {
        const message = {
          subject,
          body: { contentType: 'Text', content: body },
          toRecipients: recipients(to),
          ...(cc ? { ccRecipients: recipients(cc) } : {}),
          ...(bcc ? { bccRecipients: recipients(bcc) } : {}),
        };
        if (!message.toRecipients.length) throw new ConnectorError('invalid_input', 'No valid recipients');
        await api(ctx).post('me/sendMail', { message, saveToSentItems: true });
        return { sent: true, to: message.toRecipients.map(address) };
      },
    }),
    action({
      name: 'reply',
      title: 'Reply',
      description:
        'Replies in the same conversation; the original is quoted below. replyAll copies everyone.',
      input: z.object({
        id: MessageId,
        body: z.string().max(200_000).describe('Plain-text reply, without the quoted original'),
        replyAll: z.boolean().default(false),
        cc: Addresses.optional(),
      }),
      hints: { readOnly: false, destructive: false },
      run: async ({ id, body, replyAll, cc }, ctx) => {
        await api(ctx).post(`me/messages/${encodeURIComponent(id)}/${replyAll ? 'replyAll' : 'reply'}`, {
          comment: body,
          ...(cc?.length ? { message: { ccRecipients: recipients(cc) } } : {}),
        });
        return { sent: true };
      },
    }),
    action({
      name: 'forward',
      title: 'Forward',
      description: 'Forwards a message with its attachments and an optional note.',
      input: z.object({ id: MessageId, to: Addresses.min(1), body: z.string().max(200_000).default('') }),
      hints: { readOnly: false, destructive: false },
      run: async ({ id, to, body }, ctx) => {
        const toRecipients = recipients(to);
        await api(ctx).post(`me/messages/${encodeURIComponent(id)}/forward`, { comment: body, toRecipients });
        return { sent: true, to: toRecipients.map(address) };
      },
    }),
    action({
      name: 'create_draft',
      title: 'Create draft',
      description: 'Saves a draft (optionally a reply to a message) in Drafts for the user to review.',
      input: z.object({
        to: Addresses.default([]),
        cc: Addresses.optional(),
        subject: z.string().trim().max(998).default(''),
        body: z.string().max(200_000),
        replyToId: MessageId.optional().describe('Make the draft a reply to this message'),
      }),
      hints: { readOnly: false, destructive: false },
      run: async ({ to, cc, subject, body, replyToId }, ctx) => {
        const client = api(ctx);
        const fields = {
          ...(to.length ? { toRecipients: recipients(to) } : {}),
          ...(cc ? { ccRecipients: recipients(cc) } : {}),
        };
        const { data } = replyToId
          ? await client.post<GraphMessage>(`me/messages/${encodeURIComponent(replyToId)}/createReply`, {
              comment: body,
              ...(Object.keys(fields).length ? { message: fields } : {}),
            })
          : await client.post<GraphMessage>('me/messages', {
              subject,
              body: { contentType: 'Text', content: body },
              ...fields,
            });
        return { draftId: data.id, ...(data.webLink ? { url: data.webLink } : {}) };
      },
    }),
    action({
      name: 'move',
      title: 'Move messages',
      description:
        'Moves messages to a folder (archive, trash, junk, inbox or a folder id). Returns new ids.',
      input: z.object({ ids: z.array(MessageId).min(1).max(100), folder: z.string().trim().min(1).max(500) }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      run: async ({ ids, folder }, ctx) => {
        const client = api(ctx);
        const destinationId = folderId(folder);
        const moved = await mapLimit(ids, 4, async (id) => {
          const { data } = await client.post<GraphMessage>(`me/messages/${encodeURIComponent(id)}/move`, {
            destinationId,
          });
          return { id, newId: data.id };
        });
        return { moved };
      },
    }),
    action({
      name: 'mark',
      title: 'Mark read / flag',
      description: 'Marks messages read or unread and flags or unflags them.',
      input: z.object({
        ids: z.array(MessageId).min(1).max(100),
        read: z.boolean().optional(),
        flagged: z.boolean().optional(),
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      run: async ({ ids, read, flagged }, ctx) => {
        if (read === undefined && flagged === undefined) {
          throw new ConnectorError('invalid_input', 'Pass read or flagged.');
        }
        const client = api(ctx);
        const json = {
          ...(read !== undefined ? { isRead: read } : {}),
          ...(flagged !== undefined ? { flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' } } : {}),
        };
        await mapLimit(ids, 4, (id) =>
          client.request({ method: 'PATCH', url: `me/messages/${encodeURIComponent(id)}`, json }),
        );
        return { updated: ids.length };
      },
    }),
    action({
      name: 'list_folders',
      title: 'List folders',
      description: 'Mail folders with unread and total counts.',
      input: z.object({}),
      hints: { readOnly: true, idempotent: true },
      run: async (_input, ctx) => {
        const { data } = await api(ctx).get<{
          value: { id: string; displayName: string; unreadItemCount?: number; totalItemCount?: number }[];
        }>('me/mailFolders', { $top: 100, $select: 'id,displayName,unreadItemCount,totalItemCount' });
        return {
          folders: data.value.map((f) => ({
            id: f.id,
            name: f.displayName,
            ...(f.unreadItemCount ? { unread: f.unreadItemCount } : {}),
            total: f.totalItemCount ?? 0,
          })),
        };
      },
    }),
    action({
      name: 'list_calendars',
      title: 'List calendars',
      description: 'Calendars of the account with ids.',
      input: z.object({}),
      hints: { readOnly: true, idempotent: true },
      run: async (_input, ctx) => {
        const { data } = await api(ctx).get<{
          value: { id: string; name: string; isDefaultCalendar?: boolean; canEdit?: boolean }[];
        }>('me/calendars', { $select: 'id,name,isDefaultCalendar,canEdit' });
        return {
          calendars: data.value.map((c) => ({
            id: c.id,
            name: c.name,
            ...(c.isDefaultCalendar ? { default: true } : {}),
            ...(c.canEdit === false ? { readOnly: true } : {}),
          })),
        };
      },
    }),
    action({
      name: 'list_events',
      title: 'List events',
      description: 'Events in a time range (recurring ones expanded), ordered by start.',
      input: z.object({
        from: Time.describe('Range start, RFC 3339 or YYYY-MM-DD'),
        to: Time.describe('Range end, RFC 3339 or YYYY-MM-DD'),
        calendarId: CalendarId,
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().max(4000).optional(),
      }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ from, to, calendarId, limit, cursor }, ctx) => {
        const client = api(ctx, calendarHeaders(ctx));
        const { data } = cursor
          ? await client.get<{ value: GraphEvent[]; '@odata.nextLink'?: string }>(decodeCursor(cursor))
          : await client.get<{ value: GraphEvent[]; '@odata.nextLink'?: string }>(
              `${calendarBase(calendarId)}/calendarView`,
              {
                startDateTime: from,
                endDateTime: to,
                $select: EVENT_FIELDS,
                $orderby: 'start/dateTime',
                $top: limit,
              },
            );
        const nextCursor = encodeCursor(data['@odata.nextLink']);
        return {
          timeZone: ctx.config.timeZone,
          events: data.value.map((e) => eventSummary(e)),
          ...(nextCursor ? { nextCursor } : {}),
        };
      },
    }),
    action({
      name: 'get_event',
      title: 'Get event',
      description: 'One event with description, attendees and their responses.',
      input: z.object({ id: EventId }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ id }, ctx) => {
        const { data } = await api(ctx, { ...calendarHeaders(ctx), ...TEXT_BODY }).get<GraphEvent>(
          `me/events/${encodeURIComponent(id)}`,
          { $select: `${EVENT_FIELDS},attendees,bodyPreview` },
        );
        return { timeZone: ctx.config.timeZone, ...eventSummary(data, true) };
      },
    }),
    action({
      name: 'create_event',
      title: 'Create event',
      description: 'Creates an event; attendees get invitations.',
      input: z.object({ ...EventFields, calendarId: CalendarId }),
      hints: { readOnly: false, destructive: false },
      run: async ({ calendarId, ...input }, ctx) => {
        const { data } = await api(ctx, calendarHeaders(ctx)).post<GraphEvent>(
          `${calendarBase(calendarId)}/events`,
          eventBody(input, ctx.config.timeZone),
        );
        return { timeZone: ctx.config.timeZone, ...eventSummary(data) };
      },
    }),
    action({
      name: 'update_event',
      title: 'Update event',
      description: 'Changes only the given fields of an event; attendees get an update.',
      input: z.object({
        id: EventId,
        ...EventFields,
        subject: EventFields.subject.optional(),
        start: EventFields.start.optional(),
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      run: async ({ id, ...input }, ctx) => {
        const body = eventBody(input, ctx.config.timeZone);
        if (!Object.keys(body).length) throw new ConnectorError('invalid_input', 'Nothing to change.');
        const { data } = await api(ctx, calendarHeaders(ctx)).request<GraphEvent>({
          method: 'PATCH',
          url: `me/events/${encodeURIComponent(id)}`,
          json: body,
        });
        return { timeZone: ctx.config.timeZone, ...eventSummary(data) };
      },
    }),
    action({
      name: 'delete_event',
      title: 'Delete / cancel event',
      description:
        'Deletes an event. For a meeting you organize, cancel sends attendees a cancellation note.',
      input: z.object({
        id: EventId,
        cancel: z.boolean().default(false).describe('Send a cancellation to attendees'),
        comment: z.string().max(2000).default(''),
      }),
      hints: { readOnly: false, destructive: true, idempotent: true },
      run: async ({ id, cancel, comment }, ctx) => {
        const client = api(ctx);
        const path = `me/events/${encodeURIComponent(id)}`;
        if (cancel) await client.post(`${path}/cancel`, { comment });
        else await client.request({ method: 'DELETE', url: path });
        return cancel ? { cancelled: true } : { deleted: true };
      },
    }),
  ],
});
