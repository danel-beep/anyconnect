import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers.js';
import { repeated } from './query-log.js';
import { startWorkload, type Workload } from './workload.js';

/**
 * N+1 guard: the number of statements a page or an MCP request sends must not grow with the number
 * of accounts (or calls) in the workspace. Each page and request is measured once with the two demo
 * accounts and again with ten more: one that sends a statement per account sends at least ten more.
 */
const EXTRA_ACCOUNTS = 10;

describe('statements per request do not grow with the workspace', () => {
  let work: Workload;

  beforeAll(async () => {
    await resetDatabase();
    work = await startWorkload();
  }, 60_000);

  afterAll(async () => {
    await work?.close();
  });

  it('on every signed-in page and MCP request', async () => {
    const before = new Map([...(await work.pages()), ...(await work.apiRequests())]);
    expect(before.size).toBeGreaterThan(10);

    for (let i = 1; i <= EXTRA_ACCOUNTS; i++) {
      const created = await fetch(`${work.hub.baseUrl}/api/v1/accounts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${work.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          connectorId: 'demo',
          name: `extra${i}`,
          label: `Extra ${i}`,
          credentials: { secret: `secret-${i}` },
        }),
      });
      expect(created.status).toBe(201);
    }
    // Activity on the new accounts too.
    for (let i = 0; i < 3; i++)
      await work.mcp.callTool({ name: 'demo_echo', arguments: { text: `again ${i}` } });

    const after = new Map([...(await work.pages()), ...(await work.apiRequests())]);
    // A stray extra statement is not an N+1 (a lookup that only runs once some data exists).
    const grown: string[] = [];
    for (const [key, queries] of before) {
      const later = after.get(key);
      if (!later || later.length - queries.length < EXTRA_ACCOUNTS / 2) continue;
      grown.push(
        `${key}: ${queries.length} → ${later.length} statements\n    ${repeated(later, EXTRA_ACCOUNTS - 1).join('\n    ')}`,
      );
    }
    expect(grown, `requests that send more statements with more accounts:\n${grown.join('\n')}`).toEqual([]);
  }, 120_000);
});
