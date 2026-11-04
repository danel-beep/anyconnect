import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ConnectorResolver } from '../connectors/registry.js';
import type { AccountContext, ConnectorDefinition, ConnectorLogger, TestResult } from '../connectors/sdk.js';
import type { Db } from '../db/client.js';
import { type AccountSettings, accounts } from '../db/schema.js';
import type { SecretBox } from '../lib/crypto.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { NetworkPolicy } from '../lib/network.js';
import { slugify } from '../lib/slug.js';

export type AccountRow = typeof accounts.$inferSelect;

export const ACCOUNT_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

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

const credentialsContext = (accountId: string) => `account:${accountId}:credentials`;

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

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as any)?.cause?.code;
  return code === '23505';
}

/**
 * Manages connected accounts: validation against the connector's schemas, credential
 * encryption, and building the per-account context handed to connectors.
 */
export class AccountService {
  constructor(
    private readonly db: Db,
    private readonly connectors: ConnectorResolver,
    private readonly secrets: SecretBox,
    private readonly network: NetworkPolicy,
  ) {}

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

  private async uniqueName(workspaceId: string, connectorId: string, base: string): Promise<string> {
    const root = ACCOUNT_NAME.test(base) ? base : 'account';
    for (let i = 1; i < 100; i++) {
      const candidate = i === 1 ? root : `${root.slice(0, 28)}_${i}`;
      if (!(await this.findByName(workspaceId, connectorId, candidate))) return candidate;
    }
    throw conflict('Could not find a free account name');
  }

  async create(workspaceId: string, rawInput: CreateAccountInput): Promise<AccountRow> {
    const input = parseWith(CreateAccountInput, rawInput, 'account');
    const connector = await this.connector(workspaceId, input.connectorId);
    const name =
      input.name ?? (await this.uniqueName(workspaceId, connector.id, slugify(input.label) || connector.id));
    const config = parseWith(connector.config, input.config, 'config');
    const credentials = parseWith(connector.credentials, input.credentials, 'credentials');
    const disabledActions = this.validateDisabledActions(connector, input.settings?.disabledActions);

    const id = newId('acc');
    const hasCredentials = Object.keys(connector.credentials.shape).length > 0;
    try {
      const [row] = await this.db
        .insert(accounts)
        .values({
          id,
          workspaceId,
          connectorId: connector.id,
          name,
          label: input.label,
          description: input.description ?? null,
          config,
          credentialsEncrypted: hasCredentials
            ? this.secrets.encryptJson(credentials, credentialsContext(id))
            : null,
          enabled: input.enabled ?? true,
          settings: disabledActions ? { disabledActions } : {},
        })
        .returning();
      return row!;
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
      const current = existing.credentialsEncrypted
        ? this.secrets.decryptJson<Record<string, unknown>>(
            existing.credentialsEncrypted,
            credentialsContext(existing.id),
          )
        : {};
      const merged = parseWith(connector.credentials, { ...current, ...input.credentials }, 'credentials');
      patch.credentialsEncrypted = this.secrets.encryptJson(merged, credentialsContext(existing.id));
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
    const deleted = await this.db
      .delete(accounts)
      .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, accountId)))
      .returning({ id: accounts.id });
    if (deleted.length === 0) throw notFound('Account');
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
    let credentials: unknown = {};
    if (row.credentialsEncrypted) {
      try {
        credentials = this.secrets.decryptJson(row.credentialsEncrypted, credentialsContext(row.id));
      } catch {
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
        await this.db
          .update(accounts)
          .set({ credentialsEncrypted: this.secrets.encryptJson(valid, credentialsContext(row.id)) })
          .where(eq(accounts.id, row.id));
      },
      signal: options.signal,
      logger: options.logger,
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
    try {
      const ctx = await this.buildContext(connector, row, { signal: AbortSignal.timeout(30_000), logger });
      result = await connector.test(ctx);
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    await this.db
      .update(accounts)
      .set({
        status: result.ok ? 'active' : 'error',
        statusMessage: result.ok ? null : (result.message ?? 'Connection test failed'),
        metadata: result.identity ? { ...row.metadata, identity: result.identity } : row.metadata,
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
