/**
 * The messenger gateway inside the hub process (`GATEWAY_EMBEDDED=true`): the same runtime and
 * internal API as `node dist/gateway/index.js`, listening on 127.0.0.1 only, with a token made
 * up at start. It saves running a second service while there are few accounts; moving to a
 * separate gateway later is a configuration change (unset GATEWAY_EMBEDDED, set GATEWAY_URL and
 * GATEWAY_TOKEN), because leases keep one session per account either way. See docs/MESSENGERS.md.
 *
 * The trade-off: sessions reconnect on every deploy of the hub, and they share its memory.
 */
import { randomBytes } from 'node:crypto';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { ConfigError } from '../config.js';
import type { DbListener } from '../db/listener.js';
import type { Logger } from '../logger.js';
import { VERSION } from '../version.js';
import { gatewayApi } from './api.js';
import { loadGatewayConfig } from './config.js';
import { createDrivers } from './drivers/index.js';
import { createGatewayRuntime, type GatewayRuntime } from './runtime.js';

const TRUE = new Set(['1', 'true', 'yes', 'on']);

export interface EmbeddedGatewayPlan {
  /** Where the hub reaches the gateway (GATEWAY_URL). */
  url: string;
  /** The shared secret of this process (GATEWAY_TOKEN). */
  token: string;
  port: number;
  env: NodeJS.ProcessEnv;
}

/**
 * Decides whether to embed the gateway and where it will listen. Called before the hub reads its
 * configuration, which then gets this URL and token as GATEWAY_URL / GATEWAY_TOKEN.
 */
export function planEmbeddedGateway(env: NodeJS.ProcessEnv): EmbeddedGatewayPlan | undefined {
  if (!TRUE.has((env.GATEWAY_EMBEDDED ?? '').trim().toLowerCase())) return undefined;
  if (env.GATEWAY_URL) {
    throw new ConfigError(
      'GATEWAY_EMBEDDED and GATEWAY_URL exclude each other: pick the embedded or a separate gateway',
    );
  }
  const port = Number(env.GATEWAY_EMBEDDED_PORT ?? 10_001);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new ConfigError('GATEWAY_EMBEDDED_PORT is not a port');
  const token = randomBytes(32).toString('base64url');
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    token,
    port,
    env: {
      ...env,
      HOST: '127.0.0.1',
      PORT: String(port),
      GATEWAY_TOKEN: token,
      GATEWAY_ADVERTISE_URL: url,
      // A few connections are enough next to the hub's own pool.
      DATABASE_POOL_MAX: env.GATEWAY_DATABASE_POOL_MAX ?? '3',
    },
  };
}

export interface EmbeddedGateway {
  runtime: GatewayRuntime;
  stop(): Promise<void>;
}

/** Starts the planned gateway; call after the hub applied migrations. */
export async function startEmbeddedGateway(
  plan: EmbeddedGatewayPlan,
  logger: Logger,
  /** The hub's database notifications (same database), so the process keeps one listening connection. */
  shared: { listener?: DbListener } = {},
): Promise<EmbeddedGateway> {
  const config = loadGatewayConfig(plan.env);
  const log = logger.child({ service: 'gateway' });
  const runtime = createGatewayRuntime(config, {
    logger: log,
    drivers: createDrivers({ telegram: config.telegram }),
    ...(shared.listener ? { listener: shared.listener } : {}),
  });
  await runtime.start();
  const app = gatewayApi({ host: runtime.host, token: config.token, logger: log, version: VERSION });
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(s));
  });
  log.info(
    { port: config.port, telegram: Boolean(config.telegram) },
    'embedded messenger gateway is listening',
  );
  return {
    runtime,
    async stop() {
      server.close();
      // Sessions end and leases are released, so the next instance takes over at once.
      await runtime.stop();
    },
  };
}
