import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { isDatabaseUnavailable } from '../src/db/errors.js';

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

describe('isDatabaseUnavailable', () => {
  it('recognises what node-postgres and Postgres say when the database cannot be reached', () => {
    for (const error of [
      new Error('Connection terminated unexpectedly'),
      new Error('Connection terminated due to connection timeout'),
      new Error('timeout exceeded when trying to connect'),
      new Error('Query read timeout'),
      withCode('connect ECONNREFUSED 10.0.0.5:5432', 'ECONNREFUSED'),
      withCode('terminating connection due to administrator command', '57P01'),
      withCode('the database system is starting up', '57P03'),
      withCode('sorry, too many clients already', '53300'),
      withCode('connection failure', '08006'),
      new AggregateError([withCode('connect ECONNREFUSED ::1:5432', 'ECONNREFUSED')]),
    ]) {
      expect(isDatabaseUnavailable(error), error.message).toBe(true);
      // Drizzle wraps every driver error of a query.
      expect(isDatabaseUnavailable(new DrizzleQueryError('select 1', [], error)), error.message).toBe(true);
    }
  });

  it('does not take bugs, bad data or a service that is down for a database outage', () => {
    const fetchFailed = new TypeError('fetch failed', {
      cause: withCode('connect ECONNREFUSED 203.0.113.9:443', 'ECONNREFUSED'),
    });
    for (const error of [
      new TypeError("Cannot read properties of undefined (reading 'id')"),
      withCode('duplicate key value violates unique constraint "users_email"', '23505'),
      withCode('canceling statement due to statement timeout', '57014'),
      // A connector's own request: the service is unreachable, not the hub's database.
      fetchFailed,
      new Error('Upstream failed', { cause: fetchFailed }),
      undefined,
      'Connection terminated unexpectedly',
    ]) {
      expect(isDatabaseUnavailable(error), String((error as Error)?.message ?? error)).toBe(false);
    }
    expect(
      isDatabaseUnavailable(new DrizzleQueryError('insert …', [], withCode('duplicate key', '23505'))),
    ).toBe(false);
  });
});
