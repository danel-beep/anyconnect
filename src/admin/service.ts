import { and, count, desc, eq, gte, ilike, inArray, isNull, or, sql, sum } from 'drizzle-orm';
import type { EntitlementService } from '../billing/entitlements.js';
import { monthPeriod } from '../billing/period.js';
import { DEFAULT_PLAN_ID } from '../billing/plans.js';
import { BillingService } from '../billing/service.js';
import type { UserService } from '../core/users.js';
import type { Db } from '../db/client.js';
import {
  accounts,
  adminAuditLog,
  oauthGrants,
  subscriptions,
  usageCounters,
  users,
  userTotp,
  webauthnCredentials,
  webSessions,
  workspaceMembers,
} from '../db/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';

/** Who does an admin action, for the audit log. */
export interface AdminActor {
  userId: string;
  email: string;
  ip?: string | undefined;
}

export type UserRow = typeof users.$inferSelect;

export interface AdminUserListItem {
  user: UserRow;
  workspaceId: string | null;
  planId: string;
  accounts: number;
  actionsThisMonth: number;
}

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Everything the admin panel does, as plain operations: hub-wide numbers, the user directory and
 * changes to users (plan, extra limits, suspension). Every change is written to `admin_audit_log`.
 * Admins never see service credentials, tool arguments or results: only counts and metadata.
 */
export class AdminService {
  constructor(
    private readonly deps: {
      db: Db;
      users: UserService;
      entitlements: EntitlementService;
    },
  ) {}

  // --- Reading -----------------------------------------------------------------

  async overview(now = new Date()) {
    const db = this.deps.db;
    const since30 = new Date(now.getTime() - 30 * DAY);
    const since7 = new Date(now.getTime() - 7 * DAY);
    const [[userTotals], [accountTotal], [appTotal], plans, daily, signups, byConnector] = await Promise.all([
      db
        .select({
          total: count(),
          suspended: sql<number>`count(*) filter (where ${users.status} = 'suspended')`.mapWith(Number),
          admins: sql<number>`count(*) filter (where ${users.role} = 'admin')`.mapWith(Number),
          new7: sql<number>`count(*) filter (where ${users.createdAt} >= ${since7})`.mapWith(Number),
          active7: sql<number>`count(*) filter (where ${users.lastLoginAt} >= ${since7})`.mapWith(Number),
        })
        .from(users),
      db
        .select({
          n: count(),
          failing:
            sql<number>`count(*) filter (where ${accounts.enabled} and ${accounts.status} <> 'active')`.mapWith(
              Number,
            ),
        })
        .from(accounts),
      db.select({ n: count() }).from(oauthGrants).where(isNull(oauthGrants.revokedAt)),
      db
        .select({ planId: subscriptions.planId, n: count() })
        .from(subscriptions)
        .groupBy(subscriptions.planId),
      db
        .select({
          day: usageCounters.day,
          calls: sum(usageCounters.calls),
          errors: sum(usageCounters.errors),
        })
        .from(usageCounters)
        .where(gte(usageCounters.day, isoDay(since30)))
        .groupBy(usageCounters.day),
      db
        .select({
          day: sql<string>`to_char(${users.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`,
          n: count(),
        })
        .from(users)
        .where(gte(users.createdAt, since30))
        .groupBy(sql`1`),
      db
        .select({ connectorId: accounts.connectorId, n: count() })
        .from(accounts)
        .groupBy(accounts.connectorId)
        .orderBy(desc(count()))
        .limit(10),
    ]);
    const days: { day: string; calls: number; errors: number; signups: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const day = isoDay(new Date(now.getTime() - i * DAY));
      const usage = daily.find((d) => d.day === day);
      days.push({
        day,
        calls: Number(usage?.calls ?? 0),
        errors: Number(usage?.errors ?? 0),
        signups: signups.find((s) => s.day === day)?.n ?? 0,
      });
    }
    const paid = plans.filter((p) => p.planId !== DEFAULT_PLAN_ID).reduce((a, p) => a + p.n, 0);
    const total = userTotals?.total ?? 0;
    return {
      users: {
        total,
        new7: userTotals?.new7 ?? 0,
        active7: userTotals?.active7 ?? 0,
        suspended: userTotals?.suspended ?? 0,
        admins: userTotals?.admins ?? 0,
      },
      accounts: accountTotal?.n ?? 0,
      failingAccounts: accountTotal?.failing ?? 0,
      apps: appTotal?.n ?? 0,
      plans: [
        { planId: DEFAULT_PLAN_ID, n: Math.max(0, total - paid) },
        ...plans.filter((p) => p.planId !== DEFAULT_PLAN_ID),
      ],
      days,
      calls24h: days.at(-1)?.calls ?? 0,
      calls30d: days.reduce((a, d) => a + d.calls, 0),
      errors30d: days.reduce((a, d) => a + d.errors, 0),
      byConnector,
    };
  }

  async listUsers(opts: {
    q?: string | undefined;
    status?: 'active' | 'suspended' | undefined;
    role?: 'admin' | 'user' | undefined;
    page?: number;
    perPage?: number;
  }): Promise<{ items: AdminUserListItem[]; total: number; page: number; pages: number }> {
    const db = this.deps.db;
    const perPage = Math.min(Math.max(opts.perPage ?? 25, 5), 100);
    const page = Math.max(opts.page ?? 1, 1);
    const q = opts.q?.trim().slice(0, 100);
    const where = and(
      q
        ? or(
            ilike(users.email, `%${escapeLike(q)}%`),
            ilike(users.name, `%${escapeLike(q)}%`),
            eq(users.id, q),
          )
        : undefined,
      opts.status ? eq(users.status, opts.status) : undefined,
      opts.role ? eq(users.role, opts.role) : undefined,
    );
    const [[totalRow], rows] = await Promise.all([
      db.select({ n: count() }).from(users).where(where),
      db
        .select()
        .from(users)
        .where(where)
        .orderBy(desc(users.createdAt))
        .limit(perPage)
        .offset((page - 1) * perPage),
    ]);
    const total = totalRow?.n ?? 0;
    const items = await this.decorate(rows);
    return { items, total, page, pages: Math.max(1, Math.ceil(total / perPage)) };
  }

  /** Adds each user's owned workspace, plan, account count and this month's actions. */
  private async decorate(rows: UserRow[]): Promise<AdminUserListItem[]> {
    if (!rows.length) return [];
    const db = this.deps.db;
    const members = await db
      .select({ userId: workspaceMembers.userId, workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(
        and(
          inArray(
            workspaceMembers.userId,
            rows.map((r) => r.id),
          ),
          eq(workspaceMembers.role, 'owner'),
        ),
      );
    const wsIds = [...new Set(members.map((m) => m.workspaceId))];
    const period = monthPeriod();
    const [subs, accountCounts, usage] = wsIds.length
      ? await Promise.all([
          db.select().from(subscriptions).where(inArray(subscriptions.workspaceId, wsIds)),
          db
            .select({ workspaceId: accounts.workspaceId, n: count() })
            .from(accounts)
            .where(inArray(accounts.workspaceId, wsIds))
            .groupBy(accounts.workspaceId),
          db
            .select({ workspaceId: usageCounters.workspaceId, calls: sum(usageCounters.calls) })
            .from(usageCounters)
            .where(and(inArray(usageCounters.workspaceId, wsIds), gte(usageCounters.day, period.start)))
            .groupBy(usageCounters.workspaceId),
        ])
      : [[], [], []];
    return rows.map((user) => {
      const workspaceId = members.find((m) => m.userId === user.id)?.workspaceId ?? null;
      const sub = subs.find((s) => s.workspaceId === workspaceId);
      return {
        user,
        workspaceId,
        planId: this.deps.entitlements.planFor(sub).id,
        accounts: accountCounts.find((a) => a.workspaceId === workspaceId)?.n ?? 0,
        actionsThisMonth: Number(usage.find((u) => u.workspaceId === workspaceId)?.calls ?? 0),
      };
    });
  }

  async userDetail(userId: string) {
    const db = this.deps.db;
    const user = await this.deps.users.get(userId);
    if (!user) throw notFound('User');
    const workspace = (await this.deps.users.ownedWorkspaces(userId))[0];
    const [identities, [sessions], [totp], [passkeys], audit] = await Promise.all([
      this.deps.users.identities(userId),
      db.select({ n: count() }).from(webSessions).where(eq(webSessions.userId, userId)),
      db
        .select({ confirmedAt: userTotp.confirmedAt })
        .from(userTotp)
        .where(eq(userTotp.userId, userId))
        .limit(1),
      db.select({ n: count() }).from(webauthnCredentials).where(eq(webauthnCredentials.userId, userId)),
      db
        .select()
        .from(adminAuditLog)
        .where(eq(adminAuditLog.targetUserId, userId))
        .orderBy(desc(adminAuditLog.createdAt))
        .limit(20),
    ]);
    const [summary, allGrants, accountRows, [apps]] = workspace
      ? await Promise.all([
          this.deps.entitlements.summary(workspace.id),
          this.deps.entitlements.grants(workspace.id),
          db
            .select({
              id: accounts.id,
              connectorId: accounts.connectorId,
              name: accounts.name,
              label: accounts.label,
              status: accounts.status,
              enabled: accounts.enabled,
              createdAt: accounts.createdAt,
            })
            .from(accounts)
            .where(eq(accounts.workspaceId, workspace.id))
            .orderBy(accounts.connectorId),
          db
            .select({ n: count() })
            .from(oauthGrants)
            .where(and(eq(oauthGrants.workspaceId, workspace.id), isNull(oauthGrants.revokedAt))),
        ])
      : [undefined, [], [], [{ n: 0 }]];
    return {
      user,
      workspace,
      identities,
      sessions: sessions?.n ?? 0,
      secondFactor: Boolean(totp?.confirmedAt) || (passkeys?.n ?? 0) > 0,
      summary,
      grants: allGrants,
      accounts: accountRows,
      apps: apps?.n ?? 0,
      audit,
    };
  }

  async audit(opts: { page?: number; perPage?: number } = {}) {
    const perPage = Math.min(Math.max(opts.perPage ?? 50, 10), 200);
    const page = Math.max(opts.page ?? 1, 1);
    const db = this.deps.db;
    const [[total], rows] = await Promise.all([
      db.select({ n: count() }).from(adminAuditLog),
      db
        .select({ entry: adminAuditLog, targetEmail: users.email })
        .from(adminAuditLog)
        .leftJoin(users, eq(users.id, adminAuditLog.targetUserId))
        .orderBy(desc(adminAuditLog.createdAt))
        .limit(perPage)
        .offset((page - 1) * perPage),
    ]);
    return {
      rows: rows.map((r) => ({ ...r.entry, targetEmail: r.targetEmail })),
      page,
      pages: Math.max(1, Math.ceil((total?.n ?? 0) / perPage)),
    };
  }

  // --- Changing ----------------------------------------------------------------

  private async log(
    actor: AdminActor,
    action: string,
    target: { userId?: string | undefined; workspaceId?: string | undefined },
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.deps.db.insert(adminAuditLog).values({
      id: newId('adm'),
      actorUserId: actor.userId,
      actorEmail: actor.email,
      action,
      targetUserId: target.userId ?? null,
      targetWorkspaceId: target.workspaceId ?? null,
      details,
      ip: actor.ip ?? null,
    });
  }

  private async workspaceOf(userId: string): Promise<string> {
    const workspace = (await this.deps.users.ownedWorkspaces(userId))[0];
    if (!workspace) throw new AppError(400, 'no_workspace', 'The user has no workspace');
    return workspace.id;
  }

  /** Admins cannot lock out or delete themselves or other admins from the panel (use the CLI). */
  private async assertManageable(actor: AdminActor, userId: string): Promise<UserRow> {
    const user = await this.deps.users.get(userId);
    if (!user) throw notFound('User');
    if (user.id === actor.userId)
      throw new AppError(403, 'self_change', 'You cannot do this to your own account');
    if (user.role === 'admin')
      throw new AppError(403, 'admin_target', 'Other admins are managed with the CLI (users:role)');
    return user;
  }

  async setPlan(
    actor: AdminActor,
    userId: string,
    input: { planId: string; periodEnd: Date | null; note?: string | undefined },
  ): Promise<void> {
    const workspaceId = await this.workspaceOf(userId);
    const current = await this.deps.entitlements.subscription(workspaceId);
    if (BillingService.isPaidByProvider(current)) {
      // The provider keeps charging and its next webhook would undo a manual plan.
      throw new AppError(
        409,
        'paid_subscription',
        `This plan is paid through ${current!.provider}. Change or cancel it there, or add extra limits instead.`,
      );
    }
    const before = this.deps.entitlements.planFor(current).id;
    await this.deps.entitlements.setPlan(workspaceId, input.planId, {
      provider: 'manual',
      periodEnd: input.periodEnd,
      note: input.note ?? null,
    });
    await this.log(
      actor,
      'plan.set',
      { userId, workspaceId },
      {
        from: before,
        to: input.planId,
        until: input.periodEnd?.toISOString() ?? null,
        ...(input.note ? { note: input.note } : {}),
      },
    );
  }

  /** Closes the user's open plan request without changing the plan (e.g. no payment came). */
  async declinePlanRequest(actor: AdminActor, userId: string): Promise<void> {
    const workspaceId = await this.workspaceOf(userId);
    const request = await this.deps.entitlements.openRequest(workspaceId);
    if (!request) return;
    await this.deps.entitlements.closeRequests(workspaceId);
    await this.log(actor, 'plan.request.decline', { userId, workspaceId }, { plan: request.planId });
  }

  async grantLimit(
    actor: AdminActor,
    userId: string,
    input: { metric: string; amount: number | null; expiresAt: Date | null; reason?: string | undefined },
  ): Promise<void> {
    const workspaceId = await this.workspaceOf(userId);
    const grant = await this.deps.entitlements.grant(workspaceId, {
      metric: input.metric,
      amount: input.amount,
      expiresAt: input.expiresAt,
      reason: input.reason ?? null,
      grantedBy: actor.userId,
    });
    await this.log(
      actor,
      'limit.grant',
      { userId, workspaceId },
      {
        grantId: grant.id,
        metric: grant.metric,
        amount: grant.amount,
        until: grant.expiresAt?.toISOString() ?? null,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    );
  }

  async revokeLimit(actor: AdminActor, userId: string, grantId: string): Promise<void> {
    const workspaceId = await this.workspaceOf(userId);
    const grant = await this.deps.entitlements.revokeGrant(workspaceId, grantId);
    await this.log(actor, 'limit.revoke', { userId, workspaceId }, { grantId, metric: grant.metric });
  }

  async suspend(actor: AdminActor, userId: string, reason: string | undefined): Promise<void> {
    await this.assertManageable(actor, userId);
    await this.deps.users.setStatus(userId, 'suspended', reason ?? null);
    await this.log(actor, 'user.suspend', { userId }, reason ? { reason } : {});
  }

  async reactivate(actor: AdminActor, userId: string): Promise<void> {
    await this.assertManageable(actor, userId);
    await this.deps.users.setStatus(userId, 'active');
    await this.log(actor, 'user.reactivate', { userId });
  }

  async signOutEverywhere(actor: AdminActor, userId: string): Promise<void> {
    await this.assertManageable(actor, userId);
    const result = await this.deps.users.revokeAccess(userId);
    await this.log(actor, 'user.sign_out', { userId }, result);
  }

  async deleteUser(actor: AdminActor, userId: string, confirmEmail: string): Promise<void> {
    const user = await this.assertManageable(actor, userId);
    if (confirmEmail.trim().toLowerCase() !== user.email)
      throw new AppError(400, 'confirm_email', 'Type the user’s email to confirm');
    await this.deps.users.delete(userId);
    await this.log(actor, 'user.delete', { userId }, { email: user.email });
  }
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);
