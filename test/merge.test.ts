import { describe, expect, it } from 'vitest';
import { getCapability } from '../src/connectors/capabilities.js';
import {
  interleave,
  listOf,
  mergeAccounts,
  mergeCapabilityList,
  sortItems,
  tag,
  type UnitOutcome,
} from '../src/hub/merge.js';
import { dataResult, errorResult } from '../src/hub/result.js';

const ok = (account: string, data: unknown): UnitOutcome => ({ account, result: dataResult(data) });
const failed = (account: string, message: string): UnitOutcome => ({ account, result: errorResult(message) });

describe('merging results of several accounts', () => {
  it('reads lists from arrays and pages', () => {
    expect(listOf([1])).toEqual({ items: [1] });
    expect(listOf({ items: [1], nextCursor: 'c' })).toEqual({ items: [1], nextCursor: 'c' });
    expect(listOf({ id: 1 })).toBeUndefined();
  });

  it('tags items without overwriting their own fields', () => {
    expect(tag({ id: 1 }, 'work', 'gmail')).toEqual({ service: 'gmail', account: 'work', id: 1 });
    expect(tag({ id: 1, account: 'acct_9' }, 'work')).toEqual({ _account: 'work', id: 1, account: 'acct_9' });
    expect(tag('text', 'work')).toEqual({ account: 'work', value: 'text' });
  });

  it('interleaves so a size cut keeps every account', () => {
    expect(interleave<unknown>([[1, 2, 3], ['a'], [true, false]])).toEqual([1, 'a', true, 2, false, 3]);
  });

  it('merges lists with per-account cursors and errors', () => {
    const merged = mergeAccounts([
      ok('work', { items: [{ id: 'w1' }], nextCursor: 'next' }),
      ok('home', [{ id: 'h1' }]),
      failed('old', 'Token expired'),
    ]);
    expect(merged.data).toEqual({
      items: [
        { account: 'work', id: 'w1' },
        { account: 'home', id: 'h1' },
      ],
      nextCursors: { work: 'next' },
      hint: expect.any(String),
      errors: [{ account: 'old', error: 'Token expired' }],
    });
  });

  it('keeps non-list results per account and fails only when all failed', () => {
    expect(mergeAccounts([ok('work', { total: 3 }), ok('home', [])]).data).toEqual({
      results: [
        { account: 'work', result: { total: 3 } },
        { account: 'home', result: [] },
      ],
    });
    const none = mergeAccounts([failed('a', 'x'), failed('b', 'y')]);
    expect(none.data).toBeUndefined();
    expect(none.errors).toHaveLength(2);
  });

  it('sorts by date with undated items last, stably', () => {
    const items = [{ id: 1 }, { id: 2, date: '2026-01-01' }, { id: 3, date: '2026-03-01' }, { id: 4 }];
    expect((sortItems(items, 'date', 'desc') as typeof items).map((i) => i.id)).toEqual([3, 2, 1, 4]);
    expect((sortItems(items, 'date', 'asc') as typeof items).map((i) => i.id)).toEqual([2, 3, 1, 4]);
  });

  it('merges unified lists: canonical fields only, sorted, limited, invalid items counted', () => {
    const capability = getCapability('messages.search')!;
    const merged = mergeCapabilityList(
      capability,
      [
        {
          account: 'telegram:main',
          service: 'telegram',
          result: dataResult(null),
          items: [{ id: 't1', date: '2026-11-01T10:00:00Z', text: 'old', secret: 'x' }, { text: 'no id' }],
        },
        {
          account: 'slack:work',
          service: 'slack',
          result: dataResult(null),
          items: [
            { id: 's1', date: '2026-11-03T10:00:00Z' },
            { id: 's2', date: '2026-11-02T10:00:00Z' },
          ],
        },
        { account: 'whatsapp:home', service: 'whatsapp', result: errorResult('offline') },
      ],
      2,
    );
    expect(merged.data).toEqual({
      items: [
        { service: 'slack', account: 'slack:work', id: 's1', date: '2026-11-03T10:00:00Z' },
        { service: 'slack', account: 'slack:work', id: 's2', date: '2026-11-02T10:00:00Z' },
      ],
      more: 1,
      errors: [{ account: 'whatsapp:home', error: 'offline' }],
      skipped: expect.stringContaining('1 items'),
    });
  });
});
