import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BRAND } from '../src/brand.js';
import { PgListener } from '../src/db/listener.js';
import { createLogger } from '../src/logger.js';
import { TEST_DATABASE_URL } from './helpers.js';

const logger = createLogger({ level: 'silent' });

describe('PgListener (Postgres LISTEN/NOTIFY)', () => {
  let admin: pg.Client;
  let listener: PgListener | undefined;
  const notify = (channel: string, payload: string) =>
    admin.query('select pg_notify($1, $2)', [channel, payload]);
  const start = () => {
    listener = new PgListener({
      connectionString: TEST_DATABASE_URL,
      logger,
      retry: { minMs: 20, maxMs: 200 },
    });
    return listener;
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
  });
  afterEach(async () => {
    await listener?.stop();
    listener = undefined;
  });
  afterAll(async () => {
    await admin.end();
  });

  it('delivers the notifications of each channel and asks subscribers to resync once connected', async () => {
    const l = start();
    const a: string[] = [];
    const b: string[] = [];
    const resyncA = vi.fn();
    const stopA = l.listen('test_a', (p) => a.push(p), resyncA);
    l.start();
    await vi.waitFor(() => expect(l.connected).toBe(true), { timeout: 5_000 });
    expect(resyncA).toHaveBeenCalledTimes(1);
    // A channel added while connected is listened to at once.
    l.listen('test_b', (p) => b.push(p));
    await vi.waitFor(
      async () => {
        await notify('test_b', 'probe');
        expect(b).toContain('probe');
      },
      { timeout: 5_000 },
    );

    await notify('test_a', 'one');
    await notify('test_b', 'two');
    await vi.waitFor(() => expect(b).toContain('two'), { timeout: 5_000 });
    // Notifications of one session arrive in order: 'one' came before 'two'.
    expect(a).toEqual(['one']);

    stopA();
    await notify('test_a', 'ignored');
    await notify('test_b', 'three');
    await vi.waitFor(() => expect(b).toContain('three'), { timeout: 5_000 });
    expect(a).toEqual(['one']);
  });

  it('reconnects after losing the connection, and subscribers resync on the loss and on the return', async () => {
    const l = start();
    const got: string[] = [];
    const resync = vi.fn();
    l.listen('test_c', (p) => got.push(p), resync);
    l.start();
    await vi.waitFor(() => expect(l.connected).toBe(true), { timeout: 5_000 });
    expect(resync).toHaveBeenCalledTimes(1);

    await admin.query(
      'select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1 and datname = current_database()',
      [`${BRAND.slug}-listener`],
    );
    // Lost: subscribers re-read (notifications may be missed), then again once it is back.
    await vi.waitFor(() => expect(resync).toHaveBeenCalledTimes(3), { timeout: 5_000 });
    expect(l.connected).toBe(true);
    await vi.waitFor(
      async () => {
        await notify('test_c', 'after');
        expect(got).toContain('after');
      },
      { timeout: 5_000 },
    );
  });

  it('reconnects when the session no longer hears its channels (e.g. behind a transaction pooler)', async () => {
    listener = new PgListener({
      connectionString: TEST_DATABASE_URL,
      logger,
      retry: { minMs: 20, maxMs: 200 },
      pingMs: 50,
    });
    const l = listener;
    const got: string[] = [];
    const resync = vi.fn();
    l.listen('test_e', (p) => got.push(p), resync);
    l.start();
    await vi.waitFor(() => expect(l.connected).toBe(true), { timeout: 5_000 });
    // What a pooler does by handing the next query to another server session: LISTEN is gone.
    await (l as unknown as { client: pg.Client }).client.query('UNLISTEN *');
    await vi.waitFor(() => expect(resync).toHaveBeenCalledTimes(3), { timeout: 5_000 });
    await vi.waitFor(
      async () => {
        await notify('test_e', 'heard');
        expect(got).toContain('heard');
      },
      { timeout: 5_000 },
    );
  });

  it('never throws without a server and keeps retrying until stopped', async () => {
    listener = new PgListener({
      connectionString: 'postgres://postgres@127.0.0.1:1/none',
      logger,
      retry: { minMs: 10, maxMs: 20 },
    });
    const resync = vi.fn();
    listener.listen('test_d', () => {}, resync);
    listener.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(listener.connected).toBe(false);
    expect(resync).not.toHaveBeenCalled();
    await listener.stop();
  });
});
