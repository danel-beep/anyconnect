import type { ActionDefinition, ConnectorDefinition, JsonSchema, RiskLevel } from '../connectors/sdk.js';
import type { AccountRow } from '../core/accounts.js';
import type { WorkspaceSettings } from '../db/schema.js';
import type { BuiltinToolId } from './builtin-tools.js';

/** How accounts become tools: one tool per action with an `account` argument, or one per account. */
export type ExposureMode = NonNullable<WorkspaceSettings['toolExposure']>;
/** What `tools/list` shows: every tool, or a few meta tools to search and call the rest. */
export type ListingSetting = NonNullable<WorkspaceSettings['toolListing']>;
export type ListingMode = Exclude<ListingSetting, 'auto'>;

export interface CatalogAccount {
  id: string;
  name: string;
  label: string;
  description: string | null;
  identity: string | null;
  /** Team workspaces: whose the account is, from the caller's point of view. */
  owner?: AccountOwner;
}

/** Whose an account is, from the caller's point of view (team workspaces, see `core/teams.ts`). */
export type AccountOwner =
  | { kind: 'self' }
  | { kind: 'team' }
  | { kind: 'member'; name: string; access: 'read' | 'write' | 'full' };

/** A team workspace as the caller sees it: who they are and whose each account is. */
export interface CatalogTeam {
  name: string;
  /** The caller's name; absent for the team's shared connection. */
  member?: string;
  /** The caller runs the team (its owner or an admin). */
  admin?: boolean;
  /** By account id. */
  owners: Readonly<Record<string, AccountOwner>>;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface CapabilityImplementation {
  connectorId: string;
  connectorName: string;
  action: string;
  accounts: CatalogAccount[];
}

export type ToolTarget =
  | { kind: 'builtin'; id: BuiltinToolId }
  | {
      kind: 'action';
      connectorId: string;
      action: string;
      /** Accounts this tool can act on. */
      accounts: CatalogAccount[];
      /** Whether the tool takes an `account` argument (grouped mode). */
      accountArgument: boolean;
      /** Whether `account: "all"` runs it on every account at once (read actions, grouped mode). */
      fanOut: boolean;
    }
  | {
      /** A hub setup tool (connector `manyplug`): runs on the workspace, not on an account. */
      kind: 'workspace';
      connectorId: string;
      action: string;
    }
  | {
      /** A unified tool over a shared interface operation, e.g. `mail_search` over all mailboxes. */
      kind: 'capability';
      capabilityId: string;
      implementations: CapabilityImplementation[];
    };

export interface CatalogTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  target: ToolTarget;
  /** Risk of the underlying action(s); `read` for hub tools. */
  risk: RiskLevel;
  /** Service id for connector tools; used by search. */
  service?: string;
  /** Extra words for search only (service name and description); never sent to clients. */
  keywords?: string;
}

/**
 * Decides whether an account may use an action at all (policy, personas). Applied before anything
 * else, so a denied account disappears from the `account` enum and an action without allowed
 * accounts disappears from the catalog (and from unified tools). `account` is `undefined` for the
 * hub's setup tools, which act on the workspace itself.
 */
export type CatalogAllow = (
  connector: ConnectorDefinition,
  action: ActionDefinition,
  account: AccountRow | undefined,
) => boolean;

export interface CatalogService {
  connector: ConnectorDefinition;
  accounts: AccountRow[];
}

/** Limits of the AI client the catalog is built for. */
export interface ClientProfile {
  /** Budget for the `tools/list` result in tokens. */
  tokenBudget: number;
  /** Some clients refuse or truncate long tool lists (e.g. Cursor). */
  maxTools?: number;
}

export interface CatalogStats {
  /** Callable tools, listed or not. */
  totalTools: number;
  /** Estimated tokens of listing every tool directly. */
  directTokens: number;
  /** Estimated tokens of what is actually listed. */
  listedTokens: number;
  budget: number;
}

export interface Catalog {
  mode: ExposureMode;
  listing: ListingMode;
  /** Team workspaces: who is calling and whose each account is. */
  team?: CatalogTeam;
  /** Every callable tool (by name, through MCP or `manyplug_call_tool`). */
  tools: CatalogTool[];
  /** What `tools/list` returns. In direct listing the same as `tools`. */
  listed: CatalogTool[];
  services: CatalogService[];
  instructions: string;
  stats: CatalogStats;
}
