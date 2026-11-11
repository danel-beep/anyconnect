import addressparser from 'nodemailer/lib/addressparser/index.js';
import { z } from 'zod';
import { HttpClient } from '../http/client.js';
import { guestsRisk } from '../risk.js';
import {
  type AccountContext,
  type CapabilityOutput,
  ConnectorError,
  defineConnector,
  requireOAuth,
} from '../sdk.js';
import { cleanLine, snippetText } from '../shape.js';
import { day, dayAfter, mailRead, mailSearch, mailSend, quoted } from './email/capability.js';
import { Addresses, formatAddress, isoDate, ReadOptions, stripQuotedTail } from './email/message.js';
import { mapLimit } from './shared/concurrency.js';

/**
 * Outlook mail and calendar (Microsoft 365 and personal outlook.com accounts) over Microsoft Graph.
 * Replies and forwards use Graph's own reply/forward so Outlook keeps conversations together.
 * Ids are Graph's immutable ids: they stay the same when a message moves between folders.
 */

const isTimeZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

const Config = z.object({
  timeZone: z
    .string()
    .trim()
    .max(100)
    .refine(isTimeZone, 'Unknown time zone; use an IANA name like Europe/Moscow')
    .default('UTC')
    .describe('IANA time zone for calendar times, e.g. Europe/Moscow'),
});
type Ctx = AccountContext<z.output<typeof Config>, Record<string, never>>;

const GRAPH = 'https://graph.microsoft.com/v1.0/';

/** `prefer` adds Graph preferences (text bodies, time zone) to the immutable-id one. */
const api = (ctx: Ctx, ...prefer: string[]) => {
  requireOAuth(ctx);
  return new HttpClient(ctx, {
    baseUrl: GRAPH,
    headers: { prefer: ['IdType="ImmutableId"', ...prefer].join(', ') },
    errorMessagePaths: ['error.message'],
  });
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
    ...(to.length ? { to } : {}),
    subject: cleanLine(m.subject ?? '') || '(no subject)',
    snippet: snippetText(m.bodyPreview ?? ''),
    ...(m.isRead === false ? { unread: true } : {}),
    ...(m.flag?.flagStatus === 'flagged' ? { flagged: true } : {}),
    ...(m.hasAttachments ? { attachments: true } : {}),
  };
}

/** KQL for $search: the whole query is one quoted string. */
const kql = (query: string) => `"${query.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const TEXT_BODY = 'outlook.body-content-type="text"';

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

/** UTC offset of `zone` at the moment `utcMs`, e.g. "+03:00". */
function zoneOffset(zone: string, utcMs: number): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(utcMs))
    .find((p) => p.type === 'timeZoneName')?.value;
  return !name || name === 'GMT' ? '+00:00' : name.slice(3);
}
const offsetMs = (offset: string) => {
  const sign = offset.startsWith('-') ? -1 : 1;
  const [h, m] = offset.slice(1).split(':').map(Number);
  return sign * ((h ?? 0) * 60 + (m ?? 0)) * 60_000;
};

/**
 * Graph returns wall-clock "2026-11-05T15:00:00.0000000" in the zone asked for with Prefer; the
 * result is RFC 3339 with that zone's offset at that moment, so it is never ambiguous.
 */
export function rfc3339(t: GraphTime | undefined, allDay: boolean): string | undefined {
  if (!t) return undefined;
  const value = t.dateTime.replace(/\.\d+$/, '');
  if (allDay) return value.slice(0, 10);
  if (t.timeZone === 'UTC') return `${value}Z`;
  const wall = Date.parse(`${value}Z`);
  if (Number.isNaN(wall) || !isTimeZone(t.timeZone)) return value;
  const guess = zoneOffset(t.timeZone, wall);
  return `${value}${zoneOffset(t.timeZone, wall - offsetMs(guess))}`;
}

/** A range bound for calendarView: a bare date is midnight in the account zone. */
const rangeTime = (value: string, zone: string) =>
  DATE.test(value) ? (rfc3339({ dateTime: `${value}T00:00:00`, timeZone: zone }, false) ?? value) : value;

type EventSummary = ReturnType<typeof eventSummary>;

function eventSummary(e: GraphEvent, detailed = false) {
  const allDay = Boolean(e.isAllDay);
  const attendees = (e.attendees ?? []).map((a) => ({
    email: address(a),
    ...(a.status?.response && a.status.response !== 'none' ? { response: a.status.response } : {}),
  }));
  return {
    id: e.id,
    subject: e.subject ?? '',
    start: rfc3339(e.start, allDay),
    end: rfc3339(e.end, allDay),
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

const zonePreference = (ctx: Ctx) => `outlook.timezone="${ctx.config.timeZone}"`;

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
    'outlook_search query uses Outlook search syntax: from:ann subject:invoice hasattachments:true. Folders: inbox, sent, drafts, trash, junk, archive or an id from outlook_list_folders. Calendar times come with the offset of the account time zone.',
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
  ui: {
    locales: {
      ru: {
        setup: {
          oauth: {
            summary: 'Вы входите в свой аккаунт Microsoft и разрешаете Manyplug доступ к почте и календарю.',
            minutes: 1,
            needs: ['Аккаунт Outlook.com, Hotmail или рабочий Microsoft 365'],
            steps: [
              { text: 'Нажмите **Подключить** и войдите в нужный аккаунт Microsoft.' },
              { text: 'Microsoft попросит разрешить доступ к почте и календарю. Нажмите **Принять**.' },
              { text: 'Готово: вы вернётесь сюда, и ИИ сможет работать с этим ящиком и его календарями.' },
            ],
            tips: [
              'Чтобы закрыть доступ, удалите аккаунт здесь или уберите Manyplug на account.microsoft.com → **Конфиденциальность** → **Приложения и службы**.',
            ],
            problems: [
              {
                problem: 'Microsoft пишет, что нужно одобрение администратора',
                fix: 'Это рабочий аккаунт с ограничениями. Попросите IT-отдел разрешить приложение Manyplug, а затем подключитесь снова.',
              },
              {
                problem: 'Подключился не тот аккаунт',
                fix: 'Удалите его здесь, снова нажмите **Подключить** и на странице входа Microsoft выберите **Использовать другую учётную запись**.',
              },
            ],
          },
        },
        prompts: [
          'Какие важные письма пришли сегодня утром?',
          'Ответь Сэму, что пришлю презентацию завтра.',
          'Какие у меня встречи в среду?',
          'Поставь 30 минут с Катей в пятницу после обеда.',
        ],
        description:
          'Почта и календарь Outlook и Microsoft 365: поиск, чтение, отправка, ответы, пересылка, папки и события.',
        fields: {
          timeZone: {
            label: 'Часовой пояс',
            hint: 'Для времени событий в календаре, например Europe/Moscow',
            placeholder: 'Europe/Moscow',
          },
        },
        actions: {
          search: {
            title: 'Поиск писем',
            description:
              'Находит письма, сначала новые: отправитель, тема, начало текста. По умолчанию — во входящих.',
          },
          read: {
            title: 'Чтение письма',
            description:
              'Открывает письмо как обычный текст, без цитат прошлой переписки, со списком вложений.',
          },
          send: {
            title: 'Отправка письма',
            description:
              'Отправляет письмо обычным текстом, в том числе ответом в переписке. Копия остаётся в «Отправленных».',
          },
          reply: {
            title: 'Ответ на письмо',
            description: 'Отвечает в той же переписке, исходное письмо цитируется ниже. Можно ответить всем.',
          },
          forward: {
            title: 'Пересылка письма',
            description: 'Пересылает письмо с вложениями и, если нужно, с вашим комментарием.',
          },
          create_draft: {
            title: 'Черновик',
            description:
              'Сохраняет черновик, в том числе ответ на письмо, в «Черновиках», чтобы вы проверили его сами.',
          },
          move: {
            title: 'Перемещение писем',
            description: 'Переносит письма в архив, корзину, спам, входящие или другую папку.',
          },
          mark: {
            title: 'Прочитано и флажки',
            description: 'Отмечает письма прочитанными или непрочитанными, ставит и снимает флажок.',
          },
          list_folders: {
            title: 'Список папок',
            description: 'Папки почты с числом всех и непрочитанных писем.',
          },
          list_calendars: { title: 'Список календарей', description: 'Календари аккаунта.' },
          list_events: {
            title: 'События',
            description: 'События за период в порядке начала, повторяющиеся — каждое отдельно.',
          },
          get_event: {
            title: 'Событие',
            description: 'Одно событие с описанием, участниками и их ответами.',
          },
          create_event: {
            title: 'Новое событие',
            description: 'Создаёт событие и рассылает приглашения участникам.',
          },
          update_event: {
            title: 'Изменение события',
            description: 'Меняет только то, что указано. Участники получат обновление.',
          },
          delete_event: {
            title: 'Удаление или отмена события',
            description:
              'Удаляет событие. Встречу, которую вы организовали, можно отменить с письмом участникам.',
          },
        },
      },
      en: {
        setup: {
          oauth: {
            summary: 'You sign in to your Microsoft account and let Manyplug use your mail and calendar.',
            minutes: 1,
            needs: ['An Outlook.com, Hotmail or work Microsoft 365 account'],
            steps: [
              { text: 'Click **Connect** and sign in with the Microsoft account you want to add.' },
              { text: 'Microsoft asks to allow access to your mail and calendar. Click **Accept**.' },
              { text: 'Done: you are back here, and the AI can work with this mailbox and its calendars.' },
            ],
            tips: [
              'To cut access, delete the account here or remove Manyplug at account.microsoft.com → **Privacy** → **Apps and services**.',
            ],
            problems: [
              {
                problem: 'Microsoft says an admin must approve the app',
                fix: 'Your work account limits apps. Ask your IT admin to allow Manyplug, then connect again.',
              },
              {
                problem: 'The wrong account got connected',
                fix: 'Delete it here, click **Connect** again and pick **Use another account** on the Microsoft sign-in page.',
              },
            ],
          },
        },
        prompts: [
          'What important emails came in this morning?',
          'Reply to Sam that I will send the deck tomorrow.',
          'What meetings do I have on Wednesday?',
          'Book 30 minutes with Kate on Friday afternoon.',
        ],
        fields: {
          timeZone: {
            label: 'Time zone',
            hint: 'For calendar event times, e.g. Europe/Moscow',
            placeholder: 'Europe/Moscow',
          },
        },
        actions: {
          search: {
            title: 'Search mail',
            description:
              'Finds messages, newest first, with sender, subject and a preview. Inbox by default.',
          },
          read: {
            title: 'Read a message',
            description: 'Opens a message as plain text without the quoted history, with its attachments.',
          },
          send: {
            title: 'Send an email',
            description:
              'Sends a plain-text email, optionally as a reply in a conversation. A copy stays in Sent Items.',
          },
          reply: {
            title: 'Reply',
            description:
              'Replies in the same conversation with the original quoted below, optionally to everyone.',
          },
          forward: {
            title: 'Forward',
            description: 'Forwards a message with its attachments and an optional note.',
          },
          create_draft: {
            title: 'Create a draft',
            description: 'Saves a draft, a reply to a message too, in Drafts for you to review.',
          },
          move: {
            title: 'Move messages',
            description: 'Moves messages to the archive, trash, junk, inbox or another folder.',
          },
          mark: {
            title: 'Read and flags',
            description: 'Marks messages read or unread and flags or unflags them.',
          },
          list_folders: { title: 'List folders', description: 'Mail folders with total and unread counts.' },
          list_calendars: { title: 'List calendars', description: 'Calendars of the account.' },
          list_events: {
            title: 'Events',
            description:
              'Events in a time range by start time, each occurrence of a recurring one separately.',
          },
          get_event: {
            title: 'Event',
            description: 'One event with its description, attendees and their responses.',
          },
          create_event: {
            title: 'Create an event',
            description: 'Creates an event and sends invitations to attendees.',
          },
          update_event: {
            title: 'Update an event',
            description: 'Changes only the given details. Attendees get an update.',
          },
          delete_event: {
            title: 'Delete or cancel an event',
            description:
              'Deletes an event. A meeting you organize can be cancelled with a note to attendees.',
          },
        },
      },
    },
  },
  actions: (action) => [
    action({
      name: 'search',
      keywords: 'find emails inbox unread new letters messages sender subject check mail who wrote',
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
      capability: mailSearch((input) => {
        const kqlParts = [
          input.query,
          input.from && `from:${quoted(input.from)}`,
          input.to && `to:${quoted(input.to)}`,
          input.since && `received>=${day(input.since)}`,
          input.until && `received<${dayAfter(input.until)}`,
        ].filter(Boolean);
        return {
          ...(kqlParts.length ? { query: kqlParts.join(' ') } : {}),
          folder: input.folder ?? 'all',
          unreadOnly: Boolean(input.unread_only),
          limit: input.limit,
        };
      }),
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
      keywords: 'open email full text body attachments download attachment',
      title: 'Read message',
      description:
        'Returns a message as plain text (quoted history removed by default) with the attachment list.',
      input: z.object({ id: MessageId, ...ReadOptions }),
      hints: { readOnly: true, idempotent: true },
      capability: mailRead,
      run: async ({ id, maxChars, includeQuoted }, ctx) => {
        const client = api(ctx, TEXT_BODY);
        const path = `me/messages/${encodeURIComponent(id)}`;
        const { data: m } = await client.get<GraphMessage>(path, {
          $select: `${SUMMARY_FIELDS},ccRecipients,replyTo,body,uniqueBody,webLink`,
        });
        const attachments = m.hasAttachments
          ? (
              await client.get<{
                value: { name: string; contentType?: string; size?: number; isInline?: boolean }[];
              }>(`${path}/attachments`, { $select: 'name,contentType,size,isInline' })
            ).data.value.filter((a) => !a.isInline)
          : [];
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
          ...(m.isRead === false ? { unread: true } : {}),
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
      keywords: 'write compose new email',
      title: 'Send email',
      description:
        'Sends an email (plain text), optionally as a reply in a conversation; saved to Sent Items.',
      input: z.object({
        to: Addresses.min(1),
        cc: Addresses.optional(),
        bcc: Addresses.optional(),
        subject: z.string().trim().max(998).default('').describe('Default for replies: RE: original subject'),
        body: z.string().max(200_000),
        replyToId: MessageId.optional().describe('Send as a reply in the conversation of this message'),
      }),
      hints: { readOnly: false, destructive: false },
      // Reaches other people and cannot be taken back: asks first under the default rules.
      risk: 'dangerous',
      capability: mailSend,
      run: async ({ to, cc, bcc, subject, body, replyToId }, ctx) => {
        const fields = {
          ...(subject ? { subject } : {}),
          toRecipients: recipients(to),
          ...(cc ? { ccRecipients: recipients(cc) } : {}),
          ...(bcc ? { bccRecipients: recipients(bcc) } : {}),
        };
        if (!fields.toRecipients.length) throw new ConnectorError('invalid_input', 'No valid recipients');
        const client = api(ctx);
        // A draft first, then send it: the immutable id of the draft is the id of the sent message.
        const { data: draft } = replyToId
          ? await client.post<GraphMessage>(`me/messages/${encodeURIComponent(replyToId)}/createReply`, {
              message: fields,
              comment: body,
            })
          : await client.post<GraphMessage>('me/messages', {
              ...fields,
              body: { contentType: 'Text', content: body },
            });
        await client.post(`me/messages/${encodeURIComponent(draft.id)}/send`);
        return { sent: true, id: draft.id, to: fields.toRecipients.map(address) };
      },
    }),
    action({
      name: 'reply',
      keywords: 'answer respond email',
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
      // Reaches other people and cannot be taken back: asks first under the default rules.
      risk: 'dangerous',
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
      keywords: 'share pass on email',
      title: 'Forward',
      description: 'Forwards a message with its attachments and an optional note.',
      input: z.object({ id: MessageId, to: Addresses.min(1), body: z.string().max(200_000).default('') }),
      hints: { readOnly: false, destructive: false },
      // Reaches other people and cannot be taken back: asks first under the default rules.
      risk: 'dangerous',
      run: async ({ id, to, body }, ctx) => {
        const toRecipients = recipients(to);
        await api(ctx).post(`me/messages/${encodeURIComponent(id)}/forward`, { comment: body, toRecipients });
        return { sent: true, to: toRecipients.map(address) };
      },
    }),
    action({
      name: 'create_draft',
      keywords: 'draft compose prepare email',
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
      risk: 'write',
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
      keywords: 'archive folder delete trash spam',
      title: 'Move messages',
      description:
        'Moves messages to a folder: archive, trash, junk, inbox or a folder id. Ids stay the same.',
      input: z.object({ ids: z.array(MessageId).min(1).max(100), folder: z.string().trim().min(1).max(500) }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      // Moving to Deleted Items is restorable.
      risk: 'write',
      run: async ({ ids, folder }, ctx) => {
        const client = api(ctx);
        const destinationId = folderId(folder);
        await mapLimit(ids, 4, (id) =>
          client.post(`me/messages/${encodeURIComponent(id)}/move`, { destinationId }),
        );
        return { moved: ids.length, folder };
      },
    }),
    action({
      name: 'mark',
      keywords: 'read unread flag star seen',
      title: 'Mark read / flag',
      description: 'Marks messages read or unread and flags or unflags them.',
      input: z.object({
        ids: z.array(MessageId).min(1).max(100),
        read: z.boolean().optional(),
        flagged: z.boolean().optional(),
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
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
      keywords: 'agenda meetings appointments schedule upcoming today tomorrow week',
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
      capability: {
        id: 'calendar.list_events',
        mapInput: ({ from, to, limit }) => ({ from, to, limit }),
        // calendarView has no text search: the canonical query filters titles here.
        mapOutput: (result, input) => {
          const { events, nextCursor } = result as { events: EventSummary[]; nextCursor?: string };
          const query = typeof input.query === 'string' ? input.query.toLowerCase() : '';
          return {
            items: events
              .filter((e) => !query || e.subject.toLowerCase().includes(query))
              .map(
                (e): CapabilityOutput<'calendar.list_events'> => ({
                  id: e.id,
                  title: e.subject,
                  start: e.start ?? '',
                  ...(e.end ? { end: e.end } : {}),
                  ...(e.allDay ? { all_day: true } : {}),
                  ...(e.location ? { location: e.location } : {}),
                  ...(e.url ? { url: e.url } : {}),
                }),
              ),
            ...(nextCursor ? { nextCursor } : {}),
          };
        },
      },
      run: async ({ from, to, calendarId, limit, cursor }, ctx) => {
        const client = api(ctx, zonePreference(ctx));
        const { data } = cursor
          ? await client.get<{ value: GraphEvent[]; '@odata.nextLink'?: string }>(decodeCursor(cursor))
          : await client.get<{ value: GraphEvent[]; '@odata.nextLink'?: string }>(
              `${calendarBase(calendarId)}/calendarView`,
              {
                startDateTime: rangeTime(from, ctx.config.timeZone),
                endDateTime: rangeTime(to, ctx.config.timeZone),
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
        const { data } = await api(ctx, zonePreference(ctx), TEXT_BODY).get<GraphEvent>(
          `me/events/${encodeURIComponent(id)}`,
          { $select: `${EVENT_FIELDS},attendees,bodyPreview` },
        );
        return { timeZone: ctx.config.timeZone, ...eventSummary(data, true) };
      },
    }),
    action({
      name: 'create_event',
      keywords: 'schedule book add meeting appointment invite',
      title: 'Create event',
      description: 'Creates an event; attendees get invitations.',
      input: z.object({ ...EventFields, calendarId: CalendarId }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      // Attendees get the invitation with the event body: the user is asked like for a message.
      assessRisk: guestsRisk,
      undo: { kind: 'action', action: 'delete_event' },
      capability: {
        id: 'calendar.create_event',
        mapInput: ({ title, ...rest }) => ({ subject: title, ...rest }),
        mapOutput: (result) => {
          const e = result as EventSummary;
          return { id: e.id, ...(e.url ? { url: e.url } : {}) };
        },
      },
      run: async ({ calendarId, ...input }, ctx) => {
        const { data } = await api(ctx, zonePreference(ctx)).post<GraphEvent>(
          `${calendarBase(calendarId)}/events`,
          eventBody(input, ctx.config.timeZone),
        );
        return { timeZone: ctx.config.timeZone, ...eventSummary(data) };
      },
    }),
    action({
      name: 'update_event',
      keywords: 'reschedule move postpone change meeting appointment time',
      title: 'Update event',
      description: 'Changes only the given fields of an event; attendees get an update.',
      input: z.object({
        id: EventId,
        ...EventFields,
        subject: EventFields.subject.optional(),
        start: EventFields.start.optional(),
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      assessRisk: guestsRisk,
      run: async ({ id, ...input }, ctx) => {
        const body = eventBody(input, ctx.config.timeZone);
        if (!Object.keys(body).length) throw new ConnectorError('invalid_input', 'Nothing to change.');
        const { data } = await api(ctx, zonePreference(ctx)).request<GraphEvent>({
          method: 'PATCH',
          url: `me/events/${encodeURIComponent(id)}`,
          json: body,
        });
        return { timeZone: ctx.config.timeZone, ...eventSummary(data) };
      },
    }),
    action({
      name: 'delete_event',
      keywords: 'cancel remove meeting appointment',
      title: 'Delete / cancel event',
      description:
        'Deletes an event. For a meeting you organize, cancel sends attendees a cancellation note.',
      input: z.object({
        id: EventId,
        cancel: z.boolean().default(false).describe('Send a cancellation to attendees'),
        comment: z.string().max(2000).default(''),
      }),
      hints: { readOnly: false, destructive: true, idempotent: true },
      risk: 'dangerous',
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
