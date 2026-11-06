import type { ConnectorResolver } from '../connectors/registry.js';
import type { FetchLike } from '../connectors/sdk.js';
import type { AccountService } from '../core/accounts.js';
import type { OwnerNotifier } from '../core/owner-notices.js';
import type { Db } from '../db/client.js';
import type { DbListener } from '../db/listener.js';
import type { JobDefinition, JobQueue } from '../jobs/queue.js';
import type { SecretBox } from '../lib/crypto.js';
import type { Logger } from '../logger.js';
import { INBOUND_CHANNEL } from '../messaging/inbound-signal.js';
import type { Messaging } from '../messaging/index.js';
import type { AiClientService } from '../security/clients.js';
import type { AgentHub } from './ai/agent.js';
import { AiKeyStore } from './ai-keys.js';
import { TriggerEngine } from './engine.js';
import { TriggerService } from './service.js';
import { MailSource, MessageSource } from './sources.js';
import { TriggerStore } from './store.js';

/** The trigger subsystem, wired once (see docs/TRIGGERS.md). */
export interface Triggers {
  store: TriggerStore;
  keys: AiKeyStore;
  engine: TriggerEngine;
  service: TriggerService;
  jobs: JobDefinition[];
  /** Follows new messages (Postgres NOTIFY from every process that stores them). */
  start(): void;
  stop(): void;
}

export function createTriggers(deps: {
  db: Db;
  secrets: SecretBox;
  messaging: Messaging;
  accounts: AccountService;
  connectors: ConnectorResolver;
  aiClients: AiClientService;
  notifier: OwnerNotifier;
  /** The hub, read when a trigger runs (it is built after this module). */
  hub: () => AgentHub;
  jobs: () => JobQueue | undefined;
  listener?: DbListener;
  fetch: FetchLike;
  publicUrl: string;
  logger: Logger;
  onError?: (error: unknown, context: Record<string, string | number | boolean | undefined>) => void;
}): Triggers {
  const store = new TriggerStore(deps.db, deps.secrets, deps.messaging.ciphers);
  const keys = new AiKeyStore(deps.db, deps.secrets);
  const hub: AgentHub = {
    getCatalog: (principal) => deps.hub().getCatalog(principal),
    callTool: (principal, catalog, tool, args, options) =>
      deps.hub().callTool(principal, catalog, tool, args, options),
  };
  const pageUrl = `${deps.publicUrl}/app/triggers`;
  const aiPageUrl = `${deps.publicUrl}/app/ai`;
  const logger = deps.logger.child({ component: 'triggers' });
  const engine = new TriggerEngine({
    store,
    keys,
    sources: [
      new MessageSource({
        accounts: deps.accounts,
        connectors: deps.connectors,
        store: deps.messaging.store,
      }),
      new MailSource({ accounts: deps.accounts, connectors: deps.connectors, logger }),
    ],
    hub,
    accounts: deps.accounts,
    connectors: deps.connectors,
    aiClients: deps.aiClients,
    notifier: deps.notifier,
    fetch: deps.fetch,
    enqueue: async (eventId) => {
      const queue = deps.jobs();
      if (!queue?.running) return false;
      await queue.send('triggers.run', { eventId });
      return true;
    },
    pageUrl,
    logger,
    ...(deps.onError ? { onError: deps.onError } : {}),
  });
  const service = new TriggerService({
    store,
    keys,
    engine,
    accounts: deps.accounts,
    connectors: deps.connectors,
    hub,
    pageUrl,
    aiPageUrl,
  });
  let unlisten: (() => void) | undefined;
  return {
    store,
    keys,
    engine,
    service,
    jobs: [
      {
        name: 'triggers.run',
        description: 'Run the action of an event a trigger matched',
        run: async (data) => {
          if (typeof (data as { eventId?: unknown }).eventId === 'string')
            await engine.run((data as { eventId: string }).eventId);
        },
      },
      {
        name: 'triggers.scan',
        description: 'Check mailboxes for triggers and catch up on messages a lost notification missed',
        cron: '*/2 * * * *',
        expectEveryMs: 10 * 60_000,
        run: async () => {
          await engine.scanAll('message', { background: true });
          await engine.scanAll('mail', { background: true, signal: AbortSignal.timeout(90_000) });
          await engine.failStale();
        },
      },
      {
        name: 'triggers.prune',
        description: 'Delete trigger events past their retention',
        cron: '53 2 * * *',
        expectEveryMs: 26 * 3_600_000,
        run: () => store.prune(),
      },
    ],
    start: () => {
      unlisten ??= deps.listener?.listen(
        INBOUND_CHANNEL,
        (accountId) => void engine.onInbound(accountId),
        // Reconnected after a gap: catch up on what arrived meanwhile.
        () => void engine.scanAll('message', { background: true }).catch(() => {}),
      );
    },
    stop: () => {
      unlisten?.();
      unlisten = undefined;
    },
  };
}
