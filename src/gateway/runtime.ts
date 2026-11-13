import { randomBytes } from 'node:crypto';
import { type BuiltinDeps, createBuiltinRegistry } from '../connectors/index.js';
import type { MessagingPort } from '../connectors/messaging.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import { AccountKeyring } from '../core/account-keys.js';
import { AccountService } from '../core/accounts.js';
import { createDatabase, type Database } from '../db/client.js';
import { type DbListener, PgListener } from '../db/listener.js';
import { SecretBox } from '../lib/crypto.js';
import { createNetworkPolicy, type NetworkPolicy } from '../lib/network.js';
import type { Logger } from '../logger.js';
import { Dispatcher } from '../messaging/dispatcher.js';
import { createMessaging, type Messaging } from '../messaging/index.js';
import type { GatewayConfig } from './config.js';
import type { SessionDriver } from './drivers/types.js';
import { type HostOptions, SessionHost } from './host.js';
import { LeaseManager } from './leases.js';

export interface GatewayRuntime {
  database: Database;
  messaging: Messaging;
  host: SessionHost;
  /** The session leases of this instance (one session per account across instances). */
  leases: LeaseManager;
  /** Delivers outbox jobs of the sessions running on this instance. */
  dispatcher: Dispatcher;
  network: NetworkPolicy;
  connectors: ConnectorRegistry;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Wires the gateway process: same database, keys and connectors as the hub, plus the session host. */
export function createGatewayRuntime(
  config: GatewayConfig,
  options: {
    logger: Logger;
    drivers: SessionDriver[];
    host?: Partial<HostOptions>;
    /** Lease TTL; short values make tests fast. */
    leaseTtlMs?: number;
    instanceId?: string;
    dispatchIntervalMs?: number;
    /**
     * Database notifications shared with the hub when both run in one process; otherwise the
     * runtime opens its own listening connection.
     */
    listener?: DbListener;
    /** Replaces the built-in connectors (tests). */
    connectors?: (deps: BuiltinDeps) => ConnectorRegistry;
  },
): GatewayRuntime {
  const { logger } = options;
  const database = createDatabase(config.database.url, {
    poolMax: config.database.poolMax,
    queryTimeoutMs: config.database.queryTimeoutMs,
  });
  const db = database.db;
  const secrets = new SecretBox(config.encryption.key, config.encryption.previousKeys);
  const network = createNetworkPolicy({ allowPrivateNetwork: config.allowPrivateNetwork });
  let messaging: Messaging | undefined;
  const port: MessagingPort = { forAccount: (id) => messaging!.service.forAccount(id) };
  const builtin: BuiltinDeps = { messaging: port };
  const connectors = options.connectors ? options.connectors(builtin) : createBuiltinRegistry(builtin);
  const keyring = new AccountKeyring(secrets, secrets);
  const accounts = new AccountService(db, connectors, keyring, network);
  messaging = createMessaging({
    publicUrl: config.publicUrl,
    gatewayConfig: undefined,
    db,
    secrets,
    keyring,
    accounts,
    connectors,
    builtin: connectors,
    logger,
  });
  const instanceId = options.instanceId ?? `gw_${randomBytes(6).toString('hex')}`;
  const ownListener = options.listener
    ? undefined
    : new PgListener({
        connectionString: config.database.url,
        logger: logger.child({ component: 'db-listener' }),
      });
  const listener = options.listener ?? ownListener;
  const leases = new LeaseManager(db, instanceId, {
    ownerUrl: config.advertiseUrl,
    ttlMs: options.leaseTtlMs ?? 30_000,
  });
  let dispatcher: Dispatcher | undefined;
  const host = new SessionHost(
    {
      db,
      accounts,
      connectors,
      messaging,
      network,
      leases,
      drivers: options.drivers,
      logger,
      onOnline: () => dispatcher?.kick(),
    },
    { maxSessions: config.maxSessions, ...options.host },
  );
  dispatcher = new Dispatcher({
    outbox: messaging.outbox,
    store: messaging.store,
    messengerAccounts: messaging.accounts,
    executor: host,
    worker: instanceId,
    logger: logger.child({ component: 'gateway-outbox' }),
    ...(listener ? { listener } : {}),
    ...(options.dispatchIntervalMs ? { intervalMs: options.dispatchIntervalMs } : {}),
  });
  const ready = messaging;
  const outbox = dispatcher;

  return {
    database,
    messaging: ready,
    host,
    leases,
    dispatcher: outbox,
    network,
    connectors,
    async start() {
      await ready.init();
      ownListener?.start();
      host.start();
      outbox.start();
    },
    async stop() {
      await outbox.stop();
      await ownListener?.stop();
      await host.stop();
      await network.close();
      await database.close();
    },
  };
}
