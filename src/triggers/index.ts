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
import { RUN_TIMEOUT_MS, TriggerEngine } from './engine.js';
import { TriggerService } from './service.js';
import { CalendarSource, MailSource, MessageSource } from './sources.js';
import { TriggerStore } from './store.js';

/**
 * Trigger actions one process runs at a time (the `triggers.run` job). A run mostly waits for
 * another service, so the cost of a slot is small.
 */
const RUN_CONCURRENCY = 8;
/** …of which one workspace takes at most this many, so a busy one cannot hold up everyone else. */
const RUN_CONCURRENCY_PER_WORKSPACE = 2;
/** The catch-up pass ends before the next one is due. */
const SCAN_TIMEOUT_MS = 110_000;
/** Sources read on a schedule (their services have no push without paid infrastructure). */
const POLLED = ['mail', 'calendar'] as const;
const CALENDAR_POLL_MS = 60_000;

/** The trigger subsystem, wired once (see docs/TRIGGERS.md). */
export interface Triggers {
  store: TriggerStore;
  keys: AiKeyStore;
  engine: TriggerEngine;
  service: TriggerService;
  jobs: JobDefinition[];
  /**
   * Follows new messages (Postgres NOTIFY from every process that stores them) and reads watched
   * mailboxes every `mailPollMs` and calendars once a minute (no push without paid infrastructure).
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
  /**
   * With several instances, only the one this says yes to polls mailboxes and calendars (see
   * `WorkLeases`); absent: this process always polls.
   */
  lease?: (name: string, ttlMs: number) => Promise<boolean>;
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
      new CalendarSource({ accounts: deps.accounts, connectors: deps.connectors, logger }),
    ],
    hub,
    accounts: deps.accounts,
    connectors: deps.connectors,
    aiClients: deps.aiClients,
    notifier: deps.notifier,
    fetch: deps.fetch,
    enqueue: async (eventId, workspaceId) => {
      const queue = deps.jobs();
      if (!queue?.running) return false;
      // The same event handed over again (the recovery pass) is dropped within the hour.
      await queue.send('triggers.run', { eventId }, { group: workspaceId, dedupeKey: eventId });
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
  const loops: DueLoop[] = [];
  const poll = (source: (typeof POLLED)[number], timeoutMs = 90_000, stop?: AbortSignal) =>
    engine.scanAll(source, {
      background: true,
      signal: stop ? AbortSignal.any([stop, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
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
        groupConcurrency: RUN_CONCURRENCY_PER_WORKSPACE,
        timeoutMs: RUN_TIMEOUT_MS + 30_000,
        run: async (data, ctx) => {
          if (typeof (data as { eventId?: unknown }).eventId !== 'string') return;
          // Only a shutdown stops a run early (and only one that has not acted yet); the run keeps
          // its own time limit.
          const stop = new AbortController();
          const onAbort = () => ctx.stopping() && stop.abort();
          if (ctx.signal.aborted) onAbort();
          else ctx.signal.addEventListener('abort', onAbort, { once: true });
          try {
            await engine.run((data as { eventId: string }).eventId, stop.signal);
          } finally {
            ctx.signal.removeEventListener('abort', onAbort);
          }
        },
      },
      {
        name: 'triggers.scan',
        description:
          'Check mailboxes and calendars for triggers and catch up on messages a lost notification missed',
        cron: '*/2 * * * *',
        expectEveryMs: 10 * 60_000,
        timeoutMs: SCAN_TIMEOUT_MS,
        run: async (_data, ctx) => {
          // Runs first: it is cheap, and must not wait behind a long pass over mailboxes.
          await engine.recover();
          await engine.scanAll('message', { background: true, signal: ctx.signal, changedOnly: true });
          // The poll loops of `start()` read mail and calendars more often; this is the backstop
          // without them.
          if (!loops.length) for (const source of POLLED) await poll(source, 90_000, ctx.signal);
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
      const mailEvery = deps.mailPollMs ?? 0;
      if (mailEvery > 0 && !loops.length) {
        for (const source of POLLED) {
          // A calendar trigger fires minutes ahead of an event: a look a minute is often enough.
          const every = source === 'calendar' ? Math.max(mailEvery, CALENDAR_POLL_MS) : mailEvery;
          const loop = new DueLoop({
            work: async () => {
              const passMs = Math.max(every * 3, 60_000);
              // The lease outlives a full pass and the wait after it, so it changes hands only
              // when its holder is gone.
              if (!deps.lease || (await deps.lease(`triggers.poll.${source}`, passMs + every + 30_000)))
                await poll(source, passMs);
              return new Date(Date.now() + every);
            },
            idleMs: () => every,
            onError: (error) => deps.onError?.(error, { step: `${source}_poll` }),
            minGapMs: Math.min(every, 5_000),
          });
          loop.start();
          loops.push(loop);
        }
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
      for (const loop of loops.splice(0)) void loop.stop();
    },
  };
}
