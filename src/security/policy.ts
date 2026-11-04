import type { AccessLevel, ConfirmLevel, RiskLevel, SecuritySettings } from '../db/schema.js';

/**
 * The access policy as a pure function: (rules, persona, caller, target, risk) → decision.
 * No I/O, so it is exhaustively unit-tested and shared by the catalog (what the AI sees) and the
 * executor (what actually runs).
 *
 * Model: "client × account × risk".
 * - Subject: an AI client and/or a persona (a rule without them applies to everyone).
 * - Scope: one account, a whole service (connector), or everything.
 * - Effect: `access` (highest allowed risk), `confirm` (from which risk the user must confirm),
 *   `undoWindowSeconds` (delay before a changing action runs, so it can be cancelled).
 *
 * Every field is resolved on its own: the most specific matching rule that sets it wins.
 * Scope specificity dominates subject specificity (an account rule beats a client-wide one); on a
 * tie the more restrictive value wins. Unset everywhere → workspace defaults.
 */

export type { AccessLevel, ConfirmLevel, RiskLevel };

export const RISK_ORDER: Record<RiskLevel, number> = { read: 1, write: 2, dangerous: 3 };
const ACCESS_ORDER: Record<AccessLevel, number> = { none: 0, read: 1, write: 2, full: 3 };
/** Lowest risk that needs confirmation (4 = never). */
const CONFIRM_FROM: Record<ConfirmLevel, number> = { always: 0, write: 2, dangerous: 3, never: 4 };

export const ACCESS_LEVELS = ['none', 'read', 'write', 'full'] as const satisfies readonly AccessLevel[];
export const CONFIRM_LEVELS = [
  'never',
  'dangerous',
  'write',
  'always',
] as const satisfies readonly ConfirmLevel[];

export const DEFAULT_SECURITY: Required<SecuritySettings> = {
  defaultAccess: 'full',
  defaultConfirm: 'dangerous',
  undoWindowSeconds: 0,
};

export interface PolicyRule {
  id: string;
  aiClientId: string | null;
  personaId: string | null;
  connectorId: string | null;
  accountId: string | null;
  access: AccessLevel | null;
  confirm: ConfirmLevel | null;
  undoWindowSeconds: number | null;
}

export interface PolicyPersona {
  id: string;
  accountIds: string[];
  maxAccess: AccessLevel;
}

export interface PolicySubject {
  aiClientId?: string | undefined;
  /** The persona of the MCP URL the call came through, if any. */
  persona?: PolicyPersona | undefined;
}

export interface PolicyTarget {
  connectorId: string;
  accountId: string;
}

export interface PolicyDecision {
  allowed: boolean;
  /** Effective access level for this subject on this account. */
  access: AccessLevel;
  /** The call must be confirmed by the user before it runs. */
  confirm: boolean;
  undoWindowSeconds: number;
  /** Machine-readable reason when not allowed. */
  reason?: 'persona' | 'access';
  /** Rules that decided each field (for the audit log and the panel). */
  ruleIds: string[];
}

function specificity(rule: PolicyRule): number {
  const scope = rule.accountId ? 2 : rule.connectorId ? 1 : 0;
  const subject = (rule.aiClientId ? 2 : 0) + (rule.personaId ? 1 : 0);
  return scope * 10 + subject;
}

function matches(rule: PolicyRule, subject: PolicySubject, target: PolicyTarget): boolean {
  if (rule.aiClientId && rule.aiClientId !== subject.aiClientId) return false;
  if (rule.personaId && rule.personaId !== subject.persona?.id) return false;
  if (rule.accountId && rule.accountId !== target.accountId) return false;
  if (rule.connectorId && rule.connectorId !== target.connectorId) return false;
  return true;
}

/** Picks the value of one field: highest specificity, then most restrictive. */
function resolve<T>(
  rules: { rule: PolicyRule; score: number }[],
  field: (rule: PolicyRule) => T | null,
  restrictiveness: (value: T) => number,
): { value: T; ruleId: string } | undefined {
  let best: { value: T; ruleId: string; score: number } | undefined;
  for (const { rule, score } of rules) {
    const value = field(rule);
    if (value === null || value === undefined) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score && restrictiveness(value) > restrictiveness(best.value))
    ) {
      best = { value, ruleId: rule.id, score };
    }
  }
  return best && { value: best.value, ruleId: best.ruleId };
}

/** The effective settings for a subject on one account, before looking at a concrete action. */
export function accountPolicy(
  rules: readonly PolicyRule[],
  subject: PolicySubject,
  target: PolicyTarget,
  settings: SecuritySettings = {},
): Omit<PolicyDecision, 'allowed' | 'confirm'> & { confirmLevel: ConfirmLevel } {
  const defaults = { ...DEFAULT_SECURITY, ...settings };
  if (subject.persona && !subject.persona.accountIds.includes(target.accountId)) {
    return {
      access: 'none',
      confirmLevel: defaults.defaultConfirm,
      undoWindowSeconds: 0,
      reason: 'persona',
      ruleIds: [],
    };
  }
  const applicable = rules
    .filter((rule) => matches(rule, subject, target))
    .map((rule) => ({ rule, score: specificity(rule) }));
  const access = resolve(
    applicable,
    (r) => r.access,
    (v) => 3 - ACCESS_ORDER[v],
  );
  const confirm = resolve(
    applicable,
    (r) => r.confirm,
    (v) => 4 - CONFIRM_FROM[v],
  );
  const undo = resolve(
    applicable,
    (r) => r.undoWindowSeconds,
    (v) => v,
  );
  let level = access?.value ?? defaults.defaultAccess;
  const cap = subject.persona?.maxAccess;
  if (cap && ACCESS_ORDER[cap] < ACCESS_ORDER[level]) level = cap;
  return {
    access: level,
    confirmLevel: confirm?.value ?? defaults.defaultConfirm,
    undoWindowSeconds: Math.max(0, undo?.value ?? defaults.undoWindowSeconds),
    ...(level === 'none' ? { reason: 'access' as const } : {}),
    ruleIds: [...new Set([access?.ruleId, confirm?.ruleId, undo?.ruleId].filter((id) => id !== undefined))],
  };
}

/** Whether an access level permits an action of the given risk. */
export function accessAllows(access: AccessLevel, risk: RiskLevel): boolean {
  return ACCESS_ORDER[access] >= RISK_ORDER[risk];
}

/** Whether a confirmation level requires confirming an action of the given risk. */
export function confirmationRequired(level: ConfirmLevel, risk: RiskLevel): boolean {
  return RISK_ORDER[risk] >= CONFIRM_FROM[level];
}

export function evaluatePolicy(
  rules: readonly PolicyRule[],
  subject: PolicySubject,
  target: PolicyTarget,
  risk: RiskLevel,
  settings: SecuritySettings = {},
): PolicyDecision {
  const base = accountPolicy(rules, subject, target, settings);
  const allowed = accessAllows(base.access, risk);
  return {
    allowed,
    access: base.access,
    confirm: allowed && confirmationRequired(base.confirmLevel, risk),
    // The undo window only delays actions that change something.
    undoWindowSeconds: allowed && risk !== 'read' ? base.undoWindowSeconds : 0,
    ...(allowed ? {} : { reason: base.reason ?? 'access' }),
    ruleIds: base.ruleIds,
  };
}
