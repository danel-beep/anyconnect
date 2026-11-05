import { describe, expect, it } from 'vitest';
import { routePath } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { jobsCheck } from '../src/ops/builtin-checks.js';
import { HealthRegistry } from '../src/ops/checks.js';
import { requestIdFrom, runWithContext } from '../src/ops/context.js';
import { type ErrorEvent, ErrorReporter, fingerprint, toEvent } from '../src/ops/errors.js';
import { scrubError, scrubSecrets } from '../src/ops/scrub.js';
import { parseSentryDsn, SentrySink, sentryFrames } from '../src/ops/sentry.js';

const meta = { release: '1.0.0', environment: 'test' };
const logger = createLogger({ level: 'silent' });

describe('scrubSecrets', () => {
  it.each([
    ['Authorization: Bearer abcdefghijklmnop123', 'abcdefghijklmnop123'],
    ['GET https://api.example.com/x?access_token=ya29.secretvalue&x=1', 'ya29.secretvalue'],
    ['callback?code=4/0AbCdEf123&state=xyz', '4/0AbCdEf123'],
    ['postgres://anyconnect:hunter2pass@db.internal:5432/x', 'hunter2pass'],
    ['client_secret="s3cr3t-value"', 's3cr3t-value'],
    ['password: correct-horse', 'correct-horse'],
    ['token ac_at_0123456789abcdefghij expired', 'ac_at_0123456789abcdefghij'],
    ['stripe key sk_live_1234567890abcdef', 'sk_live_1234567890abcdef'],
    [
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'eyJ',
    ],
    ['mail to jane.doe@example.com failed', 'jane.doe@example.com'],
    ['key A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2'],
    [
      'POST https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage failed',
      'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
    ],
    ['maps key AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q rejected', 'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'],
    ['signing key 0123456789abcdef0123456789abcdef rejected', '0123456789abcdef0123456789abcdef'],
  ])('removes the secret from %s', (input, secret) => {
    expect(scrubSecrets(input)).not.toContain(secret);
  });

  it('keeps ordinary error text readable', () => {
    const text =
      'connect ECONNREFUSED 127.0.0.1:5432 at TokenManager.refresh (/app/dist/core/oauth-tokens.js:120:15)';
    expect(scrubSecrets(text)).toBe(text);
    expect(scrubSecrets('code: ECONNRESET')).toBe('code: ECONNRESET');
  });

  it('caps the length', () => {
    expect(scrubSecrets('x '.repeat(5000), 100).length).toBeLessThanOrEqual(101);
  });
});

describe('errors in log lines', () => {
  const leaky = () => {
    const error = Object.assign(
      new Error('refresh for bob@example.com failed: token ac_at_0123456789abcdefghij'),
      {
        code: 'E_REFRESH',
        status: 400,
        // What libraries attach: request configs, response bodies, Postgres row values.
        config: { headers: { authorization: 'Bearer abcdefghijklmnopq' } },
        detail: 'Key (email)=(bob@example.com) already exists.',
        cause: new Error('POST https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/x'),
      },
    );
    return error;
  };

  it('keeps the type, the scrubbed message and stack, codes and causes', () => {
    const out = scrubError(leaky()) as Record<string, unknown>;
    expect(out).toMatchObject({
      type: 'Error',
      message: 'refresh for [email] failed: token [redacted]',
      code: 'E_REFRESH',
      status: 400,
      cause: { type: 'Error' },
    });
    expect(out.stack).toMatch(/^Error: refresh for \[email\]/);
    expect(out).not.toHaveProperty('config');
    expect(out).not.toHaveProperty('detail');
    const text = JSON.stringify(out);
    for (const secret of ['bob@example.com', 'ac_at_0123456789abcdefghij', 'abcdefghijklmnopq', 'AAHdqTcv']) {
      expect(text).not.toContain(secret);
    }
    expect(scrubError('password=hunter2')).toBe('password=[redacted]');
    expect(scrubError({ access_token: 'ya29.abcdefghijkl' })).not.toContain('ya29.abcdefghijkl');
  });

  it('is how the hub logger writes every err', () => {
    const lines: string[] = [];
    const log = createLogger({
      level: 'info',
      destination: { write: (line: string) => void lines.push(line) },
    });
    log.warn({ err: leaky(), account: 'acc_1' }, 'refresh failed');
    log.error(leaky());
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain('bob@example.com');
      expect(line).not.toContain('AAHdqTcv');
      expect(line).not.toContain('abcdefghijklmnopq');
      expect(JSON.parse(line).err).toMatchObject({ code: 'E_REFRESH' });
    }
  });
});

describe('error events', () => {
  it('groups the same bug with different ids and numbers', () => {
    const stack = 'at Hub.invoke (/app/dist/hub/hub.js:10:5)\nat node:internal/process:1:1';
    const a = fingerprint('tool', 'TypeError', "Cannot read 'x' of acc_01jabcdefghjk42", stack);
    const b = fingerprint(
      'tool',
      'TypeError',
      "Cannot read 'y' of acc_01jzyxwvutsrq99",
      stack.replace(':10:5', ':12:9'),
    );
    const c = fingerprint('http', 'TypeError', "Cannot read 'x' of acc_01jabcdefghjk42", stack);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('keeps stack frames only, scrubbed, and picks up the request id', () => {
    const error = new Error('failed for bob@example.com');
    const event = runWithContext({ requestId: 'req-123456' }, () =>
      toEvent(error, { source: 'http', context: { path: '/x' } }, meta),
    );
    expect(event.message).toBe('failed for [email]');
    expect(event.stack?.split('\n').every((l) => l.startsWith('at '))).toBe(true);
    expect(event.stack).not.toContain('bob@example.com');
    expect(event.requestId).toBe('req-123456');
    expect(event.context).toEqual({ path: '/x' });
    expect(event.ref).toMatch(/^[0-9a-f]{10}$/);
  });

  it('accepts non-errors', () => {
    expect(toEvent('boom', { source: 'process' }, meta).message).toBe('boom');
    expect(toEvent(undefined, { source: 'process' }, meta).type).toBe('Error');
  });

  it('a broken sink does not break capturing or the other sinks', async () => {
    const seen: ErrorEvent[] = [];
    const reporter = new ErrorReporter({ logger, ...meta })
      .addSink({
        name: 'broken',
        capture() {
          throw new Error('sink down');
        },
      })
      .addSink({ name: 'async-broken', capture: async () => Promise.reject(new Error('later')) })
      .addSink({ name: 'ok', capture: (e) => void seen.push(e) });
    const ref = reporter.capture(new Error('x'), { source: 'job', context: { job: 'demo' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ref).toBe(ref);
    await reporter.flush();
  });

  it('turns request paths into routes', () => {
    expect(routePath('/admin/users/usr_01j9z3k6m4q8v2w7x5y1z3a4b6')).toBe('/admin/users/:id');
    expect(routePath('/connect/gmail/123')).toBe('/connect/gmail/:id');
    expect(routePath('/app/services')).toBe('/app/services');
  });
});

describe('request ids', () => {
  it('takes a sane incoming id and replaces anything else', () => {
    expect(requestIdFrom('abc-123_DEF.ghi')).toBe('abc-123_DEF.ghi');
    expect(requestIdFrom('bad id\nwith newline')).toMatch(/^[0-9a-f]{16}$/);
    expect(requestIdFrom(undefined)).toMatch(/^[0-9a-f]{16}$/);
    expect(requestIdFrom('x'.repeat(200))).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('Sentry', () => {
  it('parses DSNs', () => {
    expect(parseSentryDsn('https://pub123@o42.ingest.sentry.io/4507')).toMatchObject({
      envelopeUrl: 'https://o42.ingest.sentry.io/api/4507/envelope/',
      publicKey: 'pub123',
    });
    expect(parseSentryDsn('https://k@glitchtip.example.com/sub/7').envelopeUrl).toBe(
      'https://glitchtip.example.com/sub/api/7/envelope/',
    );
    expect(() => parseSentryDsn('https://o42.ingest.sentry.io/4507')).toThrow();
    expect(() => parseSentryDsn('not a url')).toThrow();
  });

  it('sends a scrubbed envelope and respects its rate limit', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const sink = new SentrySink('https://pub@sentry.example.com/1', {
      perMinute: 2,
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    const event = toEvent(
      new Error('token=abc123def failed'),
      { source: 'tool', context: { tool: 'gmail_search' } },
      meta,
    );
    await sink.capture(event);
    await sink.capture(event);
    await sink.capture(event); // over the limit: dropped
    await sink.flush();
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe('https://sentry.example.com/api/1/envelope/');
    expect(String((requests[0]!.init.headers as Record<string, string>)['x-sentry-auth'])).toContain(
      'sentry_key=pub',
    );
    const [header, item, payload] = String(requests[0]!.init.body)
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(header.event_id).toBe(payload.event_id);
    expect(item.type).toBe('event');
    expect(payload.exception.values[0].value).toBe('token=[redacted] failed');
    expect(payload.tags).toMatchObject({ source: 'tool', tool: 'gmail_search', ref: event.ref });
    expect(payload.fingerprint).toEqual([event.fingerprint]);
    expect(payload.release).toBe('1.0.0');
  });

  it('turns Node frames into Sentry frames, oldest first', () => {
    const frames = sentryFrames(
      'at inner (/app/dist/a.js:1:2)\nat outer (/app/node_modules/x/b.js:3:4)\nat node:internal/x:1:1',
    );
    expect(frames[0]).toMatchObject({ function: '?', filename: 'node:internal/x', in_app: false });
    expect(frames[2]).toMatchObject({
      function: 'inner',
      filename: '/app/dist/a.js',
      lineno: 1,
      in_app: true,
    });
    expect(frames[1]).toMatchObject({ in_app: false });
  });
});

describe('health checks', () => {
  it('runs checks in parallel with a timeout, and only critical ones take the instance down', async () => {
    const registry = new HealthRegistry()
      .register({ name: 'db', critical: true, run: async () => ({ status: 'ok' }) })
      .register({ name: 'slow', critical: false, run: () => new Promise(() => {}) })
      .register({
        name: 'broken',
        critical: false,
        run: async () => {
          throw new Error('password=hunter2 rejected');
        },
      });
    const report = await registry.run({ timeoutMs: 50 });
    expect(report.status).toBe('degraded');
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName.slow).toMatchObject({ status: 'down', detail: 'no answer in 50 ms' });
    expect(byName.broken!.detail).not.toContain('hunter2');

    const critical = await registry.run({ criticalOnly: true });
    expect(critical.checks.map((c) => c.name)).toEqual(['db']);
    expect(critical.status).toBe('ok');

    registry.register({ name: 'db2', critical: true, run: async () => ({ status: 'down' }) });
    expect((await registry.run({ criticalOnly: true })).status).toBe('down');
    expect(() =>
      registry.register({ name: 'db', critical: true, run: async () => ({ status: 'ok' }) }),
    ).toThrow();
  });

  it('caches reports for a short while', async () => {
    let runs = 0;
    const registry = new HealthRegistry().register({
      name: 'x',
      critical: true,
      run: async () => {
        runs++;
        return { status: 'ok' };
      },
    });
    await registry.run({ cacheMs: 10_000 });
    await registry.run({ cacheMs: 10_000 });
    await registry.run({ cacheMs: 10_000, criticalOnly: true });
    expect(runs).toBe(2);
  });

  it('reports late and failing jobs', async () => {
    const now = Date.parse('2026-11-05T12:00:00Z');
    const definitions = [
      { name: 'fast', description: '', expectEveryMs: 10 * 60_000, run: async () => {} },
      { name: 'daily', description: '', expectEveryMs: 50 * 3_600_000, run: async () => {} },
      { name: 'unwatched', description: '', run: async () => {} },
    ];
    const run = (name: string, okMinutesAgo: number, failures = 0) => ({
      name,
      lastStartedAt: null,
      lastSucceededAt: new Date(now - okMinutesAgo * 60_000),
      lastFailedAt: null,
      lastError: null,
      lastDurationMs: 5,
      consecutiveFailures: failures,
      runs: 1,
      failures,
    });
    const check = (runs: ReturnType<typeof run>[], startedAt = now - 86_400_000) =>
      jobsCheck({ definitions: () => definitions, runs: async () => runs, startedAt, now: () => now }).run(
        AbortSignal.timeout(1000),
      );
    expect(await check([run('fast', 5), run('daily', 600)])).toEqual({ status: 'ok' });
    expect(await check([run('fast', 30), run('daily', 600)])).toMatchObject({
      status: 'degraded',
      detail: 'late: fast',
    });
    expect((await check([run('fast', 5, 3), run('daily', 600)])).detail).toBe('failing: fast');
    // Right after a start nothing is late yet, even without any recorded run.
    expect(await check([], now - 60_000)).toEqual({ status: 'ok' });
  });
});
