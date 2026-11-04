import { resolveProvider, validateProvider } from './oauth/providers.js';
import type { ConnectorDefinition } from './sdk.js';

const CONNECTOR_ID = /^[a-z][a-z0-9_]{1,23}$/;
const ACTION_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** Tool names starting with these are reserved for the hub's own tools. */
const RESERVED_CONNECTOR_IDS = new Set(['anyconnect', 'hub', 'mcp']);
/** Injected by the hub to pick an account, so actions cannot use it as an input name. */
export const ACCOUNT_ARGUMENT = 'account';

/**
 * Resolves which connectors (services) exist for a workspace.
 *
 * Today all connectors are built into the code. Later, user-defined services (an OpenAPI spec,
 * a remote MCP server URL) will be stored per workspace and resolved here too — that is why
 * lookups take a workspace id.
 */
export interface ConnectorResolver {
  list(workspaceId: string): Promise<ConnectorDefinition[]>;
  get(workspaceId: string, connectorId: string): Promise<ConnectorDefinition | undefined>;
}

export class ConnectorRegistry implements ConnectorResolver {
  private readonly connectors = new Map<string, ConnectorDefinition>();

  register(connector: ConnectorDefinition): this {
    validateConnector(connector);
    if (this.connectors.has(connector.id))
      throw new Error(`Connector "${connector.id}" is already registered`);
    this.connectors.set(connector.id, connector);
    return this;
  }

  all(): ConnectorDefinition[] {
    return [...this.connectors.values()];
  }

  async list(_workspaceId: string): Promise<ConnectorDefinition[]> {
    return this.all();
  }

  async get(_workspaceId: string, connectorId: string): Promise<ConnectorDefinition | undefined> {
    return this.connectors.get(connectorId);
  }
}

export function validateConnector(connector: ConnectorDefinition): void {
  if (!CONNECTOR_ID.test(connector.id)) {
    throw new Error(
      `Invalid connector id "${connector.id}": use 2-24 lowercase letters, digits or underscores`,
    );
  }
  if (RESERVED_CONNECTOR_IDS.has(connector.id)) throw new Error(`Connector id "${connector.id}" is reserved`);
  if (connector.oauth) validateProvider(resolveProvider(connector.oauth));
  const seen = new Set<string>();
  for (const action of connector.actions) {
    if (!ACTION_NAME.test(action.name)) {
      throw new Error(`Invalid action name "${connector.id}.${action.name}": use lowercase snake_case`);
    }
    if (seen.has(action.name)) throw new Error(`Duplicate action "${connector.id}.${action.name}"`);
    seen.add(action.name);
    if (!action.description.trim())
      throw new Error(`Action "${connector.id}.${action.name}" needs a description`);
    const jsonProperties = (action.inputSchema?.properties ?? {}) as Record<string, unknown>;
    if (ACCOUNT_ARGUMENT in action.input.shape || ACCOUNT_ARGUMENT in jsonProperties) {
      throw new Error(
        `Action "${connector.id}.${action.name}" must not define an "${ACCOUNT_ARGUMENT}" input`,
      );
    }
  }
}
