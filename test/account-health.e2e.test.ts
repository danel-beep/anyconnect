import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { healthBatch } from '../src/core/health.js';
import { resetDatabase, startTestHub, type TestHub } from './helpers.js';

/** The hourly re-test of connected accounts (`accounts.health_check`). */
describe('account health check', () => {
  let hub: TestHub;

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub();
  });

  afterAll(async () => {
    await hub?.close();
  });

  const checkedAt = async () => {
    const { rows } = await hub.services.database.pool.query<{ name: string; checked_at: Date | null }>(
      'select name, checked_at from accounts order by name',
    );
    return Object.fromEntries(rows.map((row) => [row.name, row.checked_at]));
  };

  it('takes the accounts never checked first, then the ones checked longest ago', async () => {
    const { pool } = hub.services.database;
    await pool.query("update accounts set checked_at = now() - interval '3 days' where name = 'main'");
    await pool.query("update accounts set checked_at = null where name = 'second'");

    expect(await hub.services.health.checkStaleAccounts(24 * 3_600_000, 1)).toEqual({
      checked: 1,
      failing: 0,
    });
    const first = await checkedAt();
    expect(first.second).not.toBeNull();
    expect(Date.now() - first.main!.getTime()).toBeGreaterThan(2 * 86_400_000);

    // Without a limit a run takes its share of all accounts (at least 50): the rest is done now.
    expect(await hub.services.health.checkStaleAccounts()).toEqual({ checked: 1, failing: 0 });
    expect(Date.now() - (await checkedAt()).main!.getTime()).toBeLessThan(60_000);
    expect(await hub.services.health.checkStaleAccounts()).toEqual({ checked: 0, failing: 0 });
  });

  it('sizes a run so that hourly runs keep up with any number of accounts', () => {
    expect(healthBatch(0)).toBe(50);
    expect(healthBatch(300)).toBe(50);
    // 24 hourly runs cover every account twice.
    expect(healthBatch(6000) * 24).toBeGreaterThanOrEqual(2 * 6000);
    expect(healthBatch(1_000_000)).toBe(2000);
  });
});
