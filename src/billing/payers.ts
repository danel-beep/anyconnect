import { and, asc, count, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  accounts,
  type MemberRole,
  type TeamBillingMode,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema.js';

/**
 * Who pays (`docs/TEAMS.md`, «Оплата»). A plan always belongs to a person and lives on their own
 * workspace; a team has none. A team runs on the plan of its payer (its owner, unless another
 * member took over), whose limits then cover the payer's own use and every team they pay for
 * together. In `each` mode every member's use of the team counts against their own plan instead,
 * and the payer's plan covers only what is the team's: its accounts and its shared key.
 */
export interface TeamBilling {
  teamId: string;
  name: string;
  slug: string;
  mode: TeamBillingMode;
  /** Who pays for the team as a whole: the member who took over, or the owner. */
  payerUserId: string;
  payerName: string;
  ownerUserId: string;
  /** Members and their roles (in `each` mode, whose own plans pay for their use). */
  members: ReadonlyMap<string, MemberRole>;
}

/**
 * Whose plan pays for `userId`'s use of a team (`null`: the team as a whole, e.g. its shared key or
 * a team account). The one rule everything else follows: calls, accounts and the pages.
 */
export function payingUser(
  team: Pick<TeamBilling, 'mode' | 'payerUserId' | 'members'>,
  userId: string | null,
): string {
  if (team.mode === 'each' && userId !== null && team.members.has(userId)) return userId;
  return team.payerUserId;
}

/** How long a team's billing is reused: every call asks, and changes show within seconds. */
const TEAM_TTL_MS = 5_000;
/** A person's own workspace never changes; kept longer. */
const HOME_TTL_MS = 60_000;
const MAX_CACHED = 10_000;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

const displayName = (u: { name: string | null; email: string }) => u.name?.trim() || u.email;

/**
 * Resolves payers and stores how teams pay. No permission rules here: who may change what is
 * `EntitlementService.changeTeamBilling`.
 */
export class Payers {
  private readonly teams = new Map<string, Cached<TeamBilling | undefined>>();
  private readonly homes = new Map<string, Cached<string | undefined>>();

  constructor(private readonly db: Db) {}

  /**
   * The workspace whose plan pays for `userId`'s use of `workspaceId` (`null`: the workspace as a
   * whole): the workspace itself when it is a person's own, else the paying person's own workspace.
   */
  async payerOf(workspaceId: string, userId: string | null): Promise<string> {
    const team = await this.team(workspaceId);
    if (!team) return workspaceId;
    // A person always has a workspace of their own; should one be missing, the team pays as itself
    // (no plan, so the free limits, and no trial: see `EntitlementService.entitlements`).
    return (await this.home(payingUser(team, userId))) ?? workspaceId;
  }

  /** How a team pays; undefined for a person's own workspace. Cached for a few seconds. */
  team(workspaceId: string, opts: { fresh?: boolean } = {}): Promise<TeamBilling | undefined> {
    return this.cached(this.teams, workspaceId, TEAM_TTL_MS, opts.fresh, () => this.loadTeam(workspaceId));
  }

  /** A person's own workspace, where their plan lives. */
  home(userId: string): Promise<string | undefined> {
    return this.cached(this.homes, userId, HOME_TTL_MS, false, async () => {
      const [row] = await this.db
        .select({ id: workspaces.id })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.role, 'owner'),
            eq(workspaces.kind, 'personal'),
          ),
        )
        .orderBy(asc(workspaceMembers.createdAt))
        .limit(1);
      return row?.id;
    });
  }

  /** The teams a person is in, with how each pays. */
  async teamsOf(userId: string): Promise<TeamBilling[]> {
    const rows = await this.db
      .select({ id: workspaces.id })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaces.kind, 'team')))
      .orderBy(asc(workspaceMembers.createdAt));
    const teams = await Promise.all(rows.map((r) => this.team(r.id)));
    return teams.filter((t): t is TeamBilling => t !== undefined);
  }

  /** Teams whose payer is this person (all of a team's use, or in `each` mode only the team's own). */
  async paidBy(userId: string): Promise<TeamBilling[]> {
    return (await this.teamsOf(userId)).filter((t) => t.payerUserId === userId);
  }

  /**
   * The connected accounts that count against the plan of `payerId` (a person's own workspace):
   * its own, every account of the teams they pay for, and in `each` mode their own accounts in a
   * team plus, if they pay for it, the team's accounts.
   */
  async accountsOf(payerId: string): Promise<number> {
    const [owner] = await this.db
      .select({ userId: workspaceMembers.userId, kind: workspaces.kind })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.workspaceId, payerId), eq(workspaceMembers.role, 'owner')))
      .limit(1);
    const whole: string[] = [];
    const teamOwned: string[] = [];
    const theirOwn: string[] = [];
    if (owner?.kind === 'personal') {
      for (const team of await this.teamsOf(owner.userId)) {
        // Mirrors `payingUser`: an account is paid for by payingUser(team, its owner).
        if (team.mode !== 'each') {
          if (team.payerUserId === owner.userId) whole.push(team.teamId);
          continue;
        }
        theirOwn.push(team.teamId);
        if (team.payerUserId === owner.userId) teamOwned.push(team.teamId);
      }
    }
    const [row] = await this.db
      .select({ n: count() })
      .from(accounts)
      .where(
        or(
          eq(accounts.workspaceId, payerId),
          whole.length ? inArray(accounts.workspaceId, whole) : undefined,
          teamOwned.length
            ? and(inArray(accounts.workspaceId, teamOwned), isNull(accounts.ownerUserId))
            : undefined,
          theirOwn.length && owner
            ? and(inArray(accounts.workspaceId, theirOwn), eq(accounts.ownerUserId, owner.userId))
            : undefined,
        ),
      );
    return row?.n ?? 0;
  }

  /**
   * Stores how a team pays (`payerUserId` null: its owner). Rules about who may are the caller's;
   * the cached billing of the team is dropped at once (other processes see it within seconds).
   */
  async set(teamId: string, change: { mode?: TeamBillingMode; payerUserId?: string | null }): Promise<void> {
    const values = {
      ...(change.mode !== undefined ? { billingMode: change.mode } : {}),
      ...(change.payerUserId !== undefined ? { billingUserId: change.payerUserId } : {}),
    };
    if (Object.keys(values).length === 0) return;
    await this.db
      .update(workspaces)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(workspaces.id, teamId), eq(workspaces.kind, 'team')));
    this.forget(teamId);
  }

  /** Drops a team's cached billing (after members join or leave, or it changes how it pays). */
  forget(teamId: string): void {
    this.teams.delete(teamId);
  }

  private async loadTeam(workspaceId: string): Promise<TeamBilling | undefined> {
    const [team] = await this.db
      .select({
        kind: workspaces.kind,
        name: workspaces.name,
        slug: workspaces.slug,
        mode: workspaces.billingMode,
        billingUserId: workspaces.billingUserId,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (team?.kind !== 'team' || !team.slug) return undefined;
    const rows = await this.db
      .select({
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        name: users.name,
        email: users.email,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, workspaceId));
    const owner = rows.find((r) => r.role === 'owner');
    if (!owner) return undefined;
    // Only a member pays: someone who left (or a stale id) never does, the owner does instead.
    const payer = rows.find((r) => r.userId === team.billingUserId) ?? owner;
    return {
      teamId: workspaceId,
      name: team.name,
      slug: team.slug,
      mode: team.mode === 'each' ? 'each' : 'payer',
      payerUserId: payer.userId,
      payerName: displayName(payer),
      ownerUserId: owner.userId,
      members: new Map(rows.map((r) => [r.userId, r.role])),
    };
  }

  private cached<T>(
    cache: Map<string, Cached<T>>,
    key: string,
    ttlMs: number,
    fresh: boolean | undefined,
    load: () => Promise<T>,
  ): Promise<T> {
    const now = Date.now();
    const hit = cache.get(key);
    if (!fresh && hit && now - hit.at < ttlMs) return hit.value;
    const value = load();
    cache.set(key, { at: now, value });
    value.catch(() => cache.delete(key));
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
    return value;
  }
}
