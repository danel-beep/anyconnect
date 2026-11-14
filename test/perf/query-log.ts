import type { Database } from '../../src/db/client.js';

export interface LoggedQuery {
  sql: string;
  params: readonly unknown[];
}

/**
 * Records the statements the app sends while `run` works, and for a short while after (pages
 * finish some writes after the response, e.g. "last seen"), until the database has been quiet for
 * `quietMs`.
 */
export async function recordQueries<T>(
  database: Database,
  run: () => Promise<T>,
  quietMs = 40,
): Promise<{ result: T; queries: LoggedQuery[] }> {
  const queries: LoggedQuery[] = [];
  let last = Date.now();
  const stop = database.onQuery((sql, params) => {
    queries.push({ sql, params });
    last = Date.now();
  });
  try {
    const result = await run();
    last = Date.now();
    while (Date.now() - last < quietMs) await new Promise((resolve) => setTimeout(resolve, quietMs / 4));
    return { result, queries };
  } finally {
    stop();
  }
}

/**
 * The statements that ran more than `times` times with the same text: the usual shape of an N+1
 * (one query per row of an earlier one). Text with the parameters left out, shortened for messages.
 */
export function repeated(queries: LoggedQuery[], times: number): string[] {
  const counts = new Map<string, number>();
  for (const q of queries) counts.set(q.sql, (counts.get(q.sql) ?? 0) + 1);
  return [...counts]
    .filter(([, n]) => n > times)
    .map(([sql, n]) => `${n}× ${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
}
