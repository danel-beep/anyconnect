import type { ConnectorRegistry, ConnectorResolver } from '../connectors/registry.js';
import type { AccountKeyring } from '../core/account-keys.js';
import type { AccountService } from '../core/accounts.js';
import type { Db } from '../db/client.js';
import type { DbListener } from '../db/listener.js';
import type { JobDefinition } from '../jobs/queue.js';
import type { SecretBox } from '../lib/crypto.js';
import type { Logger } from '../logger.js';
import { MessengerAccounts } from './accounts.js';
import { SessionAvailability } from './availability.js';
import { AccountCiphers } from './ciphers.js';
import { DirectDeliveryExecutor } from './direct-executor.js';
import { Dispatcher } from './dispatcher.js';
import { type GatewayApi, HttpGatewayClient } from './gateway-client.js';
import { InboundSignal } from './inbound-signal.js';
import { DataKeys, MessengerKeys } from './keys.js';
import { Outbox } from './outbox.js';
import { MessagingService } from './service.js';
import { MessageStore } from './store.js';

/** The hub's messaging subsystem, wired once (see docs/MESSENGERS.md). */
export interface Messaging {
  keys: MessengerKeys;
  /** Per-account encryption of stored chats, messages, outbox jobs and session state. */
  ciphers: AccountCiphers;
  store: MessageStore;
  outbox: Outbox;
  accounts: MessengerAccounts;
  service: MessagingService;
  gateway: GatewayApi | undefined;
  /** Whether gateway-session messengers can be connected on this server (gateway and driver set up). */
  availability: SessionAvailability;
  /** Delivers jobs of direct-API accounts (Bot API, Cloud API) from this process. */
  dispatcher: Dispatcher;
  directExecutor: DirectDeliveryExecutor;
  /** Recurring housekeeping of the subsystem, registered with the hub's job queue. */
  jobs: JobDefinition[];
  /** Loads the data keys; call after migrations. */
  init(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export function createMessaging(deps: {
  /** Public origin of the hub (webhook URLs). */
  publicUrl: string;
  /** The gateway's internal API, when deployed. */
  gatewayConfig: { url: string; token: string } | undefined;
  /** Wakes the outbox dispatcher when another process queues a message (it polls without one). */
  listener?: DbListener;
  db: Db;
  /** Wraps the per-account data keys (data_keys for blind indexes stays on the master key). */
  secrets: SecretBox;
  keyring: AccountKeyring;
  accounts: AccountService;
  /** Resolves connectors of a workspace (built-in and custom). */
  connectors: ConnectorResolver;
  /** Built-in connectors: the only ones that can be messengers today. */
  builtin: ConnectorRegistry;
  logger: Logger;
  /** Overrides the HTTP gateway client (tests). */
  gateway?: GatewayApi;
}): Messaging {
  const { db, secrets, logger } = deps;
  const keys = new MessengerKeys(new DataKeys(db, secrets));
  const ciphers = new AccountCiphers(db, deps.keyring);
  const inbound = new InboundSignal(db, deps.listener);
  const store = new MessageStore(db, ciphers, keys, inbound);
  const outbox = new Outbox(db, ciphers, keys);
  const messengerAccounts = new MessengerAccounts(db);
  const gateway =
    deps.gateway ??
    (deps.gatewayConfig
      ? new HttpGatewayClient({
          baseUrl: deps.gatewayConfig.url,
          token: deps.gatewayConfig.token,
          messengerAccounts,
        })
      : undefined);
  let dispatcher: Dispatcher | undefined;
  let directExecutor: DirectDeliveryExecutor | undefined;
  const service = new MessagingService({
    db,
    store,
    outbox,
    keys,
    messengerAccounts,
    accounts: deps.accounts,
    connectors: deps.connectors,
    gateway,
    publicUrl: deps.publicUrl,
    logger,
    inbound,
    onEnqueued: () => {
      // The account may be new to the executor's cached list.
      directExecutor?.invalidate();
      dispatcher?.kick();
    },
  });
  directExecutor = new DirectDeliveryExecutor({
    db,
    connectors: deps.builtin,
    accounts: deps.accounts,
    messaging: service,
  });
  dispatcher = new Dispatcher({
    outbox,
    store,
    messengerAccounts,
    executor: directExecutor,
    worker: `hub:${process.pid}`,
    logger: logger.child({ component: 'outbox' }),
    ...(deps.listener ? { listener: deps.listener } : {}),
  });
  const ready = dispatcher;
  return {
    keys,
    ciphers,
    store,
    outbox,
    accounts: messengerAccounts,
    service,
    gateway,
    availability: new SessionAvailability({ gateway }),
    dispatcher: ready,
    directExecutor: directExecutor,
    jobs: [
      {
        name: 'messaging.prune_outbox',
        description: 'Delete finished outgoing messenger jobs past their retention',
        cron: '37 2 * * *',
        expectEveryMs: 26 * 3_600_000,
        run: async () => {
          await outbox.prune();
        },
      },
      {
        name: 'messaging.prune_messages',
        description: 'Delete messenger messages past the retention their account chose',
        cron: '47 2 * * *',
        expectEveryMs: 26 * 3_600_000,
        run: async () => {
          await store.prune();
        },
      },
    ],
    init: () => keys.init(),
    start: () => ready.start(),
    stop: () => ready.stop(),
  };
}
