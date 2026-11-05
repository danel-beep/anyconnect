import { randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  accountShares,
  apiTokens,
  type MemberRole,
  oauthGrants,
  pendingCalls,
  type ShareLevel,
  users,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
} from '../db/schema.js';
import { hashToken } from '../lib/crypto.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { slugify } from '../lib/slug.js';
import {
  isTeamAdmin,
  type MemberAccess,
  memberAccess,
  memberHandle,
  SHARE_LEVELS,
  type TeamViewer,
} from '../security/members.js';
import type { AccountOwnerInput, AccountRow, AccountService } from './accounts.js';
import type { ConnectPermissions } from './connect.js';
import { getDefaultWorkspace, getWorkspace, normalizeEmail, type Workspace } from './identity.js';
import type { Principal } from './principal.js';

/**
 * Teams: one workspace, several people, one MCP URL (`/mcp/team/<slug>`). Each member signs in to
 * the hub with their own account from their own AI app (ChatGPT Business, Claude Team, Claude
 * Code…), so the hub always knows who is calling; each connected account belongs to one member
 * (or to the team) and is shared explicitly. Nobody shares a login: that keeps every member's
 * consent explicit and stays within the AI providers' terms (see `docs/TEAMS.md`).
 *
 * Who may use what is the pure `security/members.ts`; this service stores teams, members,
 * invitations and shares, and keeps them consistent when people join and leave.
 */

/** The address part of a team's MCP URL: 3–40 lowercase letters, digits and inner dashes. */
export const TEAM_SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
/** Teams one person may own: enough for real use, too few to farm free trials. */
export const MAX_OWNED_TEAMS = 3;
const INVITATION_DAYS = 14;
/** Slugs that would read as pages rather than teams. */
const RESERVED_SLUGS = new Set(['new', 'join', 'invite', 'admin', 'api', 'app', 'mcp', 'team', 'teams']);

export const TeamName = z.string().trim().min(1).max(60);
export const InviteInput = z.object({
  email: z.email().max(254),
  role: z.enum(['admin', 'member']).default('member'),
});

export type InvitationRow = typeof workspaceInvitations.$inferSelect;
export type ShareRow = typeof accountShares.$inferSelect;

export interface TeamMember {
  userId: string;
  name: string;
  email: string;
  handle: string;
  role: MemberRole;
  joinedAt: Date;
}

/** One caller's view of a team: who they are in it and what they may use. */
export interface TeamView {
  team: { id: string; name: string; slug: string };
  /** Absent for the team's shared connection. */
  member?: { userId: string; name: string; handle: string; role: MemberRole };
  access: MemberAccess;
}

/** Seats of a team's plan (the billing layer). */
export interface TeamLimits {
  /** Throws `PlanLimitError` when `taken` (members and open invitations) already fill every seat. */
  assertCanAddMember(workspaceId: string, taken: number): Promise<void>;
}

/** What a member who leaves takes along, for the page and the AI to say. */
export interface LeaveOutcome {
  moved: string[];
  removed: string[];
}

const displayName = (u: { name: string | null; email: string }) => u.name?.trim() || u.email;

/**
 * Refusals people meet on the team page and in the chat, with their own codes so the website can
 * show them in the user's language (`ERROR_TEXTS` in `routes/page-helpers.tsx`).
 */
export const teamError = {
  adminOnly: () => new AppError(403, 'team_admin_only', 'Only the team’s owner and admins can do this.'),
  ownerOnly: (what: string) => new AppError(403, 'team_owner_only', `Only the team’s owner can ${what}.`),
  notAccountOwner: () =>
    new AppError(
      403,
      'not_account_owner',
      'Only the account’s owner (or an admin, for a team account) can do this.',
    ),
  ownerStays: () =>
    new AppError(400, 'team_owner_stays', 'The owner stays in the team; to close it, delete the team.'),
  wrongEmail: (email: string) =>
    new AppError(
      403,
      'invite_wrong_email',
      `This invitation is for ${email}. Sign in with that address to accept it.`,
    ),
  alreadyMember: (email: string) => new AppError(409, 'already_member', `${email} is already in the team.`),
  limit: () => new AppError(409, 'team_limit', `One person can own up to ${MAX_OWNED_TEAMS} teams.`),
};

/** How long one caller's view is reused: a request builds its catalog and checks its calls with one. */
const VIEW_TTL_MS = 5_000;

export class TeamService implements ConnectPermissions {
  /** Per principal object, briefly (see {@link VIEW_TTL_MS}). */
  private readonly views = new WeakMap<Principal, { at: number; view: Promise<TeamView | undefined> }>();

  constructor(
    private readonly deps: {
      db: Db;
      accounts: AccountService;
      /** The MCP endpoint URL; a team's is `<mcpUrl>/team/<slug>`. */
      mcpUrl: string;
      publicUrl: string;
      limits?: TeamLimits;
      /** Disconnects a member's AI apps and keys from a team they no longer belong to. */
      revokeGrant: (grantId: string) => Promise<void>;
      revokeToken: (workspaceId: string, tokenId: string) => Promise<void>;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // --- Addresses -------------------------------------------------------------

  teamUrl(slug: string): string {
    return `${this.deps.mcpUrl}/team/${slug}`;
  }

  /** The team slug of an MCP URL (`<mcpUrl>/team/<slug>`), or undefined for any other URL. */
  slugOfResource(resource: string): string | undefined {
    const prefix = `${this.deps.mcpUrl}/team/`;
    if (!resource.startsWith(prefix)) return undefined;
    const slug = resource.slice(prefix.length);
    return TEAM_SLUG.test(slug) ? slug : undefined;
  }

  // --- Teams -----------------------------------------------------------------

  async create(
    owner: { id: string; name: string | null; email: string },
    rawName: string,
  ): Promise<Workspace> {
    const name = TeamName.parse(rawName);
    const [owned] = await this.deps.db
      .select({ n: count() })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(
        and(
          eq(workspaceMembers.userId, owner.id),
          eq(workspaceMembers.role, 'owner'),
          eq(workspaces.kind, 'team'),
        ),
      );
    if ((owned?.n ?? 0) >= MAX_OWNED_TEAMS) throw teamError.limit();
    const slug = await this.freeSlug(name);
    return this.deps.db.transaction(async (tx) => {
      const [team] = await tx
        .insert(workspaces)
        .values({ id: newId('wsp'), name, kind: 'team', slug, settings: { toolExposure: 'grouped' } })
        .returning();
      await tx.insert(workspaceMembers).values({
        workspaceId: team!.id,
        userId: owner.id,
        role: 'owner',
        handle: memberHandle(owner, new Set()),
      });
      return team!;
    });
  }

  private async freeSlug(name: string): Promise<string> {
    let base = slugify(name, 30)
      .replace(/_/g, '-')
      .replace(/^-+|-+$/g, '');
    if (base.length < 3 || RESERVED_SLUGS.has(base)) base = `team-${base}`.replace(/-+$/, '');
    for (let attempt = 0; attempt < 8; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
      if (!TEAM_SLUG.test(slug)) continue;
      const [taken] = await this.deps.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, slug))
        .limit(1);
      if (!taken) return slug;
    }
    return `team-${randomBytes(4).toString('hex')}`;
  }

  /** The slug of a team workspace; undefined for a personal one. */
  async slugOf(workspaceId: string): Promise<string | undefined> {
    const workspace = await getWorkspace(this.deps.db, workspaceId);
    return workspace?.kind === 'team' ? (workspace.slug ?? undefined) : undefined;
  }

  async bySlug(slug: string): Promise<Workspace | undefined> {
    if (!TEAM_SLUG.test(slug)) return undefined;
    const [row] = await this.deps.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.slug, slug), eq(workspaces.kind, 'team')))
      .limit(1);
    return row;
  }

  /** A team the user belongs to, with their role; throws not found otherwise (no hint it exists). */
  async forMember(workspaceId: string, userId: string): Promise<{ team: Workspace; role: MemberRole }> {
    const [row] = await this.deps.db
      .select({ team: workspaces, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
          eq(workspaces.kind, 'team'),
        ),
      )
      .limit(1);
    if (!row) throw notFound('Team');
    return row;
  }

  /** The teams a user belongs to, oldest first. */
  async teamsOf(userId: string): Promise<{ team: Workspace; role: MemberRole; members: number }[]> {
    const rows = await this.deps.db
      .select({ team: workspaces, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaces.kind, 'team')))
      .orderBy(asc(workspaceMembers.createdAt));
    if (rows.length === 0) return [];
    const counts = await this.deps.db
      .select({ workspaceId: workspaceMembers.workspaceId, n: count() })
      .from(workspaceMembers)
      .where(
        inArray(
          workspaceMembers.workspaceId,
          rows.map((r) => r.team.id),
        ),
      )
      .groupBy(workspaceMembers.workspaceId);
    const byTeam = new Map(counts.map((c) => [c.workspaceId, c.n]));
    return rows.map((r) => ({ ...r, members: byTeam.get(r.team.id) ?? 1 }));
  }

  async members(workspaceId: string): Promise<TeamMember[]> {
    const rows = await this.deps.db
      .select({
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        handle: workspaceMembers.handle,
        joinedAt: workspaceMembers.createdAt,
        name: users.name,
        email: users.email,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .orderBy(asc(workspaceMembers.createdAt));
    return rows.map((r) => ({
      userId: r.userId,
      name: displayName(r),
      email: r.email,
      handle: r.handle ?? 'member',
      role: r.role,
      joinedAt: r.joinedAt,
    }));
  }

  private async requireRole(workspaceId: string, userId: string, admin: boolean): Promise<MemberRole> {
    const { role } = await this.forMember(workspaceId, userId);
    if (admin && !isTeamAdmin(role)) throw teamError.adminOnly();
    return role;
  }

  // --- What a caller may use -------------------------------------------------

  /**
   * The caller's view of their team, or undefined in a personal workspace. Cached per principal
   * object for a few seconds, so one request computes it once (catalog, policy and setup tools
   * share it) and a long-lived caller still sees a share or a removal soon after it happens.
   */
  view(principal: Principal): Promise<TeamView | undefined> {
    const now = Date.now();
    const hit = this.views.get(principal);
    if (hit && now - hit.at < VIEW_TTL_MS) return hit.view;
    const view = this.load(principal);
    this.views.set(principal, { at: now, view });
    view.catch(() => this.views.delete(principal));
    return view;
  }

  private async load(principal: Principal): Promise<TeamView | undefined> {
    const [team] = await this.deps.db
      .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug, kind: workspaces.kind })
      .from(workspaces)
      .where(eq(workspaces.id, principal.workspaceId))
      .limit(1);
    if (team?.kind !== 'team' || !team.slug) return undefined;
    const [members, accounts, shares] = await Promise.all([
      this.members(team.id),
      this.deps.accounts.owners(team.id),
      this.shares(team.id),
    ]);
    const me = principal.shared ? undefined : members.find((m) => m.userId === principal.userId);
    // Not a member (any more): nothing is visible, as if the account list were empty.
    const viewer: TeamViewer = me ? { kind: 'member', userId: me.userId, role: me.role } : { kind: 'shared' };
    const access =
      me || principal.shared
        ? memberAccess({
            accounts,
            shares,
            viewer,
            names: new Map(members.map((m) => [m.userId, m.name])),
          })
        : { access: {}, owners: {}, manages: new Set<string>() };
    return {
      team: { id: team.id, name: team.name, slug: team.slug },
      ...(me ? { member: { userId: me.userId, name: me.name, handle: me.handle, role: me.role } } : {}),
      access,
    };
  }

  // --- Invitations -----------------------------------------------------------

  /** Members plus open invitations: what takes a seat. */
  private async seatsTaken(workspaceId: string, exceptInvitation?: string): Promise<number> {
    const [[members], [open]] = await Promise.all([
      this.deps.db
        .select({ n: count() })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceId)),
      this.deps.db
        .select({ n: count() })
        .from(workspaceInvitations)
        .where(
          and(
            eq(workspaceInvitations.workspaceId, workspaceId),
            this.openInvitation(),
            exceptInvitation ? sql`${workspaceInvitations.id} <> ${exceptInvitation}` : undefined,
          ),
        ),
    ]);
    return (members?.n ?? 0) + (open?.n ?? 0);
  }

  private openInvitation() {
    return and(
      isNull(workspaceInvitations.acceptedAt),
      isNull(workspaceInvitations.revokedAt),
      gt(workspaceInvitations.expiresAt, this.now()),
    );
  }

  /**
   * Invites a person by email. Returns the link to send them; only someone signed in with that
   * address can accept it. Inviting the same address again replaces the earlier link.
   */
  async invite(
    actorId: string,
    workspaceId: string,
    raw: { email: string; role?: 'admin' | 'member' },
  ): Promise<{ invitation: InvitationRow; url: string }> {
    await this.requireRole(workspaceId, actorId, true);
    const parsed = InviteInput.safeParse(raw);
    if (!parsed.success) throw badRequest('Give a valid email address to invite.');
    const email = normalizeEmail(parsed.data.email);
    const members = await this.members(workspaceId);
    if (members.some((m) => m.email === email)) throw teamError.alreadyMember(email);
    const [earlier] = await this.deps.db
      .select({ id: workspaceInvitations.id })
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.workspaceId, workspaceId),
          eq(workspaceInvitations.email, email),
          this.openInvitation(),
        ),
      )
      .limit(1);
    await this.deps.limits?.assertCanAddMember(workspaceId, await this.seatsTaken(workspaceId, earlier?.id));
    const token = `ac_inv_${randomBytes(24).toString('base64url')}`;
    const invitation = await this.deps.db.transaction(async (tx) => {
      if (earlier) {
        await tx
          .update(workspaceInvitations)
          .set({ revokedAt: this.now() })
          .where(eq(workspaceInvitations.id, earlier.id));
      }
      const [row] = await tx
        .insert(workspaceInvitations)
        .values({
          id: newId('inv'),
          workspaceId,
          email,
          role: parsed.data.role,
          tokenHash: hashToken(token),
          invitedBy: actorId,
          expiresAt: new Date(this.now().getTime() + INVITATION_DAYS * 86_400_000),
        })
        .returning();
      return row!;
    });
    return { invitation, url: this.invitationUrl(token) };
  }

  invitationUrl(token: string): string {
    return new URL(`/invite/${encodeURIComponent(token)}`, this.deps.publicUrl).toString();
  }

  async invitations(workspaceId: string): Promise<InvitationRow[]> {
    return this.deps.db
      .select()
      .from(workspaceInvitations)
      .where(and(eq(workspaceInvitations.workspaceId, workspaceId), this.openInvitation()))
      .orderBy(desc(workspaceInvitations.createdAt));
  }

  async revokeInvitation(actorId: string, workspaceId: string, invitationId: string): Promise<void> {
    await this.requireRole(workspaceId, actorId, true);
    const revoked = await this.deps.db
      .update(workspaceInvitations)
      .set({ revokedAt: this.now() })
      .where(
        and(
          eq(workspaceInvitations.id, invitationId),
          eq(workspaceInvitations.workspaceId, workspaceId),
          this.openInvitation(),
        ),
      )
      .returning({ id: workspaceInvitations.id });
    if (revoked.length === 0) throw notFound('Invitation');
  }

  /** An open invitation by the token from its link, with its team and who sent it. */
  async invitation(
    token: string,
  ): Promise<{ invitation: InvitationRow; team: Workspace; invitedBy: string | null } | undefined> {
    if (!token.startsWith('ac_inv_') || token.length > 100) return undefined;
    const [row] = await this.deps.db
      .select({ invitation: workspaceInvitations, team: workspaces })
      .from(workspaceInvitations)
      .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
      .where(and(eq(workspaceInvitations.tokenHash, hashToken(token)), this.openInvitation()))
      .limit(1);
    if (!row) return undefined;
    let invitedBy: string | null = null;
    if (row.invitation.invitedBy) {
      const [inviter] = await this.deps.db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, row.invitation.invitedBy))
        .limit(1);
      invitedBy = inviter ? displayName(inviter) : null;
    }
    return { ...row, invitedBy };
  }

  /** Joins the team of an invitation. The signed-in user's email must be the invited one. */
  async accept(token: string, user: { id: string; email: string; name: string | null }): Promise<Workspace> {
    const found = await this.invitation(token);
    if (!found) throw notFound('Invitation');
    const { invitation, team } = found;
    if (normalizeEmail(user.email) !== invitation.email) throw teamError.wrongEmail(invitation.email);
    const members = await this.members(team.id);
    if (!members.some((m) => m.userId === user.id)) {
      // The invitation itself already holds a seat.
      await this.deps.limits?.assertCanAddMember(team.id, await this.seatsTaken(team.id, invitation.id));
    }
    await this.deps.db.transaction(async (tx) => {
      if (!members.some((m) => m.userId === user.id)) {
        await tx.insert(workspaceMembers).values({
          workspaceId: team.id,
          userId: user.id,
          role: invitation.role,
          handle: memberHandle(user, new Set(members.map((m) => m.handle))),
        });
      }
      await tx
        .update(workspaceInvitations)
        .set({ acceptedAt: this.now(), acceptedBy: user.id })
        .where(eq(workspaceInvitations.id, invitation.id));
    });
    return team;
  }

  // --- Roles, leaving --------------------------------------------------------

  /** Makes a member an admin or back. Only the owner decides who runs the team with them. */
  async setRole(
    actorId: string,
    workspaceId: string,
    userId: string,
    role: 'admin' | 'member',
  ): Promise<void> {
    const actorRole = await this.requireRole(workspaceId, actorId, true);
    if (actorRole !== 'owner') throw teamError.ownerOnly('change roles');
    const target = await this.forMember(workspaceId, userId).catch(() => undefined);
    if (!target) throw notFound('Member');
    if (target.role === 'owner') throw teamError.ownerStays();
    await this.deps.db
      .update(workspaceMembers)
      .set({ role })
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  }

  /** Removes a member. Admins remove members; only the owner removes admins; nobody removes the owner. */
  async removeMember(actorId: string, workspaceId: string, userId: string): Promise<LeaveOutcome> {
    const actorRole = await this.requireRole(workspaceId, actorId, true);
    if (actorId === userId) return this.leave(userId, workspaceId);
    const target = await this.forMember(workspaceId, userId).catch(() => undefined);
    if (!target) throw notFound('Member');
    if (target.role === 'owner') throw teamError.ownerStays();
    if (target.role === 'admin' && actorRole !== 'owner') throw teamError.ownerOnly('remove admins');
    return this.detach(workspaceId, userId);
  }

  /** Leaves a team. The owner cannot leave (they delete the team instead). */
  async leave(userId: string, workspaceId: string): Promise<LeaveOutcome> {
    const { role } = await this.forMember(workspaceId, userId);
    if (role === 'owner') throw teamError.ownerStays();
    return this.detach(workspaceId, userId);
  }

  /**
   * Takes a member out: their own accounts go back to their personal workspace (or are removed
   * when they cannot work there), shares with them end, their AI apps and keys lose access, and
   * their actions still waiting for confirmation are cancelled.
   */
  private async detach(workspaceId: string, userId: string): Promise<LeaveOutcome> {
    const personal = await getDefaultWorkspace(this.deps.db, userId);
    const outcome: LeaveOutcome = { moved: [], removed: [] };
    for (const account of await this.deps.accounts.ownedBy(workspaceId, userId)) {
      const moved =
        personal && personal.id !== workspaceId
          ? await this.deps.accounts
              .move(workspaceId, account.id, { workspaceId: personal.id, ownerUserId: userId })
              .catch(() => undefined)
          : undefined;
      if (moved) {
        outcome.moved.push(account.label);
      } else {
        await this.deps.accounts.delete(workspaceId, account.id);
        outcome.removed.push(account.label);
      }
    }
    const db = this.deps.db;
    const [grants, tokens] = await Promise.all([
      db
        .select({ id: oauthGrants.id })
        .from(oauthGrants)
        .where(
          and(
            eq(oauthGrants.workspaceId, workspaceId),
            eq(oauthGrants.userId, userId),
            isNull(oauthGrants.revokedAt),
          ),
        ),
      db
        .select({ id: apiTokens.id })
        .from(apiTokens)
        .where(
          and(
            eq(apiTokens.workspaceId, workspaceId),
            eq(apiTokens.userId, userId),
            isNull(apiTokens.revokedAt),
          ),
        ),
    ]);
    for (const grant of grants) await this.deps.revokeGrant(grant.id);
    for (const token of tokens) await this.deps.revokeToken(workspaceId, token.id);
    await db.transaction(async (tx) => {
      await tx
        .delete(accountShares)
        .where(and(eq(accountShares.workspaceId, workspaceId), eq(accountShares.userId, userId)));
      await tx
        .update(pendingCalls)
        .set({ status: 'cancelled', decidedVia: 'left_team', decidedAt: this.now() })
        .where(
          and(
            eq(pendingCalls.workspaceId, workspaceId),
            sql`${pendingCalls.principal}->>'userId' = ${userId}`,
            inArray(pendingCalls.status, ['awaiting_confirmation', 'scheduled']),
          ),
        );
      await tx
        .delete(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    });
    return outcome;
  }

  /** Deletes a team with its team accounts (the owner only). Members keep their own accounts. */
  async deleteTeam(actorId: string, workspaceId: string): Promise<void> {
    const { role } = await this.forMember(workspaceId, actorId);
    if (role !== 'owner') throw teamError.ownerOnly('delete the team');
    for (const member of await this.members(workspaceId)) {
      if (member.userId !== actorId) await this.detach(workspaceId, member.userId);
    }
    // The owner's own accounts go home too; team accounts are removed with the team.
    await this.detach(workspaceId, actorId).catch(() => undefined);
    for (const account of await this.deps.accounts.list(workspaceId)) {
      await this.deps.accounts.delete(workspaceId, account.id).catch(() => {});
    }
    await this.deps.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  }

  /**
   * Before a user is deleted: their own accounts in teams are removed (with their keys) and a team
   * they own passes to its longest-standing admin, or member.
   */
  async forgetUser(userId: string): Promise<void> {
    for (const { team, role } of await this.teamsOf(userId)) {
      const others = (await this.members(team.id)).filter((m) => m.userId !== userId);
      if (others.length === 0) continue; // the team goes with the user's own workspaces
      for (const account of await this.deps.accounts.ownedBy(team.id, userId)) {
        await this.deps.accounts.delete(team.id, account.id).catch(() => {});
      }
      if (role === 'owner') {
        const heir = others.find((m) => m.role === 'admin') ?? others[0]!;
        await this.deps.db
          .update(workspaceMembers)
          .set({ role: 'owner' })
          .where(and(eq(workspaceMembers.workspaceId, team.id), eq(workspaceMembers.userId, heir.userId)));
      }
    }
  }

  // --- Sharing ---------------------------------------------------------------

  async shares(workspaceId: string): Promise<ShareRow[]> {
    return this.deps.db.select().from(accountShares).where(eq(accountShares.workspaceId, workspaceId));
  }

  /**
   * Shares an account with one member (`withUserId`) or the whole team (`null`) at a level, or
   * stops sharing (`level` null). Only who manages the account may: its owner, or an admin for a
   * team account (where the whole-team level is what every member may do).
   */
  async share(
    actorId: string,
    workspaceId: string,
    accountId: string,
    withUserId: string | null,
    level: ShareLevel | null,
  ): Promise<void> {
    if (level !== null && !SHARE_LEVELS.includes(level)) throw badRequest('Unknown access level');
    const actor = await this.forMember(workspaceId, actorId);
    const account = await this.deps.accounts.get(workspaceId, accountId);
    const manages =
      account.ownerUserId === actorId || (account.ownerUserId === null && isTeamAdmin(actor.role));
    if (!manages) throw teamError.notAccountOwner();
    if (withUserId !== null) {
      if (withUserId === account.ownerUserId) throw badRequest('The owner already has full access.');
      await this.forMember(workspaceId, withUserId).catch(() => {
        throw notFound('Member');
      });
      if (account.ownerUserId === null) throw badRequest('A team account is shared with the whole team.');
    }
    const where = and(
      eq(accountShares.accountId, accountId),
      withUserId === null ? isNull(accountShares.userId) : eq(accountShares.userId, withUserId),
    );
    if (level === null) {
      await this.deps.db.delete(accountShares).where(where);
      return;
    }
    await this.deps.db.transaction(async (tx) => {
      const updated = await tx
        .update(accountShares)
        .set({ access: level, createdBy: actorId })
        .where(where)
        .returning({ id: accountShares.id });
      if (updated.length === 0) {
        await tx.insert(accountShares).values({
          id: newId('shr'),
          workspaceId,
          accountId,
          userId: withUserId,
          access: level,
          createdBy: actorId,
        });
      }
    });
  }

  /** Accounts a member may manage in their team (their own; team accounts too for admins). */
  manageable(view: TeamView, accounts: AccountRow[]): AccountRow[] {
    return accounts.filter((a) => view.access.manages.has(a.id));
  }

  // --- Connecting accounts (ConnectPermissions) --------------------------------

  /** In a team: members connect their own accounts; admins also the team's. */
  async assertCanConnect(
    workspaceId: string,
    userId: string,
    owner: AccountOwnerInput | undefined,
  ): Promise<void> {
    const workspace = await getWorkspace(this.deps.db, workspaceId);
    if (workspace?.kind !== 'team') return;
    const { role } = await this.forMember(workspaceId, userId);
    if (owner === undefined) throw badRequest('Say whose account this is: yours or the team’s.');
    if (owner.userId === null && !isTeamAdmin(role)) throw teamError.adminOnly();
    if (owner.userId !== null && owner.userId !== userId) throw teamError.notAccountOwner();
  }

  /** In a team: only who manages an account (its owner; admins for a team account) changes it. */
  async assertCanManage(workspaceId: string, userId: string, account: AccountRow): Promise<void> {
    const workspace = await getWorkspace(this.deps.db, workspaceId);
    if (workspace?.kind !== 'team') return;
    const { role } = await this.forMember(workspaceId, userId);
    const manages = account.ownerUserId === userId || (account.ownerUserId === null && isTeamAdmin(role));
    if (!manages) throw teamError.notAccountOwner();
  }
}
