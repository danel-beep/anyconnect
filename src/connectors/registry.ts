import { CAPABILITY_INTERFACES, getCapability } from './capabilities.js';
import { resolveProvider, validateProvider } from './oauth/providers.js';
import { actionCapabilities, actionRisk, type ConnectorDefinition, type RateLimitSpec } from './sdk.js';

const CONNECTOR_ID = /^[a-z][a-z0-9_]{1,23}$/;
const ACTION_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** Tool names starting with these are reserved for the hub's own and unified (capability) tools. */
// The hub's own setup connector, also under the product's former name (connectors may not import
// app code, so the names are spelled out here).
const RESERVED_CONNECTOR_IDS = new Set(['manyplug', 'anyconnect', 'hub', 'mcp', ...CAPABILITY_INTERFACES]);
/** Injected by the hub to pick an account, so actions cannot use it as an input name. */
export const ACCOUNT_ARGUMENT = 'account';
/** Injected by the hub for actions that declare `response.fields`: selects result fields. */
export const FIELDS_ARGUMENT = 'fields';
/** Input names the hub adds itself; connectors (and remote schemas, after renaming) must not use them. */
export const RESERVED_INPUTS: readonly string[] = [ACCOUNT_ARGUMENT, FIELDS_ARGUMENT];

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
    for (const reserved of RESERVED_INPUTS) {
      if (reserved in action.input.shape || reserved in jsonProperties) {
        throw new Error(`Action "${connector.id}.${action.name}" must not define an "${reserved}" input`);
      }
    }
  }
  validateRateLimit(connector.id, connector.rateLimit);
  const capabilities = new Map<string, string>();
  for (const action of connector.actions) {
    const where = `${connector.id}.${action.name}`;
    validateRateLimit(where, action.rateLimit);
    if (action.undo?.kind === 'action' && !seen.has(action.undo.action)) {
      throw new Error(`Action "${where}" names an unknown undo action "${action.undo.action}"`);
    }
    if (action.undo?.kind === 'delay' && !(action.undo.seconds > 0 && action.undo.seconds <= 600)) {
      throw new Error(`Action "${where}" has an undo delay outside 1-600 seconds`);
    }
    const risk = actionRisk(action);
    for (const binding of actionCapabilities(action)) {
      const capability = getCapability(binding.id);
      if (!capability) throw new Error(`Action "${where}" implements unknown capability "${binding.id}"`);
      if ((capability.risk === 'read') !== (risk === 'read')) {
        throw new Error(
          `Action "${where}" has risk "${risk}" but capability "${binding.id}" is ${capability.risk}-only`,
        );
      }
      const other = capabilities.get(binding.id);
      if (other) {
        throw new Error(
          `Capability "${binding.id}" is implemented twice in ${connector.id}: ${other}, ${action.name}`,
        );
      }
      capabilities.set(binding.id, action.name);
    }
  }
}

function validateRateLimit(where: string, limit: RateLimitSpec | undefined): void {
  if (!limit) return;
  if (!(Number.isInteger(limit.requests) && limit.requests > 0 && limit.perSeconds > 0)) {
    throw new Error(`Invalid rate limit for "${where}": requests and perSeconds must be positive`);
  }
}
