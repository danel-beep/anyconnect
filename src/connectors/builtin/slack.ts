import { z } from 'zod';
import { HttpClient, type QueryValue } from '../http/client.js';
import { type AccountContext, ConnectorError, defineConnector, type ErrorKind } from '../sdk.js';

/**
 * Slack Web API as the user (user token `xoxp-…`): search, read channels and DMs, send messages.
 * Slack answers HTTP 200 with `{ ok: false, error }` for most failures, so this is a code connector
 * on top of the shared HTTP client rather than a manifest.
 */

const Credentials = z.object({
  token: z
    .string()
    .regex(/^xox[pb]-/, 'a Slack token starts with xoxp- (user) or xoxb- (bot)')
    .optional()
    .describe('User OAuth token (xoxp-…) from your Slack app; not needed when connected through OAuth'),
});

type Ctx = AccountContext<Record<string, never>, z.output<typeof Credentials>>;

const ERROR_KINDS: Record<string, ErrorKind> = {
  not_authed: 'auth',
  invalid_auth: 'auth',
  token_revoked: 'auth',
  token_expired: 'auth',
  account_inactive: 'auth',
  missing_scope: 'permission',
  not_allowed_token_type: 'permission',
  restricted_action: 'permission',
  not_in_channel: 'permission',
  ratelimited: 'rate_limited',
  channel_not_found: 'not_found',
  user_not_found: 'not_found',
  thread_not_found: 'not_found',
  message_not_found: 'not_found',
};

const HINTS: Record<string, string> = {
  missing_scope: 'the Slack app lacks a required scope',
  not_in_channel: 'the account is not a member of this channel',
  channel_not_found: 'no such channel, or it is not visible to this account',
};

interface SlackResponse {
  ok: boolean;
  error?: string;
  needed?: string;
  response_metadata?: { next_cursor?: string };
  [key: string]: unknown;
}

/** Calls a Web API method; `{ ok: false }` becomes a `ConnectorError` with the right kind. */
async function call<T extends SlackResponse>(
  ctx: Ctx,
  method: string,
  params: Record<string, QueryValue>,
  write = false,
): Promise<T> {
  const token = ctx.credentials.token;
  if (!ctx.oauth && !token) throw new ConnectorError('auth', 'Slack is not connected yet');
  const client = new HttpClient(ctx, {
    baseUrl: 'https://slack.com/api',
    ...(ctx.oauth ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
  const response = write
    ? await client.request<T>({ method: 'POST', url: method, form: clean })
    : await client.request<T>({ method: 'GET', url: method, query: clean });
  const data = response.data;
  if (!data?.ok) {
    const code = data?.error ?? 'unknown_error';
    const kind = ERROR_KINDS[code] ?? 'invalid_input';
    const detail = HINTS[code] ? `: ${HINTS[code]}` : '';
    const needed = code === 'missing_scope' && data?.needed ? ` (needs ${data.needed})` : '';
    throw new ConnectorError(kind, `Slack error ${code}${detail}${needed}`, {
      ...(kind === 'rate_limited' ? { retryAfterSeconds: 30 } : {}),
    });
  }
  return data;
}

// Slack messages refer to people by id; names are resolved once per account and cached briefly.
const USER_CACHE_MS = 10 * 60_000;
const userCache = new Map<string, { at: number; names: Map<string, string> }>();

async function userNames(ctx: Ctx, ids: Iterable<string>): Promise<Map<string, string>> {
  const key = ctx.account.id;
  let entry = userCache.get(key);
  if (!entry || Date.now() - entry.at > USER_CACHE_MS) {
    entry = { at: Date.now(), names: new Map() };
    userCache.set(key, entry);
  }
  const missing = [...new Set(ids)].filter((id) => id && !entry!.names.has(id));
  await Promise.all(
    missing.slice(0, 30).map(async (id) => {
      try {
        const { user } = await call<SlackResponse & { user: SlackUser }>(ctx, 'users.info', { user: id });
        entry!.names.set(id, displayName(user));
      } catch {
        entry!.names.set(id, id);
      }
    }),
  );
  return entry.names;
}

interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { display_name?: string; real_name?: string; email?: string; title?: string };
}

const displayName = (u: SlackUser) =>
  u.profile?.display_name || u.real_name || u.profile?.real_name || u.name || u.id;

/** Slack timestamps ("1730700000.123456") as ISO dates. */
const tsToIso = (ts: string | undefined) =>
  ts ? new Date(Number(ts.split('.')[0]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : undefined;

/** Replaces `<@U123>` mentions with names and `<url|label>` links with readable text. */
function readableText(text: string | undefined, names: Map<string, string>): string {
  return (text ?? '')
    .replace(/<@([UW][A-Z0-9]+)(\|[^>]+)?>/g, (_m, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1');
}

const mentionedIds = (text: string | undefined) =>
  [...(text ?? '').matchAll(/<@([UW][A-Z0-9]+)/g)].map((m) => m[1]!);

interface SlackMessage {
  ts: string;
  user?: string;
  username?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  files?: { id: string; name?: string; mimetype?: string; size?: number }[];
}

async function formatMessages(ctx: Ctx, messages: SlackMessage[]) {
  const names = await userNames(
    ctx,
    messages.flatMap((m) => [m.user ?? '', ...mentionedIds(m.text)]),
  );
  return messages.map((m) => ({
    ts: m.ts,
    date: tsToIso(m.ts),
    from: m.user ? (names.get(m.user) ?? m.user) : (m.username ?? m.bot_id ?? 'unknown'),
    text: readableText(m.text, names),
    ...(m.thread_ts && m.reply_count ? { thread: { ts: m.thread_ts, replies: m.reply_count } } : {}),
    ...(m.files?.length ? { files: m.files.map((f) => f.name ?? f.id) } : {}),
  }));
}

/** Accepts a channel id, "#name", "@username" or a user id; DMs are opened on demand. */
async function resolveChannel(ctx: Ctx, channel: string): Promise<string> {
  const value = channel.trim();
  if (/^[CGD][A-Z0-9]{6,}$/.test(value)) return value;
  if (/^[UW][A-Z0-9]{6,}$/.test(value) || value.startsWith('@')) {
    const userId = value.startsWith('@') ? await findUserId(ctx, value.slice(1)) : value;
    const opened = await call<SlackResponse & { channel: { id: string } }>(
      ctx,
      'conversations.open',
      { users: userId },
      true,
    );
    return opened.channel.id;
  }
  const name = value.replace(/^#/, '').toLowerCase();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await call<SlackResponse & { channels: { id: string; name?: string }[] }>(
      ctx,
      'conversations.list',
      { types: 'public_channel,private_channel', exclude_archived: true, limit: 1000, cursor },
    );
    const found = result.channels.find((c) => c.name?.toLowerCase() === name);
    if (found) return found.id;
    cursor = result.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  throw new ConnectorError('not_found', `Channel "${channel}" not found. Use slack_list_channels for ids.`);
}

async function findUsers(ctx: Ctx, query: string, limit: number): Promise<SlackUser[]> {
  const q = query.trim().toLowerCase().replace(/^@/, '');
  const found: SlackUser[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20 && found.length < limit; page++) {
    const result = await call<SlackResponse & { members: SlackUser[] }>(ctx, 'users.list', {
      limit: 500,
      cursor,
    });
    for (const user of result.members) {
      if (user.deleted) continue;
      const haystack = [user.name, user.real_name, user.profile?.display_name, user.profile?.email]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (haystack.includes(q)) found.push(user);
    }
    cursor = result.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return found.slice(0, limit);
}

async function findUserId(ctx: Ctx, query: string): Promise<string> {
  const users = await findUsers(ctx, query, 5);
  const exact = users.find((u) => u.name === query || u.profile?.display_name === query);
  if (exact) return exact.id;
  if (users.length === 1) return users[0]!.id;
  if (users.length === 0) throw new ConnectorError('not_found', `No Slack user matches "${query}".`);
  throw new ConnectorError(
    'invalid_input',
    `Several users match "${query}": ${users.map((u) => `${displayName(u)} (${u.id})`).join(', ')}. Pass the id.`,
  );
}

const Channel = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe('Channel id (C…/D…), "#channel-name", "@username" or user id (opens a DM)');
const Limit = (max: number, fallback: number) => z.number().int().min(1).max(max).default(fallback);

export default defineConnector({
  id: 'slack',
  name: 'Slack',
  description: 'Slack workspace as you: search messages, read channels, DMs and threads, send messages.',
  version: '1.0.0',
  homepage: 'https://api.slack.com/web',
  instructions:
    'Message "ts" identifies a message in its channel; pass it as thread_ts to read or reply in a thread.',
  credentials: Credentials,
  oauth: {
    provider: 'slack',
    scopes: [
      'search:read',
      'channels:read',
      'channels:history',
      'groups:read',
      'groups:history',
      'im:read',
      'im:history',
      'im:write',
      'mpim:read',
      'mpim:history',
      'users:read',
      'chat:write',
    ],
  },
  async test(ctx) {
    const auth = await call<SlackResponse & { user?: string; team?: string }>(ctx, 'auth.test', {});
    return { ok: true, identity: [auth.user, auth.team].filter(Boolean).join(' @ ') };
  },
  actions: (action) => [
    action({
      name: 'search_messages',
      title: 'Search messages',
      description:
        'Searches messages in all channels and DMs. Supports Slack modifiers: from:@user, in:#channel, after:2026-11-01, has:link.',
      input: z.object({
        query: z.string().trim().min(1).max(500),
        sort: z.enum(['timestamp', 'score']).default('timestamp'),
        limit: Limit(50, 20),
        page: z.number().int().min(1).max(100).default(1),
      }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ query, sort, limit, page }, ctx) => {
        const result = await call<
          SlackResponse & {
            messages: {
              total: number;
              matches: (SlackMessage & { channel?: { id: string; name?: string }; permalink?: string })[];
              paging?: { page: number; pages: number };
            };
          }
        >(ctx, 'search.messages', { query, sort, sort_dir: 'desc', count: limit, page });
        const matches = result.messages.matches ?? [];
        const formatted = await formatMessages(ctx, matches);
        const paging = result.messages.paging;
        return {
          total: result.messages.total,
          messages: formatted.map((m, i) => ({
            channel: matches[i]?.channel?.name ? `#${matches[i]!.channel!.name}` : matches[i]?.channel?.id,
            channelId: matches[i]?.channel?.id,
            ...m,
            ...(matches[i]?.permalink ? { url: matches[i]!.permalink } : {}),
          })),
          ...(paging && paging.page < paging.pages ? { nextPage: paging.page + 1 } : {}),
        };
      },
    }),
    action({
      name: 'list_channels',
      title: 'List channels',
      description: 'Lists channels and direct messages the account is in, with ids.',
      input: z.object({
        types: z
          .array(z.enum(['public_channel', 'private_channel', 'im', 'mpim']))
          .default(['public_channel', 'private_channel', 'im', 'mpim']),
        limit: Limit(200, 100),
        cursor: z.string().max(200).optional().describe('nextCursor from the previous page'),
      }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ types, limit, cursor }, ctx) => {
        const result = await call<
          SlackResponse & {
            channels: {
              id: string;
              name?: string;
              is_im?: boolean;
              is_mpim?: boolean;
              is_private?: boolean;
              user?: string;
              num_members?: number;
              topic?: { value?: string };
            }[];
          }
        >(ctx, 'users.conversations', { types: types.join(','), exclude_archived: true, limit, cursor });
        const names = await userNames(
          ctx,
          result.channels.flatMap((c) => (c.is_im && c.user ? [c.user] : [])),
        );
        const next = result.response_metadata?.next_cursor;
        return {
          channels: result.channels.map((c) => ({
            id: c.id,
            name: c.is_im ? `@${names.get(c.user ?? '') ?? c.user}` : `#${c.name}`,
            kind: c.is_im ? 'dm' : c.is_mpim ? 'group_dm' : c.is_private ? 'private' : 'public',
            ...(c.num_members ? { members: c.num_members } : {}),
            ...(c.topic?.value ? { topic: c.topic.value } : {}),
          })),
          ...(next ? { nextCursor: next } : {}),
        };
      },
    }),
    action({
      name: 'read_channel',
      title: 'Read channel',
      description:
        'Latest messages of a channel or DM, newest first. Use thread_ts to read a thread instead.',
      input: z.object({
        channel: Channel,
        thread_ts: z.string().max(30).optional().describe('ts of the thread parent to read its replies'),
        limit: Limit(100, 30),
        cursor: z.string().max(200).optional().describe('nextCursor from the previous page (older messages)'),
      }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ channel, thread_ts, limit, cursor }, ctx) => {
        const id = await resolveChannel(ctx, channel);
        const result = thread_ts
          ? await call<SlackResponse & { messages: SlackMessage[] }>(ctx, 'conversations.replies', {
              channel: id,
              ts: thread_ts,
              limit,
              cursor,
            })
          : await call<SlackResponse & { messages: SlackMessage[] }>(ctx, 'conversations.history', {
              channel: id,
              limit,
              cursor,
            });
        const next = result.response_metadata?.next_cursor;
        return {
          channelId: id,
          messages: await formatMessages(ctx, result.messages ?? []),
          ...(next ? { nextCursor: next } : {}),
        };
      },
    }),
    action({
      name: 'send_message',
      title: 'Send message',
      description:
        'Posts a message to a channel or DM as the user, optionally as a thread reply. Slack mrkdwn is supported.',
      input: z.object({
        channel: Channel,
        text: z.string().min(1).max(40_000),
        thread_ts: z.string().max(30).optional().describe('ts of the message to reply to in its thread'),
      }),
      hints: { readOnly: false, destructive: false },
      run: async ({ channel, text, thread_ts }, ctx) => {
        const id = await resolveChannel(ctx, channel);
        const result = await call<SlackResponse & { channel: string; ts: string }>(
          ctx,
          'chat.postMessage',
          { channel: id, text, thread_ts },
          true,
        );
        return { sent: true, channelId: result.channel, ts: result.ts };
      },
    }),
    action({
      name: 'find_user',
      title: 'Find user',
      description: 'Finds people in the workspace by name, username or email.',
      input: z.object({ query: z.string().trim().min(1).max(200), limit: Limit(20, 5) }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ query, limit }, ctx) => ({
        users: (await findUsers(ctx, query, limit)).map((u) => ({
          id: u.id,
          name: displayName(u),
          username: u.name,
          ...(u.profile?.email ? { email: u.profile.email } : {}),
          ...(u.profile?.title ? { title: u.profile.title } : {}),
          ...(u.is_bot ? { bot: true } : {}),
        })),
      }),
    }),
  ],
});
