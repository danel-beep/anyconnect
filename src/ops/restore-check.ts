import type pg from 'pg';
import { type MigrationState, migrationState } from './builtin-checks.js';

/**
 * Checks a database restored from a backup (`backup:verify`) without starting anything on it:
 * starting a hub on a copy of production would run its automations and messenger sessions a
 * second time. What it proves: the schema matches this build, every secret envelope names a key
 * this server has, and every account the server can open by itself does open.
 */

export interface RestoreReport {
  migrations: MigrationState;
  /** Rows of the tables that matter most, to compare with the live hub. */
  rows: Record<string, number>;
  /** SecretBox envelopes (`v1.<key id>.…` in `*_encrypted` columns) by whether their key is known. */
  envelopes: { checked: number; unknownKeys: { column: string; keyId: string; count: number }[] };
  accounts: { readable: number; sealed: number; unreadable: string[] };
  ok: boolean;
}

const COUNTED = [
  'users',
  'workspaces',
  'accounts',
  'oauth_tokens',
  'api_tokens',
  'web_sessions',
  'vault_wraps',
];

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

export async function checkRestoredDatabase(deps: {
  pool: pg.Pool;
  secrets: { knowsKey(id: string): boolean };
  accounts: { checkReadable(): Promise<RestoreReport['accounts']> };
}): Promise<RestoreReport> {
  const { pool } = deps;
  const migrations = await migrationState(pool);
  const rows: Record<string, number> = {};
  for (const table of COUNTED) {
    const result = await pool.query<{ n: number }>(`select count(*)::int as n from public.${ident(table)}`);
    rows[table] = result.rows[0]?.n ?? 0;
  }
  const columns = await pool.query<{ table: string; column: string }>(
    `select table_name as table, column_name as column from information_schema.columns
      where table_schema = 'public' and data_type = 'text' and column_name like '%\\_encrypted'
      order by 1, 2`,
  );
  const envelopes: RestoreReport['envelopes'] = { checked: 0, unknownKeys: [] };
  for (const { table, column } of columns.rows) {
    const result = await pool.query<{ key_id: string; n: number }>(
      `select split_part(${ident(column)}, '.', 2) as key_id, count(*)::int as n
         from public.${ident(table)} where ${ident(column)} like 'v1.%' group by 1`,
    );
    for (const { key_id: keyId, n } of result.rows) {
      envelopes.checked += n;
      if (!deps.secrets.knowsKey(keyId))
        envelopes.unknownKeys.push({ column: `${table}.${column}`, keyId, count: n });
    }
  }
  const accounts = await deps.accounts.checkReadable();
  return {
    migrations,
    rows,
    envelopes,
    accounts,
    ok:
      migrations.state === 'current' &&
      envelopes.unknownKeys.length === 0 &&
      accounts.unreadable.length === 0,
  };
}

export function formatRestoreReport(report: RestoreReport): string {
  const lines = [
    `Migrations: ${report.migrations.applied} applied, ${report.migrations.expected} in this build (${report.migrations.state}).`,
    `Rows: ${Object.entries(report.rows)
      .map(([table, n]) => `${table} ${n}`)
      .join(', ')}.`,
    `Encrypted values: ${report.envelopes.checked} checked, ${report.envelopes.unknownKeys.length ? 'some need a key this server does not have' : 'every key is known'}.`,
    ...report.envelopes.unknownKeys.map(
      (u) => `  ${u.column}: ${u.count} with key ${u.keyId} (add it to ENCRYPTION_KEYS_PREVIOUS)`,
    ),
    `Accounts: ${report.accounts.readable} open with ENCRYPTION_KEY, ${report.accounts.sealed} sealed to their owner's vault (open when the owner signs in), ${report.accounts.unreadable.length} unreadable${report.accounts.unreadable.length ? `: ${report.accounts.unreadable.join(', ')}` : ''}.`,
    report.ok ? 'The backup restores and its data opens with these keys.' : 'PROBLEMS FOUND: see above.',
  ];
  return lines.join('\n');
}
