import { and, asc, eq } from 'drizzle-orm';
import { defineManifestConnector } from '../connectors/manifest/compile.js';
import type { HttpManifestInput } from '../connectors/manifest/schema.js';
import {
  defineRemoteMcpConnector,
  type RemoteMcpAuth,
  type RemoteMcpTool,
} from '../connectors/mcp-remote/connector.js';
import { type ConnectorRegistry, type ConnectorResolver, validateConnector } from '../connectors/registry.js';
import { actionRisk, type ConnectorDefinition, type RiskLevel } from '../connectors/sdk.js';
import type { Db } from '../db/client.js';
import { customConnectors } from '../db/schema.js';
import type { Logger } from '../logger.js';

export type CustomConnectorRow = typeof customConnectors.$inferSelect;

/** What is stored for a remote MCP server (the tool list is kept in its own column). */
export interface RemoteMcpDefinition {
  name: string;
  description: string;
  instructions?: string;
  url: string;
  auth: RemoteMcpAuth;
  /** Risk the workspace set per action name (overrides the server's annotations). */
  toolRisk?: Record<string, RiskLevel>;
}

/** Builds the connector of a stored row. Throws when the stored definition is no longer valid. */
export function compileCustomConnector(row: CustomConnectorRow): ConnectorDefinition {
  let connector: ConnectorDefinition;
  if (row.kind === 'mcp') {
    const definition = row.definition as unknown as RemoteMcpDefinition;
    connector = defineRemoteMcpConnector({
      id: row.connectorId,
      ...definition,
      tools: (row.tools ?? []) as RemoteMcpTool[],
    });
  } else {
    const compiled = defineManifestConnector({
      ...(row.definition as HttpManifestInput),
      id: row.connectorId,
    });
    // An API the user described: the hub does not know who reads what its write actions receive,
    // so right after reading another account they ask (the `publishes` tag, see the SDK).
    connector = {
      ...compiled,
      actions: compiled.actions.map((action) =>
        actionRisk(action) === 'write' && !action.tags?.includes('publishes')
          ? { ...action, tags: [...(action.tags ?? []), 'publishes' as const] }
          : action,
      ),
    };
  }
  validateConnector(connector);
  return connector;
}

/**
 * Loads and compiles the services users defined in their workspaces. Compiled connectors are cached
 * per row version, so the catalog pays one indexed query per request, not a recompilation.
 */
export class CustomConnectorStore {
  private readonly cache = new Map<string, { version: number; connector: ConnectorDefinition | null }>();

  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  async rows(workspaceId: string): Promise<CustomConnectorRow[]> {
    return this.db
      .select()
      .from(customConnectors)
      .where(eq(customConnectors.workspaceId, workspaceId))
      .orderBy(asc(customConnectors.createdAt));
  }

  async row(workspaceId: string, connectorId: string): Promise<CustomConnectorRow | undefined> {
    const [row] = await this.db
      .select()
      .from(customConnectors)
      .where(
        and(eq(customConnectors.workspaceId, workspaceId), eq(customConnectors.connectorId, connectorId)),
      )
      .limit(1);
    return row;
  }

  compiled(row: CustomConnectorRow): ConnectorDefinition | undefined {
    const version = row.updatedAt.getTime();
    const cached = this.cache.get(row.id);
    if (cached && cached.version === version) return cached.connector ?? undefined;
    let connector: ConnectorDefinition | null = null;
    try {
      connector = compileCustomConnector(row);
    } catch (error) {
      this.logger.warn({ err: error, service: row.connectorId }, 'stored service definition is invalid');
    }
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(row.id, { version, connector });
    return connector ?? undefined;
  }

  async list(workspaceId: string): Promise<ConnectorDefinition[]> {
    return (await this.rows(workspaceId)).map((row) => this.compiled(row)).filter((c) => c !== undefined);
  }

  async get(workspaceId: string, connectorId: string): Promise<ConnectorDefinition | undefined> {
    const row = await this.row(workspaceId, connectorId);
    return row ? this.compiled(row) : undefined;
  }
}

/**
 * The connectors a workspace sees: built-in ones plus the services its users defined. Built-in ids
 * always win, so a user-defined service can never impersonate a built-in one.
 */
export class WorkspaceConnectorResolver implements ConnectorResolver {
  constructor(
    readonly builtin: ConnectorRegistry,
    private readonly custom: CustomConnectorStore,
  ) {}

  async list(workspaceId: string): Promise<ConnectorDefinition[]> {
    const builtin = this.builtin.all();
    const ids = new Set(builtin.map((c) => c.id));
    const custom = (await this.custom.list(workspaceId)).filter((c) => !ids.has(c.id));
    return [...builtin, ...custom];
  }

  async get(workspaceId: string, connectorId: string): Promise<ConnectorDefinition | undefined> {
    return (await this.builtin.get(workspaceId, connectorId)) ?? this.custom.get(workspaceId, connectorId);
  }
}
