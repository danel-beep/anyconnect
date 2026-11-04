import { describe, expect, it } from 'vitest';
import github from '../../src/connectors/builtin/github.js';
import stripe from '../../src/connectors/builtin/stripe.js';
import todoist from '../../src/connectors/builtin/todoist.js';
import { fakeRoutes, json, testAccount } from './harness.js';

// Fixtures follow the documented response shapes of each API (trimmed to the fields that matter).

describe('github', () => {
  const issue = {
    number: 12,
    title: 'Login fails on Safari',
    state: 'open',
    user: { login: 'ann', id: 1, avatar_url: 'https://avatars/1' },
    comments: 3,
    updated_at: '2026-11-03T10:00:00Z',
    html_url: 'https://github.com/acme/web/issues/12',
    repository_url: 'https://api.github.com/repos/acme/web',
    body: 'Steps to reproduce…',
    labels: [{ id: 1, name: 'bug', color: 'f00' }],
    reactions: { total_count: 0 },
  };
  const service = fakeRoutes({
    'GET /user': { login: 'danel', id: 7 },
    'GET /search/issues': (req) =>
      json(
        { total_count: 40, incomplete_results: false, items: [issue] },
        {
          headers: {
            link: `<https://api.github.com/search/issues?q=${encodeURIComponent(req.url.searchParams.get('q') ?? '')}&page=2>; rel="next", <https://api.github.com/search/issues?page=2>; rel="last"`,
          },
        },
      ),
    'GET /repos/acme/web/issues/12': issue,
    'POST /repos/acme/web/issues': (req) =>
      json(
        {
          ...issue,
          number: 13,
          title: JSON.parse(req.body!).title,
          html_url: 'https://github.com/acme/web/issues/13',
        },
        { status: 201 },
      ),
    'PATCH /repos/acme/web/issues/12': { ...issue, state: 'closed' },
    'GET /repos/acme/web/issues/999': { message: 'Not Found' },
  });
  const acc = testAccount(github, { credentials: { token: 'ghp_x' }, fetch: service.fetch });

  it('identifies the account and sends the token and API version', async () => {
    expect(await github.test!(acc.ctx as never)).toMatchObject({ ok: true, identity: 'danel' });
    const call = service.calls.at(-1)!;
    expect(call.headers.get('authorization')).toBe('Bearer ghp_x');
    expect(call.headers.get('x-github-api-version')).toBe('2022-11-28');
  });

  it('searches with compact items and follows Link pagination on the API origin only', async () => {
    const page = (await acc.run('search_issues', { q: 'is:open assignee:@me' })) as {
      items: unknown[];
      nextCursor?: string;
    };
    expect(page.items).toEqual([
      {
        number: 12,
        title: 'Login fails on Safari',
        state: 'open',
        user: { login: 'ann' },
        comments: 3,
        updated_at: '2026-11-03T10:00:00Z',
        html_url: 'https://github.com/acme/web/issues/12',
        repository_url: 'https://api.github.com/repos/acme/web',
      },
    ]);
    expect(page.nextCursor).toBeDefined();
    await acc.run('search_issues', { q: 'is:open', cursor: page.nextCursor });
    expect(service.calls.at(-1)!.url.searchParams.get('page')).toBe('2');
    const forged = Buffer.from(JSON.stringify({ v: 'https://evil.test/steal' })).toString('base64url');
    await expect(acc.run('search_issues', { q: 'x', cursor: forged })).rejects.toMatchObject({
      kind: 'invalid_input',
    });
  });

  it('creates and closes issues', async () => {
    expect(
      await acc.run('create_issue', { owner: 'acme', repo: 'web', title: 'New bug', labels: ['bug'] }),
    ).toEqual({
      number: 13,
      html_url: 'https://github.com/acme/web/issues/13',
    });
    expect(JSON.parse(service.calls.at(-1)!.body!)).toEqual({ title: 'New bug', labels: ['bug'] });
    expect(
      await acc.run('update_issue', { owner: 'acme', repo: 'web', number: 12, state: 'closed' }),
    ).toMatchObject({
      state: 'closed',
    });
  });

  it('maps 404 to not_found with the GitHub message', async () => {
    const missing = fakeRoutes({});
    const a = testAccount(github, { credentials: { token: 'x' }, fetch: missing.fetch });
    await expect(a.run('get_issue', { owner: 'acme', repo: 'web', number: 999 })).rejects.toMatchObject({
      kind: 'not_found',
    });
  });
});

describe('todoist', () => {
  const task = {
    id: '6X7rM8997g3RQmvh',
    content: 'Оплатить счёт',
    description: '',
    project_id: '6Jf8VQXxpwv56VQ7',
    due: { date: '2026-11-04', string: 'today', lang: 'ru', is_recurring: false },
    priority: 4,
    labels: ['finance'],
    checked: false,
    user_id: '1',
    child_order: 1,
    added_at: '2026-11-01T10:00:00Z',
  };
  const service = fakeRoutes({
    'GET /api/v1/user': { email: 'me@example.com', full_name: 'Me' },
    'GET /api/v1/tasks/filter': (req) =>
      json({ results: [task], next_cursor: req.url.searchParams.get('cursor') ? null : 'c2' }),
    'POST /api/v1/tasks': (req) => json({ ...task, ...JSON.parse(req.body!) }),
    'POST /api/v1/tasks/6X7rM8997g3RQmvh/close': () => new Response(null, { status: 204 }),
  });
  const acc = testAccount(todoist, { credentials: { token: 't' }, fetch: service.fetch });

  it('finds tasks by filter with cursor pages', async () => {
    const page = (await acc.run('find_tasks', { query: 'today | overdue', lang: 'ru' })) as {
      items: unknown[];
      nextCursor?: string;
    };
    expect(page.items).toEqual([
      {
        id: '6X7rM8997g3RQmvh',
        content: 'Оплатить счёт',
        description: '',
        project_id: '6Jf8VQXxpwv56VQ7',
        due: { string: 'today', date: '2026-11-04' },
        priority: 4,
        labels: ['finance'],
        checked: false,
      },
    ]);
    expect(service.calls.at(-1)!.url.searchParams.get('query')).toBe('today | overdue');
    const next = (await acc.run('find_tasks', { query: 'today', cursor: page.nextCursor })) as {
      nextCursor?: string;
    };
    expect(service.calls.at(-1)!.url.searchParams.get('cursor')).toBe('c2');
    expect(next.nextCursor).toBeUndefined();
  });

  it('adds and completes tasks', async () => {
    const added = (await acc.run('add_task', {
      content: 'Позвонить',
      due_string: 'завтра в 10',
      due_lang: 'ru',
    })) as Record<string, unknown>;
    expect(added.content).toBe('Позвонить');
    expect(JSON.parse(service.calls.at(-1)!.body!)).toEqual({
      content: 'Позвонить',
      due_string: 'завтра в 10',
      due_lang: 'ru',
    });
    expect(await acc.run('complete_task', { task_id: '6X7rM8997g3RQmvh' })).toBe('Completed.');
  });
});

describe('stripe', () => {
  const service = fakeRoutes({
    'GET /v1/balance': {
      object: 'balance',
      available: [{ amount: 12_500, currency: 'usd' }],
      pending: [],
      livemode: false,
    },
    'GET /v1/payment_intents/search': {
      object: 'search_result',
      data: [
        {
          id: 'pi_1',
          object: 'payment_intent',
          amount: 5000,
          amount_received: 5000,
          currency: 'usd',
          status: 'succeeded',
          created: 1767225600,
          customer: 'cus_1',
          description: 'Order 42',
          client_secret: 'pi_1_secret_x',
          payment_method_types: ['card'],
        },
      ],
      has_more: true,
      next_page: 'page_2',
      url: '/v1/payment_intents/search',
    },
    'POST /v1/refunds': (req) =>
      json({
        id: 're_1',
        amount: Number(new URLSearchParams(req.body).get('amount')),
        currency: 'usd',
        status: 'succeeded',
      }),
  });
  const acc = testAccount(stripe, { credentials: { apiKey: 'rk_test_123' }, fetch: service.fetch });

  it('rejects keys that are not Stripe secret or restricted keys', () => {
    expect(stripe.credentials.safeParse({ apiKey: 'pk_test_1' }).success).toBe(false);
    expect(stripe.credentials.safeParse({ apiKey: 'rk_live_1' }).success).toBe(true);
  });

  it('searches payments without leaking client secrets and pages with next_page', async () => {
    const page = (await acc.run('search_payments', { query: "status:'succeeded'" })) as {
      items: Record<string, unknown>[];
      nextCursor?: string;
    };
    expect(page.items[0]).toEqual({
      id: 'pi_1',
      amount: 5000,
      amount_received: 5000,
      currency: 'usd',
      status: 'succeeded',
      created: 1767225600,
      customer: 'cus_1',
      description: 'Order 42',
    });
    expect(service.calls.at(-1)!.headers.get('authorization')).toBe('Bearer rk_test_123');
    await acc.run('search_payments', { query: "status:'succeeded'", cursor: page.nextCursor });
    expect(service.calls.at(-1)!.url.searchParams.get('page')).toBe('page_2');
  });

  it('sends refunds form-encoded', async () => {
    const refund = await acc.run('create_refund', { payment_intent: 'pi_1', amount: 1000 });
    expect(refund).toEqual({ id: 're_1', amount: 1000, currency: 'usd', status: 'succeeded' });
    const call = service.calls.at(-1)!;
    expect(call.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(call.body).toBe('payment_intent=pi_1&amount=1000');
  });
});
