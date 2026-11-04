import { and, desc, eq, lt } from 'drizzle-orm';
import type { ConnectorResolver } from '../connectors/registry.js';
import { ACCOUNT_ARGUMENT, FIELDS_ARGUMENT } from '../connectors/registry.js';
import {
  actionCapabilities,
  actionIdempotent,
  actionRisk,
  type ConnectorDefinition,
  ConnectorError,
} from '../connectors/sdk.js';
import type { AccountService } from '../core/accounts.js';
import { getWorkspace } from '../core/identity.js';
import type { Principal } from '../core/principal.js';
import type { Db } from '../db/client.js';
import { toolCalls } from '../db/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import type { RateLimiter } from '../lib/rate-limit.js';
import type { Logger } from '../logger.js';
import {
  buildCatalog,
  type Catalog,
  type CatalogAccount,
  type CatalogAllow,
  type CatalogTool,
  describeAccount,
} from './catalog.js';
import { type CallContext, Executor, type Interaction, type StageMap } from './executor.js';
import type { IdempotencyStore } from './idempotency.js';
import { type ExecResult, errorResult, normalizeResult, type ToolCallResult, toTransport } from './result.js';
import { defaultStages, recordToolCall } from './stages/index.js';

export type { ToolCallResult } from './result.js';

class ToolTimeoutError extends Error {}

const isTimeout = (reason: unknown) => reason instanceof DOMException && reason.name === 'TimeoutError';

export interface HubDeps {
  db: Db;
  connectors: ConnectorResolver;
  accounts: AccountService;
  logger: Logger;
  rateLimiter: RateLimiter;
  idempotency: IdempotencyStore;
  toolTimeoutMs: number;
  /** Result size budget in tokens (default for actions that do not set their own). */
  maxResultTokens: number;
  /** How long a successful non-idempotent write is remembered to suppress duplicates. */
  idempotencyWindowMs: number;
  /** Replaces built-in stages or fills the policy / confirm / untrusted slots. */
  stages?: StageMap;
  /** Per-caller catalog filter (policy, personas). */
  catalogFilter?: (principal: Principal) => Promise<CatalogAllow | undefined> | CatalogAllow | undefined;
}

export interface CallOptions {
  /** Aborted when the client cancels the request. */
  signal?: AbortSignal;
  /** Answers to hub questions, when the transport supports asking (MCP elicitation). */
  interaction?: Interaction;
}

/**
 * The hub core: builds the catalog for a caller and executes tool calls against connectors,
 * routing each call to the right account. Transport-agnostic (used by MCP, the REST API and the
 * CLI). All connector calls go through the {@link Executor} chain.
 */
export class Hub {
  readonly executor: Executor;

  constructor(private readonly deps: HubDeps) {
    this.executor = new Executor(
      {
        ...defaultStages({
          db: deps.db,
          logger: deps.logger,
          rateLimiter: deps.rateLimiter,
          idempotency: deps.idempotency,
          idempotencyWindowMs: deps.idempotencyWindowMs,
          maxResultTokens: deps.maxResultTokens,
        }),
        ...deps.stages,
      },
      (call) => this.invoke(call),
    );
  }

  async getCatalog(principal: Principal): Promise<Catalog> {
    const { workspaceId } = principal;
    const [workspace, connectors, accounts, allow] = await Promise.all([
      getWorkspace(this.deps.db, workspaceId),
      this.deps.connectors.list(workspaceId),
      this.deps.accounts.list(workspaceId),
      this.deps.catalogFilter?.(principal),
    ]);
    if (!workspace) throw notFound('Workspace');
    return buildCatalog({
      connectors,
      accounts,
      mode: workspace.settings.toolExposure ?? 'grouped',
      ...(allow ? { allow } : {}),
    });
  }

  /** Executes a tool by name. Never throws for tool-level failures: they become `isError` results. */
  async callTool(
    principal: Principal,
    catalog: Catalog,
    toolName: string,
    args: Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<ToolCallResult> {
    const signal = options.signal ?? new AbortController().signal;
    const tool = catalog.tools.find((t) => t.name === toolName);
    if (!tool) return toTransport(errorResult(`Unknown tool "${toolName}".`));
    const started = Date.now();
    if (tool.target.kind === 'builtin') {
      const result = this.runBuiltin(catalog, args);
      await this.auditHubCall(principal, tool, null, result, started);
      return toTransport(result);
    }
    let result: ExecResult;
    let accountId: string | null = null;
    try {
      const prepared = await this.prepare(principal, catalog, tool, args, signal, options.interaction);
      if ('error' in prepared) {
        result = prepared.error;
        accountId = prepared.accountId;
      } else {
        result = await this.executor.execute(prepared.call);
        return toTransport(result);
      }
    } catch (error) {
      result = this.toErrorResult(error, tool.name);
    }
    // Calls rejected before reaching the executor (bad account, invalid input) are audited here.
    await this.auditHubCall(principal, tool, accountId, result, started);
    return toTransport(result);
  }

  /**
   * Runs a call the user already approved out of band (Telegram, web page) as its original caller.
   * The call goes through the whole chain again: if the caller lost access meanwhile, it is denied;
   * `preApproved` only lets it pass the confirmation stage.
   */
  async runApproved(
    principal: Principal,
    target: { toolName: string; connectorId: string; action: string; accountId: string },
    args: Record<string, unknown>,
  ): Promise<ExecResult> {
    try {
      const catalog = await this.getCatalog(principal);
      const candidates = catalog.tools.filter(
        (t) =>
          t.target.kind === 'action' &&
          t.target.connectorId === target.connectorId &&
          t.target.action === target.action &&
          t.target.accounts.some((a) => a.id === target.accountId),
      );
      const tool = candidates.find((t) => t.name === target.toolName) ?? candidates[0];
      if (tool?.target.kind !== 'action') {
        return errorResult(
          'This action is no longer available for the account, so nothing was done.',
          'permission',
        );
      }
      const account = tool.target.accounts.find((a) => a.id === target.accountId)!;
      const rawArgs = tool.target.accountArgument ? { ...args, [ACCOUNT_ARGUMENT]: account.name } : args;
      const prepared = await this.prepare(
        principal,
        catalog,
        tool,
        rawArgs,
        new AbortController().signal,
        undefined,
      );
      if ('error' in prepared) return prepared.error;
      return await this.executor.execute({ ...prepared.call, preApproved: true });
    } catch (error) {
      return this.toErrorResult(error, target.toolName);
    }
  }

  private runBuiltin(catalog: Catalog, args: Record<string, unknown>): ExecResult {
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

  /** Resolves the account, validates input and builds the unit for the executor. */
  private async prepare(
    principal: Principal,
    catalog: Catalog,
    tool: CatalogTool,
    rawArgs: Record<string, unknown>,
    signal: AbortSignal,
    interaction: Interaction | undefined,
  ): Promise<{ call: CallContext } | { error: ExecResult; accountId: string | null }> {
    if (tool.target.kind !== 'action') throw new Error('not an action tool');
    const { connectorId, action: actionName, accounts, accountArgument } = tool.target;
    const { [ACCOUNT_ARGUMENT]: requestedAccount, [FIELDS_ARGUMENT]: fields, ...args } = rawArgs;
    const fail = (message: string, accountId: string | null = null) => ({
      error: errorResult(message),
      accountId,
    });

    // 1. Pick the account.
    let account: CatalogAccount | undefined = accounts[0];
    if (accountArgument) {
      if (requestedAccount === undefined || requestedAccount === null || requestedAccount === '') {
        if (accounts.length > 1) {
          return fail(
            `Several accounts are connected; pass "${ACCOUNT_ARGUMENT}" with one of: ${accounts.map(describeAccount).join('; ')}.`,
          );
        }
      } else {
        account = accounts.find((a) => a.name === requestedAccount);
        if (!account) {
          return fail(
            `Unknown account "${String(requestedAccount)}". Available: ${accounts.map(describeAccount).join('; ')}.`,
          );
        }
      }
    }
    if (!account) return fail('No account is available for this tool.');

    // 2. Resolve connector + action and validate input with the connector's own schema.
    const connector = await this.deps.connectors.get(principal.workspaceId, connectorId);
    const action = connector?.actions.find((a) => a.name === actionName);
    if (!connector || !action) return fail('This tool is no longer available.', account.id);
    const parsed = action.input.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
        .join('; ');
      return fail(`Invalid arguments: ${issues}`, account.id);
    }

    // 3. Load the current account state (it may have been disabled since the catalog was built).
    const row = await this.deps.accounts.get(principal.workspaceId, account.id).catch(() => undefined);
    if (!row?.enabled) return fail(`Account "${account.name}" is disabled or was removed.`, account.id);

    const now = Date.now();
    const deadline = now + this.deps.toolTimeoutMs;
    const callSignal = AbortSignal.any([signal, AbortSignal.timeout(this.deps.toolTimeoutMs)]);
    const logger = this.deps.logger.child({
      connector: connector.id,
      action: action.name,
      account: account.id,
    });
    let context: ReturnType<CallContext['context']> | undefined;
    return {
      call: {
        principal,
        catalog,
        tool,
        connector,
        action,
        account,
        accountRow: row,
        input: parsed.data as Record<string, unknown>,
        options: Array.isArray(fields) ? { fields: fields.filter((f) => typeof f === 'string') } : {},
        risk: actionRisk(action),
        meta: {
          idempotent: actionIdempotent(action),
          ...(action.undo ? { undo: action.undo } : {}),
          capabilities: actionCapabilities(action),
        },
        context: () => {
          context ??= this.deps.accounts.buildContext(connector, row, { signal: callSignal, logger });
          return context;
        },
        signal: callSignal,
        startedAt: now,
        deadline,
        audit: {},
        locals: {},
        ...(interaction ? { interaction } : {}),
      },
    };
  }

  /** The innermost step: decrypt credentials and run the action with a timeout. Never throws. */
  private async invoke(call: CallContext): Promise<ExecResult> {
    const { action, account, accountRow: row, signal } = call;
    try {
      const ctx = await call.context();
      const value = await new Promise<unknown>((resolve, reject) => {
        // The timeout signal aborts with a TimeoutError; comparing clocks with the deadline is not
        // reliable (timers may fire a millisecond before Date.now() reaches it).
        const onAbort = () =>
          reject(
            isTimeout(signal.reason) || Date.now() >= call.deadline
              ? new ToolTimeoutError()
              : new ConnectorError('upstream', 'The call was cancelled'),
          );
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve()
          .then(() => action.run(call.input, ctx))
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', onAbort));
      });
      await this.deps.accounts.touch(account.id).catch(() => {});
      if (row.status !== 'active')
        await this.deps.accounts.markStatus(account.id, 'active', null).catch(() => {});
      return normalizeResult(value);
    } catch (error) {
      return this.handleError(error, call.tool.name, call.connector, account);
    }
  }

  private async handleError(
    error: unknown,
    toolName: string,
    connector: ConnectorDefinition,
    account: CatalogAccount,
  ): Promise<ExecResult> {
    if (error instanceof ToolTimeoutError) {
      return errorResult(
        `The call timed out after ${Math.round(this.deps.toolTimeoutMs / 1000)} seconds.`,
        'timeout',
      );
    }
    if (error instanceof ConnectorError && error.kind === 'auth') {
      // Flag the account so the user sees in the panel that it must be reconnected.
      await this.deps.accounts.markStatus(account.id, 'needs_reauth', error.message).catch(() => {});
      return errorResult(
        `Authorization with ${connector.name} failed for account "${account.name}": ${error.message}. The user needs to reconnect this account.`,
        'auth',
      );
    }
    return this.toErrorResult(error, toolName);
  }

  private toErrorResult(error: unknown, toolName: string): ExecResult {
    if (error instanceof ConnectorError) {
      const retry = error.options.retryAfterSeconds
        ? ` Retry after ${error.options.retryAfterSeconds} s.`
        : '';
      return errorResult(`${error.message}${retry}`, error.kind, error.options.retryAfterSeconds);
    }
    if (error instanceof AppError) return errorResult(error.message);
    const ref = Math.random().toString(36).slice(2, 10);
    this.deps.logger.error({ err: error, tool: toolName, ref }, 'tool call failed');
    return errorResult(`Internal error while running ${toolName} (ref ${ref}).`, 'internal');
  }

  private auditHubCall(
    principal: Principal,
    tool: CatalogTool,
    accountId: string | null,
    result: ExecResult,
    started: number,
  ): Promise<void> {
    return recordToolCall(this.deps.db, this.deps.logger, {
      principal,
      toolName: tool.name,
      connectorId: tool.target.kind === 'action' ? tool.target.connectorId : null,
      action: tool.target.kind === 'action' ? tool.target.action : tool.target.id,
      accountId,
      risk: tool.risk,
      result,
      durationMs: Date.now() - started,
    });
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
