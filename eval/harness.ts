import type { Principal } from '../src/core/principal.js';
import type { Catalog } from '../src/hub/catalog.js';
import type { ToolCallResult } from '../src/hub/result.js';
import { toolListTokens } from '../src/hub/tokens.js';
import { resultJson, startTestHub, type TestHub } from '../test/helpers.js';
import { ACCOUNTS, evalRegistry, resetOutbox } from './fixtures.js';

/**
 * Efficiency eval harness: a hub with the synthetic workspace from `fixtures.ts`, and an "agent
 * session" that counts the calls a model would make. A scripted agent uses a tool directly when it
 * is listed and otherwise finds it with `manyplug_search_tools` first — exactly what the hub
 * instructions tell real models to do. A live runner (planned) will replace the script with a real model.
 */
export interface EvalHub {
  hub: TestHub;
  principal: Principal;
  catalog(): Promise<Catalog>;
  close(): Promise<void>;
}

export async function startEvalHub(
  options: {
    services?: string[];
    listing?: 'auto' | 'direct' | 'discovery';
    env?: Record<string, string>;
  } = {},
): Promise<EvalHub> {
  const registry = evalRegistry(options.services);
  const hub = await startTestHub({
    connectors: registry,
    seed: false,
    ...(options.env ? { env: options.env } : {}),
  });
  const s = hub.services;
  const workspace = (await s.db.query.workspaces.findFirst())!;
  const user = (await s.db.query.users.findFirst())!;
  // The eval counts the agent's tool calls; confirmations happen outside them (in the chat or in
  // Telegram) and have their own tests, so the scripted agent's dangerous actions run at once.
  await s.database.pool.query(`UPDATE workspaces SET settings = settings || $1::jsonb WHERE id = $2`, [
    JSON.stringify({
      ...(options.listing ? { toolListing: options.listing } : {}),
      security: { defaultConfirm: 'never' },
    }),
    workspace.id,
  ]);
  for (const connector of registry.all()) {
    for (const [name, label, identity] of ACCOUNTS[connector.id] ?? []) {
      const row = await s.accounts.create(workspace.id, { connectorId: connector.id, name, label });
      await s.database.pool.query(`UPDATE accounts SET metadata = $1::jsonb WHERE id = $2`, [
        JSON.stringify({ identity }),
        row.id,
      ]);
    }
  }
  resetOutbox();
  const principal: Principal = {
    kind: 'api_token',
    userId: user.id,
    workspaceId: workspace.id,
    scopes: ['mcp'],
  };
  return {
    hub,
    principal,
    catalog: () => s.hub.getCatalog(principal),
    close: () => hub.close(),
  };
}

export interface Session {
  /** Calls made so far, as a model would count them (one per tool call). */
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  /** Raw call. */
  call(tool: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  /**
   * Uses a tool like a model following the hub instructions: directly when listed, otherwise
   * searched for first (once per tool) and run through `manyplug_call_tool`.
   */
  use(tool: string, args: Record<string, unknown>, searchQuery: string): Promise<ToolCallResult>;
  /** Several independent tools in one `manyplug_call_tools` step (searching unlisted ones first). */
  batch(
    calls: Array<{ tool: string; args: Record<string, unknown>; searchQuery: string }>,
  ): Promise<ToolCallResult>;
  listedTokens: number;
  listing: Catalog['listing'];
}

export function data(result: ToolCallResult): any {
  if (result.isError) throw new Error(`tool failed: ${JSON.stringify(result.content)}`);
  return resultJson(result);
}

export async function session(evalHub: EvalHub): Promise<Session> {
  const catalog = await evalHub.catalog();
  const listed = new Set(catalog.listed.map((t) => t.name));
  const found = new Set<string>();
  const calls: Session['calls'] = [];
  const call = (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    return evalHub.hub.services.hub.callTool(evalHub.principal, catalog, tool, args);
  };
  /** Finds unlisted tools with one search (as a model would phrase one query for several needs). */
  const discover = async (needed: Array<{ tool: string; searchQuery: string }>) => {
    const missing = needed.filter((n) => !listed.has(n.tool) && !found.has(n.tool));
    if (missing.length === 0) return;
    const query = missing.map((m) => m.searchQuery).join(', ');
    const result = data(
      await call('manyplug_search_tools', { query, limit: Math.max(5, missing.length * 3) }),
    );
    const names = (result.tools as Array<{ name: string }>).map((t) => t.name);
    for (const name of names) found.add(name);
    const lost = missing.filter((m) => !found.has(m.tool));
    if (lost.length)
      throw new Error(`search "${query}" did not find ${lost.map((l) => l.tool)}: ${names.join(', ')}`);
  };
  return {
    calls,
    call,
    listedTokens: toolListTokens(catalog.listed),
    listing: catalog.listing,
    async use(tool, args, searchQuery) {
      await discover([{ tool, searchQuery }]);
      return listed.has(tool)
        ? call(tool, args)
        : call('manyplug_call_tool', { name: tool, arguments: args });
    },
    async batch(items) {
      await discover(items);
      return call('manyplug_call_tools', {
        calls: items.map((i) => ({ name: i.tool, arguments: i.args })),
      });
    },
  };
}
