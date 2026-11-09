import type { CapabilityDefinition } from '../connectors/capabilities.js';
import { type ExecResult, resultText } from './result.js';
import { fits, shapeData, tidy } from './shaping.js';

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

/** An account whose result did not fit the size budget at all: named, so the AI knows to ask again. */
export interface OmittedAccount {
  account: string;
  status: 'omitted';
  hint: string;
}

export function omittedAccount(account: string): OmittedAccount {
  return {
    account,
    status: 'omitted',
    hint: `Left out to stay within the size limit: call again with "account": "${account}" (and a smaller limit).`,
  };
}

/** Items a size cut left out of one account's list (`shapeData` notes it as `truncated.omitted`). */
function cutItems(data: unknown): number {
  const note = (data as { truncated?: { omitted?: unknown } } | null)?.truncated;
  return typeof note?.omitted === 'number' ? note.omitted : 0;
}

/**
 * Merges a service tool run on several accounts. Lists become one list of tagged items
 * (round-robin), with per-account cursors; anything else becomes one entry per account.
 * Accounts in `omitted` (left out for size, see `fitAccounts`) get an explicit entry.
 * Returns `undefined` data when every account failed.
 */
export function mergeAccounts(
  outcomes: UnitOutcome[],
  omitted: readonly string[] = [],
): { data?: unknown; errors: UnitError[] } {
  const errors = errorsOf(outcomes);
  const ok = outcomes.filter((o) => !o.result.isError);
  if (ok.length === 0) return { errors };
  const shown = ok.filter((o) => !omitted.includes(o.account));
  const left = ok.filter((o) => omitted.includes(o.account)).map((o) => omittedAccount(o.account));
  const lists = shown.map((o) => ({
    outcome: o,
    list: o.result.data === undefined ? undefined : listOf(o.result.data),
  }));
  if (shown.length > 0 && lists.every((l) => l.list)) {
    const items = interleave(
      lists.map(({ outcome, list }) => list!.items.map((i) => tag(i, outcome.account))),
    );
    const cursors = Object.fromEntries(
      lists.filter((l) => l.list!.nextCursor).map((l) => [l.outcome.account, l.list!.nextCursor!]),
    );
    const cut = Object.fromEntries(
      lists.map((l) => [l.outcome.account, cutItems(l.outcome.result.data)]).filter(([, n]) => n),
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
        ...(Object.keys(cut).length
          ? {
              truncated: {
                omittedPerAccount: cut,
                hint: 'Some items were left out to stay within the size limit: ask those accounts for fewer at a time.',
              },
            }
          : {}),
        ...(left.length ? { omitted: left } : {}),
        ...(errors.length ? { errors } : {}),
      },
      errors,
    };
  }
  return {
    data: {
      results: [
        ...shown.map((o) => ({ account: o.account, result: o.result.data ?? resultText(o.result) })),
        ...left,
      ],
      ...(errors.length ? { errors } : {}),
    },
    errors,
  };
}

/** Each account's share of the budget never goes below this; below it, accounts are omitted. */
const MIN_ACCOUNT_TOKENS = 150;

/**
 * Merges a fan-out (`account: "all"`) within `maxTokens` without silently losing accounts: every
 * account that answered is in the result. When the whole does not fit, each account's own result is
 * cut to an equal share of the budget (long texts first, then items of its list); only when even
 * that cannot fit are the last accounts replaced by an explicit `{ account, status: "omitted" }`
 * entry. Pure, covered by tests.
 */
export function fitAccounts(
  outcomes: UnitOutcome[],
  maxTokens: number,
): { data?: unknown; errors: UnitError[] } {
  const whole = mergeAccounts(outcomes);
  if (whole.data === undefined) return whole;
  const first = shapeData(whole.data, { maxTokens });
  if (!first.truncated) return { data: first.data, errors: whole.errors };

  const ok = outcomes.filter((o) => !o.result.isError && o.result.data !== undefined);
  const attempt = (shown: UnitOutcome[], share: number) => {
    const names = new Set(shown.map((o) => o.account));
    const trimmed = outcomes.map((o) =>
      names.has(o.account)
        ? { ...o, result: { ...o.result, data: shapeData(o.result.data, { maxTokens: share }).data } }
        : o,
    );
    const omitted = ok.filter((o) => !names.has(o.account)).map((o) => o.account);
    return tidy(mergeAccounts(trimmed, omitted).data);
  };

  // 1. Every account, each cut to an equal share (the share shrinks to leave room for the merge).
  for (const part of [0.9, 0.75, 0.6, 0.45]) {
    const share = Math.floor((maxTokens * part) / ok.length);
    if (share < MIN_ACCOUNT_TOKENS) break;
    const data = attempt(ok, share);
    if (fits(data, maxTokens)) return { data, errors: whole.errors };
  }
  // 2. Too many accounts for the budget: as many as fit, the rest named as omitted.
  const most = Math.min(ok.length - 1, Math.floor((maxTokens * 0.6) / MIN_ACCOUNT_TOKENS));
  for (let count = most; count >= 1; count--) {
    const data = attempt(ok.slice(0, count), Math.floor((maxTokens * 0.6) / count));
    if (fits(data, maxTokens)) return { data, errors: whole.errors };
  }
  return { data: attempt([], 0), errors: whole.errors };
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
