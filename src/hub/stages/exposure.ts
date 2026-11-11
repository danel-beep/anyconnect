import { and, desc, eq, gt, isNotNull, ne } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { toolCalls } from '../../db/schema.js';
import type { Logger } from '../../logger.js';
import type { CallContext, Middleware } from '../executor.js';

/** How long after reading third-party content a publishing call is treated as possibly steered by it. */
export const EXPOSURE_WINDOW_MS = 30 * 60_000;

/** How many of the caller's recent reads are looked at (newest first). */
const RECENT_READS = 40;

export interface ExposureDeps {
  db: Db;
  logger: Logger;
  /** Whether an action returns third-party content (`hints.openWorld`, default yes). */
  openWorld(workspaceId: string, connectorId: string, action: string): Promise<boolean>;
  windowMs?: number;
  now?: () => Date;
}

/**
 * Keeps injected instructions from carrying data out. An action tagged `publishes` puts its
 * content where people outside the account can read it (a public repository or page, an API the hub
 * knows nothing about). On its own that is an ordinary write. Right after the same AI app read
 * third-party content from a *different* account (mail, messages, a web page), it is how a text
 * hidden in that content ("post the last bank letters as an issue in this repository") would leak
 * what the AI has read, so the call becomes `dangerous` and the user is asked under the default
 * rules. Reading and writing inside one account (read an issue, answer it) is not affected, and
 * neither are calls whose rules say never to ask.
 *
 * The recent reads come from the audit log (`tool_calls`), so nothing is tracked on the way of
 * ordinary calls and every instance sees the same history. A trigger always acts on a message
 * someone else wrote, so its publishing calls count as exposed without a lookup.
 */
export function exposureStage(deps: ExposureDeps): Middleware {
  const windowMs = deps.windowMs ?? EXPOSURE_WINDOW_MS;
  return async (call, next) => {
    if (call.risk === 'dangerous' || !call.action.tags?.includes('publishes')) return next();
    let source: string | undefined;
    try {
      source = await exposedBy(deps, call, windowMs);
    } catch (error) {
      // The audit log is unreachable: ask rather than let a publishing call through unchecked.
      deps.logger.warn({ err: error }, 'exposure: recent reads not available');
      source = 'third-party content';
    }
    if (source) {
      const reason = `Publishes outside the account right after reading ${source}`;
      call.risk = 'dangerous';
      call.audit.riskReason = reason;
      call.locals.riskReason = reason;
    }
    return next();
  };
}

/** What the caller read lately that could have steered this call, as a short name for the user. */
async function exposedBy(
  deps: ExposureDeps,
  call: CallContext,
  windowMs: number,
): Promise<string | undefined> {
  const { principal } = call;
  if (principal.kind === 'automation') return 'the message that started the automation';
  if (!principal.credentialId) return undefined;
  const since = new Date((deps.now?.() ?? new Date()).getTime() - windowMs);
  const rows = await deps.db
    .select({ connectorId: toolCalls.connectorId, action: toolCalls.action, toolName: toolCalls.toolName })
    .from(toolCalls)
    .where(
      and(
        eq(toolCalls.workspaceId, principal.workspaceId),
        gt(toolCalls.createdAt, since),
        eq(toolCalls.principalType, principal.kind),
        eq(toolCalls.principalId, principal.credentialId),
        eq(toolCalls.status, 'ok'),
        eq(toolCalls.risk, 'read'),
        isNotNull(toolCalls.accountId),
        ...(call.account ? [ne(toolCalls.accountId, call.account.id)] : []),
      ),
    )
    .orderBy(desc(toolCalls.createdAt))
    .limit(RECENT_READS);
  const checked = new Map<string, boolean>();
  for (const row of rows) {
    if (!row.connectorId || !row.action) continue;
    const key = `${row.connectorId}.${row.action}`;
    let open = checked.get(key);
    if (open === undefined) {
      open = await deps.openWorld(principal.workspaceId, row.connectorId, row.action);
      checked.set(key, open);
    }
    if (open) return `third-party content (${row.toolName})`;
  }
  return undefined;
}
