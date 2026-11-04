import type { CapabilityDefinition } from '../connectors/capabilities.js';
import { type ExecResult, resultText } from './result.js';

/**
 * Merging the results of one call executed on several accounts (`account: "all"`, unified tools).
 * Pure functions, covered by tests.
 */

export interface UnitOutcome {
  /** How the account is named in the merged result: `work` or `gmail:work`. */
  account: string;
  service?: string;
  result: ExecResult;
}

export interface UnitError {
  account: string;
  error: string;
}

/** The list inside a result: the value itself or its `items`, as returned by `page()`. */
export function listOf(data: unknown): { items: unknown[]; nextCursor?: string } | undefined {
  if (Array.isArray(data)) return { items: data };
  if (typeof data === 'object' && data !== null && Array.isArray((data as { items?: unknown }).items)) {
    const page = data as { items: unknown[]; nextCursor?: unknown };
    return {
      items: page.items,
      ...(typeof page.nextCursor === 'string' ? { nextCursor: page.nextCursor } : {}),
    };
  }
  return undefined;
}

/** Adds the account (and service) to an item without overwriting the item's own fields. */
export function tag(item: unknown, account: string, service?: string): unknown {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return { ...(service ? { service } : {}), account, value: item };
  }
  const record = item as Record<string, unknown>;
  return {
    ...(service && !('service' in record) ? { service } : {}),
    ...('account' in record ? { _account: account } : { account }),
    ...record,
  };
}

/** Takes one item from each list in turn, so a size cut does not drop whole accounts. */
export function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const list of lists) if (i < list.length) out.push(list[i]!);
  return out;
}

function errorsOf(outcomes: UnitOutcome[]): UnitError[] {
  return outcomes
    .filter((o) => o.result.isError)
    .map((o) => ({ account: o.account, error: resultText(o.result).slice(0, 300) }));
}

/**
 * Merges a service tool run on several accounts. Lists become one list of tagged items
 * (round-robin), with per-account cursors; anything else becomes one entry per account.
 * Returns `undefined` data when every account failed.
 */
export function mergeAccounts(outcomes: UnitOutcome[]): { data?: unknown; errors: UnitError[] } {
  const errors = errorsOf(outcomes);
  const ok = outcomes.filter((o) => !o.result.isError);
  if (ok.length === 0) return { errors };
  const lists = ok.map((o) => ({
    outcome: o,
    list: o.result.data === undefined ? undefined : listOf(o.result.data),
  }));
  if (lists.every((l) => l.list)) {
    const items = interleave(
      lists.map(({ outcome, list }) => list!.items.map((i) => tag(i, outcome.account))),
    );
    const cursors = Object.fromEntries(
      lists.filter((l) => l.list!.nextCursor).map((l) => [l.outcome.account, l.list!.nextCursor!]),
    );
    return {
      data: {
        items,
        ...(Object.keys(cursors).length
          ? {
              nextCursors: cursors,
              hint: 'More results exist for these accounts: call again with that account and its cursor.',
            }
          : {}),
        ...(errors.length ? { errors } : {}),
      },
      errors,
    };
  }
  return {
    data: {
      results: ok.map((o) => ({ account: o.account, result: o.result.data ?? resultText(o.result) })),
      ...(errors.length ? { errors } : {}),
    },
    errors,
  };
}

function sortKey(item: unknown, field: string): string | undefined {
  const value = (item as Record<string, unknown>)[field];
  return typeof value === 'string' && value ? value : undefined;
}

/** Sorts by an ISO date-like field; items without it go last. Stable. */
export function sortItems(items: unknown[], field: string, order: 'asc' | 'desc'): unknown[] {
  return items
    .map((item, index) => ({ item, index, key: sortKey(item, field) }))
    .sort((a, b) => {
      if (a.key === b.key) return a.index - b.index;
      if (a.key === undefined) return 1;
      if (b.key === undefined) return -1;
      const cmp = Date.parse(a.key) - Date.parse(b.key) || a.key.localeCompare(b.key);
      return order === 'asc' ? cmp : -cmp;
    })
    .map((x) => x.item);
}

/**
 * Validates capability output against its schema (unknown fields are dropped, so unified results
 * stay compact and uniform). Returns `undefined` for output that does not match.
 */
export function canonicalItem(
  capability: CapabilityDefinition,
  value: unknown,
): Record<string, unknown> | undefined {
  const parsed = capability.output.safeParse(value);
  return parsed.success ? (parsed.data as Record<string, unknown>) : undefined;
}

/** Merges unified list results: canonical items from every account, sorted and limited. */
export function mergeCapabilityList(
  capability: CapabilityDefinition,
  outcomes: Array<UnitOutcome & { items?: unknown[] }>,
  limit: number | undefined,
): { data?: unknown; errors: UnitError[] } {
  const errors = errorsOf(outcomes);
  const ok = outcomes.filter((o) => !o.result.isError);
  if (ok.length === 0) return { errors };
  let invalid = 0;
  const lists = ok.map((o) =>
    (o.items ?? []).flatMap((raw) => {
      const item = canonicalItem(capability, raw);
      if (!item) {
        invalid++;
        return [];
      }
      return [tag(item, o.account, o.service)];
    }),
  );
  let items = interleave(lists);
  if (capability.sortBy) items = sortItems(items, capability.sortBy, capability.sortOrder ?? 'desc');
  const total = items.length;
  if (limit !== undefined && items.length > limit) items = items.slice(0, limit);
  return {
    data: {
      items,
      ...(total > items.length ? { more: total - items.length } : {}),
      ...(errors.length ? { errors } : {}),
      ...(invalid ? { skipped: `${invalid} items in an unexpected format were left out` } : {}),
    },
    errors,
  };
}
