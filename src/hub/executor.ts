import type {
  AccountContext,
  ActionDefinition,
  CapabilityBinding,
  ConnectorDefinition,
  RiskLevel,
  UndoSpec,
} from '../connectors/sdk.js';
import type { AccountRow } from '../core/accounts.js';
import type { Principal } from '../core/principal.js';
import type { Catalog, CatalogAccount, CatalogTool } from './catalog.js';
import type { ExecResult } from './result.js';

/**
 * The single call executor. Every call to a connector action — direct, part of an `account: "all"`
 * fan-out, a unified capability tool or a `call_tools` batch — runs as one *unit* (one action on one
 * account) through the same ordered chain of stages:
 *
 *   audit → policy → confirm → limits → idempotency → untrusted → shape → invoke
 *
 * Each stage is a middleware `(call, next) => result`: it may inspect the call, short-circuit with
 * its own result (a policy denial), call `next()` more than once (a retry) or post-process the
 * result (shaping). A new rule is one more middleware; the hub and connectors do not change.
 */
export const STAGE_ORDER = [
  /** Records every unit in `tool_calls`, including denials (outermost, so it sees everything). */
  'audit',
  /** Who may do what: client × account × risk (implemented in the security layer). */
  'policy',
  /** Lets the action raise the risk of this particular call (`assessRisk`), e.g. a new recipient. */
  'risk',
  /** Asks the user before risky actions (MCP elicitation, Telegram…; security layer). */
  'confirm',
  /** Per-account rate limits and safe retries of transient failures. */
  'limits',
  /** Suppresses accidental duplicates of non-idempotent writes. */
  'idempotency',
  /** Marks third-party content (emails, messages) as data, not instructions (security layer). */
  'untrusted',
  /** Field selection, compaction and the result size budget. */
  'shape',
] as const;

export type StageName = (typeof STAGE_ORDER)[number];

/** Answers the client gave to hub questions (MCP multi round-trip elicitation), mapped by the transport. */
export interface Interaction {
  answers: Record<string, unknown>;
  state?: string;
  /** Whether the client can be asked a question during this call. */
  canAsk: boolean;
}

/** Free-form audit details stages add while the call runs; the audit stage stores them. */
export interface AuditRecord {
  /** Why the result is what it is when it is not a plain success or failure: `denied`, `deduplicated`… */
  outcome?: string;
  /** Short, argument-free note. */
  note?: string;
  [key: string]: unknown;
}

export interface CallMeta {
  idempotent: boolean;
  undo?: UndoSpec;
  capabilities: CapabilityBinding[];
}

/** Everything known about one unit of work. Stages may add to `audit` and read the rest. */
export interface CallContext {
  principal: Principal;
  catalog: Catalog;
  /** The tool the AI called (for a unified tool, the capability tool, not the connector action). */
  tool: CatalogTool;
  connector: ConnectorDefinition;
  action: ActionDefinition;
  account: CatalogAccount;
  accountRow: AccountRow;
  /** The action input, already validated by the action's schema. */
  input: Record<string, unknown>;
  /** Hub-level options taken from reserved arguments. */
  options: { fields?: string[] };
  /** Declared risk, possibly raised by the `risk` stage; `confirm` and `audit` use the final value. */
  risk: RiskLevel;
  meta: CallMeta;
  /** The connector context for this account (credentials decrypted on first use, then cached). */
  context(): Promise<AccountContext<unknown, unknown>>;
  /** Aborted on client cancellation or when the deadline passes. */
  signal: AbortSignal;
  /** Epoch ms after which the unit must not start new work (timeout budget shared by retries). */
  deadline: number;
  startedAt: number;
  audit: AuditRecord;
  /** Per-call scratch space for stages to hand data to later stages (e.g. policy → confirm). */
  locals: Record<string, unknown>;
  interaction?: Interaction;
  /** Already approved by the user (e.g. a stored call approved in Telegram): `confirm` lets it pass. */
  preApproved?: boolean;
  /** Set when the unit is part of a bigger call (fan-out over accounts, capability tool, batch). */
  group?: { kind: 'fanout' | 'capability' | 'batch'; id: string };
}

export type Next = () => Promise<ExecResult>;
export type Middleware = (call: CallContext, next: Next) => Promise<ExecResult>;
export type Invoke = (call: CallContext) => Promise<ExecResult>;
export type StageMap = Partial<Record<StageName, Middleware>>;

export const passThrough: Middleware = (_call, next) => next();

export interface ExecuteOptions {
  /** Stages to bypass for this call, e.g. `['confirm']` for a call the user already approved. */
  skip?: readonly StageName[];
}

export class Executor {
  private readonly chain: Array<{ name: StageName; run: Middleware }>;

  constructor(
    stages: StageMap,
    private readonly invoke: Invoke,
  ) {
    this.chain = STAGE_ORDER.map((name) => ({ name, run: stages[name] ?? passThrough }));
  }

  execute(call: CallContext, options: ExecuteOptions = {}): Promise<ExecResult> {
    const skip = new Set(options.skip ?? []);
    const stages = this.chain.filter((stage) => !skip.has(stage.name));
    const dispatch = (index: number): Promise<ExecResult> => {
      const stage = stages[index];
      if (!stage) return this.invoke(call);
      // A stage may call next() more than once (a retry); each call re-runs the inner stages.
      return stage.run(call, () => dispatch(index + 1));
    };
    return dispatch(0);
  }
}
