import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { StandingApprovalSpec } from '../connectors/sdk.js';
import type { Principal } from '../core/principal.js';
import type { Db } from '../db/client.js';
import { standingApprovals } from '../db/schema.js';
import type { SecretBox } from '../lib/crypto.js';
import { newId } from '../lib/ids.js';

export type StandingApprovalRow = typeof standingApprovals.$inferSelect;

/** Upper bounds whatever a connector asks for: an approval is for a task, not a permanent rule. */
export const MAX_APPROVAL_MINUTES = 7 * 24 * 60;
export const MAX_APPROVAL_USES = 500;

/** What a covered call is: one action on one account and scope, from one caller. */
export interface ApprovalTarget {
  connectorId: string;
  accountId: string;
  action: string;
  scope: string;
}

export interface StandingApprovalView {
  id: string;
  scope: string;
  actions: string[];
  purpose?: string;
  usesLeft: number;
  expiresAt: Date;
}

/**
 * Who may use an approval: the AI app the user approved it for (all its connections), else the
 * exact connection, else the signed-in user (browser session). Mirrors `PendingCallService.belongsTo`.
 */
export function approvalHolder(principal: Principal): string {
  if (principal.aiClientId) return `ai:${principal.aiClientId}`;
  if (principal.credentialId) return `${principal.kind}:${principal.credentialId}`;
  return `user:${principal.userId}`;
}

/**
 * Series of calls the user approved once (see `ActionDefinition.grants`): e.g. "carry on the
 * conversation with Alex" lets the AI app that started it send in that one chat for a few hours,
 * up to a number of messages, without asking each time. The confirm stage asks this service before
 * asking the user; it never covers what always needs the user, and access rules still apply.
 */
export class StandingApprovals {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
  ) {}

  async grant(
    principal: Principal,
    target: { connectorId: string; accountId: string; grantedBy: string },
    spec: StandingApprovalSpec,
  ): Promise<StandingApprovalView> {
    if (principal.shared) throw new Error('a shared team connection cannot hold standing approvals');
    const id = newId('apr');
    const minutes = Math.min(Math.max(1, Math.round(spec.minutes)), MAX_APPROVAL_MINUTES);
    const maxUses = Math.min(Math.max(1, Math.round(spec.maxUses)), MAX_APPROVAL_USES);
    const holder = approvalHolder(principal);
    // One approval per caller and scope: starting the same conversation again replaces the old one.
    await this.revoke(principal, {
      connectorId: target.connectorId,
      accountId: target.accountId,
      scope: spec.scope,
    });
    const [row] = await this.db
      .insert(standingApprovals)
      .values({
        id,
        workspaceId: principal.workspaceId,
        userId: principal.userId,
        holder,
        connectorId: target.connectorId,
        accountId: target.accountId,
        actions: spec.actions,
        scope: spec.scope,
        grantedBy: target.grantedBy,
        purposeEncrypted: spec.purpose
          ? this.secrets.encryptJson({ purpose: spec.purpose }, `approval:${id}:purpose`)
          : null,
        maxUses,
        expiresAt: new Date(Date.now() + minutes * 60_000),
      })
      .returning();
    return this.view(row!);
  }

  /**
   * Takes one use of an approval that covers this call, atomically. False when none does (none
   * granted, expired, used up, revoked, or held by another caller).
   */
  async use(principal: Principal, target: ApprovalTarget): Promise<StandingApprovalView | undefined> {
    const found = await this.find(principal, target);
    if (!found) return undefined;
    // The guard runs under the row lock, so concurrent calls never take more uses than allowed.
    const [row] = await this.db
      .update(standingApprovals)
      .set({ uses: sql`${standingApprovals.uses} + 1` })
      .where(
        and(
          eq(standingApprovals.id, found.id),
          lt(standingApprovals.uses, standingApprovals.maxUses),
          isNull(standingApprovals.revokedAt),
          gt(standingApprovals.expiresAt, new Date()),
        ),
      )
      .returning();
    return row ? this.view(row) : undefined;
  }

  /** The approval that would cover this call, without using it (for status in results). */
  async find(principal: Principal, target: ApprovalTarget): Promise<StandingApprovalView | undefined> {
    if (principal.shared) return undefined;
    const [row] = await this.db
      .select()
      .from(standingApprovals)
      .where(this.covering(principal, target))
      .orderBy(desc(standingApprovals.createdAt))
      .limit(1);
    return row ? this.view(row) : undefined;
  }

  /** Ends this caller's approvals for one scope of an account. */
  async revoke(
    principal: Principal,
    target: { connectorId: string; accountId: string; scope: string },
  ): Promise<number> {
    const rows = await this.db
      .update(standingApprovals)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(standingApprovals.workspaceId, principal.workspaceId),
          eq(standingApprovals.userId, principal.userId),
          eq(standingApprovals.holder, approvalHolder(principal)),
          eq(standingApprovals.connectorId, target.connectorId),
          eq(standingApprovals.accountId, target.accountId),
          eq(standingApprovals.scope, target.scope),
          isNull(standingApprovals.revokedAt),
          gt(standingApprovals.expiresAt, new Date()),
        ),
      )
      .returning({ id: standingApprovals.id });
    return rows.length;
  }

  /** Active approvals of a workspace, newest first (the panel and the setup tools show them). */
  async listActive(workspaceId: string): Promise<(StandingApprovalView & StandingApprovalRow)[]> {
    const rows = await this.db
      .select()
      .from(standingApprovals)
      .where(
        and(
          eq(standingApprovals.workspaceId, workspaceId),
          isNull(standingApprovals.revokedAt),
          gt(standingApprovals.expiresAt, new Date()),
          lt(standingApprovals.uses, standingApprovals.maxUses),
        ),
      )
      .orderBy(desc(standingApprovals.createdAt));
    return rows.map((row) => ({ ...row, ...this.view(row) }));
  }

  /** Ends one approval of a workspace (the user stops it from the panel). */
  async revokeById(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .update(standingApprovals)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(standingApprovals.workspaceId, workspaceId),
          eq(standingApprovals.id, id),
          isNull(standingApprovals.revokedAt),
        ),
      )
      .returning({ id: standingApprovals.id });
    return rows.length > 0;
  }

  /** Deletes approvals that ended more than a day ago. */
  async prune(): Promise<void> {
    const before = new Date(Date.now() - 86_400_000);
    await this.db
      .delete(standingApprovals)
      .where(or(lt(standingApprovals.expiresAt, before), lt(standingApprovals.revokedAt, before)));
  }

  private covering(principal: Principal, target: ApprovalTarget) {
    return and(
      eq(standingApprovals.workspaceId, principal.workspaceId),
      eq(standingApprovals.userId, principal.userId),
      eq(standingApprovals.holder, approvalHolder(principal)),
      eq(standingApprovals.connectorId, target.connectorId),
      eq(standingApprovals.accountId, target.accountId),
      eq(standingApprovals.scope, target.scope),
      sql`${target.action} = any(${standingApprovals.actions})`,
      isNull(standingApprovals.revokedAt),
      gt(standingApprovals.expiresAt, new Date()),
      lt(standingApprovals.uses, standingApprovals.maxUses),
    );
  }

  private view(row: StandingApprovalRow): StandingApprovalView {
    const purpose = row.purposeEncrypted
      ? this.secrets.decryptJson<{ purpose: string }>(row.purposeEncrypted, `approval:${row.id}:purpose`)
          .purpose
      : undefined;
    return {
      id: row.id,
      scope: row.scope,
      actions: row.actions,
      ...(purpose ? { purpose } : {}),
      usesLeft: Math.max(0, row.maxUses - row.uses),
      expiresAt: row.expiresAt,
    };
  }
}
