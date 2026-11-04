import { z } from 'zod';
import type {
  ActionContext,
  ActionDefinition,
  ActionHints,
  ActionResult,
  AnyObjectSchema,
  ConnectorDefinition,
  RiskLevel,
} from '../connectors/sdk.js';
import { ACCOUNT_NAME } from '../core/accounts.js';
import { AddMcpServerInput } from '../core/custom-services.js';
import type { Principal } from '../core/principal.js';
import type { WorkspaceAdmin } from '../core/workspace-admin.js';

/**
 * The hub's own setup tools (`anyconnect_*`): after connecting the hub once, the user manages
 * everything else from their AI assistant — connect accounts, add services, rename, disable tools,
 * change settings. They form the connector `anyconnect`, whose actions run on the workspace instead
 * of an account, so they go through the same executor stages as every other call: audit, access
 * rules, confirmation, duplicate protection.
 *
 * Rules: secrets never pass through the chat (connecting returns a link to the hub's page);
 * anything that removes data or adds a new destination for data is `dangerous` and always needs the
 * user's confirmation (`requiresConfirmation`, which access rules cannot turn off). Access rules,
 * personas, AI clients and sign-in security are deliberately not editable from the chat: an AI must
 * not be able to lift its own restrictions.
 */

export const SETUP_CONNECTOR_ID = 'anyconnect';

/** What setup actions run with (instead of an account's connector context). */
export interface SetupContext {
  principal: Principal;
  admin: WorkspaceAdmin;
  signal: AbortSignal;
}

interface SetupActionSpec<TInput extends AnyObjectSchema> {
  name: string;
  title: string;
  description: string;
  input: TInput;
  risk: RiskLevel;
  requiresConfirmation?: boolean;
  hints?: ActionHints;
  run(input: z.output<TInput>, ctx: SetupContext): Promise<ActionResult>;
}

/**
 * The one place where a setup action meets the connector action shape: the hub invokes workspace
 * units with a {@link SetupContext} (see `Hub.invoke`), never with an account context.
 */
function setupAction<TInput extends AnyObjectSchema>(spec: SetupActionSpec<TInput>): ActionDefinition {
  const { run, ...rest } = spec;
  return {
    ...rest,
    run: (input: unknown, ctx: ActionContext<unknown, unknown>) =>
      run(input as z.output<TInput>, ctx as unknown as SetupContext),
  };
}

const accountRef = z.string().min(1).describe('"service:account", e.g. "gmail:work"');

const accountView = (a: {
  connectorId: string;
  name: string;
  label: string;
  enabled: boolean;
  status: string;
  statusMessage: string | null;
  settings: { disabledActions?: string[] };
}) => ({
  account: `${a.connectorId}:${a.name}`,
  label: a.label,
  enabled: a.enabled,
  status: a.enabled ? a.status : 'disabled',
  ...(a.statusMessage ? { statusMessage: a.statusMessage } : {}),
  ...(a.settings.disabledActions?.length ? { disabledTools: a.settings.disabledActions } : {}),
});

const NEW_TOOLS_HINT =
  'New tools work right away through anyconnect_search_tools and anyconnect_call_tool; some apps show them in their tool list only after reconnecting.';

export const SETUP_ACTIONS: ActionDefinition[] = [
  setupAction({
    name: 'services',
    title: 'Services to connect',
    description:
      'Lists services that can be connected, how (oauth, form, none) and how many accounts each has.',
    input: z.object({ query: z.string().optional() }),
    risk: 'read',
    hints: { readOnly: true, openWorld: false },
    async run({ query }, ctx) {
      const services = await ctx.admin.services(ctx.principal.workspaceId, query);
      return {
        services,
        hint: 'Connect one with anyconnect_connect_account. Any other MCP server can be added with anyconnect_add_service.',
      };
    },
  }),
  setupAction({
    name: 'connect_account',
    title: 'Connect an account',
    description:
      'Returns a link for the user to connect (or reconnect) an account of a service. Never ask for passwords or keys in the chat.',
    input: z.object({
      service: z.string().min(1).describe('Service id, e.g. "gmail"'),
      label: z.string().trim().min(1).max(100).optional().describe('e.g. "Work mail"'),
      name: z.string().regex(ACCOUNT_NAME).optional().describe('Short key, e.g. "work"'),
      reconnect: accountRef.optional().describe('Existing account to reconnect'),
    }),
    risk: 'read',
    hints: { readOnly: true, openWorld: false },
    async run(input, ctx) {
      const link = await ctx.admin.connectLink(ctx.principal.workspaceId, input);
      return {
        url: link.url,
        method: link.method,
        instructions: `Ask the user to open the link and finish there${link.method === 'oauth' ? ' (sign in with the provider)' : ''}. Then check with anyconnect_list_accounts. ${NEW_TOOLS_HINT}`,
      };
    },
  }),
  setupAction({
    name: 'update_account',
    title: 'Change an account',
    description: 'Renames or relabels an account, turns it on or off, or hides / shows some of its tools.',
    input: z.object({
      account: accountRef,
      label: z.string().trim().min(1).max(100).optional(),
      description: z.string().trim().max(500).nullable().optional(),
      rename: z.string().regex(ACCOUNT_NAME).optional(),
      enabled: z.boolean().optional(),
      disable_tools: z.array(z.string()).optional().describe('Action names, e.g. ["send"]'),
      enable_tools: z.array(z.string()).optional(),
    }),
    risk: 'write',
    hints: { idempotent: true, openWorld: false },
    async run({ account, disable_tools, enable_tools, ...change }, ctx) {
      const row = await ctx.admin.updateAccount(ctx.principal.workspaceId, account, {
        ...change,
        ...(disable_tools ? { disableTools: disable_tools } : {}),
        ...(enable_tools ? { enableTools: enable_tools } : {}),
      });
      return { updated: accountView(row) };
    },
  }),
  setupAction({
    name: 'test_account',
    title: 'Check an account',
    description: 'Checks that an account still works.',
    input: z.object({ account: accountRef }),
    risk: 'read',
    hints: { readOnly: true, idempotent: true },
    async run({ account }, ctx) {
      const { account: row, test } = await ctx.admin.testAccount(ctx.principal.workspaceId, account);
      return {
        ...accountView(row),
        ok: test.ok,
        ...(test.message ? { message: test.message } : {}),
        ...(test.identity ? { identity: test.identity } : {}),
        ...(test.ok ? {} : { hint: 'Reconnect it with anyconnect_connect_account and "reconnect".' }),
      };
    },
  }),
  setupAction({
    name: 'remove_account',
    title: 'Remove an account',
    description: 'Deletes an account and its credentials. The user always confirms.',
    input: z.object({ account: accountRef }),
    risk: 'dangerous',
    requiresConfirmation: true,
    hints: { destructive: true, openWorld: false },
    async run({ account }, ctx) {
      const row = await ctx.admin.removeAccount(ctx.principal.workspaceId, account);
      return { removed: `${row.connectorId}:${row.name}` };
    },
  }),
  setupAction({
    name: 'add_service',
    title: 'Add a service',
    description:
      'Adds a remote MCP server (mcp_url) or an HTTP API manifest as a new service. The user always confirms.',
    input: z.object({
      mcp_url: z.url().optional(),
      name: z.string().trim().min(1).max(60).optional(),
      manifest: z.record(z.string(), z.unknown()).optional(),
    }),
    risk: 'dangerous',
    requiresConfirmation: true,
    hints: { destructive: false, openWorld: true },
    async run({ mcp_url, name, manifest }, ctx) {
      if (Boolean(mcp_url) === Boolean(manifest)) {
        return { error: 'Pass either mcp_url (with name) or manifest.' };
      }
      const view = mcp_url
        ? await ctx.admin.addService(
            ctx.principal.workspaceId,
            AddMcpServerInput.parse({ kind: 'mcp', url: mcp_url, name: name ?? new URL(mcp_url).hostname }),
          )
        : await ctx.admin.addService(ctx.principal.workspaceId, { kind: 'manifest', manifest: manifest! });
      return {
        added: { service: view.connectorId, name: view.name, auth: view.auth, tools: view.tools },
        next: `Connect an account: anyconnect_connect_account with service "${view.connectorId}".`,
      };
    },
  }),
  setupAction({
    name: 'remove_service',
    title: 'Remove a service',
    description: 'Removes an added service (after its accounts). The user always confirms.',
    input: z.object({ service: z.string().min(1) }),
    risk: 'dangerous',
    requiresConfirmation: true,
    hints: { destructive: true, openWorld: false },
    async run({ service }, ctx) {
      await ctx.admin.removeService(ctx.principal.workspaceId, service);
      return { removed: service };
    },
  }),
  setupAction({
    name: 'update_settings',
    title: 'Change hub settings',
    description:
      'Changes how tools are listed: tool_listing auto / direct (all) / discovery (search); tool_exposure grouped / per_account.',
    input: z.object({
      tool_listing: z.enum(['auto', 'direct', 'discovery']).optional(),
      tool_exposure: z.enum(['grouped', 'per_account']).optional(),
    }),
    risk: 'write',
    hints: { idempotent: true, openWorld: false },
    async run({ tool_listing, tool_exposure }, ctx) {
      const settings = await ctx.admin.updateSettings(ctx.principal.workspaceId, {
        ...(tool_listing ? { toolListing: tool_listing } : {}),
        ...(tool_exposure ? { toolExposure: tool_exposure } : {}),
      });
      return {
        settings: {
          tool_listing: settings.toolListing ?? 'auto',
          tool_exposure: settings.toolExposure ?? 'grouped',
        },
        hint: 'Takes effect on the next tool list; reconnecting the app may be needed to see it.',
      };
    },
  }),
];

/** The setup tools as a connector, so the catalog and the executor treat them like any other. */
export const SETUP_CONNECTOR: ConnectorDefinition = {
  id: SETUP_CONNECTOR_ID,
  name: 'AnyConnect',
  description: 'Setting up this hub: services, accounts and settings.',
  version: '1.0.0',
  config: z.object({}),
  credentials: z.object({}),
  actions: SETUP_ACTIONS,
};
