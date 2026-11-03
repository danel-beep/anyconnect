import { createHash } from 'node:crypto';
import { ACCOUNT_ARGUMENT } from '../connectors/registry.js';
import { type ConnectorDefinition, type JsonSchema, toJsonSchema } from '../connectors/sdk.js';
import type { AccountRow } from '../core/accounts.js';
import type { WorkspaceSettings } from '../db/schema.js';

/**
 * The catalog is what an AI client sees: the list of MCP tools built from the workspace's
 * connectors and accounts. It is a pure function of (connectors, accounts, settings), so the
 * exposure strategy can evolve (e.g. a "discovery" mode with search/call meta-tools for very large
 * catalogs) without touching connectors or the MCP transport.
 */

export type ExposureMode = NonNullable<WorkspaceSettings['toolExposure']>;

export interface CatalogAccount {
  id: string;
  name: string;
  label: string;
  description: string | null;
  identity: string | null;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type BuiltinToolId = 'list_accounts';

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
    };

export interface CatalogTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  target: ToolTarget;
}

export interface CatalogService {
  connector: ConnectorDefinition;
  accounts: AccountRow[];
}

export interface Catalog {
  mode: ExposureMode;
  tools: CatalogTool[];
  services: CatalogService[];
  instructions: string;
}

/** Tool names must match ^[a-zA-Z0-9_-]{1,64}$ to work in every major AI client. */
export const MAX_TOOL_NAME = 64;
export const BUILTIN_PREFIX = 'anyconnect_';

export function makeToolName(parts: string[], uniqueSeed: string): string {
  const name = parts
    .join('_')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_');
  if (name.length <= MAX_TOOL_NAME) return name;
  const hash = createHash('sha256').update(uniqueSeed).digest('hex').slice(0, 6);
  return `${name.slice(0, MAX_TOOL_NAME - 7)}_${hash}`;
}

function toCatalogAccount(row: AccountRow): CatalogAccount {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    description: row.description,
    identity: typeof row.metadata.identity === 'string' ? row.metadata.identity : null,
  };
}

export function describeAccount(account: CatalogAccount): string {
  const details = [account.identity, account.description].filter(Boolean).join('; ');
  return `"${account.name}" — ${account.label}${details ? ` (${details})` : ''}`;
}

function annotationsFor(
  title: string,
  hints: ConnectorDefinition['actions'][number]['hints'],
): ToolAnnotations {
  const readOnly = hints?.readOnly ?? false;
  return {
    title,
    readOnlyHint: readOnly,
    ...(readOnly ? {} : { destructiveHint: hints?.destructive ?? true }),
    idempotentHint: hints?.idempotent ?? false,
    openWorldHint: hints?.openWorld ?? true,
  };
}

function withAccountArgument(schema: JsonSchema, accounts: CatalogAccount[], connector: ConnectorDefinition) {
  const properties = (schema.properties as Record<string, unknown> | undefined) ?? {};
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const single = accounts.length === 1;
  const accountProperty = {
    type: 'string',
    enum: accounts.map((a) => a.name),
    description: single
      ? `${connector.name} account to use. Only one is connected: ${describeAccount(accounts[0]!)}.`
      : `Which ${connector.name} account to use: ${accounts.map(describeAccount).join('; ')}.`,
  };
  return {
    ...schema,
    type: 'object',
    properties: { [ACCOUNT_ARGUMENT]: accountProperty, ...properties },
    required: single ? required : [ACCOUNT_ARGUMENT, ...required],
  };
}

const LIST_ACCOUNTS_TOOL: CatalogTool = {
  name: `${BUILTIN_PREFIX}list_accounts`,
  title: 'List connected services and accounts',
  description:
    'Lists every service connected to the AnyConnect hub with its accounts (name, label, identity, status) and the tools available for each. Call it to find out what is connected or which account to use.',
  inputSchema: {
    type: 'object',
    properties: {
      service: { type: 'string', description: 'Only show this service (its id, e.g. "gmail").' },
    },
  },
  annotations: {
    title: 'List connected services and accounts',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  target: { kind: 'builtin', id: 'list_accounts' },
};

export function buildInstructions(services: CatalogService[], mode: ExposureMode): string {
  const lines = [
    'AnyConnect is a hub that connects the user’s services and accounts. Several accounts of the same service can be connected (for example two mailboxes or two Telegram accounts).',
    mode === 'grouped'
      ? 'Service tools take an "account" argument that selects the account. If the user did not say which account to use and it matters, ask them.'
      : 'Each tool is bound to one account; its name and description say which.',
    `Call ${LIST_ACCOUNTS_TOOL.name} to see all connected services and accounts.`,
  ];
  const active = services.filter((s) => s.accounts.some((a) => a.enabled));
  if (active.length === 0) {
    lines.push('No services are connected yet. The user can add accounts in the AnyConnect web panel.');
  } else {
    lines.push('Connected services:');
    for (const { connector, accounts } of active) {
      const names = accounts.filter((a) => a.enabled).map((a) => describeAccount(toCatalogAccount(a)));
      lines.push(`- ${connector.name} (${connector.id}): ${names.join('; ')}`);
      if (connector.instructions) lines.push(`  ${connector.instructions}`);
    }
  }
  return lines.join('\n');
}

export function buildCatalog(input: {
  connectors: ConnectorDefinition[];
  accounts: AccountRow[];
  mode?: ExposureMode;
}): Catalog {
  const mode = input.mode ?? 'grouped';
  const byConnector = new Map(input.connectors.map((c) => [c.id, c]));
  const services: CatalogService[] = [];
  const grouped = new Map<string, AccountRow[]>();
  for (const account of input.accounts) {
    if (!byConnector.has(account.connectorId)) continue; // connector removed from the codebase
    const list = grouped.get(account.connectorId) ?? [];
    list.push(account);
    grouped.set(account.connectorId, list);
  }
  for (const [connectorId, accounts] of grouped) {
    services.push({ connector: byConnector.get(connectorId)!, accounts });
  }
  services.sort((a, b) => a.connector.name.localeCompare(b.connector.name));

  const tools: CatalogTool[] = [LIST_ACCOUNTS_TOOL];
  const used = new Set(tools.map((t) => t.name));
  const add = (tool: CatalogTool) => {
    let name = tool.name;
    if (used.has(name)) {
      // Rare: e.g. account "a_b" + action "c" vs account "a" + action "b_c" in per-account mode.
      const hash = createHash('sha256').update(JSON.stringify(tool.target)).digest('hex').slice(0, 6);
      name = `${name.slice(0, MAX_TOOL_NAME - 7)}_${hash}`;
    }
    used.add(name);
    tools.push({ ...tool, name });
  };

  for (const { connector, accounts } of services) {
    const usable = accounts.filter((a) => a.enabled);
    for (const action of connector.actions) {
      const eligible = usable
        .filter((a) => !a.settings.disabledActions?.includes(action.name))
        .map(toCatalogAccount);
      if (eligible.length === 0) continue;
      const baseSchema = toJsonSchema(action.input);
      const title = action.title ?? action.name;
      if (mode === 'grouped') {
        add({
          name: makeToolName([connector.id, action.name], `${connector.id}:${action.name}`),
          title: `${connector.name}: ${title}`,
          description: `[${connector.name}] ${action.description}`,
          inputSchema: withAccountArgument(baseSchema, eligible, connector),
          annotations: annotationsFor(`${connector.name}: ${title}`, action.hints),
          target: {
            kind: 'action',
            connectorId: connector.id,
            action: action.name,
            accounts: eligible,
            accountArgument: true,
          },
        });
      } else {
        for (const account of eligible) {
          const fullTitle = `${connector.name} (${account.label}): ${title}`;
          add({
            name: makeToolName([connector.id, account.name, action.name], `${account.id}:${action.name}`),
            title: fullTitle,
            description: `[${connector.name} — account ${describeAccount(account)}] ${action.description}`,
            inputSchema: { ...baseSchema, type: 'object' },
            annotations: annotationsFor(fullTitle, action.hints),
            target: {
              kind: 'action',
              connectorId: connector.id,
              action: action.name,
              accounts: [account],
              accountArgument: false,
            },
          });
        }
      }
    }
  }

  return { mode, tools, services, instructions: buildInstructions(services, mode) };
}
