import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ConnectorResolver } from '../connectors/registry.js';
import {
  type AccountContext,
  type ConnectorDefinition,
  ConnectorError,
  type ConnectorLogger,
  type TestResult,
} from '../connectors/sdk.js';
import type { Db, DbExecutor } from '../db/client.js';
import {
  type AccountSettings,
  accessRules,
  accountOauth,
  accountShares,
  accounts,
  oauthConnectStates,
  pendingCalls,
  personas,
  toolCalls,
  workspaceMembers,
  workspaces,
} from '../db/schema.js';
import type { DataKey } from '../lib/crypto.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { NetworkPolicy } from '../lib/network.js';
import { slugify } from '../lib/slug.js';
import type { AccountKeyring } from './account-keys.js';
import type { TokenManager } from './oauth-tokens.js';
import { VaultLockedError, type VaultService } from './vaults.js';

export type AccountRow = typeof accounts.$inferSelect;

export const ACCOUNT_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Names that select accounts in tool calls (`account: "all"`, `"mine"`), never given to one. */
const RESERVED_NAMES = new Set(['all', 'mine']);

/** Account as returned by the API: never contains credentials. */
export interface AccountView {
  id: string;
  connectorId: string;
  name: string;
  label: string;
  description: string | null;
  config: Record<string, unknown>;
  hasCredentials: boolean;
  enabled: boolean;
  status: AccountRow['status'];
  statusMessage: string | null;
  identity: string | null;
  settings: AccountSettings;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  checkedAt: string | null;
}

export function toAccountView(row: AccountRow): AccountView {
  return {
    id: row.id,
    connectorId: row.connectorId,
    name: row.name,
    label: row.label,
    description: row.description,
    config: row.config,
    hasCredentials: Boolean(row.credentialsEncrypted),
    enabled: row.enabled,
    status: row.status,
    statusMessage: row.statusMessage,
    identity: typeof row.metadata.identity === 'string' ? row.metadata.identity : null,
    settings: row.settings,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    checkedAt: row.checkedAt?.toISOString() ?? null,
  };
}

export const CreateAccountInput = z.object({
  connectorId: z.string().min(1),
  name: z.string().regex(ACCOUNT_NAME, 'use 1-32 lowercase letters, digits, "-" or "_"').optional(),
  label: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  settings: z.object({ disabledActions: z.array(z.string()).optional() }).optional(),
});
export type CreateAccountInput = z.infer<typeof CreateAccountInput>;

export const UpdateAccountInput = z.object({
  name: z.string().regex(ACCOUNT_NAME, 'use 1-32 lowercase letters, digits, "-" or "_"').optional(),
  label: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  /** Replaces the whole config. */
  config: z.record(z.string(), z.unknown()).optional(),
  /** Merged into the stored credentials (send only the fields that change). */
  credentials: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  settings: z.object({ disabledActions: z.array(z.string()).optional() }).optional(),
});
export type UpdateAccountInput = z.infer<typeof UpdateAccountInput>;

function parseWith<T extends z.ZodType>(schema: T, value: unknown, what: string): z.output<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw badRequest(
      `Invalid ${what}`,
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

function hasAnyValue(record: Record<string, unknown>): boolean {
  return Object.values(record).some((v) => v !== undefined && v !== null && v !== '');
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as any)?.cause?.code;
  return code === '23505';
}

/**
 * Manages connected accounts: validation against the connector's schemas, credential
 * encryption, and building the per-account context handed to connectors.
 */
/** How many accounts a workspace may have (implemented by the billing layer). */
export interface AccountLimits {
  /**
   * Throws when the plan that pays for the new account is full. `ownerUserId`: whose it will be (in
   * a team a member, or `null` for the team's own); it decides whose plan pays in some teams.
   */
  assertCanAddAccount(workspaceId: string, ownerUserId?: string | null): Promise<void>;
}

/**
 * Whose a new account is. In a personal workspace it is always its owner's (the default). In a
 * team it must be said: a member's own account (`userId`) or the team's (`null`, see `teams.ts`).
 */
export interface AccountOwnerInput {
  userId: string | null;
}

export class AccountService {
  constructor(
    private readonly db: Db,
    private readonly connectors: ConnectorResolver,
    private readonly keys: AccountKeyring,
    private readonly network: NetworkPolicy,
    /** OAuth tokens of OAuth-connected services (`ctx.oauth`). */
    private readonly tokens?: TokenManager,
    /** Plan limits on the number of accounts (billing layer); without it any number is allowed. */
    private readonly limits?: AccountLimits,
    /**
     * Vault public keys: new accounts of a personal workspace whose owner has a vault are sealed to
     * it (see `docs/VAULTS.md`). Without it every account is wrapped by the master key.
     */
    private readonly vaults?: Pick<VaultService, 'publicKey'>,
  ) {}

  /** Throws when the plan that would pay for one more account (see `AccountLimits`) is full. */
  async assertCanCreate(workspaceId: string, ownerUserId?: string | null): Promise<void> {
    await this.limits?.assertCanAddAccount(workspaceId, ownerUserId);
  }

  async list(workspaceId: string): Promise<AccountRow[]> {
    return this.db
      .select()
      .from(accounts)
      .where(eq(accounts.workspaceId, workspaceId))
      .orderBy(asc(accounts.connectorId), asc(accounts.createdAt));
  }

  async get(workspaceId: string, accountId: string): Promise<AccountRow> {
    const [row] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, accountId)))
      .limit(1);
    if (!row) throw notFound('Account');
    return row;
  }

  async findByName(workspaceId: string, connectorId: string, name: string): Promise<AccountRow | undefined> {
    const [row] = await this.db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.workspaceId, workspaceId),
          eq(accounts.connectorId, connectorId),
          eq(accounts.name, name),
        ),
      )
      .limit(1);
    return row;
  }

  private async connector(workspaceId: string, connectorId: string): Promise<ConnectorDefinition> {
    const connector = await this.connectors.get(workspaceId, connectorId);
    if (!connector) throw badRequest(`Unknown service "${connectorId}"`);
    return connector;
  }

  /** The first free name among `bases`, then the first one numbered (`work_2`, `work_3`…). */
  private async uniqueName(workspaceId: string, connectorId: string, bases: string[]): Promise<string> {
    const valid = bases.filter((b) => ACCOUNT_NAME.test(b) && !RESERVED_NAMES.has(b));
    const roots = valid.length ? valid : ['account'];
    for (const root of roots) {
      if (!(await this.findByName(workspaceId, connectorId, root))) return root;
    }
    const root = roots[0]!;
    for (let i = 2; i < 100; i++) {
      const candidate = `${root.slice(0, 28)}_${i}`;
      if (!(await this.findByName(workspaceId, connectorId, candidate))) return candidate;
    }
    throw conflict('Could not find a free account name');
  }

  /**
   * Who a new account belongs to and the name it gets: in a team a member's accounts are named
   * after them (`ann`, then `ann_work`), so "Ann's mail" is easy to say; elsewhere after the label.
   */
  private async ownerAndName(
    workspaceId: string,
    connectorId: string,
    label: string,
    owner: AccountOwnerInput | undefined,
  ): Promise<{ ownerUserId: string | null; name: string; sealable: boolean }> {
    const [workspace] = await this.db
      .select({ kind: workspaces.kind })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!workspace) throw notFound('Workspace');
    const fromLabel = slugify(label) || connectorId;
    if (workspace.kind !== 'team') {
      const [member] = await this.db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')))
        .limit(1);
      const name = await this.uniqueName(workspaceId, connectorId, [fromLabel]);
      // Personal workspaces only: a team's accounts are used by several members (PR 3 of the vault plan).
      return { ownerUserId: owner?.userId ?? member?.userId ?? null, name, sealable: true };
    }
    if (owner === undefined) throw badRequest('Say whose account this is: a member’s or the team’s');
    if (owner.userId === null) {
      return {
        ownerUserId: null,
        name: await this.uniqueName(workspaceId, connectorId, [fromLabel]),
        sealable: false,
      };
    }
    const [member] = await this.db
      .select({ handle: workspaceMembers.handle })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, owner.userId)))
      .limit(1);
    if (!member) throw badRequest('Only members of the team can connect accounts to it');
    const handle = member.handle ?? 'member';
    const fromBoth = `${handle}_${fromLabel}`.slice(0, 32).replace(/[-_]+$/, '');
    return {
      ownerUserId: owner.userId,
      name: await this.uniqueName(workspaceId, connectorId, [handle, fromBoth]),
      sealable: false,
    };
  }

  /**
   * `opts.secrets` stores more of the new account's secrets (e.g. OAuth tokens) in the same
   * transaction, encrypted with the fresh data key it is handed. A sealed account needs only its
   * owner's public key to be created, so this works in a request that cannot open the vault (a
   * browser not yet approved); without it, opening the key again would fail there.
   */
  async create(
    workspaceId: string,
    rawInput: CreateAccountInput,
    owner?: AccountOwnerInput,
    opts: { secrets?: (account: AccountRow, key: DataKey, tx: DbExecutor) => Promise<void> } = {},
  ): Promise<AccountRow> {
    const input = parseWith(CreateAccountInput, rawInput, 'account');
    const connector = await this.connector(workspaceId, input.connectorId);
    const placed = await this.ownerAndName(workspaceId, connector.id, input.label, owner);
    await this.assertCanCreate(workspaceId, placed.ownerUserId);
    const name = input.name ?? placed.name;
    const config = parseWith(connector.config, input.config, 'config');
    const credentials = parseWith(connector.credentials, input.credentials, 'credentials');
    const disabledActions = this.validateDisabledActions(connector, input.settings?.disabledActions);

    const id = newId('acc');
    const hasCredentials = Object.keys(connector.credentials.shape).length > 0;
    // Messengers stay on the master key until their background ingest can seal to the public key
    // alone (stage 4 in docs/VAULTS.md).
    const sealTo =
      placed.sealable && placed.ownerUserId && !connector.messenger
        ? await this.vaults?.publicKey(placed.ownerUserId)
        : undefined;
    const { key, wrapped } = this.keys.createKey(id, sealTo);
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(accounts)
          .values({
            id,
            workspaceId,
            connectorId: connector.id,
            ownerUserId: placed.ownerUserId,
            name,
            label: input.label,
            description: input.description ?? null,
            config,
            dataKeyEncrypted: wrapped,
            credentialsEncrypted: hasCredentials
              ? this.keys.encryptCredentials({ id }, key, credentials)
              : null,
            enabled: input.enabled ?? true,
            settings: disabledActions ? { disabledActions } : {},
            // OAuth services get their tokens from the connect flow; until then the account is unusable.
            ...(connector.oauth && !(connector.oauth.optional && hasAnyValue(credentials))
              ? { status: 'needs_reauth' as const, statusMessage: 'Not connected yet: connect the account' }
              : {}),
          })
          .returning();
        await opts.secrets?.(row!, key, tx);
        return row!;
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw conflict(`An account named "${name}" already exists for ${connector.name}`);
      throw error;
    }
  }

  async update(workspaceId: string, accountId: string, rawInput: UpdateAccountInput): Promise<AccountRow> {
    const input = parseWith(UpdateAccountInput, rawInput, 'account update');
    const existing = await this.get(workspaceId, accountId);
    const connector = await this.connector(workspaceId, existing.connectorId);

    const patch: Partial<typeof accounts.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.label !== undefined) patch.label = input.label;
    if (input.description !== undefined) patch.description = input.description;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.config !== undefined) patch.config = parseWith(connector.config, input.config, 'config');
    if (input.settings !== undefined) {
      const disabledActions = this.validateDisabledActions(connector, input.settings.disabledActions);
      patch.settings = { ...existing.settings, disabledActions: disabledActions ?? [] };
    }
    if (input.credentials !== undefined) {
      await this.prepareKeys(existing);
      const current = existing.credentialsEncrypted
        ? this.keys.decryptCredentials<Record<string, unknown>>(existing, existing.credentialsEncrypted)
        : {};
      const merged = parseWith(connector.credentials, { ...current, ...input.credentials }, 'credentials');
      const { key, dataKeyEncrypted } = this.dataKeyFor(existing);
      patch.dataKeyEncrypted = dataKeyEncrypted;
      patch.credentialsEncrypted = this.keys.encryptCredentials(existing, key, merged);
      // New credentials: give the account a fresh chance.
      patch.status = 'active';
      patch.statusMessage = null;
    }
    if (Object.keys(patch).length === 0) return existing;
    try {
      const [row] = await this.db
        .update(accounts)
        .set(patch)
        .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, accountId)))
        .returning();
      return row!;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(`An account named "${input.name}" already exists`);
      throw error;
    }
  }

  async delete(workspaceId: string, accountId: string): Promise<void> {
    const existing = await this.get(workspaceId, accountId);
    const connector = await this.connectors.get(workspaceId, existing.connectorId);
    // Best effort: tell the provider to drop the grant so a deleted account leaves no live token.
    if (connector?.oauth && this.tokens) await this.tokens.revoke(connector, existing).catch(() => {});
    const deleted = await this.db
      .delete(accounts)
      .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, accountId)))
      .returning({ id: accounts.id });
    if (deleted.length === 0) throw notFound('Account');
  }

  /**
   * Moves an account to another workspace of its owner: a member leaving a team takes their own
   * accounts along instead of losing them (or leaving their keys with the team). What belonged to
   * the team's setup stays behind: its access rules, shares, held-back calls and persona lists;
   * the team's activity log keeps the calls but no longer points at the account.
   *
   * Throws when the account cannot work in the other workspace (a service the team added itself,
   * or tokens from the team's own OAuth app); the caller deletes it instead.
   */
  async move(
    fromWorkspaceId: string,
    accountId: string,
    to: { workspaceId: string; ownerUserId: string },
  ): Promise<AccountRow> {
    const row = await this.get(fromWorkspaceId, accountId);
    if (!(await this.connectors.get(to.workspaceId, row.connectorId))) {
      throw badRequest(`The service of account "${row.name}" is not available there`);
    }
    const [oauth] = await this.db
      .select({ appRef: accountOauth.appRef })
      .from(accountOauth)
      .where(eq(accountOauth.accountId, accountId))
      .limit(1);
    if (oauth && !oauth.appRef.startsWith('env:')) {
      throw badRequest(`Account "${row.name}" was connected through the team's own OAuth app`);
    }
    const name = await this.uniqueName(to.workspaceId, row.connectorId, [row.name]);
    return this.db.transaction(async (tx) => {
      await tx.delete(accessRules).where(eq(accessRules.accountId, accountId));
      await tx.delete(accountShares).where(eq(accountShares.accountId, accountId));
      await tx.delete(pendingCalls).where(eq(pendingCalls.accountId, accountId));
      await tx.delete(oauthConnectStates).where(eq(oauthConnectStates.accountId, accountId));
      await tx
        .update(personas)
        .set({ accountIds: sql`array_remove(${personas.accountIds}, ${accountId})` })
        .where(
          and(eq(personas.workspaceId, fromWorkspaceId), sql`${accountId} = any(${personas.accountIds})`),
        );
      await tx
        .update(toolCalls)
        .set({ accountId: null })
        .where(and(eq(toolCalls.workspaceId, fromWorkspaceId), eq(toolCalls.accountId, accountId)));
      const [moved] = await tx
        .update(accounts)
        .set({ workspaceId: to.workspaceId, ownerUserId: to.ownerUserId, name })
        .where(and(eq(accounts.id, accountId), eq(accounts.workspaceId, fromWorkspaceId)))
        .returning();
      return moved!;
    });
  }

  /** Accounts of a workspace that belong to one member. */
  async ownedBy(workspaceId: string, userId: string): Promise<AccountRow[]> {
    return this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.ownerUserId, userId)))
      .orderBy(asc(accounts.createdAt));
  }

  /** Owner of each account (team workspaces: who may use and manage it, see `security/members.ts`). */
  async owners(workspaceId: string, ids?: string[]): Promise<{ id: string; ownerUserId: string | null }[]> {
    return this.db
      .select({ id: accounts.id, ownerUserId: accounts.ownerUserId })
      .from(accounts)
      .where(and(eq(accounts.workspaceId, workspaceId), ids ? inArray(accounts.id, ids) : undefined));
  }

  private async oauthAccess(connector: ConnectorDefinition, row: AccountRow, signal: AbortSignal) {
    try {
      return this.tokens ? await this.tokens.access(connector, row, signal) : undefined;
    } catch (error) {
      if (error instanceof VaultLockedError) throw lockedAccount(await this.keys.lockedError());
      throw error;
    }
  }

  /** True when the account's key is sealed to its owner's vault (only a request can open it). */
  async isSealed(accountId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: accounts.id, dataKeyEncrypted: accounts.dataKeyEncrypted })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    return row !== undefined && this.keys.isSealed(row);
  }

  /**
   * Throws a user-safe 423 when the account is sealed and this request cannot open its vault, e.g.
   * before sending the user to a provider to reconnect it from a browser that is not approved yet.
   */
  async assertCanOpen(row: AccountRow): Promise<void> {
    await this.prepareKeys(row);
  }

  /** Opens the caller's vault when the account is sealed; a locked vault is a user-safe error. */
  private async prepareKeys(row: AccountRow): Promise<void> {
    await this.keys.prepare(row);
    if (this.keys.isSealed(row)) {
      try {
        this.keys.openKey(row);
      } catch (error) {
        if (error instanceof VaultLockedError) throw lockedAccount(await this.keys.lockedError());
        throw error;
      }
    }
  }

  /** The account's data key, creating one for accounts that predate envelope encryption. */
  private dataKeyFor(row: AccountRow): { key: DataKey; dataKeyEncrypted: string } {
    if (row.dataKeyEncrypted) {
      return { key: this.keys.openKey(row), dataKeyEncrypted: row.dataKeyEncrypted };
    }
    const { key, wrapped } = this.keys.createKey(row.id);
    return { key, dataKeyEncrypted: wrapped };
  }

  /**
   * Brings every account to the current encryption scheme: gives legacy accounts their own data
   * key (re-encrypting their credentials with it) and re-wraps data keys that were wrapped with a
   * previous master key. Idempotent and safe to run concurrently on several instances: each row
   * is only updated if it has not changed since it was read.
   */
  async upgradeEncryption(): Promise<{ upgraded: number; rewrapped: number; failed: number }> {
    const result = { upgraded: 0, rewrapped: 0, failed: 0 };
    const rows = await this.db.select().from(accounts);
    for (const row of rows) {
      try {
        // Sealed accounts are already on the newest scheme and cannot be opened here anyway.
        if (this.keys.isSealed(row)) continue;
        if (!row.dataKeyEncrypted || this.keys.isLegacy(row.credentialsEncrypted)) {
          const { key, dataKeyEncrypted } = this.dataKeyFor(row);
          const credentials = row.credentialsEncrypted
            ? this.keys.encryptCredentials(
                row,
                key,
                this.keys.decryptCredentials(row, row.credentialsEncrypted),
              )
            : null;
          const updated = await this.db
            .update(accounts)
            .set({
              dataKeyEncrypted,
              credentialsEncrypted: credentials,
              updatedAt: sql`${accounts.updatedAt}`,
            })
            .where(and(eq(accounts.id, row.id), this.unchanged(row)))
            .returning({ id: accounts.id });
          if (updated.length) result.upgraded++;
        } else if (this.keys.needsRewrap(row)) {
          const updated = await this.db
            .update(accounts)
            .set({ dataKeyEncrypted: this.keys.rewrap(row), updatedAt: sql`${accounts.updatedAt}` })
            .where(and(eq(accounts.id, row.id), this.unchanged(row)))
            .returning({ id: accounts.id });
          if (updated.length) result.rewrapped++;
        }
      } catch {
        // Unreadable with the configured keys (e.g. a missing previous key): leave it as is.
        result.failed++;
      }
    }
    return result;
  }

  private unchanged(row: AccountRow) {
    return and(
      row.dataKeyEncrypted === null
        ? isNull(accounts.dataKeyEncrypted)
        : eq(accounts.dataKeyEncrypted, row.dataKeyEncrypted),
      row.credentialsEncrypted === null
        ? isNull(accounts.credentialsEncrypted)
        : eq(accounts.credentialsEncrypted, row.credentialsEncrypted),
    );
  }

  private validateDisabledActions(
    connector: ConnectorDefinition,
    names: string[] | undefined,
  ): string[] | undefined {
    if (!names) return undefined;
    const known = new Set(connector.actions.map((a) => a.name));
    const unknown = names.filter((n) => !known.has(n));
    if (unknown.length) throw badRequest(`Unknown actions for ${connector.name}: ${unknown.join(', ')}`);
    return [...new Set(names)];
  }

  /** Builds the context a connector receives for one account: decrypted credentials and helpers. */
  async buildContext(
    connector: ConnectorDefinition,
    row: AccountRow,
    options: { signal: AbortSignal; logger: ConnectorLogger },
  ): Promise<AccountContext<unknown, unknown>> {
    const config = parseWith(connector.config, row.config, `config of account "${row.name}"`);
    await this.prepareKeys(row);
    let credentials: unknown = {};
    if (row.credentialsEncrypted) {
      try {
        credentials = this.keys.decryptCredentials(row, row.credentialsEncrypted);
      } catch (error) {
        if (error instanceof VaultLockedError) throw lockedAccount(await this.keys.lockedError());
        throw new AppError(
          500,
          'credentials_unreadable',
          `Credentials of account "${row.name}" cannot be decrypted`,
        );
      }
    }
    return {
      account: {
        id: row.id,
        name: row.name,
        label: row.label,
        description: row.description ?? undefined,
        identity: typeof row.metadata.identity === 'string' ? row.metadata.identity : undefined,
      },
      config,
      credentials,
      updateCredentials: async (next) => {
        const valid = parseWith(connector.credentials, next, 'credentials');
        const { key, dataKeyEncrypted } = this.dataKeyFor(row);
        await this.db
          .update(accounts)
          .set({ dataKeyEncrypted, credentialsEncrypted: this.keys.encryptCredentials(row, key, valid) })
          .where(eq(accounts.id, row.id));
        row.dataKeyEncrypted = dataKeyEncrypted;
      },
      signal: options.signal,
      logger: options.logger,
      oauth: await this.oauthAccess(connector, row, options.signal),
      fetch: this.network.fetch,
      network: { lookup: this.network.lookup, assertHostAllowed: this.network.assertHostAllowed },
    };
  }

  /** Runs the connector's self-test and stores the outcome (status + identity) on the account. */
  async test(workspaceId: string, accountId: string, logger: ConnectorLogger): Promise<TestResult> {
    const row = await this.get(workspaceId, accountId);
    const connector = await this.connector(workspaceId, row.connectorId);
    if (!connector.test) return { ok: true, message: 'This service has no connection test' };
    let result: TestResult;
    let authFailed = false;
    try {
      const ctx = await this.buildContext(connector, row, { signal: AbortSignal.timeout(30_000), logger });
      result = await connector.test(ctx);
    } catch (error) {
      // A sealed account tested without its vault (a background check) says nothing about the connection.
      if (error instanceof AppError && error.code === 'vault_locked')
        return { ok: false, message: error.message };
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      if (error instanceof ConnectorError && error.kind === 'auth') authFailed = true;
    }
    await this.db
      .update(accounts)
      .set({
        status: result.ok ? 'active' : authFailed ? 'needs_reauth' : 'error',
        statusMessage: result.ok ? null : (result.message ?? 'Connection test failed'),
        metadata: result.identity ? { ...row.metadata, identity: result.identity } : row.metadata,
        checkedAt: new Date(),
        updatedAt: sql`${accounts.updatedAt}`,
      })
      .where(eq(accounts.id, row.id));
    return result;
  }

  async markStatus(accountId: string, status: AccountRow['status'], message: string | null): Promise<void> {
    await this.db.update(accounts).set({ status, statusMessage: message }).where(eq(accounts.id, accountId));
  }

  async touch(accountId: string): Promise<void> {
    // Keep updated_at unchanged: using an account is not modifying it.
    await this.db
      .update(accounts)
      .set({ lastUsedAt: new Date(), updatedAt: sql`${accounts.updatedAt}` })
      .where(eq(accounts.id, accountId));
  }
}

/** A sealed account whose owner's vault this request cannot open (423 Locked). */
function lockedAccount(error: VaultLockedError): AppError {
  return new AppError(423, 'vault_locked', error.message);
}
