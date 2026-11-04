import { and, count, desc, eq, gt, lt } from 'drizzle-orm';
import { type CapabilityDefinition, getCapability } from '../connectors/capabilities.js';
import type { ConnectorResolver } from '../connectors/registry.js';
import { ACCOUNT_ARGUMENT, FIELDS_ARGUMENT } from '../connectors/registry.js';
import {
  type ActionDefinition,
  actionCapabilities,
  actionIdempotent,
  actionRisk,
  type ConnectorDefinition,
  ConnectorError,
} from '../connectors/sdk.js';
import type { AccountService } from '../core/accounts.js';
import { getWorkspace } from '../core/identity.js';
import type { Principal } from '../core/principal.js';
import type { WorkspaceAdmin } from '../core/workspace-admin.js';
import type { Db } from '../db/client.js';
import { oauthClients, toolCalls } from '../db/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import type { RateLimiter } from '../lib/rate-limit.js';
import type { Logger } from '../logger.js';
import type { WorkspaceBilling } from './billing-tools.js';
import { BUILTIN_TOOLS, MAX_BATCH_CALLS } from './builtin-tools.js';
import {
  ALL_ACCOUNTS,
  accountKey,
  buildCatalog,
  type Catalog,
  type CatalogAccount,
  type CatalogAllow,
  type CatalogTool,
  type ClientProfile,
  DEFAULT_PROFILE,
  describeAccount,
} from './catalog.js';
import { searchTools } from './discovery.js';
import {
  type CallContext,
  type ExecuteOptions,
  Executor,
  type Interaction,
  type StageMap,
} from './executor.js';
import type { IdempotencyStore } from './idempotency.js';
import { listOf, mergeAccounts, mergeCapabilityList, type UnitOutcome } from './merge.js';
import type { QuotaGate } from './quota.js';
import {
  carryUntrusted,
  dataResult,
  type ExecResult,
  errorResult,
  normalizeResult,
  resultText,
  type ToolCallResult,
  toTransport,
} from './result.js';
import type { SetupContext } from './setup-tools.js';
import { shapeData } from './shaping.js';
import { defaultStages, recordToolCall } from './stages/index.js';
import type { UsageMeter } from './usage.js';

export type { ToolCallResult } from './result.js';

class ToolTimeoutError extends Error {}

/** Accounts one fan-out call may run on in parallel. */
const FAN_OUT_CONCURRENCY = 8;
const CACHE_TTL_MS = 5 * 60_000;

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
  /** Token budget for `tools/list`; above it the catalog switches to discovery (setting `auto`). */
  toolListTokenBudget?: number;
  /** Counts executed calls (stage `meter`); without it nothing is counted. */
  meter?: UsageMeter;
  /** Plan limits (stage `quota`); without it nothing is limited. */
  quota?: QuotaGate;
  /** Replaces built-in stages or fills the policy / confirm / untrusted slots. */
  stages?: StageMap;
  /**
   * The hub's setup tools (`manyplug_*`, connector `manyplug`) and the workspace operations they
   * run. Without it the AI cannot manage the hub from the chat.
   */
  setup?: { connector: ConnectorDefinition; admin: WorkspaceAdmin; billing?: WorkspaceBilling };
  /** Per-caller catalog filter (policy, personas). */
  catalogFilter?: (principal: Principal) => Promise<CatalogAllow | undefined> | CatalogAllow | undefined;
}

export interface CallOptions {
  /** Aborted when the client cancels the request. */
  signal?: AbortSignal;
  /** Answers to hub questions, when the transport supports asking (MCP elicitation). */
  interaction?: Interaction;
  /** Internal: nesting level of `call_tool` / `call_tools`. */
  depth?: number;
}

/** Known limits of AI clients, matched by their OAuth client name. */
const CLIENT_LIMITS: Array<{ match: RegExp; maxTools: number }> = [{ match: /cursor/i, maxTools: 40 }];

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const isEmpty = (value: unknown) => value === undefined || value === null || value === '';

/**
 * The hub core: builds the catalog for a caller and executes tool calls against connectors,
 * routing each call to the right account(s). Transport-agnostic (used by MCP, the REST API and
 * the CLI). Every connector call runs as a unit through the {@link Executor} chain; fan-out over
 * accounts, unified tools and batches are compositions of units.
 */
export class Hub {
  readonly executor: Executor;
  private readonly usageCache = new Map<string, { at: number; usage: Record<string, number> }>();
  private readonly clientNames = new Map<string, { at: number; name: string | null }>();

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
          ...(deps.meter ? { meter: deps.meter } : {}),
          ...(deps.quota ? { quota: deps.quota } : {}),
        }),
        ...deps.stages,
      },
      (call) => this.invoke(call),
    );
  }

  // -------------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------------

  async getCatalog(principal: Principal): Promise<Catalog> {
    const { workspaceId } = principal;
    const [workspace, connectors, accounts, allow, usage, client] = await Promise.all([
      getWorkspace(this.deps.db, workspaceId),
      this.deps.connectors.list(workspaceId),
      this.deps.accounts.list(workspaceId),
      this.deps.catalogFilter?.(principal),
      this.usage(workspaceId),
      this.clientProfile(principal),
    ]);
    if (!workspace) throw notFound('Workspace');
    return buildCatalog({
      connectors,
      accounts,
      mode: workspace.settings.toolExposure ?? 'grouped',
      listing: workspace.settings.toolListing ?? 'auto',
      client,
      usage,
      ...(allow ? { allow } : {}),
      ...(this.deps.setup ? { setup: this.deps.setup.connector } : {}),
    });
  }

  /** Tool call counts of the last 30 days (cached): the most used tools stay listed in discovery. */
  private async usage(workspaceId: string): Promise<Record<string, number>> {
    const cached = this.usageCache.get(workspaceId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.usage;
    const since = new Date(Date.now() - 30 * 86_400_000);
    const rows = await this.deps.db
      .select({ tool: toolCalls.toolName, calls: count() })
      .from(toolCalls)
      .where(and(eq(toolCalls.workspaceId, workspaceId), gt(toolCalls.createdAt, since)))
      .groupBy(toolCalls.toolName)
      .orderBy(desc(count()))
      .limit(50);
    const usage = Object.fromEntries(rows.map((r) => [r.tool, Number(r.calls)]));
    this.usageCache.set(workspaceId, { at: Date.now(), usage });
    return usage;
  }

  private async clientProfile(principal: Principal): Promise<ClientProfile> {
    const profile: ClientProfile = {
      tokenBudget: this.deps.toolListTokenBudget ?? DEFAULT_PROFILE.tokenBudget,
    };
    if (!principal.clientId) return profile;
    let entry = this.clientNames.get(principal.clientId);
    if (!entry || Date.now() - entry.at > CACHE_TTL_MS) {
      const [row] = await this.deps.db
        .select({ metadata: oauthClients.metadata })
        .from(oauthClients)
        .where(eq(oauthClients.id, principal.clientId))
        .limit(1);
      entry = { at: Date.now(), name: row?.metadata.client_name ?? null };
      this.clientNames.set(principal.clientId, entry);
    }
    const limit = entry.name ? CLIENT_LIMITS.find((l) => l.match.test(entry.name!)) : undefined;
    return limit ? { ...profile, maxTools: limit.maxTools } : profile;
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  /** Executes a tool by name. Never throws for tool-level failures: they become `isError` results. */
  async callTool(
    principal: Principal,
    catalog: Catalog,
    toolName: string,
    args: Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<ToolCallResult> {
    return toTransport(await this.dispatch(principal, catalog, toolName, args ?? {}, options));
  }

  private async dispatch(
    principal: Principal,
    catalog: Catalog,
    toolName: string,
    args: Record<string, unknown>,
    options: CallOptions,
  ): Promise<ExecResult> {
    const tool = catalog.tools.find((t) => t.name === toolName);
    if (!tool) {
      return errorResult(
        `Unknown tool "${toolName}". Find tools with ${BUILTIN_TOOLS.search_tools.name} or ${BUILTIN_TOOLS.list_accounts.name}.`,
      );
    }
    const started = Date.now();
    let result: ExecResult;
    let audit: { accountId: string | null } | null = null;
    try {
      switch (tool.target.kind) {
        case 'builtin': {
          const id = tool.target.id;
          if (id === 'call_tool' || id === 'call_tools')
            return await this.runDispatcher(principal, catalog, tool, args, options);
          result = this.runBuiltin(catalog, id, args);
          audit = { accountId: null };
          break;
        }
        case 'action': {
          const outcome = await this.runActionTool(principal, catalog, tool, args, options);
          if ('rejected' in outcome) {
            result = outcome.rejected;
            audit = { accountId: outcome.accountId };
          } else result = outcome.result;
          break;
        }
        case 'workspace': {
          const outcome = await this.runWorkspaceTool(principal, catalog, tool, args, options);
          if ('rejected' in outcome) {
            result = outcome.rejected;
            audit = { accountId: null };
          } else result = outcome.result;
          break;
        }
        case 'capability': {
          const outcome = await this.runCapabilityTool(principal, catalog, tool, args, options);
          if ('rejected' in outcome) {
            result = outcome.rejected;
            audit = { accountId: null };
          } else result = outcome.result;
          break;
        }
      }
    } catch (error) {
      result = this.toErrorResult(error, tool.name);
      audit = { accountId: null };
    }
    // Units are audited by the executor; hub tools and calls rejected before execution are audited here.
    if (audit) await this.auditHubCall(principal, tool, audit.accountId, result, started);
    return result;
  }

  /**
   * Runs a call the user already approved out of band (Telegram, web page) as its original caller.
   * The call goes through the whole chain again: if the caller lost access meanwhile, it is denied;
   * `preApproved` only lets it pass the confirmation stage.
   */
  async runApproved(
    principal: Principal,
    /** `accountId` null: a setup tool acting on the workspace. */
    target: { toolName: string; connectorId: string; action: string; accountId: string | null },
    args: Record<string, unknown>,
  ): Promise<ExecResult> {
    try {
      const catalog = await this.getCatalog(principal);
      if (target.accountId === null) {
        const tool = catalog.tools.find(
          (t) =>
            t.target.kind === 'workspace' &&
            t.target.connectorId === target.connectorId &&
            t.target.action === target.action,
        );
        if (!tool) {
          return errorResult('This action is no longer available, so nothing was done.', 'permission');
        }
        const outcome = await this.runWorkspaceTool(principal, catalog, tool, args, {}, true);
        return 'rejected' in outcome ? outcome.rejected : outcome.result;
      }
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
      const connector = await this.deps.connectors.get(principal.workspaceId, target.connectorId);
      const action = connector?.actions.find((a) => a.name === target.action);
      if (!connector || !action) {
        return errorResult('This action is no longer available, so nothing was done.', 'permission');
      }
      const { [FIELDS_ARGUMENT]: fields, ...input } = args;
      const parsed = action.input.safeParse(input);
      if (!parsed.success) return errorResult(`Invalid arguments: ${issuesOf(parsed.error)}`);
      const unit = await this.unit(principal, catalog, tool, connector, action, account, parsed.data, {
        options: Array.isArray(fields) ? { fields: fields.filter((f) => typeof f === 'string') } : {},
        signal: undefined,
        interaction: undefined,
      });
      if ('rejected' in unit) return unit.rejected;
      return await this.executor.execute({ ...unit.call, preApproved: true });
    } catch (error) {
      return this.toErrorResult(error, target.toolName);
    }
  }

  // --- Hub tools -------------------------------------------------------------

  private runBuiltin(catalog: Catalog, id: string, args: Record<string, unknown>): ExecResult {
    switch (id) {
      case 'list_accounts':
        return this.listAccounts(catalog, args);
      case 'search_tools': {
        const query = typeof args.query === 'string' ? args.query : '';
        const limit = typeof args.limit === 'number' ? Math.min(Math.max(Math.trunc(args.limit), 1), 20) : 5;
        const found = searchTools(catalog.tools, query, {
          ...(typeof args.service === 'string' && args.service ? { service: args.service } : {}),
          limit,
        });
        const listed = new Set(catalog.listed.map((t) => t.name));
        return normalizeResult({
          tools: found.map((t, i) => ({
            name: t.name,
            description: t.description,
            // Schemas of the top matches let the model call right away, saving a describe step.
            ...(i < 3 ? { inputSchema: t.inputSchema } : {}),
            ...(listed.has(t.name) ? { listed: true } : {}),
          })),
          hint:
            found.length === 0
              ? `Nothing matched. Connected services: ${catalog.services.map((s) => s.connector.id).join(', ') || 'none'}.`
              : `Call with ${BUILTIN_TOOLS.call_tool.name} (several at once: ${BUILTIN_TOOLS.call_tools.name}); ${BUILTIN_TOOLS.describe_tool.name} gives other schemas.`,
        });
      }
      case 'describe_tool': {
        const names = Array.isArray(args.names) ? args.names.filter((n) => typeof n === 'string') : [];
        return normalizeResult({
          tools: names.map((name) => {
            const tool = catalog.tools.find((t) => t.name === name);
            return tool
              ? {
                  name,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                  annotations: tool.annotations,
                }
              : { name, error: 'Unknown tool' };
          }),
        });
      }
      default:
        return errorResult(`Unknown hub tool "${id}".`);
    }
  }

  private listAccounts(catalog: Catalog, args: Record<string, unknown>): ExecResult {
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
    const unified = catalog.tools.filter((t) => t.target.kind === 'capability').map((t) => t.name);
    return normalizeResult({
      exposure: catalog.mode,
      listing: catalog.listing,
      services,
      ...(unified.length ? { unifiedTools: unified } : {}),
      ...(services.length === 0
        ? { hint: filter ? `No service "${filter}" is connected.` : 'No services are connected yet.' }
        : {}),
    });
  }

  /** `call_tool` and `call_tools`: run other tools; each inner call is audited on its own. */
  private async runDispatcher(
    principal: Principal,
    catalog: Catalog,
    tool: CatalogTool,
    args: Record<string, unknown>,
    options: CallOptions,
  ): Promise<ExecResult> {
    const depth = options.depth ?? 0;
    if (depth >= 1) return errorResult(`${tool.name} cannot be nested inside another call_tool(s).`);
    const inner = { ...options, depth: depth + 1 };
    const isDispatcher = (name: string) =>
      name === BUILTIN_TOOLS.call_tool.name || name === BUILTIN_TOOLS.call_tools.name;
    const argsOf = (value: unknown) =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    if (tool.target.kind === 'builtin' && tool.target.id === 'call_tool') {
      const name = typeof args.name === 'string' ? args.name : '';
      if (isDispatcher(name)) return errorResult(`Call ${name} directly.`);
      return this.dispatch(principal, catalog, name, argsOf(args.arguments), inner);
    }

    const calls = Array.isArray(args.calls) ? args.calls : [];
    if (calls.length === 0 || calls.length > MAX_BATCH_CALLS) {
      return errorResult(
        `Pass 1 to ${MAX_BATCH_CALLS} calls as "calls": [{ "name": ..., "arguments": {...} }].`,
      );
    }
    // Batched calls run in parallel, so none of them may ask the user in the chat.
    const { interaction: _ignored, ...batched } = inner;
    const results = await Promise.all(
      calls.map(async (raw) => {
        const call = argsOf(raw);
        const name = typeof call.name === 'string' ? call.name : '';
        const result = isDispatcher(name)
          ? errorResult('Nested batches are not allowed.')
          : await this.dispatch(principal, catalog, name, argsOf(call.arguments), batched);
        return {
          raw: result,
          name,
          ok: !result.isError,
          result: result.isError
            ? resultText(result)
            : (result.structuredContent ?? result.data ?? resultText(result)),
        };
      }),
    );
    const shaped = shapeData(
      { results: results.map(({ raw: _raw, ...r }) => r) },
      { maxTokens: this.deps.maxResultTokens * 2 },
    );
    const out = carryUntrusted(
      dataResult(shaped.data),
      results.map((r) => r.raw),
      tool.name,
    );
    return results.every((r) => !r.ok) ? { ...out, isError: true } : out;
  }

  // --- Service tools -----------------------------------------------------------

  private async runActionTool(
    principal: Principal,
    catalog: Catalog,
    tool: CatalogTool,
    rawArgs: Record<string, unknown>,
    options: CallOptions,
  ): Promise<{ result: ExecResult } | { rejected: ExecResult; accountId: string | null }> {
    if (tool.target.kind !== 'action') throw new Error('not an action tool');
    const { connectorId, action: actionName, accounts, accountArgument, fanOut } = tool.target;
    const { [ACCOUNT_ARGUMENT]: requested, [FIELDS_ARGUMENT]: fields, ...args } = rawArgs;
    const reject = (message: string, accountId: string | null = null) => ({
      rejected: errorResult(message),
      accountId,
    });

    // 1. Pick the account(s).
    let targets: CatalogAccount[];
    if (!accountArgument) targets = accounts.slice(0, 1);
    else if (isEmpty(requested) || requested === ALL_ACCOUNTS) {
      if (accounts.length === 1) targets = accounts;
      else if (fanOut) targets = accounts;
      else {
        return reject(
          `Several accounts are connected; pass "${ACCOUNT_ARGUMENT}" with one of: ${accounts.map(describeAccount).join('; ')}.`,
        );
      }
    } else {
      const account = accounts.find((a) => a.name === requested);
      if (!account) {
        return reject(
          `Unknown account "${String(requested)}". Available: ${accounts.map(describeAccount).join('; ')}.`,
        );
      }
      targets = [account];
    }
    if (targets.length === 0) return reject('No account is available for this tool.');

    // 2. Resolve connector + action and validate input with the connector's own schema.
    const connector = await this.deps.connectors.get(principal.workspaceId, connectorId);
    const action = connector?.actions.find((a) => a.name === actionName);
    if (!connector || !action) return reject('This tool is no longer available.', targets[0]!.id);
    const parsed = action.input.safeParse(args);
    if (!parsed.success) return reject(`Invalid arguments: ${issuesOf(parsed.error)}`, targets[0]!.id);
    const callOptions = Array.isArray(fields) ? { fields: fields.filter((f) => typeof f === 'string') } : {};

    // 3. One account: one unit.
    if (targets.length === 1) {
      const account = targets[0]!;
      const unit = await this.unit(principal, catalog, tool, connector, action, account, parsed.data, {
        options: callOptions,
        signal: options.signal,
        interaction: options.interaction,
      });
      if ('rejected' in unit) return { rejected: unit.rejected, accountId: account.id };
      return { result: await this.executor.execute(unit.call) };
    }

    // 4. Several accounts: run in parallel, merge, keep the total within budget.
    const group = { kind: 'fanout' as const, id: crypto.randomUUID() };
    const outcomes = await mapLimit(targets, FAN_OUT_CONCURRENCY, async (account): Promise<UnitOutcome> => {
      const unit = await this.unit(principal, catalog, tool, connector, action, account, parsed.data, {
        options: callOptions,
        signal: options.signal,
        // Several units must not each ask the user in the chat: they use the out-of-chat channels.
        interaction: undefined,
        group,
      });
      const result = 'rejected' in unit ? unit.rejected : await this.executor.execute(unit.call);
      return { account: account.name, result };
    });
    const merged = mergeAccounts(outcomes);
    if (merged.data === undefined) {
      return {
        result: errorResult(
          `Failed on every account: ${merged.errors.map((e) => `${e.account}: ${e.error}`).join(' | ')}`,
          outcomes[0]?.result.error?.kind,
        ),
      };
    }
    const result = dataResult(shapeData(merged.data, { maxTokens: this.deps.maxResultTokens }).data);
    return {
      result: carryUntrusted(
        result,
        outcomes.map((o) => o.result),
        tool.name,
      ),
    };
  }

  // --- Unified tools -----------------------------------------------------------

  private async runCapabilityTool(
    principal: Principal,
    catalog: Catalog,
    tool: CatalogTool,
    rawArgs: Record<string, unknown>,
    options: CallOptions,
  ): Promise<{ result: ExecResult } | { rejected: ExecResult }> {
    if (tool.target.kind !== 'capability') throw new Error('not a capability tool');
    const capability = getCapability(tool.target.capabilityId);
    if (!capability) return { rejected: errorResult('This tool is no longer available.') };
    const { [ACCOUNT_ARGUMENT]: requested, ...args } = rawArgs;
    const parsed = capability.input.safeParse(args);
    if (!parsed.success) return { rejected: errorResult(`Invalid arguments: ${issuesOf(parsed.error)}`) };
    const canonical = parsed.data as Record<string, unknown>;

    // Which (service, account) pairs to run on.
    const all = tool.target.implementations.flatMap((impl) =>
      impl.accounts.map((account) => ({ impl, account })),
    );
    let targets = all;
    if (!isEmpty(requested) && requested !== ALL_ACCOUNTS) {
      const value = String(requested);
      targets = all.filter(
        ({ impl, account }) =>
          impl.connectorId === value || accountKey(impl.connectorId, account.name) === value,
      );
      if (targets.length === 0) {
        return {
          rejected: errorResult(
            `Unknown account "${value}". Use one of: ${all.map(({ impl, account }) => accountKey(impl.connectorId, account.name)).join(', ')}.`,
          ),
        };
      }
    }
    if (capability.kind === 'single' && targets.length !== 1) {
      return {
        rejected: errorResult(
          `Pick one account as "${ACCOUNT_ARGUMENT}": ${targets.map(({ impl, account }) => accountKey(impl.connectorId, account.name)).join(', ')}.`,
        ),
      };
    }

    const group = { kind: 'capability' as const, id: crypto.randomUUID() };
    const outcomes = await mapLimit(
      targets,
      FAN_OUT_CONCURRENCY,
      async ({ impl, account }): Promise<UnitOutcome & { output?: unknown }> => {
        const key = accountKey(impl.connectorId, account.name);
        const base = { account: key, service: impl.connectorId };
        const connector = await this.deps.connectors.get(principal.workspaceId, impl.connectorId);
        const action = connector?.actions.find((a) => a.name === impl.action);
        const binding = action && actionCapabilities(action).find((b) => b.id === capability.id);
        if (!connector || !action || !binding)
          return { ...base, result: errorResult('No longer available.') };
        const input = binding.mapInput ? binding.mapInput(canonical) : canonical;
        const valid = action.input.safeParse(input);
        if (!valid.success) {
          // A mismatch between the capability and the connector is a connector bug, not the AI's fault.
          this.deps.logger.warn(
            { connector: connector.id, action: action.name },
            'capability input rejected',
          );
          return {
            ...base,
            result: errorResult(`${connector.name} could not handle this request.`, 'internal'),
          };
        }
        const unit = await this.unit(principal, catalog, tool, connector, action, account, valid.data, {
          options: {},
          signal: options.signal,
          interaction: targets.length === 1 ? options.interaction : undefined,
          group,
        });
        if ('rejected' in unit) return { ...base, result: unit.rejected };
        // Shaping happens once on the merged canonical result.
        const result = await this.executor.execute(unit.call, { skip: ['shape'] as ExecuteOptions['skip'] });
        if (result.isError || result.data === undefined) return { ...base, result };
        const output = binding.mapOutput ? binding.mapOutput(result.data, canonical) : result.data;
        return { ...base, result, output };
      },
    );

    if (capability.kind === 'single') {
      const [outcome] = outcomes;
      if (!outcome || outcome.result.isError) return { result: outcome?.result ?? errorResult('No result.') };
      const parsedOutput = capability.output.safeParse(outcome.output);
      const data = parsedOutput.success ? parsedOutput.data : outcome.output;
      const result = dataResult(
        shapeData(
          { service: outcome.service, account: outcome.account, ...asObject(data) },
          { maxTokens: this.deps.maxResultTokens },
        ).data,
      );
      return { result: carryUntrusted(result, [outcome.result], tool.name) };
    }

    const merged = mergeCapabilityList(
      capability as CapabilityDefinition,
      outcomes.map((o) => ({ ...o, items: 'output' in o ? (listOf(o.output)?.items ?? []) : [] })),
      typeof canonical.limit === 'number' ? canonical.limit : undefined,
    );
    if (merged.data === undefined) {
      return {
        result: errorResult(
          `Failed on every account: ${merged.errors.map((e) => `${e.account}: ${e.error}`).join(' | ')}`,
        ),
      };
    }
    const result = dataResult(shapeData(merged.data, { maxTokens: this.deps.maxResultTokens }).data);
    return {
      result: carryUntrusted(
        result,
        outcomes.map((o) => o.result),
        tool.name,
      ),
    };
  }

  // --- Setup tools (the workspace itself) ----------------------------------------

  private async runWorkspaceTool(
    principal: Principal,
    catalog: Catalog,
    tool: CatalogTool,
    args: Record<string, unknown>,
    options: CallOptions,
    /** The user already approved this call (see `runApproved`). */
    preApproved = false,
  ): Promise<{ result: ExecResult } | { rejected: ExecResult }> {
    if (tool.target.kind !== 'workspace') throw new Error('not a workspace tool');
    const setup = this.deps.setup;
    const { action: actionName } = tool.target;
    const action = setup?.connector.actions.find((a) => a.name === actionName);
    if (!setup || !action) return { rejected: errorResult('This tool is no longer available.') };
    const parsed = action.input.safeParse(args);
    if (!parsed.success) return { rejected: errorResult(`Invalid arguments: ${issuesOf(parsed.error)}`) };

    const now = Date.now();
    const signals = [AbortSignal.timeout(this.deps.toolTimeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    const context: SetupContext = {
      principal,
      admin: setup.admin,
      ...(setup.billing ? { billing: setup.billing } : {}),
      signal,
    };
    const call: CallContext = {
      principal,
      catalog,
      tool,
      connector: setup.connector,
      action,
      scope: 'workspace',
      input: parsed.data as Record<string, unknown>,
      options: {},
      risk: actionRisk(action),
      meta: {
        idempotent: actionIdempotent(action),
        ...(action.undo ? { undo: action.undo } : {}),
        capabilities: [],
      },
      // Setup actions take the setup context in place of an account context (see setup-tools.ts).
      context: async () => context as unknown as Awaited<ReturnType<CallContext['context']>>,
      signal,
      startedAt: now,
      deadline: now + this.deps.toolTimeoutMs,
      audit: {},
      locals: {},
      ...(options.interaction ? { interaction: options.interaction } : {}),
      ...(preApproved ? { preApproved } : {}),
    };
    return { result: await this.executor.execute(call) };
  }

  // --- Units -------------------------------------------------------------------

  /** Loads the fresh account state and builds one executor unit. */
  private async unit(
    principal: Principal,
    catalog: Catalog,
    tool: CatalogTool,
    connector: ConnectorDefinition,
    action: ActionDefinition,
    account: CatalogAccount,
    input: unknown,
    extra: {
      options: CallContext['options'];
      signal: AbortSignal | undefined;
      interaction: Interaction | undefined;
      group?: CallContext['group'];
    },
  ): Promise<{ call: CallContext } | { rejected: ExecResult }> {
    // The account may have been disabled since the catalog was built.
    const row = await this.deps.accounts.get(principal.workspaceId, account.id).catch(() => undefined);
    if (!row?.enabled)
      return { rejected: errorResult(`Account "${account.name}" is disabled or was removed.`) };

    const now = Date.now();
    const signals = [AbortSignal.timeout(this.deps.toolTimeoutMs)];
    if (extra.signal) signals.push(extra.signal);
    const callSignal = AbortSignal.any(signals);
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
        scope: 'account',
        account,
        accountRow: row,
        input: input as Record<string, unknown>,
        options: extra.options,
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
        deadline: now + this.deps.toolTimeoutMs,
        audit: {},
        locals: {},
        ...(extra.interaction ? { interaction: extra.interaction } : {}),
        ...(extra.group ? { group: extra.group } : {}),
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
            // The timer can fire a millisecond before the deadline: trust the abort reason first.
            (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError' ||
              Date.now() >= call.deadline
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
      if (account && row) {
        await this.deps.accounts.touch(account.id).catch(() => {});
        if (row.status !== 'active')
          await this.deps.accounts.markStatus(account.id, 'active', null).catch(() => {});
      }
      return normalizeResult(value);
    } catch (error) {
      return this.handleError(error, call.tool.name, call.connector, account);
    }
  }

  private async handleError(
    error: unknown,
    toolName: string,
    connector: ConnectorDefinition,
    account: CatalogAccount | undefined,
  ): Promise<ExecResult> {
    if (error instanceof ToolTimeoutError) {
      return errorResult(
        `The call timed out after ${Math.round(this.deps.toolTimeoutMs / 1000)} seconds.`,
        'timeout',
      );
    }
    if (account && error instanceof ConnectorError && error.kind === 'auth') {
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
    if (error instanceof AppError) return errorResult(appErrorText(error));
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
    const target = tool.target;
    return recordToolCall(this.deps.db, this.deps.logger, {
      principal,
      toolName: tool.name,
      connectorId: target.kind === 'action' || target.kind === 'workspace' ? target.connectorId : null,
      action:
        target.kind === 'action' || target.kind === 'workspace'
          ? target.action
          : target.kind === 'builtin'
            ? target.id
            : target.capabilityId,
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

/** An app error for the AI, with field problems when there are any. */
function appErrorText(error: AppError): string {
  const details = Array.isArray(error.details)
    ? (error.details as Array<{ path?: string; message?: string }>)
        .map((d) => (d.path ? `${d.path}: ${d.message}` : d.message))
        .filter(Boolean)
    : [];
  return details.length ? `${error.message}: ${details.join('; ')}` : error.message;
}

function issuesOf(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`).join('; ');
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { result: value };
}
