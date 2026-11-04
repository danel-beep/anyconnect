import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
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
  /** Only verified addresses create accounts or link to existing ones. */
  emailVerified: boolean;
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
  async ownedWorkspaces(userId: string): Promise<Workspace[]> {
    const rows = await this.deps.db
      .select({ workspace: workspaces })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.role, 'owner')));
    return rows.map((r) => r.workspace);
  }

  identities(userId: string) {
    return this.deps.db.select().from(userIdentities).where(eq(userIdentities.userId, userId));
  }

  /** Promotes configured admin emails; never demotes (admins are removed with `setRole`). */
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
      return { user: await this.syncRole(user), created: false };
    }
    if (!profile.emailVerified) throw new SignInRefused('email_unverified');

    const existing = await findUserByEmail(db, email);
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

    if (this.deps.signups === 'closed' && !this.deps.adminEmails.includes(email))
      throw new SignInRefused('signups_closed');
    const { user } = await createUser(db, {
      email,
      ...(profile.name ? { name: profile.name.slice(0, 100) } : {}),
      role: this.deps.adminEmails.includes(email) ? 'admin' : 'user',
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
    if (status === 'suspended') await this.revokeAccess(userId);
    return user;
  }

  /** Signs the user out everywhere and disconnects every AI app and personal token. */
  async revokeAccess(userId: string): Promise<{ sessions: number; apps: number; tokens: number }> {
    const sessions = await this.deps.db
      .delete(webSessions)
      .where(eq(webSessions.userId, userId))
      .returning({ id: webSessions.tokenHash });
    let apps = 0;
    let tokens = 0;
    for (const workspace of await this.ownedWorkspaces(userId)) {
      for (const grant of await this.deps.oauth.listGrants(workspace.id)) {
        await this.deps.oauth.revokeGrantById(grant.id);
        apps += 1;
      }
      for (const token of await this.deps.apiTokens.list(workspace.id)) {
        await this.deps.apiTokens.revoke(workspace.id, token.id);
        tokens += 1;
      }
    }
    return { sessions: sessions.length, apps, tokens };
  }

  /**
   * Deletes the user and the workspaces only they own, with every connected account (OAuth grants at
   * the providers are revoked best effort first). Shared workspaces stay with their other members.
   */
  async delete(userId: string): Promise<void> {
    await this.require(userId);
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
