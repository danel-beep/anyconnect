import { and, eq, inArray } from 'drizzle-orm';
import type { DirectTransport, OutboundJob, PacingLimits, SentReceipt } from '../connectors/messaging.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import type { AccountService } from '../core/accounts.js';
import type { Db } from '../db/client.js';
import { accounts } from '../db/schema.js';
import type { DeliveryExecutor } from './dispatcher.js';
import type { MessagingService, ResolvedMessenger } from './service.js';

const REFRESH_MS = 15_000;

/**
 * Delivers outbox jobs of accounts whose transport is a plain API (Telegram Bot API, WhatsApp
 * Cloud API) from the hub process itself. Session accounts are left to the gateway.
 */
export class DirectDeliveryExecutor implements DeliveryExecutor {
  private cache: { at: number; ids: Set<string>; idempotent: Map<string, boolean> } | undefined;

  constructor(
    private readonly deps: {
      db: Db;
      connectors: ConnectorRegistry;
      accounts: AccountService;
      messaging: MessagingService;
    },
  ) {}

  /** Forget the cached account list (a new account was added, a mode changed). */
  invalidate(): void {
    this.cache = undefined;
  }

  async accounts(): Promise<string[]> {
    if (!this.cache || Date.now() - this.cache.at > REFRESH_MS) {
      const messengers = this.deps.connectors.all().filter((c) => c.messenger);
      const ids = new Set<string>();
      const idempotent = new Map<string, boolean>();
      if (messengers.length) {
        const rows = await this.deps.db
          .select({ id: accounts.id, connectorId: accounts.connectorId, config: accounts.config })
          .from(accounts)
          .where(
            and(
              inArray(
                accounts.connectorId,
                messengers.map((c) => c.id),
              ),
              eq(accounts.enabled, true),
            ),
          );
        for (const row of rows) {
          const connector = messengers.find((c) => c.id === row.connectorId)!;
          const config = connector.config.safeParse(row.config ?? {});
          if (!config.success) continue;
          const transport = connector.messenger!.transport(config.data);
          if (transport.kind !== 'direct') continue;
          ids.add(row.id);
          idempotent.set(row.id, transport.idempotentSend);
        }
      }
      this.cache = { at: Date.now(), ids, idempotent };
    }
    return [...this.cache.ids];
  }

  idempotentSend(accountId: string): boolean {
    return this.cache?.idempotent.get(accountId) ?? false;
  }

  private async resolve(accountId: string): Promise<ResolvedMessenger & { transport: DirectTransport }> {
    const resolved = await this.deps.messaging.resolve(accountId);
    if (resolved?.transport.kind !== 'direct')
      throw new Error(`account ${accountId} is not a direct messenger`);
    return resolved as ResolvedMessenger & { transport: DirectTransport };
  }

  async pacing(accountId: string): Promise<PacingLimits> {
    return this.deps.messaging.pacing(await this.resolve(accountId));
  }

  async deliver(accountId: string, job: OutboundJob): Promise<SentReceipt | undefined> {
    const resolved = await this.resolve(accountId);
    const ctx = await this.deps.messaging.context(resolved, AbortSignal.timeout(60_000));
    return resolved.transport.send(job, ctx);
  }

  async onAuthError(accountId: string, message: string): Promise<void> {
    await this.deps.accounts.markStatus(accountId, 'needs_reauth', message);
  }
}
