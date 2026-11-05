import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from './helpers.js';
import { databaseName, quoteIdent, siblingDatabaseUrl } from './setup/databases.js';

/** Guards the parallel test setup: a config change must not quietly put all workers on one database. */
describe('test isolation', () => {
  it('runs this worker on its own database', async () => {
    const worker = process.env.VITEST_POOL_ID;
    expect(worker).toBeDefined();
    expect(databaseName(TEST_DATABASE_URL).endsWith(`_w${worker}`)).toBe(true);
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{ name: string }>('select current_database() as name');
      expect(rows[0]?.name).toBe(databaseName(TEST_DATABASE_URL));
    } finally {
      await client.end();
    }
  });

  it('names and quotes sibling databases safely', () => {
    expect(siblingDatabaseUrl('postgres://u@db:5432/app_test', 'w2')).toBe(
      'postgres://u@db:5432/app_test_w2',
    );
    // Postgres would cut a longer name, and two workers could end up on the same database.
    expect(() => siblingDatabaseUrl(`postgres://db/${'x'.repeat(61)}`, 'w1')).toThrow(/longer than 63/);
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});
