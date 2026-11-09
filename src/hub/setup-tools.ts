import { z } from 'zod';
import { BRAND, LEGACY_SLUGS } from '../brand.js';
import type {
  ActionContext,
  ActionDefinition,
  ActionHints,
  ActionResult,
  AnyObjectSchema,
  ConnectorDefinition,
  RiskAssessment,
  RiskLevel,
} from '../connectors/sdk.js';
import { ACCOUNT_NAME } from '../core/accounts.js';
import { AddMcpServerInput } from '../core/custom-services.js';
import type { Principal } from '../core/principal.js';
import {
  ACCESS_LEVELS,
  CONFIRM_IN,
  CONFIRM_LEVELS,
  type ConnectLink,
  type RuleChange,
  type RulesOverview,
  type WorkspaceAdmin,
} from '../core/workspace-admin.js';
import { AppError, badRequest } from '../lib/errors.js';
import { aiKeyActions } from './ai-key-tools.js';
import { appActions, type WorkspaceApps } from './app-tools.js';
import { billingActions, referralActions, type WorkspaceBilling } from './billing-tools.js';
import type { CatalogAllow } from './catalog-types.js';
import { profileActions, type WorkspaceProfiles } from './profile-tools.js';
import { securityActions, type UserSecurity } from './security-tools.js';
import { TEAM_ONLY_ACTIONS, teamActions } from './team-tools.js';
import { triggerActions, type WorkspaceTriggers } from './trigger-tools.js';

/**
 * The hub's own setup tools (`manyplug_*`): after connecting the hub once, the user manages
 * everything else from their AI assistant — connect accounts, add services, rename, disable tools,
 * set access rules, change settings. They form the connector `manyplug`, whose actions run on the
 * workspace instead of an account, so they go through the same executor stages as every other
 * call: audit, access rules, confirmation, duplicate protection.
 *
 * Rules: secrets never pass through the chat (connecting returns a link to the hub's page);
 * anything that removes data or adds a new destination for data is `dangerous` and always needs the
 * user's confirmation (`requiresConfirmation`, which access rules cannot turn off). An AI must not
 * lift its own restrictions: a change that tightens access rules applies at once, but one that
 * loosens them anywhere (more access, fewer confirmations, a shorter undo window, a tool or account
 * turned back on) is held for the user's confirmation (`assessRisk` with `confirm`), which only the
 * user can give, in the chat's own prompt, in Telegram or on the hub's page. The same goes for
 * access profiles (`profile-tools.ts`): narrowing one applies at once, widening one waits. Sign-in
 * security stays on the website.
 */

export const SETUP_CONNECTOR_ID = BRAND.slug;

/** Whether a connector id is the hub's own setup connector (also under the product's former name). */
export const isSetupConnector = (id: string): boolean =>
  id === SETUP_CONNECTOR_ID || LEGACY_SLUGS.includes(id);

/** What setup actions run with (instead of an account's connector context). */
export interface SetupContext {
  principal: Principal;
  admin: WorkspaceAdmin;
  /** Plans and payments (`billing-tools.ts`); absent in hubs built without billing. */
  billing?: WorkspaceBilling;
  /** Access profiles (`profile-tools.ts`); absent in hubs built without the security layer. */
  profiles?: WorkspaceProfiles;
  /** AI apps (`app-tools.ts`); absent in hubs built without the security layer. */
  apps?: WorkspaceApps;
  /** The user's sign-in security, read only (`security-tools.ts`). */
  security?: UserSecurity;
  /** Triggers and the "anything new?" check (`trigger-tools.ts`); absent in hubs built without them. */
  triggers?: WorkspaceTriggers;
  signal: AbortSignal;
}

export interface SetupActionSpec<TInput extends AnyObjectSchema> {
  name: string;
  title: string;
  description: string;
  input: TInput;
  risk: RiskLevel;
  requiresConfirmation?: boolean;
  hints?: ActionHints;
  tags?: ActionDefinition['tags'];
  /** Raises the risk of one call or holds it for the user (see `ActionDefinition.assessRisk`). */
  assessRisk?(input: z.output<TInput>, ctx: SetupContext): Promise<RiskAssessment | undefined>;
  run(input: z.output<TInput>, ctx: SetupContext): Promise<ActionResult>;
}

/**
 * The one place where a setup action meets the connector action shape: the hub invokes workspace
 * units with a {@link SetupContext} (see `Hub.invoke`), never with an account context.
 */
export function setupAction<TInput extends AnyObjectSchema>(spec: SetupActionSpec<TInput>): ActionDefinition {
  const { run, assessRisk, ...rest } = spec;
  return {
    ...rest,
    ...(assessRisk
      ? {
          assessRisk: (input: unknown, ctx: ActionContext<unknown, unknown>) =>
            assessRisk(input as z.output<TInput>, ctx as unknown as SetupContext),
        }
      : {}),
    run: (input: unknown, ctx: ActionContext<unknown, unknown>) =>
      run(input as z.output<TInput>, ctx as unknown as SetupContext),
  };
}

export const accountRef = z.string().min(1).describe('"service:account", e.g. "gmail:work"');

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

/** The hub's own settings as a policy target (setup tools act on no account). */
const HUB_TARGET = { connectorId: SETUP_CONNECTOR_ID, accountId: null };

const LEVELS = {
  access:
    'none: no access · read: only reading · write: reading and changes · full: everything, including sending and deleting',
  confirm:
    'when the app asks the user first: never · dangerous: before sending, deleting and other risky actions · write: before any change · always: before everything, reading too',
  confirm_in:
    'where the user confirms: link: on a Manyplug page or in Telegram, outside the chat · chat: by answering the AI app in the chat (changes to the hub that lower protection still use the link)',
};

/** The rules for the AI: defaults, rules for apps and accounts, and what applies to the caller. */
function rulesView(o: RulesOverview) {
  return {
    defaults: {
      access: o.defaults.defaultAccess,
      confirm: o.defaults.defaultConfirm,
      confirm_in: o.defaults.confirmIn,
      undo_window_seconds: o.defaults.undoWindowSeconds,
    },
    rules: o.rules,
    ...(o.otherRules
      ? { other_rules: `${o.otherRules} more (for personas or whole services), managed on the website` }
      : {}),
    apps: o.apps.map((a) => ({ app: a.name, id: a.id, ...(a.current ? { this_app: true } : {}) })),
    for_this_app: o.accounts,
    levels: LEVELS,
  };
}

const RuleInput = z.object({
  app: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('AI app name or id, or "this" for the app making this call. Leave out for every app.'),
  account: accountRef.optional().describe('Leave out for every account.'),
  access: z.enum(ACCESS_LEVELS).nullable().optional().describe('null: back to the default'),
  confirm: z.enum(CONFIRM_LEVELS).nullable().optional().describe('null: back to the default'),
  undo_window_seconds: z
    .number()
    .int()
    .min(0)
    .max(3600)
    .optional()
    .describe('Defaults only: seconds before a change runs, to cancel it'),
  confirm_in: z.enum(CONFIRM_IN).optional(),
});

/** The change a `set_rule` call asks for; throws a user-safe error for a call that makes no sense. */
async function ruleChangeOf(input: z.output<typeof RuleInput>, ctx: SetupContext): Promise<RuleChange> {
  const { app, account, access, confirm, undo_window_seconds, confirm_in } = input;
  if (
    access === undefined &&
    confirm === undefined &&
    undo_window_seconds === undefined &&
    confirm_in === undefined
  ) {
    throw badRequest('Set access, confirm, confirm_in or undo_window_seconds.');
  }
  if (!app && !account) {
    if (access === null || confirm === null) throw badRequest('The defaults can be changed, not removed.');
    await ctx.admin.authorize(ctx.principal, 'admin');
    return {
      kind: 'defaults',
      access,
      confirm,
      undoWindowSeconds: undo_window_seconds,
      confirmIn: confirm_in,
    };
  }
  if (undo_window_seconds !== undefined || confirm_in !== undefined) {
    throw badRequest(
      'The undo window and where to confirm are set for everything at once: leave out app and account.',
    );
  }
  const workspaceId = ctx.principal.workspaceId;
  let aiClientId: string | null = null;
  if (app?.toLowerCase() === 'this') {
    if (!ctx.principal.aiClientId)
      throw badRequest('This connection is not linked to an AI app; name the app.');
    aiClientId = ctx.principal.aiClientId;
  } else if (app) {
    aiClientId = (await ctx.admin.findAiClient(workspaceId, app)).id;
  }
  // In a team a rule on one account is its owner's to set; a rule for every account is the admins'.
  let accountId: string | null = null;
  if (account) accountId = (await ctx.admin.accountFor(ctx.principal, account, { manage: true })).id;
  else await ctx.admin.authorize(ctx.principal, 'admin');
  return { kind: 'rule', aiClientId, accountId, access, confirm };
}

/** Short description of what a loosening change does, shown when the user is asked to confirm. */
function looseningReason(input: z.output<typeof RuleInput>, kinds: Set<string>): string {
  const who = [
    input.app ? `app ${input.app}` : 'every app',
    input.account ? `on ${input.account}` : 'on every account',
  ];
  const what = [
    ...(kinds.has('access') ? ['may do more'] : []),
    ...(kinds.has('confirm') ? ['asks before fewer actions'] : []),
    ...(kinds.has('confirm_in') ? ['asks for confirmation in the chat instead of on a Manyplug page'] : []),
    ...(kinds.has('undo') ? ['gets a shorter undo window'] : []),
  ];
  return `Lowers your protection: ${who.join(' ')} ${what.join(', ')}`;
}

const NEW_TOOLS_HINT =
  'New tools work right away through manyplug_search_tools and manyplug_call_tool; some apps show them in their tool list only after reconnecting.';

/** What the user does on the connect page, by how it connects the service. */
const CONNECT_STEPS: Record<ConnectLink['method'], string> = {
  oauth: ' (sign in with the provider)',
  form: '',
  none: '',
  app: ' (scan the QR code with their phone and confirm on the page; no password or key is needed)',
};

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
        hint: 'Connect one with manyplug_connect_account. Any other MCP server can be added with manyplug_add_service.',
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
      for_team: z
        .boolean()
        .optional()
        .describe('Teams, admins only: an account of the whole team instead of the user’s own'),
    }),
    risk: 'read',
    hints: { readOnly: true, openWorld: false },
    async run({ for_team, ...input }, ctx) {
      const link = await ctx.admin.connectLink(ctx.principal, {
        ...input,
        ...(for_team ? { forTeam: true } : {}),
      });
      return {
        url: link.url,
        method: link.method,
        instructions: `Ask the user to open the link and finish there${CONNECT_STEPS[link.method]}. Then check with manyplug_list_accounts. ${NEW_TOOLS_HINT}`,
      };
    },
  }),
  setupAction({
    name: 'update_account',
    title: 'Change an account',
    description:
      'Renames or relabels an account, turns it on or off, or hides / shows some of its tools. Turning back on what the user turned off waits for their confirmation.',
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
    // Turning back on what the user turned off lifts a restriction: the user confirms it.
    async assessRisk({ account, enabled, enable_tools }, ctx) {
      if (enabled !== true && !enable_tools?.length) return undefined;
      const row = await ctx.admin.accountFor(ctx.principal, account, { manage: true }).catch(() => undefined);
      if (!row) return undefined; // run() reports the unknown account
      const disabled = new Set(row.settings.disabledActions ?? []);
      const back = (enable_tools ?? []).filter((name) => disabled.has(name));
      const ref = `${row.connectorId}:${row.name}`;
      if (enabled === true && !row.enabled) {
        return { risk: 'write', confirm: true, reason: `Turns account ${ref} back on` };
      }
      if (back.length) {
        return { risk: 'write', confirm: true, reason: `Turns tools of ${ref} back on: ${back.join(', ')}` };
      }
      return undefined;
    },
    async run({ account, disable_tools, enable_tools, ...change }, ctx) {
      const target = await ctx.admin.accountFor(ctx.principal, account, { manage: true });
      const row = await ctx.admin.updateAccount(ctx.principal.workspaceId, target.id, {
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
      const target = await ctx.admin.accountFor(ctx.principal, account);
      const { account: row, test } = await ctx.admin.testAccount(ctx.principal.workspaceId, target.id);
      return {
        ...accountView(row),
        ok: test.ok,
        ...(test.message ? { message: test.message } : {}),
        ...(test.identity ? { identity: test.identity } : {}),
        ...(test.ok ? {} : { hint: 'Reconnect it with manyplug_connect_account and "reconnect".' }),
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
      const target = await ctx.admin.accountFor(ctx.principal, account, { manage: true });
      const row = await ctx.admin.removeAccount(ctx.principal.workspaceId, target.id);
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
      await ctx.admin.authorize(ctx.principal, 'admin');
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
        next: `Connect an account: manyplug_connect_account with service "${view.connectorId}".`,
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
      await ctx.admin.authorize(ctx.principal, 'admin');
      await ctx.admin.removeService(ctx.principal.workspaceId, service);
      return { removed: service };
    },
  }),
  setupAction({
    name: 'rules',
    title: 'Show access rules',
    description:
      'Shows what each AI app may do on each account and when it asks the user first: defaults, rules and what applies to this app.',
    input: z.object({}),
    risk: 'read',
    hints: { readOnly: true, openWorld: false },
    async run(_input, ctx) {
      return rulesView(await ctx.admin.rulesOverview(ctx.principal));
    },
  }),
  setupAction({
    name: 'set_rule',
    title: 'Change an access rule',
    description:
      'Sets what an AI app may do (access), when it asks the user first (confirm) and where: link or in the chat (confirm_in, defaults only) for one app and/or one account, or the defaults when neither is given. null returns a value to the default. Tightening applies at once; anything that loosens protection waits for the user’s confirmation.',
    input: RuleInput,
    risk: 'write',
    hints: { idempotent: true, openWorld: false },
    async assessRisk(input, ctx) {
      let change: RuleChange;
      try {
        change = await ruleChangeOf(input, ctx);
      } catch (error) {
        if (error instanceof AppError) return undefined; // run() reports the same problem
        throw error;
      }
      try {
        const loosened = await ctx.admin.ruleLoosenings(ctx.principal.workspaceId, change, [HUB_TARGET]);
        if (!loosened.length) return undefined;
        return {
          risk: 'dangerous',
          confirm: true,
          reason: looseningReason(input, new Set(loosened.map((l) => l.change))),
        };
      } catch {
        // Fail closed: if the check cannot run, the user decides.
        return { risk: 'dangerous', confirm: true, reason: 'Changes your access rules' };
      }
    },
    async run(input, ctx) {
      await ctx.admin.changeRule(ctx.principal.workspaceId, await ruleChangeOf(input, ctx));
      return { saved: true, ...rulesView(await ctx.admin.rulesOverview(ctx.principal)) };
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
      await ctx.admin.authorize(ctx.principal, 'admin');
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
  ...profileActions(setupAction),
  ...billingActions(setupAction),
  // Rarely needed: listed after the rest while they fit, always found by search. The team tools
  // show only inside a team (but the overview), where the access profile tools give them room.
  // A scheduled check that uses `check_triggers` keeps it listed (most used tools stay listed).
  ...appActions(setupAction),
  ...triggerActions(setupAction),
  ...teamActions(setupAction),
  ...securityActions(setupAction),
  ...referralActions(setupAction),
  // Changed once or twice after the key is pasted: last, so they never push team tools out.
  ...aiKeyActions(setupAction),
];

/** Setup tools a team's shared connection still sees: reading only (it cannot change the setup). */
const SHARED_CONNECTION_TOOLS: ReadonlySet<string> = new Set(['services', 'rules', 'plan', 'team']);
/**
 * Setup tools that, in a team, only its owner and admins may use (their `run` checks it too): they
 * are not offered to other members, so the AI does not suggest what would be refused.
 */
const TEAM_ADMIN_TOOLS: ReadonlySet<string> = new Set([
  'invite_member',
  'remove_member',
  'add_service',
  'remove_service',
  'update_settings',
  // An AI app of a team is everyone's who uses it: renaming or disconnecting it affects them all.
  'rename_app',
  'disconnect_app',
  // A trigger acts for the whole team's setup: the team's admins add and change them.
  'create_trigger',
  'update_trigger',
  'delete_trigger',
]);
/**
 * Setup tools for what teams do not have yet: access profiles (`/mcp/<profile>` addresses belong
 * to a person's own workspace).
 */
const NOT_IN_TEAMS: ReadonlySet<string> = new Set([
  'access_profiles',
  'create_access_profile',
  'update_access_profile',
  'delete_access_profile',
]);

/**
 * Wraps a catalog filter for teams: the team tools appear only to members of a team, admin tools
 * only to its owner and admins, and a team's shared connection sees no setup tool that changes
 * anything.
 */
export function teamCatalogFilter(
  base: ((caller: Principal) => Promise<CatalogAllow | undefined> | CatalogAllow | undefined) | undefined,
  team: (caller: Principal) => Promise<{ member?: unknown; admin?: boolean } | undefined>,
): (caller: Principal) => Promise<CatalogAllow> {
  return async (caller) => {
    const [allow, view] = await Promise.all([base?.(caller), team(caller)]);
    return (connector, action, account) => {
      if (account === undefined && isSetupConnector(connector.id)) {
        if (TEAM_ONLY_ACTIONS.has(action.name) && !view?.member) return false;
        if (view && NOT_IN_TEAMS.has(action.name)) return false;
        if (view && !view.member && !SHARED_CONNECTION_TOOLS.has(action.name)) return false;
        if (view?.member && !view.admin && TEAM_ADMIN_TOOLS.has(action.name)) return false;
      }
      return allow ? allow(connector, action, account) : true;
    };
  };
}

/** The setup tools as a connector, so the catalog and the executor treat them like any other. */
export const SETUP_CONNECTOR: ConnectorDefinition = {
  id: SETUP_CONNECTOR_ID,
  name: BRAND.name,
  description: 'Setting up this hub: services, accounts, access rules and profiles, settings and the plan.',
  version: '1.0.0',
  config: z.object({}),
  credentials: z.object({}),
  actions: SETUP_ACTIONS,
};
