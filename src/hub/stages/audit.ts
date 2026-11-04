import type { RiskLevel } from '../../connectors/sdk.js';
import type { Principal } from '../../core/principal.js';
import type { Db } from '../../db/client.js';
import { toolCalls } from '../../db/schema.js';
import type { Logger } from '../../logger.js';
import type { Middleware } from '../executor.js';
import { type ExecResult, resultText } from '../result.js';

export interface AuditEntry {
  principal: Principal;
  toolName: string;
  connectorId: string | null;
  action: string;
  accountId: string | null;
  risk: RiskLevel | null;
  outcome?: string | undefined;
  result: ExecResult;
  durationMs: number;
}

/** Writes one audit row. Arguments and results are never stored, only an error message. */
export async function recordToolCall(db: Db, logger: Logger, entry: AuditEntry): Promise<void> {
  const failed = entry.result.isError === true;
  try {
    await db.insert(toolCalls).values({
      workspaceId: entry.principal.workspaceId,
      accountId: entry.accountId,
      connectorId: entry.connectorId,
      action: entry.action,
      toolName: entry.toolName,
      principalType: entry.principal.kind,
      principalId: entry.principal.credentialId ?? null,
      clientId: entry.principal.clientId ?? null,
      status: failed ? 'error' : 'ok',
      outcome: entry.outcome ?? (failed ? (entry.result.error?.kind ?? 'error') : null),
      risk: entry.risk,
      errorMessage: failed ? resultText(entry.result).slice(0, 1000) : null,
      durationMs: entry.durationMs,
    });
  } catch (error) {
    logger.warn({ err: error }, 'failed to record tool call');
  }
}

/** Outermost stage: every unit is recorded, including denials and deduplicated calls. */
export function auditStage(deps: { db: Db; logger: Logger }): Middleware {
  return async (call, next) => {
    const result = await next();
    await recordToolCall(deps.db, deps.logger, {
      principal: call.principal,
      toolName: call.tool.name,
      connectorId: call.connector.id,
      action: call.action.name,
      accountId: call.account.id,
      risk: call.risk,
      outcome: call.audit.outcome,
      result,
      durationMs: Date.now() - call.startedAt,
    });
    return result;
  };
}
