import type { ConnectorResolver } from '../connectors/registry.js';
import type { FetchLike } from '../connectors/sdk.js';
import type { AccountService } from '../core/accounts.js';
import type { OwnerNotifier } from '../core/owner-notices.js';
import type { Db } from '../db/client.js';
import type { DbListener } from '../db/listener.js';
import type { JobDefinition, JobQueue } from '../jobs/queue.js';
import type { Semaphore } from '../lib/concurrency.js';
import type { SecretBox } from '../lib/crypto.js';
import { DueLoop } from '../lib/due-loop.js';
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

/** Trigger actions one process runs at a time (the `triggers.run` job). */
const RUN_CONCURRENCY = 4;

/** The trigger subsystem, wired once (see docs/TRIGGERS.md). */
export interface Triggers {
  store: TriggerStore;
  keys: AiKeyStore;
  engine: TriggerEngine;
  service: TriggerService;
  jobs: JobDefinition[];
  /**
   * Follows new messages (Postgres NOTIFY from every process that stores them) and reads watched
   * mailboxes every `mailPollMs` (mail has no push without paid infrastructure).
   */
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
  /** How often `start()` reads watched mailboxes (0 or absent: only the `triggers.scan` job). */
  mailPollMs?: number;
  /** The share of the database pool scans may hold for their locks (`TriggerStore.exclusive`). */
  scanSlots?: Semaphore;
}): Triggers {
  const store = new TriggerStore(deps.db, deps.secrets, deps.messaging.ciphers, deps.scanSlots);
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
  let mailLoop: DueLoop | undefined;
  const scanMail = (timeoutMs = 90_000) =>
    engine.scanAll('mail', { background: true, signal: AbortSignal.timeout(timeoutMs) });
  return {
    store,
    keys,
    engine,
    service,
    jobs: [
      {
        name: 'triggers.run',
        description: 'Run the action of an event a trigger matched',
        // A run mostly waits (for the user's AI, for a service), up to two minutes: several at a
        // time, so one slow answer does not delay every other user's trigger.
        concurrency: RUN_CONCURRENCY,
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
          // The poll loop of `start()` reads mail more often; this is the backstop without it.
          if (!mailLoop) await scanMail();
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
      const every = deps.mailPollMs ?? 0;
      if (every > 0 && !mailLoop) {
        mailLoop = new DueLoop({
          work: async () => {
            await scanMail(Math.max(every * 3, 60_000));
            return new Date(Date.now() + every);
          },
          idleMs: () => every,
          onError: (error) => deps.onError?.(error, { step: 'mail_poll' }),
          minGapMs: Math.min(every, 5_000),
        });
        mailLoop.start();
      }
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
      void mailLoop?.stop();
      mailLoop = undefined;
    },
  };
}
