import { describe, expect, it } from 'vitest';
import bitbucket from '../../src/connectors/builtin/bitbucket.js';
import brevo from '../../src/connectors/builtin/brevo.js';
import calcom from '../../src/connectors/builtin/calcom.js';
import cloudflare from '../../src/connectors/builtin/cloudflare.js';
import vercel from '../../src/connectors/builtin/vercel.js';
import webflow from '../../src/connectors/builtin/webflow.js';
import { fakeRoutes, json, type RecordedRequest, testAccount } from './harness.js';

// Fourth catalogue batch. Fixtures follow the documented response shapes of each API, trimmed.

const body = (req: RecordedRequest) => JSON.parse(req.body!);
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('vercel', () => {
  const service = fakeRoutes({
    'GET /v2/user': { user: { id: 'u1', email: 'ann@acme.com', username: 'ann' } },
    'GET /v6/deployments': (req) =>
      json({
        deployments: [
          {
            uid: 'dpl_1',
            name: 'landing',
            url: 'landing-abc.vercel.app',
            state: 'ERROR',
            target: 'production',
            created: 1793613600000,
            creator: { uid: 'u1', username: 'ann' },
            meta: { githubCommitRef: 'main', githubCommitMessage: 'Fix hero', githubCommitSha: 'abc' },
          },
        ],
        pagination: { count: 1, next: req.url.searchParams.get('until') ? null : 1793613500000, prev: null },
      }),
    'POST /v10/projects/landing/promote/dpl_1': () => new Response(null, { status: 202 }),
  });
  const acc = testAccount(vercel, {
    config: { team_id: 'team_abc' },
    credentials: { token: 'vercel_token_0123456789' },
    fetch: service.fetch,
  });

  it('checks the token against the user', async () => {
    expect(await vercel.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    expect(service.calls.at(-1)!.headers.get('authorization')).toBe('Bearer vercel_token_0123456789');
  });

  it('scopes requests to the team and pages with until', async () => {
    const first = (await acc.run('list_deployments', { project_id: 'landing', state: 'ERROR' })) as {
      items: unknown[];
      nextCursor?: string;
    };
    const url = service.calls.at(-1)!.url;
    expect(url.searchParams.get('teamId')).toBe('team_abc');
    expect(url.searchParams.get('projectId')).toBe('landing');
    expect(first.items[0]).toEqual({
      uid: 'dpl_1',
      name: 'landing',
      url: 'landing-abc.vercel.app',
      state: 'ERROR',
      target: 'production',
      created: 1793613600000,
      creator: { username: 'ann' },
      meta: { githubCommitRef: 'main', githubCommitMessage: 'Fix hero' },
    });
    await acc.run('list_deployments', { cursor: first.nextCursor });
    expect(service.calls.at(-1)!.url.searchParams.get('until')).toBe('1793613500000');
  });

  it('keeps promotion dangerous', async () => {
    expect(vercel.actions.find((a) => a.name === 'promote_deployment')!.risk).toBe('dangerous');
    expect(await acc.run('promote_deployment', { project_id: 'landing', deployment_id: 'dpl_1' })).toBe(
      'Promotion started.',
    );
  });
});

describe('cloudflare', () => {
  const zone = 'a'.repeat(32);
  const service = fakeRoutes({
    'GET /client/v4/user/tokens/verify': { success: true, result: { id: 'tok1', status: 'active' } },
    [`GET /client/v4/zones/${zone}/dns_records`]: (req) =>
      json({
        success: true,
        result:
          req.url.searchParams.get('page') === '1'
            ? [
                {
                  id: 'b'.repeat(32),
                  type: 'A',
                  name: 'acme.com',
                  content: '203.0.113.7',
                  proxied: true,
                  ttl: 1,
                  meta: {},
                },
              ]
            : [],
      }),
    [`POST /client/v4/zones/${zone}/dns_records`]: (req) =>
      json({ success: true, result: { id: 'c'.repeat(32), ...body(req) } }),
    [`POST /client/v4/zones/${zone}/purge_cache`]: { success: true, result: { id: zone } },
  });
  const acc = testAccount(cloudflare, { credentials: { token: 't'.repeat(40) }, fetch: service.fetch });

  it('verifies the token', async () => {
    expect(await cloudflare.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'tok1' });
  });

  it('pages DNS records until an empty page', async () => {
    const first = (await acc.run('list_dns_records', { zone_id: zone, type: 'A' })) as {
      items: unknown[];
      nextCursor?: string;
    };
    expect(first.items).toEqual([
      { id: 'b'.repeat(32), type: 'A', name: 'acme.com', content: '203.0.113.7', proxied: true, ttl: 1 },
    ]);
    const second = (await acc.run('list_dns_records', { zone_id: zone, cursor: first.nextCursor })) as {
      nextCursor?: string;
    };
    expect(second.nextCursor).toBeUndefined();
  });

  it('adds records with only the given fields and keeps changes dangerous', async () => {
    await acc.run('create_dns_record', {
      zone_id: zone,
      type: 'CNAME',
      name: 'docs.acme.com',
      content: 'acme.github.io',
    });
    expect(body(service.calls.at(-1)!)).toEqual({
      type: 'CNAME',
      name: 'docs.acme.com',
      content: 'acme.github.io',
    });
    for (const name of ['update_dns_record', 'delete_dns_record', 'purge_everything']) {
      expect(cloudflare.actions.find((a) => a.name === name)!.risk).toBe('dangerous');
    }
    await acc.run('purge_cache', { zone_id: zone, urls: ['https://acme.com/pricing'] });
    expect(body(service.calls.at(-1)!)).toEqual({ files: ['https://acme.com/pricing'] });
  });
});

describe('bitbucket', () => {
  const next = 'https://api.bitbucket.org/2.0/repositories/acme/api/pullrequests?page=2';
  const service = fakeRoutes({
    'GET /2.0/repositories/acme/': { values: [{ slug: 'api' }], next: null },
    'GET /2.0/repositories/acme/api/pullrequests': (req) =>
      json({
        values: [
          {
            id: 42,
            title: 'Fix login',
            state: 'OPEN',
            author: { display_name: 'Ann', uuid: '{1}' },
            source: { branch: { name: 'fix-login' }, commit: { hash: 'a' } },
            destination: { branch: { name: 'main' } },
            links: { html: { href: 'https://bitbucket.org/acme/api/pull-requests/42' } },
          },
        ],
        ...(req.url.searchParams.get('page') ? {} : { next }),
      }),
    'POST /2.0/repositories/acme/api/pullrequests/42/comments': (req) => json({ id: 7, ...body(req) }),
  });
  const acc = testAccount(bitbucket, {
    config: { workspace: 'acme', email: 'ann@acme.com' },
    credentials: { apiToken: 'ATATT3xFfGF0abcdefghij' },
    fetch: service.fetch,
  });

  it('uses the Atlassian email and API token', async () => {
    expect(await bitbucket.test!(acc.ctx as never)).toMatchObject({ ok: true });
    expect(service.calls.at(-1)!.headers.get('authorization')).toBe(
      basic('ann@acme.com', 'ATATT3xFfGF0abcdefghij'),
    );
  });

  it('lists open pull requests and follows next within the API', async () => {
    const first = (await acc.run('list_pull_requests', { repo: 'api' })) as {
      items: unknown[];
      nextCursor?: string;
    };
    expect(service.calls.at(-1)!.url.searchParams.get('state')).toBe('OPEN');
    expect(first.items[0]).toEqual({
      id: 42,
      title: 'Fix login',
      state: 'OPEN',
      author: { display_name: 'Ann' },
      source: { branch: { name: 'fix-login' } },
      destination: { branch: { name: 'main' } },
      links: { html: { href: 'https://bitbucket.org/acme/api/pull-requests/42' } },
    });
    await acc.run('list_pull_requests', { repo: 'api', cursor: first.nextCursor });
    expect(service.calls.at(-1)!.url.href).toBe(next);
  });

  it('sends plain and inline comments in the right shape', async () => {
    await acc.run('add_comment', { repo: 'api', pr_id: 42, text: 'LGTM' });
    expect(body(service.calls.at(-1)!)).toEqual({ content: { raw: 'LGTM' } });
    await acc.run('add_inline_comment', { repo: 'api', pr_id: 42, file: 'src/a.ts', line: 10, text: 'Typo' });
    expect(body(service.calls.at(-1)!)).toEqual({
      content: { raw: 'Typo' },
      inline: { path: 'src/a.ts', to: 10 },
    });
    expect(bitbucket.actions.find((a) => a.name === 'merge')!.risk).toBe('dangerous');
  });
});

describe('brevo', () => {
  const service = fakeRoutes({
    'GET /v3/account': { email: 'ann@acme.com', companyName: 'ACME' },
    'POST /v3/contacts': () => new Response(null, { status: 204 }),
    'POST /v3/smtp/email': { messageId: '<m1@smtp-relay>' },
  });
  const acc = testAccount(brevo, { credentials: { apiKey: 'xkeysib-abc' }, fetch: service.fetch });

  it('sends the key in the api-key header', async () => {
    expect(await brevo.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    expect(service.calls.at(-1)!.headers.get('api-key')).toBe('xkeysib-abc');
  });

  it('upserts contacts', async () => {
    expect(
      await acc.run('save_contact', {
        email: 'ann@acme.com',
        attributes: { FIRSTNAME: 'Ann' },
        list_ids: [3],
      }),
    ).toBe('Contact updated.');
    expect(body(service.calls.at(-1)!)).toEqual({
      email: 'ann@acme.com',
      attributes: { FIRSTNAME: 'Ann' },
      listIds: [3],
      updateEnabled: true,
    });
  });

  it('sends email only as a dangerous action', async () => {
    expect(brevo.actions.find((a) => a.name === 'send_email')!.risk).toBe('dangerous');
    await acc.run('send_email', {
      from_email: 'news@acme.com',
      to: [{ email: 'ben@acme.com' }],
      subject: 'Hi',
      html: '<p>Hi</p>',
    });
    expect(body(service.calls.at(-1)!)).toEqual({
      sender: { email: 'news@acme.com' },
      to: [{ email: 'ben@acme.com' }],
      subject: 'Hi',
      htmlContent: '<p>Hi</p>',
    });
  });
});

describe('cal.com', () => {
  const service = fakeRoutes({
    'GET /v2/me': { status: 'success', data: { id: 1, email: 'ann@acme.com' } },
    'GET /v2/bookings': {
      status: 'success',
      data: [
        {
          id: 5,
          uid: 'bk1',
          title: 'Intro call',
          status: 'accepted',
          start: '2026-11-05T10:00:00.000Z',
          end: '2026-11-05T10:30:00.000Z',
          duration: 30,
          meetingUrl: 'https://app.cal.com/video/bk1',
          attendees: [{ name: 'Ben', email: 'ben@acme.com', timeZone: 'UTC' }],
          hosts: [{ id: 1 }],
        },
      ],
    },
  });
  const acc = testAccount(calcom, { credentials: { apiKey: 'cal_live_abc' }, fetch: service.fetch });

  it('pins the bookings API version', async () => {
    expect(await calcom.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ann@acme.com' });
    await acc.run('list_bookings', {});
    const call = service.calls.at(-1)!;
    expect(call.headers.get('cal-api-version')).toBe('2024-08-13');
    expect(call.url.searchParams.get('status')).toBe('upcoming');
  });

  it('joins the shared calendar list', async () => {
    const events = (await acc.runCapability('calendar.list_events', {
      from: '2026-11-05T00:00:00Z',
      to: '2026-11-06T00:00:00Z',
    })) as { items: unknown[] };
    expect(service.calls.at(-1)!.url.searchParams.get('afterStart')).toBe('2026-11-05T00:00:00Z');
    expect(events.items).toEqual([
      {
        id: 'bk1',
        title: 'Intro call',
        start: '2026-11-05T10:00:00.000Z',
        end: '2026-11-05T10:30:00.000Z',
        location: 'https://app.cal.com/video/bk1',
        attendees: ['ben@acme.com'],
        calendar: 'Cal.com',
      },
    ]);
  });
});

describe('webflow', () => {
  const collection = '1'.repeat(24);
  const service = fakeRoutes({
    'GET /v2/sites': { sites: [{ id: '2'.repeat(24), displayName: 'ACME', shortName: 'acme' }] },
    [`POST /v2/collections/${collection}/items`]: (req) => json({ id: '3'.repeat(24), ...body(req) }),
    [`POST /v2/collections/${collection}/items/publish`]: { publishedItemIds: ['3'.repeat(24)], errors: [] },
  });
  const acc = testAccount(webflow, { credentials: { token: 'w'.repeat(40) }, fetch: service.fetch });

  it('names the account after its site', async () => {
    expect(await webflow.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'ACME' });
  });

  it('creates drafts and publishes only with confirmation', async () => {
    await acc.run('create_item', {
      collection_id: collection,
      field_data: { name: 'November recap', slug: 'nov' },
    });
    expect(body(service.calls.at(-1)!)).toEqual({
      isDraft: true,
      isArchived: false,
      fieldData: { name: 'November recap', slug: 'nov' },
    });
    expect(webflow.actions.find((a) => a.name === 'publish_items')!.risk).toBe('dangerous');
  });
});
