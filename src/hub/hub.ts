import { and, desc, eq, lt } from 'drizzle-orm';
import type { ConnectorResolver } from '../connectors/registry.js';
import { ACCOUNT_ARGUMENT } from '../connectors/registry.js';
import { ConnectorError, type ContentBlock, isRawResult } from '../connectors/sdk.js';
import type { AccountService } from '../core/accounts.js';
import { getWorkspace } from '../core/identity.js';
import type { Principal } from '../core/principal.js';
import type { Db } from '../db/client.js';
import { toolCalls } from '../db/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import type { Logger } from '../logger.js';
import { buildCatalog, type Catalog, type CatalogTool, describeAccount } from './catalog.js';

/** Result in MCP CallToolResult shape (kept local so the hub core does not depend on the MCP SDK). */
export interface ToolCallResult {
  [key: string]: unknown;
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const errorResult = (message: string): ToolCallResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

function normalizeResult(value: unknown): ToolCallResult {
  if (isRawResult(value)) {
    const { content, structuredContent, isError } = value;
    return { content, ...(structuredContent ? { structuredContent } : {}), ...(isError ? { isError } : {}) };
  }
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
  if (value === undefined) return { content: [{ type: 'text', text: 'Done.' }] };
  const text = JSON.stringify(value, null, 2);
  const structured =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { structuredContent: value as Record<string, unknown> }
      : {};
  return { content: [{ type: 'text', text }], ...structured };
}

class ToolTimeoutError extends Error {}

interface CallState {
  /** The account the call was routed to, once known. */
  accountId: string | null;
}

/**
 * The hub core: builds the catalog for a workspace and executes tool calls against connectors,
 * routing each call to the right account. Transport-agnostic (used by MCP and the REST API).
 */
export class Hub {
  constructor(
    private readonly deps: {
      db: Db;
      connectors: ConnectorResolver;
      accounts: AccountService;
      logger: Logger;
      toolTimeoutMs: number;
    },
  ) {}

  async getCatalog(workspaceId: string): Promise<Catalog> {
    const [workspace, connectors, accounts] = await Promise.all([
      getWorkspace(this.deps.db, workspaceId),
      this.deps.connectors.list(workspaceId),
      this.deps.accounts.list(workspaceId),
    ]);
    if (!workspace) throw notFound('Workspace');
    return buildCatalog({ connectors, accounts, mode: workspace.settings.toolExposure ?? 'grouped' });
  }

  /** Executes a tool by name. Never throws for tool-level failures: they become `isError` results. */
  async callTool(
    principal: Principal,
    catalog: Catalog,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ToolCallResult> {
    const tool = catalog.tools.find((t) => t.name === toolName);
    if (!tool) return errorResult(`Unknown tool "${toolName}".`);
    const started = Date.now();
    const state: CallState = { accountId: null };
    let result: ToolCallResult;
    try {
      result =
        tool.target.kind === 'builtin'
          ? this.runBuiltin(catalog, args)
          : await this.runAction(principal, tool, args, signal, state);
    } catch (error) {
      result = await this.handleError(error, tool, state);
    }
    await this.audit(principal, tool, state.accountId, result, Date.now() - started);
    return result;
  }

  private runBuiltin(catalog: Catalog, args: Record<string, unknown>): ToolCallResult {
    const filter = typeof args.service === 'string' ? args.service.trim().toLowerCase() : undefined;
    const services = catalog.services
      .filter(
        ({ connector }) => !filter || connector.id === filter || connector.name.toLowerCase() === filter,
      )
      .map(({ connector, accounts }) => ({
        service: connector.id,
        name: connector.name,
        description: connector.description,
        accounts: accounts.map((a) => ({
          name: a.name,
          label: a.label,
          description: a.description ?? undefined,
          identity: typeof a.metadata.identity === 'string' ? a.metadata.identity : undefined,
          enabled: a.enabled,
          status: a.enabled ? a.status : 'disabled',
          statusMessage: a.statusMessage ?? undefined,
        })),
        tools: catalog.tools
          .filter((t) => t.target.kind === 'action' && t.target.connectorId === connector.id)
          .map((t) => t.name),
      }));
    return normalizeResult({
      exposure: catalog.mode,
      services,
      ...(services.length === 0
        ? { hint: filter ? `No service "${filter}" is connected.` : 'No services are connected yet.' }
        : {}),
    });
  }

  private async runAction(
    principal: Principal,
    tool: CatalogTool,
    rawArgs: Record<string, unknown>,
    signal: AbortSignal,
    state: CallState,
  ): Promise<ToolCallResult> {
    if (tool.target.kind !== 'action') throw new Error('not an action tool');
    const { connectorId, action: actionName, accounts, accountArgument } = tool.target;
    const { [ACCOUNT_ARGUMENT]: requestedAccount, ...args } = rawArgs;

    // 1. Pick the account.
    let account = accounts[0];
    if (accountArgument) {
      if (requestedAccount === undefined || requestedAccount === null || requestedAccount === '') {
        if (accounts.length > 1) {
          return errorResult(
            `Several accounts are connected; pass "${ACCOUNT_ARGUMENT}" with one of: ${accounts.map(describeAccount).join('; ')}.`,
          );
        }
      } else {
        account = accounts.find((a) => a.name === requestedAccount);
        if (!account) {
          return errorResult(
            `Unknown account "${String(requestedAccount)}". Available: ${accounts.map(describeAccount).join('; ')}.`,
          );
        }
      }
    }
    if (!account) return errorResult('No account is available for this tool.');
    state.accountId = account.id;

    // 2. Resolve connector + action and validate input with the connector's own schema.
    const connector = await this.deps.connectors.get(principal.workspaceId, connectorId);
    const action = connector?.actions.find((a) => a.name === actionName);
    if (!connector || !action) return errorResult('This tool is no longer available.');
    const parsed = action.input.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
        .join('; ');
      return errorResult(`Invalid arguments: ${issues}`);
    }

    // 3. Load the current account state (it may have been disabled since the catalog was built).
    const row = await this.deps.accounts.get(principal.workspaceId, account.id).catch(() => undefined);
    if (!row?.enabled) {
      return errorResult(`Account "${account.name}" is disabled or was removed.`);
    }

    // 4. Run with a timeout, honouring client cancellation.
    const timeout = AbortSignal.timeout(this.deps.toolTimeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const logger = this.deps.logger.child({
      connector: connectorId,
      action: actionName,
      account: account.id,
    });
    const ctx = await this.deps.accounts.buildContext(connector, row, { signal: combined, logger });
    const value = await new Promise<unknown>((resolve, reject) => {
      const onAbort = () =>
        reject(
          timeout.aborted ? new ToolTimeoutError() : new ConnectorError('upstream', 'The call was cancelled'),
        );
      if (combined.aborted) return onAbort();
      combined.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(() => action.run(parsed.data, ctx))
        .then(resolve, reject)
        .finally(() => combined.removeEventListener('abort', onAbort));
    });

    await this.deps.accounts.touch(account.id).catch(() => {});
    if (row.status !== 'active')
      await this.deps.accounts.markStatus(account.id, 'active', null).catch(() => {});
    return normalizeResult(value);
  }

  private async handleError(error: unknown, tool: CatalogTool, state: CallState): Promise<ToolCallResult> {
    if (error instanceof ToolTimeoutError) {
      return errorResult(`The call timed out after ${Math.round(this.deps.toolTimeoutMs / 1000)} seconds.`);
    }
    if (error instanceof ConnectorError) {
      if (error.kind === 'auth') {
        // Flag the account so the user sees in the panel that it must be reconnected.
        if (state.accountId) {
          await this.deps.accounts.markStatus(state.accountId, 'needs_reauth', error.message).catch(() => {});
        }
        return errorResult(
          `Authorization with the service failed: ${error.message}. The user needs to reconnect this account.`,
        );
      }
      const retry = error.options.retryAfterSeconds
        ? ` Retry after ${error.options.retryAfterSeconds} s.`
        : '';
      return errorResult(`${error.message}${retry}`);
    }
    if (error instanceof AppError) return errorResult(error.message);
    const ref = Math.random().toString(36).slice(2, 10);
    this.deps.logger.error({ err: error, tool: tool.name, ref }, 'tool call failed');
    return errorResult(`Internal error while running ${tool.name} (ref ${ref}).`);
  }

  private async audit(
    principal: Principal,
    tool: CatalogTool,
    accountId: string | null,
    result: ToolCallResult,
    durationMs: number,
  ): Promise<void> {
    const firstText = result.content.find((c) => c.type === 'text');
    try {
      await this.deps.db.insert(toolCalls).values({
        workspaceId: principal.workspaceId,
        accountId,
        connectorId: tool.target.kind === 'action' ? tool.target.connectorId : null,
        action: tool.target.kind === 'action' ? tool.target.action : tool.target.id,
        toolName: tool.name,
        principalType: principal.kind,
        principalId: principal.credentialId ?? null,
        clientId: principal.clientId ?? null,
        status: result.isError ? 'error' : 'ok',
        errorMessage: result.isError && firstText?.type === 'text' ? firstText.text.slice(0, 1000) : null,
        durationMs,
      });
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'failed to record tool call');
    }
  }

  async recentToolCalls(workspaceId: string, options: { limit?: number; before?: number } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    return this.deps.db
      .select()
      .from(toolCalls)
      .where(
        options.before
          ? and(eq(toolCalls.workspaceId, workspaceId), lt(toolCalls.id, options.before))
          : eq(toolCalls.workspaceId, workspaceId),
      )
      .orderBy(desc(toolCalls.id))
      .limit(limit);
  }
}
