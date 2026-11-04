import { describe, expect, it } from 'vitest';
import slack from '../../src/connectors/builtin/slack.js';
import { fakeRoutes, json, testAccount } from './harness.js';

// Fixtures follow the documented Slack Web API responses (trimmed).
const users: Record<string, unknown> = {
  U01ANN: {
    id: 'U01ANN',
    name: 'ann',
    real_name: 'Ann Lee',
    profile: { display_name: 'ann', email: 'ann@acme.test' },
  },
  U02BOB: {
    id: 'U02BOB',
    name: 'bob',
    real_name: 'Bob Stone',
    profile: { display_name: '', real_name: 'Bob Stone' },
  },
};

function setup(credentials: Record<string, unknown> = { token: 'xoxp-1' }) {
  const service = fakeRoutes({
    'GET /api/auth.test': { ok: true, user: 'danel', team: 'Acme' },
    'GET /api/users.info': (req) => {
      const user = users[req.url.searchParams.get('user') ?? ''];
      return json(user ? { ok: true, user } : { ok: false, error: 'user_not_found' });
    },
    'GET /api/users.list': {
      ok: true,
      members: Object.values(users),
      response_metadata: { next_cursor: '' },
    },
    'GET /api/search.messages': {
      ok: true,
      messages: {
        total: 31,
        paging: { count: 20, total: 31, page: 1, pages: 2 },
        matches: [
          {
            ts: '1767225600.000100',
            user: 'U01ANN',
            text: 'Invoice for <@U02BOB> is at <https://pay.test/1|pay link>',
            channel: { id: 'C0GENERAL', name: 'general' },
            permalink: 'https://acme.slack.com/archives/C0GENERAL/p1767225600000100',
            blocks: [{ type: 'rich_text' }],
          },
        ],
      },
    },
    'GET /api/conversations.list': {
      ok: true,
      channels: [{ id: 'C0GENERAL', name: 'general' }],
      response_metadata: { next_cursor: '' },
    },
    'GET /api/conversations.history': (req) =>
      req.url.searchParams.get('channel') === 'C0GENERAL'
        ? json({
            ok: true,
            messages: [
              {
                ts: '1767225700.000200',
                user: 'U02BOB',
                text: 'Paid',
                thread_ts: '1767225700.000200',
                reply_count: 2,
              },
            ],
            has_more: true,
            response_metadata: { next_cursor: 'bmV4dA==' },
          })
        : json({ ok: false, error: 'channel_not_found' }),
    'POST /api/conversations.open': { ok: true, channel: { id: 'D0ANN' } },
    'POST /api/chat.postMessage': (req) => {
      const form = new URLSearchParams(req.body);
      return json({ ok: true, channel: form.get('channel'), ts: '1767225800.000300' });
    },
  });
  return { service, acc: testAccount(slack, { credentials, fetch: service.fetch }) };
}

describe('slack', () => {
  it('identifies the account', async () => {
    const { acc, service } = setup();
    expect(await slack.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'danel @ Acme' });
    expect(service.calls[0]!.headers.get('authorization')).toBe('Bearer xoxp-1');
  });

  it('searches with readable names, links and paging', async () => {
    const { acc } = setup();
    const result = (await acc.run('search_messages', { query: 'invoice in:#general' })) as {
      total: number;
      messages: Record<string, unknown>[];
      nextPage?: number;
    };
    expect(result.total).toBe(31);
    expect(result.nextPage).toBe(2);
    expect(result.messages[0]).toEqual({
      channel: '#general',
      channelId: 'C0GENERAL',
      ts: '1767225600.000100',
      date: '2026-01-01T00:00:00Z',
      from: 'ann',
      text: 'Invoice for @Bob Stone is at pay link (https://pay.test/1)',
      url: 'https://acme.slack.com/archives/C0GENERAL/p1767225600000100',
    });
  });

  it('reads a channel by name and shows threads', async () => {
    const { acc } = setup();
    const result = (await acc.run('read_channel', { channel: '#general' })) as Record<string, unknown>;
    expect(result).toMatchObject({
      channelId: 'C0GENERAL',
      nextCursor: 'bmV4dA==',
      messages: [{ from: 'Bob Stone', text: 'Paid', thread: { ts: '1767225700.000200', replies: 2 } }],
    });
  });

  it('opens a DM for @username and posts as a thread reply', async () => {
    const { acc, service } = setup();
    const sent = await acc.run('send_message', { channel: '@ann', text: 'Thanks!', thread_ts: '1.2' });
    expect(sent).toEqual({ sent: true, channelId: 'D0ANN', ts: '1767225800.000300' });
    const post = service.calls.at(-1)!;
    expect(new URLSearchParams(post.body).get('thread_ts')).toBe('1.2');
    expect(post.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
  });

  it('turns ok:false into typed errors', async () => {
    const { acc } = setup();
    await expect(acc.run('read_channel', { channel: 'C0MISSING1' })).rejects.toMatchObject({
      kind: 'not_found',
    });
    await expect(acc.run('send_message', { channel: '#nope', text: 'x' })).rejects.toMatchObject({
      kind: 'not_found',
    });
    const unauthed = setup({});
    await expect(unauthed.acc.run('find_user', { query: 'ann' })).rejects.toMatchObject({ kind: 'auth' });
  });

  it('uses the OAuth token when the account is connected through OAuth', async () => {
    const service = fakeRoutes({ 'GET /api/users.list': { ok: true, members: Object.values(users) } });
    const acc = testAccount(slack, { fetch: service.fetch, oauth: { accessToken: 'xoxp-oauth' } });
    const found = (await acc.run('find_user', { query: 'stone' })) as { users: { id: string }[] };
    expect(found.users.map((u) => u.id)).toEqual(['U02BOB']);
    expect(service.calls[0]!.headers.get('authorization')).toBe('Bearer xoxp-oauth');
  });
});
