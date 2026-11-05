import type { AccessLevel, MemberRole, ShareLevel } from '../db/schema.js';
import { slugify } from '../lib/slug.js';

/**
 * Who may use which account in a team, as a pure function (no I/O, unit-tested).
 *
 * Every account of a team belongs to one member or to the team itself:
 * - a member's own account is private: only its owner uses it, unless they share it with one
 *   member or with the whole team (read / write / full);
 * - a team account (no owner) is used by every member (fully, unless a whole-team share row says
 *   less) and managed by the team admins;
 * - the team's shared connection (one key for everyone, `api_tokens.shared`) is nobody in
 *   particular: it sees team accounts and what was shared with the whole team, nothing private.
 *
 * The result caps the access rules (`PolicySubject.member`): rules can only lower it. Admins do not
 * see other members' private accounts: running the team is not reading its members' mail.
 */

export type { MemberRole, ShareLevel };

export const SHARE_LEVELS = ['read', 'write', 'full'] as const satisfies readonly ShareLevel[];
const SHARE_ORDER: Record<ShareLevel, number> = { read: 1, write: 2, full: 3 };

export const isTeamAdmin = (role: MemberRole | undefined): boolean => role === 'owner' || role === 'admin';

export interface TeamAccountRef {
  id: string;
  /** Null: the team's own account. */
  ownerUserId: string | null;
}

export interface ShareRef {
  accountId: string;
  /** Null: shared with the whole team. */
  userId: string | null;
  access: ShareLevel;
}

/** The caller: a member, or the team's shared connection. */
export type TeamViewer = { kind: 'member'; userId: string; role: MemberRole } | { kind: 'shared' };

/** Whose an account is, from the caller's point of view (shown to the AI and in the panel). */
export type AccountOwner =
  | { kind: 'self' }
  | { kind: 'team' }
  | { kind: 'member'; userId: string; name: string; access: ShareLevel };

export interface MemberAccess {
  /** The most the caller may do on each account they can see; a missing account is invisible. */
  access: Record<string, AccessLevel>;
  owners: Record<string, AccountOwner>;
  /** Accounts the caller manages: rename, reconnect, share, remove, set rules on. */
  manages: Set<string>;
}

const higher = (a: ShareLevel | undefined, b: ShareLevel | undefined): ShareLevel | undefined =>
  !a ? b : !b ? a : SHARE_ORDER[a] >= SHARE_ORDER[b] ? a : b;

export function memberAccess(input: {
  accounts: readonly TeamAccountRef[];
  shares: readonly ShareRef[];
  viewer: TeamViewer;
  /** Display names of members, for "Ann's" labels. */
  names: ReadonlyMap<string, string>;
}): MemberAccess {
  const { viewer } = input;
  const forTeam = new Map<string, ShareLevel>();
  const forViewer = new Map<string, ShareLevel>();
  for (const share of input.shares) {
    if (share.userId === null) forTeam.set(share.accountId, share.access);
    else if (viewer.kind === 'member' && share.userId === viewer.userId)
      forViewer.set(share.accountId, share.access);
  }
  const result: MemberAccess = { access: {}, owners: {}, manages: new Set() };
  const admin = viewer.kind === 'member' && isTeamAdmin(viewer.role);
  for (const account of input.accounts) {
    if (account.ownerUserId === null) {
      result.access[account.id] = forTeam.get(account.id) ?? 'full';
      result.owners[account.id] = { kind: 'team' };
      if (admin) result.manages.add(account.id);
      continue;
    }
    if (viewer.kind === 'member' && account.ownerUserId === viewer.userId) {
      result.access[account.id] = 'full';
      result.owners[account.id] = { kind: 'self' };
      result.manages.add(account.id);
      continue;
    }
    const level = higher(forTeam.get(account.id), forViewer.get(account.id));
    if (!level) continue;
    result.access[account.id] = level;
    result.owners[account.id] = {
      kind: 'member',
      userId: account.ownerUserId,
      name: input.names.get(account.ownerUserId) ?? 'another member',
      access: level,
    };
  }
  return result;
}

/** A member's short name from their display name or email: lowercase, `a-z0-9`, unique in the team. */
export function memberHandle(source: { name?: string | null; email: string }, taken: ReadonlySet<string>) {
  const fromName = source.name?.trim().split(/\s+/)[0];
  const base = slug(fromName ?? '') || slug(source.email.split('@')[0] ?? '') || 'member';
  const root = base.slice(0, 20);
  if (!taken.has(root) && !RESERVED_HANDLES.has(root)) return root;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${root}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${root}${Date.now().toString(36)}`;
}

/** Handles that would read as account selectors (`account: "all"`, `"mine"`). */
const RESERVED_HANDLES = new Set(['all', 'mine', 'team', 'account']);

const slug = (text: string): string => slugify(text).replace(/_/g, '');
