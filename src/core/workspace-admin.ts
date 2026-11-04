import { eq } from 'drizzle-orm';
import { resolveProvider } from '../connectors/oauth/providers.js';
import type { ConnectorRegistry, ConnectorResolver } from '../connectors/registry.js';
import type { ConnectorDefinition, ConnectorLogger, TestResult } from '../connectors/sdk.js';
import type { Db } from '../db/client.js';
import { type WorkspaceSettings, workspaces } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { AccountRow, AccountService, UpdateAccountInput } from './accounts.js';
import type { AddServiceInput, CustomServiceManager, ServiceView } from './custom-services.js';
import { getWorkspace } from './identity.js';
import type { OAuthAppService } from './oauth-apps.js';

/**
 * Workspace administration as plain operations: what the hub's setup tools (`anyconnect_*`) and,
 * later, the web panel do on behalf of the signed-in user. Everything a person would otherwise do in
 * a settings page is here, so the AI assistant can manage the hub end to end.
 *
 * Secrets never pass through here: connecting an account returns a link to the hub's own page,
 * where the user signs in with the provider or types the key.
 */

/** How an account of a service is connected. */
export type ConnectMethod =
  /** Sign in with the provider (Google, Microsoft…): the hub stores and refreshes the tokens. */
  | 'oauth'
  /** An API key, token or password typed into the hub's form. */
  | 'form'
  /** Nothing to enter. */
  | 'none';

export interface ServiceEntry {
  service: string;
  name: string;
  description: string;
  connect: ConnectMethod;
  /** OAuth services without an OAuth app configured cannot be connected yet. */
  ready: boolean;
  problem?: string;
  /** Added by this workspace (remote MCP server or HTTP manifest), not built in. */
  custom: boolean;
  accounts: number;
}

export interface ConnectLink {
  url: string;
  method: ConnectMethod;
  service: string;
}

/** `service:account`, `account` (when unambiguous) or an account id. */
export type AccountRef = string;

export class WorkspaceAdmin {
  constructor(
    private readonly deps: {
      db: Db;
      connectors: ConnectorResolver;
      /** Built-in services, listed to visitors who have not signed in yet. */
      builtin: ConnectorRegistry;
      accounts: AccountService;
      customServices: CustomServiceManager;
      apps: OAuthAppService;
      publicUrl: string;
      logger: ConnectorLogger;
    },
  ) {}

  // --- Services --------------------------------------------------------------

  connectMethod(connector: ConnectorDefinition): ConnectMethod {
    if (connector.oauth) return 'oauth';
    const fields =
      Object.keys(connector.credentials.shape).length + Object.keys(connector.config.shape).length;
    return fields > 0 ? 'form' : 'none';
  }

  /**
   * Every service the workspace can connect, with how and whether it is ready. Without a workspace
   * (a visitor who has not signed in) it lists the hub's built-in services.
   */
  async services(workspaceId: string | undefined, filter?: string): Promise<ServiceEntry[]> {
    const [connectors, accounts, custom] = workspaceId
      ? await Promise.all([
          this.deps.connectors.list(workspaceId),
          this.deps.accounts.list(workspaceId),
          this.deps.customServices.list(workspaceId),
        ])
      : [this.deps.builtin.all(), [], []];
    const customIds = new Set(custom.map((c) => c.connectorId));
    const query = filter?.trim().toLowerCase();
    const entries: ServiceEntry[] = [];
    for (const connector of connectors) {
      if (
        query &&
        !`${connector.id} ${connector.name} ${connector.description}`.toLowerCase().includes(query)
      ) {
        continue;
      }
      const method = this.connectMethod(connector);
      const problem = method === 'oauth' ? await this.oauthProblem(workspaceId, connector) : undefined;
      entries.push({
        service: connector.id,
        name: connector.name,
        description: connector.description,
        connect: method,
        ready: !problem,
        ...(problem ? { problem } : {}),
        custom: customIds.has(connector.id),
        accounts: accounts.filter((a) => a.connectorId === connector.id).length,
      });
    }
    return entries.sort((a, b) => b.accounts - a.accounts || a.name.localeCompare(b.name));
  }

  /** Why an OAuth service cannot be connected yet, if it cannot. */
  private async oauthProblem(
    workspaceId: string | undefined,
    connector: ConnectorDefinition,
  ): Promise<string | undefined> {
    const provider = resolveProvider(connector.oauth!);
    const app = workspaceId
      ? await this.deps.apps.pick(workspaceId, provider.id).catch(() => undefined)
      : this.deps.apps.hasHubApp(provider.id);
    if (app) return undefined;
    if (connector.oauth!.optional) return undefined; // a personal token in the form works too
    return `No ${provider.name} OAuth app is configured on this hub yet (the hub owner sets OAUTH_APP_${provider.id.toUpperCase()}_CLIENT_ID).`;
  }

  /**
   * How the browser connects an account of the service now: the provider's sign-in when an OAuth
   * app is available (or OAuth is the only way), otherwise the hub's form (API key, password).
   */
  async connectVia(workspaceId: string, connector: ConnectorDefinition): Promise<'oauth' | 'form'> {
    if (!connector.oauth) return 'form';
    const provider = resolveProvider(connector.oauth);
    const app = await this.deps.apps.pick(workspaceId, provider.id).catch(() => undefined);
    return app || !connector.oauth.optional ? 'oauth' : 'form';
  }

  async addService(workspaceId: string, input: AddServiceInput): Promise<ServiceView> {
    return this.deps.customServices.add(workspaceId, input);
  }

  async removeService(workspaceId: string, connectorId: string): Promise<void> {
    await this.deps.customServices.remove(workspaceId, connectorId);
  }

  // --- Accounts --------------------------------------------------------------

  /**
   * A link that connects (or re-connects) an account in the user's browser. The hub page asks for
   * whatever the service needs: the provider's sign-in, an API key, a QR code.
   */
  async connectLink(
    workspaceId: string,
    input: { service: string; label?: string; name?: string; reconnect?: AccountRef },
  ): Promise<ConnectLink> {
    const connector = await this.deps.connectors.get(workspaceId, input.service);
    if (!connector) throw badRequest(`Unknown service "${input.service}". List them with the services tool.`);
    let method = this.connectMethod(connector);
    if (method === 'oauth') {
      const problem = await this.oauthProblem(workspaceId, connector);
      if (problem) throw badRequest(problem);
      // Optional OAuth without an app: the link opens the form for a personal token.
      if ((await this.connectVia(workspaceId, connector)) === 'form') method = 'form';
    }
    const url = new URL(`/connect/${encodeURIComponent(connector.id)}`, this.deps.publicUrl);
    if (input.reconnect) {
      const account = await this.findAccount(workspaceId, input.reconnect, connector.id);
      url.searchParams.set('account', account.id);
    } else {
      if (input.name && (await this.deps.accounts.findByName(workspaceId, connector.id, input.name))) {
        throw badRequest(`${connector.name} already has an account named "${input.name}".`);
      }
      if (input.label) url.searchParams.set('label', input.label);
      if (input.name) url.searchParams.set('name', input.name);
    }
    return { url: url.toString(), method, service: connector.id };
  }

  async findAccount(workspaceId: string, ref: AccountRef, service?: string): Promise<AccountRow> {
    const all = await this.deps.accounts.list(workspaceId);
    const [first, second] = ref.includes(':') ? ref.split(':', 2) : [service, ref];
    const matches = all.filter(
      (a) => a.id === ref || (a.name === second && (first === undefined || a.connectorId === first)),
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw notFound(`Account "${ref}"`);
    throw badRequest(
      `"${ref}" is ambiguous: use one of ${matches.map((a) => `${a.connectorId}:${a.name}`).join(', ')}.`,
    );
  }

  async updateAccount(
    workspaceId: string,
    ref: AccountRef,
    change: {
      label?: string;
      description?: string | null;
      rename?: string;
      enabled?: boolean;
      disableTools?: string[];
      enableTools?: string[];
    },
  ): Promise<AccountRow> {
    const account = await this.findAccount(workspaceId, ref);
    const patch: UpdateAccountInput = {};
    if (change.label !== undefined) patch.label = change.label;
    if (change.description !== undefined) patch.description = change.description;
    if (change.rename !== undefined) patch.name = change.rename;
    if (change.enabled !== undefined) patch.enabled = change.enabled;
    if (change.disableTools?.length || change.enableTools?.length) {
      const disabled = new Set(account.settings.disabledActions ?? []);
      for (const name of change.disableTools ?? []) disabled.add(name);
      for (const name of change.enableTools ?? []) disabled.delete(name);
      patch.settings = { disabledActions: [...disabled] };
    }
    return this.deps.accounts.update(workspaceId, account.id, patch);
  }

  async removeAccount(workspaceId: string, ref: AccountRef): Promise<AccountRow> {
    const account = await this.findAccount(workspaceId, ref);
    await this.deps.accounts.delete(workspaceId, account.id);
    return account;
  }

  async testAccount(
    workspaceId: string,
    ref: AccountRef,
  ): Promise<{ account: AccountRow; test: TestResult }> {
    const account = await this.findAccount(workspaceId, ref);
    const test = await this.deps.accounts.test(workspaceId, account.id, this.deps.logger);
    return { account: await this.deps.accounts.get(workspaceId, account.id), test };
  }

  // --- Workspace settings ------------------------------------------------------

  async settings(workspaceId: string): Promise<WorkspaceSettings> {
    const workspace = await getWorkspace(this.deps.db, workspaceId);
    if (!workspace) throw notFound('Workspace');
    return workspace.settings;
  }

  async updateSettings(
    workspaceId: string,
    change: Pick<WorkspaceSettings, 'toolExposure' | 'toolListing'>,
  ): Promise<WorkspaceSettings> {
    const current = await this.settings(workspaceId);
    const next = {
      ...current,
      ...Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)),
    };
    await this.deps.db.update(workspaces).set({ settings: next }).where(eq(workspaces.id, workspaceId));
    return next;
  }
}
