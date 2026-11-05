import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  apiTokens,
  oauthAuthorizationCodes,
  oauthGrants,
  type UserRole,
  type UserStatus,
  userIdentities,
  users,
  webSessions,
  workspaceMembers,
  workspaces,
} from '../db/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import type { OAuthServer } from '../oauth/server.js';
import type { AccountService } from './accounts.js';
import type { ApiTokenService } from './api-tokens.js';
import {
  createUser,
  findUserByEmail,
  getUser,
  normalizeEmail,
  type User,
  type Workspace,
} from './identity.js';

/** A person as an external sign-in provider (Google) describes them. */
export interface ExternalProfile {
  provider: string;
  /** The provider's stable user id. */
  subject: string;
  email: string;
  /** Only verified addresses create accounts. */
  emailVerified: boolean;
  /**
   * Whether the provider is the authority for this address (Google: an @gmail.com address or a
   * Google Workspace domain), not just "verified once". Only then may it link to an existing user
   * or become an admin: anyone can create a Google account for an address they once controlled.
   */
  emailAuthoritative: boolean;
  name?: string | undefined;
}

export type SignInRefusal = 'suspended' | 'signups_closed' | 'email_unverified';

/** A sign-in that must not go ahead; the website shows a translated message by `reason`. */
export class SignInRefused extends AppError {
  constructor(readonly reason: SignInRefusal) {
    super(403, reason, `Sign-in refused: ${reason}`);
  }
}

/**
 * Hub users beyond authentication: sign-up through external providers, roles, suspension and
 * deletion. Suspending a user signs them out everywhere and revokes every AI app connection and
 * personal token, so nothing keeps working on their behalf.
 */
export class UserService {
  constructor(
    private readonly deps: {
      db: Db;
      accounts: AccountService;
      oauth: OAuthServer;
      apiTokens: ApiTokenService;
      /** Teams the user belongs to: their accounts there go, a team they own passes on. */
      teams?: { forgetUser(userId: string): Promise<void> };
      /** Lower-cased emails that are promoted to admin when they sign in. */
      adminEmails: string[];
      signups: 'open' | 'closed';
    },
  ) {}

  get(id: string): Promise<User | undefined> {
    return getUser(this.deps.db, id);
  }

  async require(id: string): Promise<User> {
    const user = await this.get(id);
    if (!user) throw notFound('User');
    return user;
  }

  /** Workspaces the user owns. */
  /** Workspaces the user owns: their personal one first, then teams they own. */
  async ownedWorkspaces(userId: string): Promise<Workspace[]> {
    const rows = await this.deps.db
      .select({ workspace: workspaces })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.role, 'owner')))
      .orderBy(sql`(${workspaces.kind} = 'personal') desc`, asc(workspaceMembers.createdAt));
    return rows.map((r) => r.workspace);
  }

  /**
   * The user's own workspace (never a team): the one the admin panel shows and puts on a plan, and
   * the one an administrator's unlimited plan applies to.
   */
  async personalWorkspace(userId: string): Promise<Workspace | undefined> {
    return (await this.ownedWorkspaces(userId)).find((w) => w.kind === 'personal');
  }

  identities(userId: string) {
    return this.deps.db.select().from(userIdentities).where(eq(userIdentities.userId, userId));
  }

  /**
   * Promotes configured admin emails; never demotes (admins are removed with `setRole`). Only called
   * when this very sign-in proved the address (an authoritative Google sign-in): an account that
   * once signed up with an unproven address must not become admin when the address is added later.
   */
  async syncRole(user: User): Promise<User> {
    if (user.role === 'admin' || !this.deps.adminEmails.includes(user.email)) return user;
    const [updated] = await this.deps.db
      .update(users)
      .set({ role: 'admin' })
      .where(eq(users.id, user.id))
      .returning();
    return updated ?? user;
  }

  /**
   * Finds or creates the user behind an external sign-in:
   * a known identity signs in its user; otherwise a verified email links to the existing user with
   * that address (the provider proved the person owns it); otherwise a new user with a personal
   * workspace is created, if sign-ups are open.
   */
  async signInExternal(profile: ExternalProfile): Promise<{ user: User; created: boolean }> {
    const db = this.deps.db;
    const email = normalizeEmail(profile.email);
    const [identity] = await db
      .select()
      .from(userIdentities)
      .where(and(eq(userIdentities.provider, profile.provider), eq(userIdentities.subject, profile.subject)))
      .limit(1);
    if (identity) {
      const user = await this.require(identity.userId);
      if (user.status !== 'active') throw new SignInRefused('suspended');
      await db
        .update(userIdentities)
        .set({ email, lastUsedAt: new Date() })
        .where(
          and(eq(userIdentities.provider, profile.provider), eq(userIdentities.subject, profile.subject)),
        );
      return {
        user: profile.emailAuthoritative && profile.emailVerified ? await this.syncRole(user) : user,
        created: false,
      };
    }
    if (!profile.emailVerified) throw new SignInRefused('email_unverified');

    const existing = await findUserByEmail(db, email);
    const isAdminEmail = this.deps.adminEmails.includes(email);
    if ((existing || isAdminEmail) && !profile.emailAuthoritative)
      throw new SignInRefused('email_unverified');
    if (existing) {
      if (existing.status !== 'active') throw new SignInRefused('suspended');
      await this.link(existing.id, profile, email);
      if (!existing.name && profile.name)
        await db
          .update(users)
          .set({ name: profile.name.slice(0, 100) })
          .where(eq(users.id, existing.id));
      return { user: await this.syncRole(existing), created: false };
    }

    if (this.deps.signups === 'closed' && !isAdminEmail) throw new SignInRefused('signups_closed');
    const { user } = await createUser(db, {
      email,
      ...(profile.name ? { name: profile.name.slice(0, 100) } : {}),
      role: isAdminEmail ? 'admin' : 'user',
    });
    await this.link(user.id, profile, email);
    return { user, created: true };
  }

  private async link(userId: string, profile: ExternalProfile, email: string): Promise<void> {
    await this.deps.db
      .insert(userIdentities)
      .values({ provider: profile.provider, subject: profile.subject, userId, email, lastUsedAt: new Date() })
      .onConflictDoNothing();
  }

  async setProfile(userId: string, change: { name?: string | null; locale?: string | null }): Promise<void> {
    const patch: Partial<typeof users.$inferInsert> = {};
    if (change.name !== undefined) patch.name = change.name?.trim().slice(0, 100) || null;
    if (change.locale !== undefined) patch.locale = change.locale;
    if (Object.keys(patch).length) await this.deps.db.update(users).set(patch).where(eq(users.id, userId));
  }

  async setRole(userId: string, role: UserRole): Promise<User> {
    const [user] = await this.deps.db.update(users).set({ role }).where(eq(users.id, userId)).returning();
    if (!user) throw notFound('User');
    return user;
  }

  /** Suspends (sign-out, AI apps and tokens revoked) or reactivates a user. */
  async setStatus(userId: string, status: UserStatus, reason?: string | null): Promise<User> {
    const [user] = await this.deps.db
      .update(users)
      .set({ status, statusReason: status === 'suspended' ? (reason?.slice(0, 500) ?? null) : null })
      .where(eq(users.id, userId))
      .returning();
    if (!user) throw notFound('User');
    activeCache.delete(userId);
    if (status === 'suspended') await this.revokeAccess(userId);
    return user;
  }

  /**
   * Signs the user out everywhere and disconnects every AI app and personal token they hold, in any
   * workspace; authorization codes not yet exchanged are dropped too.
   */
  async revokeAccess(userId: string): Promise<{ sessions: number; apps: number; tokens: number }> {
    const db = this.deps.db;
    const sessions = await db
      .delete(webSessions)
      .where(eq(webSessions.userId, userId))
      .returning({ id: webSessions.tokenHash });
    await db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.userId, userId));
    const grants = await db
      .select({ id: oauthGrants.id })
      .from(oauthGrants)
      .where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)));
    for (const grant of grants) await this.deps.oauth.revokeGrantById(grant.id);
    const tokens = await db
      .select({ id: apiTokens.id, workspaceId: apiTokens.workspaceId })
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
    for (const token of tokens) await this.deps.apiTokens.revoke(token.workspaceId, token.id);
    activeCache.delete(userId);
    return { sessions: sessions.length, apps: grants.length, tokens: tokens.length };
  }

  /**
   * Deletes the user and the workspaces only they own, with every connected account (OAuth grants at
   * the providers are revoked best effort first). Shared workspaces stay with their other members.
   */
  async delete(userId: string): Promise<void> {
    await this.require(userId);
    await this.deps.teams?.forgetUser(userId);
    for (const workspace of await this.ownedWorkspaces(userId)) {
      const members = await this.deps.db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspace.id));
      if (members.some((m) => m.userId !== userId)) continue;
      for (const account of await this.deps.accounts.list(workspace.id)) {
        await this.deps.accounts.delete(workspace.id, account.id).catch(() => {});
      }
      await this.deps.db.delete(workspaces).where(eq(workspaces.id, workspace.id));
    }
    await this.deps.db.delete(users).where(eq(users.id, userId));
  }
}

const ACTIVE_CACHE_MS = 15_000;
const activeCache = new Map<string, { at: number; active: boolean }>();
const memberCache = new Map<string, { at: number; member: boolean }>();

/**
 * `(user, workspace) → is the user still a member`, for the token verifier: a person removed from a
 * team has their tokens revoked at once; this is the backstop. Cached for 15 s per process.
 */
export function memberCheck(db: Db): (userId: string, workspaceId: string) => Promise<boolean> {
  return async (userId, workspaceId) => {
    const key = `${userId}:${workspaceId}`;
    const now = Date.now();
    const hit = memberCache.get(key);
    if (hit && now - hit.at < ACTIVE_CACHE_MS) return hit.member;
    const [row] = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, workspaceId)))
      .limit(1);
    const member = Boolean(row);
    memberCache.set(key, { at: now, member });
    if (memberCache.size > 10_000) memberCache.delete(memberCache.keys().next().value!);
    return member;
  };
}

/** Forgets cached memberships of a workspace (after someone left it). */
export function forgetMembership(userId: string, workspaceId: string): void {
  memberCache.delete(`${userId}:${workspaceId}`);
}

/**
 * `userId → is the user active`, for the token verifier on every MCP/API request. Cached for 15 s
 * per process; suspending also revokes the user's tokens, so the cache only delays the backstop.
 */
export function activeUserCheck(db: Db): (userId: string) => Promise<boolean> {
  return async (userId) => {
    const now = Date.now();
    const hit = activeCache.get(userId);
    if (hit && now - hit.at < ACTIVE_CACHE_MS) return hit.active;
    const [row] = await db.select({ status: users.status }).from(users).where(eq(users.id, userId)).limit(1);
    const active = row?.status === 'active';
    activeCache.set(userId, { at: now, active });
    if (activeCache.size > 10_000) activeCache.delete(activeCache.keys().next().value!);
    return active;
  };
}
