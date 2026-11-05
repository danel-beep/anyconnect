import pg from 'pg';

/**
 * Names and creation of test databases, shared by the Vitest setup file, `test/helpers.ts` and
 * tests that need a database of their own (backups, a second hub). One place decides how a test
 * database is named next to `TEST_DATABASE_URL` and how its name is quoted.
 */

export const DEFAULT_TEST_DATABASE_URL = 'postgres://postgres@localhost:5432/manyplug_test';

/** Postgres truncates longer identifiers, which would silently make two names the same. */
const MAX_IDENTIFIER_BYTES = 63;

export function databaseName(url: string | URL): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

/** `manyplug_test` + `w1` → the URL of `manyplug_test_w1` on the same server. */
export function siblingDatabaseUrl(url: string | URL, suffix: string): string {
  const target = new URL(url);
  const name = `${databaseName(url)}_${suffix}`;
  if (Buffer.byteLength(name) > MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `Test database name "${name}" is longer than ${MAX_IDENTIFIER_BYTES} bytes: use a shorter TEST_DATABASE_URL`,
    );
  }
  target.pathname = `/${encodeURIComponent(name)}`;
  return target.toString();
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const NO_SERVER = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOENT', // a Unix socket path that does not exist
]);

/** No Postgres to talk to (as opposed to a server that refused): thrown only while connecting. */
export class NoServerError extends Error {
  constructor(cause: unknown) {
    super(`No Postgres server: ${(cause as Error).message}`, { cause });
  }
}

function isNoServer(error: unknown): boolean {
  const { code, message } = error as { code?: string; message?: string };
  // pg reports its own connection timeout without a code.
  return (
    (code !== undefined && NO_SERVER.has(code)) || /connection timeout|timeout expired/i.test(message ?? '')
  );
}

/**
 * Creates the database of `url` if it does not exist. Connects through a database that does
 * exist: `postgres`, then the base database the caller names, then `template1` (locked-down
 * servers do not always allow `postgres`). Throws the server's own error otherwise.
 */
export async function createDatabaseIfMissing(url: string | URL, via: (string | URL)[] = []): Promise<void> {
  const name = databaseName(url);
  const candidates = ['postgres', ...via.map(databaseName), 'template1'];
  let lastError: unknown;
  for (const candidate of candidates) {
    const admin = new URL(url);
    admin.pathname = `/${encodeURIComponent(candidate)}`;
    const client = new pg.Client({ connectionString: admin.toString(), connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
    } catch (error) {
      if (isNoServer(error)) throw new NoServerError(error);
      lastError = error; // e.g. no access to this database: try the next one
      continue;
    }
    try {
      const exists = await client.query('select 1 from pg_database where datname = $1', [name]);
      if (exists.rowCount === 0) await client.query(`CREATE DATABASE ${quoteIdent(name)}`);
      return;
    } catch (error) {
      // Another process created it first (42P04): fine.
      if ((error as { code?: string }).code === '42P04') return;
      throw error;
    } finally {
      await client.end();
    }
  }
  throw lastError;
}
