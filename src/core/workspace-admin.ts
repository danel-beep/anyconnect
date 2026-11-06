import { eq } from 'drizzle-orm';
import { resolveProvider } from '../connectors/oauth/providers.js';
import type { ConnectorRegistry, ConnectorResolver } from '../connectors/registry.js';
import type { ConnectorDefinition, ConnectorLogger, TestResult } from '../connectors/sdk.js';
import type { Db } from '../db/client.js';
import {
  type AccessLevel,
  type ConfirmLevel,
  type SecuritySettings,
  type ShareLevel,
  type WorkspaceSettings,
  workspaces,
} from '../db/schema.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import type { AiClientRow, AiClientService } from '../security/clients.js';
import { isTeamAdmin } from '../security/members.js';
import { DEFAULT_SECURITY, type Loosening, type PolicyTarget, type RuleChange } from '../security/policy.js';
import type { PolicyService } from '../security/policy-service.js';
import type { AccountRow, AccountService, UpdateAccountInput } from './accounts.js';
import type { AddServiceInput, CustomServiceManager, ServiceView } from './custom-services.js';
import { getWorkspace } from './identity.js';
import type { OAuthAppService } from './oauth-apps.js';
import type { Principal } from './principal.js';
import type { QuickConnects } from './quick-connect.js';
import type { TeamMember, TeamService, TeamView } from './teams.js';

/** One account by `service:name`, a name that is unique, or its id. */
function matchAccount(all: AccountRow[], ref: AccountRef, service?: string): AccountRow {
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

/** Rule levels and changes, for the setup tools (the hub does not depend on the security layer). */
export { ACCESS_LEVELS, CONFIRM_IN, CONFIRM_LEVELS, type RuleChange } from '../security/policy.js';

/**
 * Workspace administration as plain operations: what the hub's setup tools (`manyplug_*`) and,
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

/**
 * Server-side prerequisites of services beyond OAuth apps, e.g. the messenger gateway and its API
 * keys for Telegram as a personal account (`SessionAvailability` in `src/messaging/`).
 */
export interface ConnectorAvailability {
  /** Why the service cannot be connected on this server, or undefined when it can. */
  check(connector: ConnectorDefinition): Promise<{ problem: string; env: string[] } | undefined>;
}

export interface ServiceEntry {
  service: string;
  name: string;
  description: string;
  connect: ConnectMethod;
  /** OAuth services without an OAuth app configured cannot be connected yet. */
  ready: boolean;
  problem?: string;
  /** The environment variable the hub owner sets to make a not-ready OAuth service available. */
  setupVar?: string;
  /** Added by this workspace (remote MCP server or HTTP manifest), not built in. */
  custom: boolean;
  accounts: number;
}

export interface ConnectLink {
  url: string;
  /**
   * How the page connects it; `app`: the person confirms in the service's own app (Telegram: scan
   * a QR code, then the code from the hub's bot typed on the page), with no password or key (see
   * `quick-connect.ts`).
   */
  method: ConnectMethod | 'app';
  service: string;
}

/** `service:account`, `account` (when unambiguous) or an account id. */
export type AccountRef = string;

/**
 * What a setup operation needs from the caller in a team (personal workspaces allow everything):
 * `read` anyone, `member` a person (not the team's shared connection), `admin` the owner or an admin.
 */
export type TeamNeed = 'read' | 'member' | 'admin';

const SHARED_CONNECTION =
  'This is the team’s shared connection, which is not tied to one person: it cannot change the setup. A member does that signed in with their own account.';

/** The access rules as the chat shows them (see `WorkspaceAdmin.rulesOverview`). */
export interface RulesOverview {
  defaults: Required<SecuritySettings>;
  /** Rules for an app and/or an account; persona and service rules are counted in `otherRules`. */
  rules: {
    app?: string;
    account?: string;
    access: AccessLevel | null;
    confirm: ConfirmLevel | null;
  }[];
  otherRules: number;
  apps: { id: string; name: string; current: boolean; lastUsedAt: Date | null }[];
  /** What applies to the calling app on each account. */
  accounts: { account: string; label: string; access: AccessLevel; confirm: ConfirmLevel }[];
}

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
      policies: PolicyService;
      aiClients: AiClientService;
      /** Teams: who may change what (personal workspaces: the owner, everything). */
      teams?: TeamService;
      /** Services connected by confirming in their own app; the connect page offers them first. */
      quickConnects?: QuickConnects;
      /** Server-side prerequisites of services (the messenger gateway's API keys). */
      availability?: ConnectorAvailability;
      publicUrl: string;
      logger: ConnectorLogger;
    },
  ) {}

  // --- Who may do what (teams) ---------------------------------------------------

  /** The caller's view of their team; undefined in a personal workspace. */
  teamView(principal: Principal): Promise<TeamView | undefined> {
    return this.deps.teams?.view(principal) ?? Promise.resolve(undefined);
  }

  /** Throws a user-safe error when the caller may not do this in their team. */
  async authorize(principal: Principal, need: TeamNeed): Promise<TeamView | undefined> {
    const view = await this.teamView(principal);
    if (!view || need === 'read') return view;
    if (!view.member) throw forbidden(SHARED_CONNECTION);
    if (need === 'admin' && !isTeamAdmin(view.member.role)) {
      throw forbidden('Only the team’s owner and admins can change this; ask one of them.');
    }
    return view;
  }

  /**
   * An account the caller can see (with `manage`: may change). In a team that is their own
   * accounts, the team's, and what others shared with them; only owners (and admins, for team
   * accounts) manage an account.
   */
  async accountFor(
    principal: Principal,
    ref: AccountRef,
    opts: { manage?: boolean; service?: string } = {},
  ): Promise<AccountRow> {
    const view = opts.manage ? await this.authorize(principal, 'member') : await this.teamView(principal);
    const all = await this.deps.accounts.list(principal.workspaceId);
    const visible = view ? all.filter((a) => a.id in view.access.access) : all;
    const account = matchAccount(visible, ref, opts.service);
    if (opts.manage && view && !view.access.manages.has(account.id)) {
      throw forbidden(
        account.ownerUserId === null
          ? 'Only the team’s owner and admins can change team accounts.'
          : 'Only the account’s owner can change it.',
      );
    }
    return account;
  }

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
      // How it connects now: optional OAuth without an app takes a personal token in the form.
      const route = connector.oauth ? await this.oauthRoute(workspaceId, connector) : undefined;
      const method = route?.via ?? this.connectMethod(connector);
      const gap = route?.problem ? undefined : await this.setupGap(connector);
      const problem = route?.problem ?? gap?.problem;
      const setupVar = route?.problem
        ? `OAUTH_APP_${resolveProvider(connector.oauth!).id.toUpperCase()}_CLIENT_ID`
        : gap?.env[0];
      entries.push({
        service: connector.id,
        name: connector.name,
        description: connector.description,
        connect: method,
        ready: !problem,
        ...(problem ? { problem, ...(setupVar ? { setupVar } : {}) } : {}),
        custom: customIds.has(connector.id),
        accounts: accounts.filter((a) => a.connectorId === connector.id).length,
      });
    }
    return entries.sort((a, b) => b.accounts - a.accounts || a.name.localeCompare(b.name));
  }

  /** What this server still lacks for the service outside OAuth (see {@link ConnectorAvailability}). */
  setupGap(connector: ConnectorDefinition): Promise<{ problem: string; env: string[] } | undefined> {
    return this.deps.availability?.check(connector) ?? Promise.resolve(undefined);
  }

  /**
   * How an OAuth service connects now: the provider's sign-in when an OAuth app is available (the
   * workspace's own or the hub's), the form for a personal token when OAuth is optional, otherwise
   * not at all, with `problem` saying why.
   */
  private async oauthRoute(
    workspaceId: string | undefined,
    connector: ConnectorDefinition,
  ): Promise<{ via: 'oauth' | 'form'; problem?: string }> {
    const provider = resolveProvider(connector.oauth!);
    const app = workspaceId
      ? await this.deps.apps.pick(workspaceId, connector).catch(() => undefined)
      : this.deps.apps.hasHubApp(connector);
    if (app) return { via: 'oauth' };
    if (connector.oauth!.optional) return { via: 'form' };
    if (this.deps.apps.envProviders().includes(provider.id)) {
      // The hub has an app for the provider, but only its own services use it.
      return {
        via: 'oauth',
        problem: `Services you add yourself connect with your own ${provider.name} OAuth app: register one with the redirect URI ${this.deps.publicUrl}/connect/callback and add it with POST /api/v1/oauth/apps.`,
      };
    }
    return {
      via: 'oauth',
      problem: `No ${provider.name} OAuth app is configured on this hub yet (the hub owner sets OAUTH_APP_${provider.id.toUpperCase()}_CLIENT_ID).`,
    };
  }

  /**
   * How the browser connects an account of the service now: the provider's sign-in when an OAuth
   * app is available (or OAuth is the only way), otherwise the hub's form (API key, password).
   */
  async connectVia(workspaceId: string, connector: ConnectorDefinition): Promise<'oauth' | 'form'> {
    return connector.oauth ? (await this.oauthRoute(workspaceId, connector)).via : 'form';
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
    principal: Principal,
    input: { service: string; label?: string; name?: string; reconnect?: AccountRef; forTeam?: boolean },
  ): Promise<ConnectLink> {
    const workspaceId = principal.workspaceId;
    const view = await this.authorize(principal, input.forTeam ? 'admin' : 'member');
    if (input.forTeam && !view) throw badRequest('Team accounts exist only in a team.');
    const connector = await this.deps.connectors.get(workspaceId, input.service);
    if (!connector) throw badRequest(`Unknown service "${input.service}". List them with the services tool.`);
    const reconnect = input.reconnect
      ? await this.accountFor(principal, input.reconnect, { manage: true, service: connector.id })
      : undefined;
    // The page offers the quick way first when it works for this account (the same check as there).
    const quick = await this.deps.quickConnects?.for(connector.id, reconnect);
    const method = quick ? 'app' : await this.linkMethod(workspaceId, connector);
    // The page connects into this team, as the member who opens it (or for the whole team).
    const url = this.connectPage(connector.id, view?.team.slug);
    if (input.forTeam) url.searchParams.set('owner', 'team');
    if (reconnect) {
      url.searchParams.set('account', reconnect.id);
    } else {
      if (input.name && (await this.deps.accounts.findByName(workspaceId, connector.id, input.name))) {
        throw badRequest(`${connector.name} already has an account named "${input.name}".`);
      }
      await this.deps.accounts.assertCanCreate(workspaceId, input.forTeam ? null : principal.userId);
      if (input.label) url.searchParams.set('label', input.label);
      if (input.name) url.searchParams.set('name', input.name);
    }
    return { url: url.toString(), method, service: connector.id };
  }

  /**
   * Where an account is signed in again, for notices sent outside a chat (an expired sign-in): its
   * connect link, or its page when the service cannot connect right now (the page says why). The
   * connect page checks that whoever opens the link may change the account.
   */
  async reconnectUrl(workspaceId: string, accountId: string): Promise<string> {
    const slug = await this.deps.teams?.slugOf(workspaceId);
    try {
      const account = await this.deps.accounts.get(workspaceId, accountId);
      const connector = await this.deps.connectors.get(workspaceId, account.connectorId);
      if (!connector) throw notFound(`Service "${account.connectorId}"`);
      await this.linkMethod(workspaceId, connector);
      const url = this.connectPage(connector.id, slug);
      url.searchParams.set('account', account.id);
      return url.toString();
    } catch {
      const page = slug ? `/app/team/${slug}` : `/app/accounts/${encodeURIComponent(accountId)}`;
      return new URL(page, this.deps.publicUrl).toString();
    }
  }

  /** How a link connects the service now; throws (user-safe) when it cannot. */
  private async linkMethod(workspaceId: string, connector: ConnectorDefinition): Promise<ConnectMethod> {
    const gap = await this.setupGap(connector);
    if (gap) throw badRequest(gap.problem);
    if (!connector.oauth) return this.connectMethod(connector);
    const route = await this.oauthRoute(workspaceId, connector);
    if (route.problem) throw badRequest(route.problem);
    // Optional OAuth without an app: the link opens the form for a personal token.
    return route.via;
  }

  /** The hub's connect page; in a team it connects into the team, as whoever opens it. */
  private connectPage(service: string, teamSlug: string | undefined): URL {
    const url = new URL(`/connect/${encodeURIComponent(service)}`, this.deps.publicUrl);
    if (teamSlug) {
      url.searchParams.set('team', teamSlug);
      url.searchParams.set('returnTo', `/app/team/${teamSlug}`);
    }
    return url;
  }

  /** The workspace's accounts by id (to show ids as `service:account`). */
  async accountsById(workspaceId: string): Promise<Map<string, AccountRow>> {
    return new Map((await this.deps.accounts.list(workspaceId)).map((a) => [a.id, a]));
  }

  async findAccount(workspaceId: string, ref: AccountRef, service?: string): Promise<AccountRow> {
    return matchAccount(await this.deps.accounts.list(workspaceId), ref, service);
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

  // --- Teams ---------------------------------------------------------------------

  private teams(): TeamService {
    if (!this.deps.teams) throw badRequest('Teams are not available on this server.');
    return this.deps.teams;
  }

  /** A member by handle, email or name (any case). */
  async findMember(workspaceId: string, ref: string): Promise<TeamMember> {
    const wanted = ref.trim().toLowerCase().replace(/^@/, '');
    const members = await this.teams().members(workspaceId);
    const matches = members.filter(
      (m) => m.handle === wanted || m.email === wanted || m.name.toLowerCase() === wanted,
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw notFound(`Team member "${ref}"`);
    throw badRequest(
      `"${ref}" matches several members: use one of ${matches.map((m) => m.handle).join(', ')}.`,
    );
  }

  /** The team as the caller sees it: members, whose each account is, what is shared, invitations. */
  async teamOverview(principal: Principal) {
    const view = await this.teamView(principal);
    if (!view) {
      const teams = await this.deps.teams?.teamsOf(principal.userId);
      return { personal: true as const, teams: teams ?? [] };
    }
    const teams = this.teams();
    const admin = isTeamAdmin(view.member?.role);
    const [members, accounts, shares, invitations] = await Promise.all([
      teams.members(view.team.id),
      this.deps.accounts.list(view.team.id),
      teams.shares(view.team.id),
      admin ? teams.invitations(view.team.id) : Promise.resolve([]),
    ]);
    const handleOf = new Map(members.map((m) => [m.userId, m.handle]));
    const visible = accounts.filter((a) => a.id in view.access.access);
    return {
      personal: false as const,
      view,
      url: teams.teamUrl(view.team.slug),
      members,
      accounts: visible.map((a) => ({
        account: a,
        owner: view.access.owners[a.id]!,
        access: view.access.access[a.id]!,
        manages: view.access.manages.has(a.id),
        // Only who manages an account sees whom it is shared with.
        sharedWith: view.access.manages.has(a.id)
          ? shares
              .filter((sh) => sh.accountId === a.id)
              .map((sh) => ({
                with: sh.userId ? (handleOf.get(sh.userId) ?? sh.userId) : 'team',
                access: sh.access,
              }))
          : [],
      })),
      invitations,
    };
  }

  /**
   * Whether sharing an account this way gives anyone more than now (a new share, a higher level):
   * that waits for the owner's confirmation, while narrowing or ending a share applies at once.
   */
  async shareWidens(
    principal: Principal,
    ref: AccountRef,
    withRef: string,
    level: ShareLevel | null,
  ): Promise<boolean> {
    if (level === null) return false;
    const { account, userId } = await this.shareTarget(principal, ref, withRef);
    const current = (await this.teams().shares(principal.workspaceId)).find(
      (sh) => sh.accountId === account.id && sh.userId === userId,
    );
    const order = { read: 1, write: 2, full: 3 } as const;
    if (account.ownerUserId === null && userId === null)
      return order[level] > order[current?.access ?? 'full'];
    return !current || order[level] > order[current.access];
  }

  private async shareTarget(principal: Principal, ref: AccountRef, withRef: string) {
    const account = await this.accountFor(principal, ref, { manage: true });
    const userId =
      withRef.trim().toLowerCase() === 'team'
        ? null
        : (await this.findMember(principal.workspaceId, withRef)).userId;
    return { account, userId };
  }

  async shareAccount(
    principal: Principal,
    ref: AccountRef,
    withRef: string,
    level: ShareLevel | null,
  ): Promise<{ account: AccountRow; with: string }> {
    const { account, userId } = await this.shareTarget(principal, ref, withRef);
    await this.teams().share(principal.userId, principal.workspaceId, account.id, userId, level);
    return { account, with: userId === null ? 'team' : withRef };
  }

  async inviteMember(principal: Principal, input: { email: string; role?: 'admin' | 'member' }) {
    await this.authorize(principal, 'admin');
    return this.teams().invite(principal.userId, principal.workspaceId, input);
  }

  async removeMember(principal: Principal, memberRef: string) {
    await this.authorize(principal, 'admin');
    const member = await this.findMember(principal.workspaceId, memberRef);
    const outcome = await this.teams().removeMember(principal.userId, principal.workspaceId, member.userId);
    return { member, ...outcome };
  }

  // --- Workspace settings ------------------------------------------------------

  async settings(workspaceId: string): Promise<WorkspaceSettings> {
    const workspace = await getWorkspace(this.deps.db, workspaceId);
    if (!workspace) throw notFound('Workspace');
    return workspace.settings;
  }

  /** Default access, confirmation level and where to confirm (`DEFAULT_SECURITY` fills the gaps). */
  async security(workspaceId: string): Promise<Required<SecuritySettings>> {
    return { ...DEFAULT_SECURITY, ...(await this.settings(workspaceId)).security };
  }

  async updateSecurity(workspaceId: string, change: SecuritySettings): Promise<Required<SecuritySettings>> {
    const current = await this.settings(workspaceId);
    const security = {
      ...current.security,
      ...Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)),
    };
    await this.deps.db
      .update(workspaces)
      .set({ settings: { ...current, security } })
      .where(eq(workspaces.id, workspaceId));
    return { ...DEFAULT_SECURITY, ...security };
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

  // --- Access rules ------------------------------------------------------------

  /** Defaults, the rules for apps and accounts, and what applies to the caller on each account. */
  async rulesOverview(principal: Principal): Promise<RulesOverview> {
    const workspaceId = principal.workspaceId;
    const [defaults, allRules, clients, allAccounts, policy, view] = await Promise.all([
      this.security(workspaceId),
      this.deps.policies.listRules(workspaceId),
      this.deps.aiClients.list(workspaceId),
      this.deps.accounts.list(workspaceId),
      this.deps.policies.forPrincipal(principal),
      this.teamView(principal),
    ]);
    // In a team, rules on accounts the caller cannot see stay as private as the accounts.
    const accounts = view ? allAccounts.filter((a) => a.id in view.access.access) : allAccounts;
    const rules = view
      ? allRules.filter((r) => r.accountId === null || r.accountId in view.access.access)
      : allRules;
    const appName = new Map(clients.map((c) => [c.id, c.name]));
    const ref = new Map(accounts.map((a) => [a.id, `${a.connectorId}:${a.name}`]));
    const simple = rules.filter((r) => r.personaId === null && r.connectorId === null);
    return {
      defaults,
      rules: simple.map((r) => ({
        ...(r.aiClientId ? { app: appName.get(r.aiClientId) ?? r.aiClientId } : {}),
        ...(r.accountId ? { account: ref.get(r.accountId) ?? r.accountId } : {}),
        access: r.access,
        confirm: r.confirm,
      })),
      otherRules: rules.length - simple.length,
      apps: clients.map((c) => ({
        id: c.id,
        name: c.name,
        current: c.id === principal.aiClientId,
        lastUsedAt: c.lastUsedAt,
      })),
      accounts: accounts.map((a) => {
        const effective = policy.effective({ connectorId: a.connectorId, accountId: a.id });
        return {
          account: `${a.connectorId}:${a.name}`,
          label: a.label,
          access: effective.access,
          confirm: effective.confirm,
        };
      }),
    };
  }

  /** An AI app by id or name (any case); a name two apps share must be given as an id. */
  async findAiClient(workspaceId: string, ref: string): Promise<AiClientRow> {
    const all = await this.deps.aiClients.list(workspaceId);
    const wanted = ref.trim().toLowerCase();
    const matches = all.filter((c) => c.id === ref || c.name.toLowerCase() === wanted);
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw notFound(`AI app "${ref}"`);
    throw badRequest(
      `Several AI apps are called "${ref}": use one of the ids ${matches.map((c) => c.id).join(', ')}.`,
    );
  }

  /**
   * What a rule change would let any app do that it could not before (empty: it only tightens).
   * `extraTargets` adds what has no account, such as the hub's own settings.
   */
  ruleLoosenings(
    workspaceId: string,
    change: RuleChange,
    extraTargets: readonly PolicyTarget[] = [],
  ): Promise<Loosening[]> {
    return this.deps.policies.loosenedBy(workspaceId, change, extraTargets);
  }

  /** Applies a change to the defaults or to the rule for an app and/or an account. */
  async changeRule(workspaceId: string, change: RuleChange): Promise<void> {
    if (change.kind === 'defaults') {
      await this.updateSecurity(workspaceId, {
        ...(change.access ? { defaultAccess: change.access } : {}),
        ...(change.confirm ? { defaultConfirm: change.confirm } : {}),
        ...(change.undoWindowSeconds !== undefined ? { undoWindowSeconds: change.undoWindowSeconds } : {}),
        ...(change.confirmIn ? { confirmIn: change.confirmIn } : {}),
      });
      return;
    }
    await this.deps.policies.setRuleAt(workspaceId, change);
  }
}
