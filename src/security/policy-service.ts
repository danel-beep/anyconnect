import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Principal } from '../core/principal.js';
import type { Db } from '../db/client.js';
import { accessRules, accounts, aiClients, personas, type RiskLevel, workspaces } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import {
  ACCESS_LEVELS,
  accountPolicy,
  CONFIRM_LEVELS,
  evaluatePolicy,
  type PolicyDecision,
  type PolicyPersona,
  type PolicyRule,
  type PolicySubject,
} from './policy.js';

export type AccessRuleRow = typeof accessRules.$inferSelect;

export const AccessRuleInput = z
  .object({
    aiClientId: z.string().nullable().optional(),
    personaId: z.string().nullable().optional(),
    connectorId: z.string().nullable().optional(),
    accountId: z.string().nullable().optional(),
    access: z.enum(ACCESS_LEVELS).nullable().optional(),
    confirm: z.enum(CONFIRM_LEVELS).nullable().optional(),
    undoWindowSeconds: z.number().int().min(0).max(3600).nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .refine((r) => r.access != null || r.confirm != null || r.undoWindowSeconds != null, {
    message: 'set at least one of access, confirm, undoWindowSeconds',
  });
export type AccessRuleInput = z.input<typeof AccessRuleInput>;

export function toRuleView(row: AccessRuleRow) {
  return {
    id: row.id,
    aiClientId: row.aiClientId,
    personaId: row.personaId,
    connectorId: row.connectorId,
    accountId: row.accountId,
    access: row.access,
    confirm: row.confirm,
    undoWindowSeconds: row.undoWindowSeconds,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The policy of one caller, loaded once per request and asked per (account, action). */
export class CallerPolicy {
  constructor(
    private readonly rules: PolicyRule[],
    readonly subject: PolicySubject,
    private readonly settings: NonNullable<typeof workspaces.$inferSelect.settings.security>,
  ) {}

  /** Can the caller see this account at all (any risk)? */
  seesAccount(target: { connectorId: string; accountId: string }): boolean {
    return accountPolicy(this.rules, this.subject, target, this.settings).access !== 'none';
  }

  decide(target: { connectorId: string; accountId: string }, risk: RiskLevel): PolicyDecision {
    return evaluatePolicy(this.rules, this.subject, target, risk, this.settings);
  }
}

/** Storage and loading of access rules; the decision logic itself is the pure `policy.ts`. */
export class PolicyService {
  constructor(private readonly db: Db) {}

  async forPrincipal(principal: Principal): Promise<CallerPolicy> {
    const [rules, [workspace], persona] = await Promise.all([
      this.db.select().from(accessRules).where(eq(accessRules.workspaceId, principal.workspaceId)),
      this.db
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, principal.workspaceId))
        .limit(1),
      principal.personaId ? this.loadPersona(principal.workspaceId, principal.personaId) : undefined,
    ]);
    if (principal.personaId && !persona) {
      // The persona was deleted while the token was still alive: see nothing.
      return new CallerPolicy(
        [],
        {
          aiClientId: principal.aiClientId,
          persona: { id: principal.personaId, accountIds: [], maxAccess: 'none' },
        },
        {},
      );
    }
    return new CallerPolicy(
      rules,
      { aiClientId: principal.aiClientId, persona },
      workspace?.settings.security ?? {},
    );
  }

  private async loadPersona(workspaceId: string, id: string): Promise<PolicyPersona | undefined> {
    const [row] = await this.db
      .select({ id: personas.id, accountIds: personas.accountIds, maxAccess: personas.maxAccess })
      .from(personas)
      .where(and(eq(personas.workspaceId, workspaceId), eq(personas.id, id)))
      .limit(1);
    return row;
  }

  async listRules(workspaceId: string): Promise<AccessRuleRow[]> {
    return this.db
      .select()
      .from(accessRules)
      .where(eq(accessRules.workspaceId, workspaceId))
      .orderBy(asc(accessRules.createdAt));
  }

  private async checkReferences(workspaceId: string, input: z.output<typeof AccessRuleInput>) {
    const checks: Promise<void>[] = [];
    const exists = async (
      table: typeof aiClients | typeof personas | typeof accounts,
      id: string,
      what: string,
    ) => {
      const [row] = await this.db
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.workspaceId, workspaceId), eq(table.id, id)))
        .limit(1);
      if (!row) throw badRequest(`Unknown ${what} "${id}"`);
    };
    if (input.aiClientId) checks.push(exists(aiClients, input.aiClientId, 'AI client'));
    if (input.personaId) checks.push(exists(personas, input.personaId, 'persona'));
    if (input.accountId) checks.push(exists(accounts, input.accountId, 'account'));
    await Promise.all(checks);
  }

  private parse(raw: unknown) {
    const result = AccessRuleInput.safeParse(raw ?? {});
    if (!result.success) {
      throw badRequest(
        'Invalid access rule',
        result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return result.data;
  }

  async createRule(workspaceId: string, raw: AccessRuleInput): Promise<AccessRuleRow> {
    const input = this.parse(raw);
    await this.checkReferences(workspaceId, input);
    const [row] = await this.db
      .insert(accessRules)
      .values({
        id: newId('rul'),
        workspaceId,
        aiClientId: input.aiClientId ?? null,
        personaId: input.personaId ?? null,
        connectorId: input.connectorId ?? null,
        accountId: input.accountId ?? null,
        access: input.access ?? null,
        confirm: input.confirm ?? null,
        undoWindowSeconds: input.undoWindowSeconds ?? null,
        note: input.note ?? null,
      })
      .returning();
    return row!;
  }

  async updateRule(workspaceId: string, id: string, raw: AccessRuleInput): Promise<AccessRuleRow> {
    const input = this.parse(raw);
    await this.checkReferences(workspaceId, input);
    const [row] = await this.db
      .update(accessRules)
      .set({
        aiClientId: input.aiClientId ?? null,
        personaId: input.personaId ?? null,
        connectorId: input.connectorId ?? null,
        accountId: input.accountId ?? null,
        access: input.access ?? null,
        confirm: input.confirm ?? null,
        undoWindowSeconds: input.undoWindowSeconds ?? null,
        note: input.note ?? null,
      })
      .where(and(eq(accessRules.workspaceId, workspaceId), eq(accessRules.id, id)))
      .returning();
    if (!row) throw notFound('Access rule');
    return row;
  }

  async deleteRule(workspaceId: string, id: string): Promise<void> {
    const deleted = await this.db
      .delete(accessRules)
      .where(and(eq(accessRules.workspaceId, workspaceId), eq(accessRules.id, id)))
      .returning({ id: accessRules.id });
    if (deleted.length === 0) throw notFound('Access rule');
  }
}
