import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HttpClient } from '../http/client.js';
import {
  type AccountContext,
  type CapabilityOutput,
  ConnectorError,
  compact,
  defineConnector,
  page,
  truncateText,
} from '../sdk.js';

/**
 * Zoom API v2 through a Server-to-Server OAuth app of the user's own Zoom account: the app's account
 * id, client id and secret are exchanged for an hour-long access token (account_credentials grant).
 * Tokens are cached in memory per hub account and never stored.
 */

const Credentials = z.object({
  accountId: z.string().trim().min(10).max(64).describe('Account ID of the Server-to-Server OAuth app'),
  clientId: z.string().trim().min(10).max(64).describe('Client ID of the app'),
  clientSecret: z.string().trim().min(10).max(128).describe('Client secret of the app'),
});

type Ctx = AccountContext<Record<string, never>, z.output<typeof Credentials>>;

const tokens = new Map<string, { token: string; expires: number; key: string }>();

async function accessToken(ctx: Ctx): Promise<string> {
  const { accountId, clientId, clientSecret } = ctx.credentials;
  // A credential change (new secret, other app) must not reuse the old token.
  const key = createHash('sha256').update(`${accountId}\n${clientId}\n${clientSecret}`).digest('hex');
  const cached = tokens.get(ctx.account.id);
  if (cached && cached.key === key && cached.expires > Date.now() + 60_000) return cached.token;
  const client = new HttpClient(ctx, {
    baseUrl: 'https://zoom.us',
    headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
    errorMessagePaths: ['reason', 'error_description', 'error'],
  });
  let data: { access_token?: string; expires_in?: number };
  try {
    ({ data } = await client.request<{ access_token?: string; expires_in?: number }>({
      method: 'POST',
      url: '/oauth/token',
      query: { grant_type: 'account_credentials', account_id: accountId },
    }));
  } catch (error) {
    // Zoom answers 400 for a wrong id or secret; for the user that is an auth problem.
    if (error instanceof ConnectorError && error.kind === 'invalid_input') {
      throw new ConnectorError('auth', `Zoom rejected the app credentials: ${error.message}`);
    }
    throw error;
  }
  if (!data.access_token) throw new ConnectorError('auth', 'Zoom did not return an access token');
  tokens.set(ctx.account.id, {
    token: data.access_token,
    expires: Date.now() + (data.expires_in ?? 3600) * 1000,
    key,
  });
  return data.access_token;
}

async function zoom(ctx: Ctx) {
  return new HttpClient(ctx, {
    baseUrl: 'https://api.zoom.us/v2',
    headers: { authorization: `Bearer ${await accessToken(ctx)}` },
    errorMessagePaths: ['message'],
  });
}

interface Meeting {
  id: number;
  uuid?: string;
  topic: string;
  type?: number;
  start_time?: string;
  duration?: number;
  timezone?: string;
  agenda?: string;
  join_url?: string;
  password?: string;
  status?: string;
}

const meetingOut = (m: Meeting) =>
  compact({
    id: String(m.id),
    topic: m.topic,
    start: m.start_time,
    duration: m.duration,
    timezone: m.timezone,
    agenda: m.agenda ? truncateText(m.agenda, 1000) : undefined,
    join_url: m.join_url,
    status: m.status,
  });

const endOf = (start: string | undefined, minutes: number | undefined) =>
  start && minutes ? new Date(Date.parse(start) + minutes * 60_000).toISOString() : undefined;

const MeetingId = z
  .union([z.string().regex(/^\d{9,12}$/), z.number().int().positive()])
  .transform(String)
  .describe('Meeting id (digits, without spaces)');
const Start = z.string().datetime({ offset: true }).describe('ISO date-time, e.g. 2026-11-20T15:00:00Z');

export default defineConnector({
  id: 'zoom',
  name: 'Zoom',
  description: 'Zoom meetings and recordings: list, schedule, change and cancel meetings, find recordings.',
  version: '1.0.0',
  homepage: 'https://developers.zoom.us/docs/api/',
  instructions:
    'Meetings are created for the user of the Zoom app. Times are ISO 8601; pass timezone to show local time to invitees.',
  credentials: Credentials,
  rateLimit: { requests: 20, perSeconds: 1 },
  async test(ctx) {
    const { data } = await (await zoom(ctx)).get<{ email?: string; display_name?: string }>('/users/me');
    return { ok: true, identity: data.email ?? data.display_name ?? 'Zoom' };
  },
  ui: {
    primaryFields: ['accountId', 'clientId', 'clientSecret'],
    locales: {
      ru: {
        description: 'Встречи и записи Zoom: список, планирование, изменение и отмена встреч, поиск записей.',
        setup: {
          form: {
            summary:
              'Вы создаёте личное приложение Server-to-Server OAuth в Zoom App Marketplace и вставляете сюда три его ключа.',
            minutes: 6,
            needs: [
              'Аккаунт Zoom, где вы администратор или у вас есть право **Server-to-Server OAuth app** от администратора',
            ],
            steps: [
              {
                text: 'Откройте Zoom App Marketplace → **Develop → Build App** и выберите **Server-to-Server OAuth App**.',
                link: {
                  label: 'Открыть Zoom Marketplace',
                  url: 'https://marketplace.zoom.us/develop/create',
                },
              },
              {
                text: 'Назовите приложение Manyplug и нажмите **Create**. На вкладке **App Credentials** скопируйте **Account ID**, **Client ID** и **Client Secret**.',
                fills: ['accountId', 'clientId', 'clientSecret'],
              },
              {
                text: 'На вкладке **Information** заполните краткое описание, название компании, имя и почту разработчика: без них Zoom не активирует приложение.',
              },
              {
                text: 'На вкладке **Scopes** нажмите **Add Scopes** и добавьте meeting:read:list_meetings:admin, meeting:read:meeting:admin, meeting:write:meeting:admin, meeting:update:meeting:admin и meeting:delete:meeting:admin.',
              },
              {
                text: 'Добавьте ещё cloud_recording:read:list_user_recordings:admin и user:read:user:admin, затем на вкладке **Activation** нажмите **Activate your app**.',
              },
            ],
            tips: [
              'Приложение доступно только вашему аккаунту Zoom и не публикуется в Marketplace.',
              'ИИ отменяет встречу только после вашего подтверждения: участники получат письмо.',
            ],
            problems: [
              {
                problem: '«Invalid client_id or client_secret»',
                fix: 'Скопируйте три значения заново с вкладки **App Credentials**. Если вы перевыпускали секрет, возьмите новый.',
              },
              {
                problem: 'ИИ получает «Invalid access token, does not contain scopes»',
                fix: 'Приложению не хватает разрешения. Добавьте его на вкладке **Scopes** (шаги 4–5) и нажмите здесь **Переподключить**.',
              },
              {
                problem: 'Нет варианта **Server-to-Server OAuth App**',
                fix: 'Попросите администратора Zoom отметить **View** и **Edit** для **Server-to-Server OAuth app** в вашей роли (**User Management → Roles → Advanced features**) и дать доступ к нужным правам.',
              },
            ],
          },
        },
        prompts: [
          'Какие встречи в Zoom у меня на этой неделе?',
          'Создай Zoom на завтра в 15:00 на 30 минут «Созвон с ACME» и дай ссылку.',
          'Перенеси встречу «Планёрка» на час позже.',
          'Найди запись вчерашнего созвона с Беном.',
        ],
        fields: {
          accountId: { label: 'Account ID', hint: 'App Credentials в приложении Server-to-Server OAuth.' },
          clientId: { label: 'Client ID', hint: 'Там же.' },
          clientSecret: { label: 'Client Secret', hint: 'Там же.' },
        },
        actions: {
          list_meetings: { title: 'Встречи', description: 'Ближайшие, прошедшие или регулярные встречи.' },
          get_meeting: { title: 'Встреча', description: 'Время, повестка и ссылка встречи.' },
          create_meeting: { title: 'Новая встреча', description: 'Планирует встречу и даёт ссылку.' },
          update_meeting: { title: 'Изменение встречи', description: 'Меняет тему, время, длительность.' },
          cancel_meeting: {
            title: 'Отмена встречи',
            description: 'Отменяет встречу и уведомляет участников.',
          },
          list_recordings: { title: 'Записи', description: 'Облачные записи за период.' },
        },
      },
      en: {
        setup: {
          form: {
            summary:
              'You create a private Server-to-Server OAuth app in the Zoom App Marketplace and paste its three keys here.',
            minutes: 6,
            needs: [
              'A Zoom account where you are an admin, or have the **Server-to-Server OAuth app** permission from your admin',
            ],
            steps: [
              {
                text: 'Open the Zoom App Marketplace → **Develop → Build App** and pick **Server-to-Server OAuth App**.',
                link: { label: 'Open Zoom Marketplace', url: 'https://marketplace.zoom.us/develop/create' },
              },
              {
                text: 'Name it Manyplug and click **Create**. On **App Credentials**, copy the **Account ID**, **Client ID** and **Client Secret**.',
                fills: ['accountId', 'clientId', 'clientSecret'],
              },
              {
                text: 'On **Information**, fill in the short description, company name and the developer’s name and email: Zoom will not activate the app without them.',
              },
              {
                text: 'On **Scopes**, click **Add Scopes** and add meeting:read:list_meetings:admin, meeting:read:meeting:admin, meeting:write:meeting:admin, meeting:update:meeting:admin and meeting:delete:meeting:admin.',
              },
              {
                text: 'Also add cloud_recording:read:list_user_recordings:admin and user:read:user:admin, then on **Activation** click **Activate your app**.',
              },
            ],
            tips: [
              'The app is private to your Zoom account and is not published in the Marketplace.',
              'The AI cancels a meeting only after you confirm: invitees get an email.',
            ],
            problems: [
              {
                problem: '“Invalid client_id or client_secret”',
                fix: 'Copy the three values again from **App Credentials**. If you regenerated the secret, use the new one.',
              },
              {
                problem: 'The AI gets “Invalid access token, does not contain scopes”',
                fix: 'The app lacks a scope. Add it on **Scopes** (steps 4–5) and click **Reconnect** here.',
              },
              {
                problem: 'There is no **Server-to-Server OAuth App** option',
                fix: 'Ask your Zoom admin to tick **View** and **Edit** for **Server-to-Server OAuth app** in your role (**User Management → Roles → Advanced features**), plus access to the scopes you add.',
              },
            ],
          },
        },
        prompts: [
          'Which Zoom meetings do I have this week?',
          'Create a 30-minute Zoom tomorrow at 3 pm, “Call with ACME”, and give me the link.',
          'Move the “Stand-up” meeting an hour later.',
          'Find the recording of yesterday’s call with Ben.',
        ],
        fields: {
          accountId: { label: 'Account ID', hint: 'App Credentials of the Server-to-Server OAuth app.' },
          clientId: { label: 'Client ID', hint: 'Same page.' },
          clientSecret: { label: 'Client Secret', hint: 'Same page.' },
        },
        actions: {
          list_meetings: { title: 'Meetings', description: 'Upcoming, past or recurring meetings.' },
          get_meeting: { title: 'Get a meeting', description: 'Time, agenda and join link.' },
          create_meeting: {
            title: 'Schedule a meeting',
            description: 'Schedules a meeting and returns its link.',
          },
          update_meeting: { title: 'Change a meeting', description: 'Changes topic, time or length.' },
          cancel_meeting: {
            title: 'Cancel a meeting',
            description: 'Cancels a meeting and notifies invitees.',
          },
          list_recordings: { title: 'Recordings', description: 'Cloud recordings in a period.' },
        },
      },
    },
  },
  actions: (action) => [
    action({
      name: 'list_meetings',
      title: 'List meetings',
      description: 'Lists scheduled meetings: upcoming (default), past (previous_meetings) or recurring.',
      input: z.object({
        type: z.enum(['upcoming', 'scheduled', 'previous_meetings', 'live']).default('upcoming'),
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}/)
          .optional()
          .describe('YYYY-MM-DD'),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}/)
          .optional()
          .describe('YYYY-MM-DD'),
        limit: z.number().int().min(1).max(300).default(30),
        cursor: z.string().max(500).optional().describe('nextCursor from the previous result'),
      }),
      hints: { readOnly: true, idempotent: true },
      capability: {
        id: 'calendar.list_events',
        mapInput: ({ from, to, limit }) => ({
          type: 'upcoming',
          ...(typeof from === 'string' ? { from: from.slice(0, 10) } : {}),
          ...(typeof to === 'string' ? { to: to.slice(0, 10) } : {}),
          limit,
        }),
        mapOutput: (result, input) => {
          const { items, nextCursor } = result as {
            items: ReturnType<typeof meetingOut>[];
            nextCursor?: string;
          };
          const words = typeof input.query === 'string' ? input.query.toLowerCase() : undefined;
          return {
            items: items
              .filter((m) => m.start && (!words || String(m.topic).toLowerCase().includes(words)))
              .map((m): CapabilityOutput<'calendar.list_events'> => {
                const end = endOf(m.start as string, m.duration as number | undefined);
                return {
                  id: String(m.id),
                  title: String(m.topic),
                  start: String(m.start),
                  ...(end ? { end } : {}),
                  ...(m.join_url ? { location: String(m.join_url), url: String(m.join_url) } : {}),
                  calendar: 'Zoom',
                };
              }),
            ...(nextCursor ? { nextCursor } : {}),
          };
        },
      },
      run: async ({ type, from, to, limit, cursor }, ctx) => {
        const { data } = await (await zoom(ctx)).get<{ meetings: Meeting[]; next_page_token?: string }>(
          '/users/me/meetings',
          compact({ type, from, to, page_size: limit, next_page_token: cursor }),
        );
        return page(data.meetings.map(meetingOut), { nextCursor: data.next_page_token || undefined });
      },
    }),
    action({
      name: 'get_meeting',
      title: 'Get meeting',
      description: 'Returns a meeting with its time, agenda, join link and passcode.',
      input: z.object({ meeting_id: MeetingId }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ meeting_id }, ctx) => {
        const { data } = await (await zoom(ctx)).get<Meeting>(`/meetings/${meeting_id}`);
        return compact({ ...meetingOut(data), passcode: data.password });
      },
    }),
    action({
      name: 'create_meeting',
      title: 'Schedule meeting',
      description: 'Schedules a meeting and returns its join link.',
      input: z.object({
        topic: z.string().trim().min(1).max(200),
        start: Start,
        duration: z.number().int().min(1).max(1440).default(30).describe('Minutes'),
        timezone: z.string().max(60).optional().describe('IANA zone, e.g. Europe/Berlin'),
        agenda: z.string().max(2000).optional(),
        waiting_room: z.boolean().optional(),
      }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      undo: { kind: 'action', action: 'cancel_meeting' },
      capability: {
        id: 'calendar.create_event',
        mapInput: ({ title, start, end, description }) => ({
          topic: title,
          start,
          ...(typeof end === 'string' && typeof start === 'string'
            ? { duration: Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 60_000)) }
            : {}),
          ...(description ? { agenda: description } : {}),
        }),
        mapOutput: (result) => {
          const m = result as ReturnType<typeof meetingOut>;
          return { id: String(m.id), ...(m.join_url ? { url: String(m.join_url) } : {}) };
        },
      },
      run: async ({ topic, start, duration, timezone, agenda, waiting_room }, ctx) => {
        const { data } = await (await zoom(ctx)).post<Meeting>('/users/me/meetings', {
          topic,
          type: 2,
          start_time: start,
          duration,
          ...(timezone ? { timezone } : {}),
          ...(agenda ? { agenda } : {}),
          ...(waiting_room !== undefined ? { settings: { waiting_room } } : {}),
        });
        return compact({ ...meetingOut(data), passcode: data.password });
      },
    }),
    action({
      name: 'update_meeting',
      title: 'Change meeting',
      description: 'Changes the topic, time, length, time zone or agenda of a meeting.',
      input: z.object({
        meeting_id: MeetingId,
        topic: z.string().trim().min(1).max(200).optional(),
        start: Start.optional(),
        duration: z.number().int().min(1).max(1440).optional(),
        timezone: z.string().max(60).optional(),
        agenda: z.string().max(2000).optional(),
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      run: async ({ meeting_id, topic, start, duration, timezone, agenda }, ctx) => {
        const patch = compact({ topic, start_time: start, duration, timezone, agenda });
        if (!Object.keys(patch).length) throw new ConnectorError('invalid_input', 'Nothing to change.');
        const client = await zoom(ctx);
        await client.request({ method: 'PATCH', url: `/meetings/${meeting_id}`, json: patch });
        const { data } = await client.get<Meeting>(`/meetings/${meeting_id}`);
        return meetingOut(data);
      },
    }),
    action({
      name: 'cancel_meeting',
      title: 'Cancel meeting',
      description: 'Deletes a scheduled meeting and emails the cancellation to registrants.',
      input: z.object({ meeting_id: MeetingId }),
      hints: { readOnly: false, destructive: true, idempotent: true },
      risk: 'dangerous',
      run: async ({ meeting_id }, ctx) => {
        await (await zoom(ctx)).request({
          method: 'DELETE',
          url: `/meetings/${meeting_id}`,
          query: { schedule_for_reminder: true, cancel_meeting_reminder: true },
        });
        return 'Meeting cancelled.';
      },
    }),
    action({
      name: 'list_recordings',
      title: 'List recordings',
      description: 'Cloud recordings in a date range (default: the last 30 days), with share links.',
      input: z.object({
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('YYYY-MM-DD'),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('YYYY-MM-DD'),
        limit: z.number().int().min(1).max(300).default(30),
        cursor: z.string().max(500).optional(),
      }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ from, to, limit, cursor }, ctx) => {
        const since = from ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
        const { data } = await (await zoom(ctx)).get<{
          meetings: {
            id: number;
            topic: string;
            start_time: string;
            duration?: number;
            share_url?: string;
            recording_files?: { file_type?: string; recording_type?: string }[];
          }[];
          next_page_token?: string;
        }>('/users/me/recordings', compact({ from: since, to, page_size: limit, next_page_token: cursor }));
        return page(
          data.meetings.map((m) =>
            compact({
              meeting_id: String(m.id),
              topic: m.topic,
              start: m.start_time,
              duration: m.duration,
              share_url: m.share_url,
              files: [
                ...new Set((m.recording_files ?? []).map((f) => f.recording_type ?? f.file_type)),
              ].filter(Boolean),
            }),
          ),
          { nextCursor: data.next_page_token || undefined },
        );
      },
    }),
  ],
});
