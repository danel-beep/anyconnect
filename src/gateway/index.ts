/**
 * Entry point of the messenger gateway: a private service that holds the long-lived messenger
 * sessions (see docs/MESSENGERS.md). Same image as the hub: `node dist/gateway/index.js`.
 */
import { serve } from '@hono/node-server';
import { ConfigError } from '../config.js';
import { runMigrations } from '../db/migrate.js';
import { createLogger } from '../logger.js';
import { VERSION } from '../version.js';
import { gatewayApi } from './api.js';
import { loadGatewayConfig } from './config.js';
import { createDrivers } from './drivers/index.js';
import { createGatewayRuntime } from './runtime.js';

/** What the gateway was doing when startup failed (reported instead of the error's own text). */
let step = 'reading the configuration';

async function main() {
  let config: ReturnType<typeof loadGatewayConfig>;
  try {
    config = loadGatewayConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  const logger = createLogger({
    level: config.logLevel,
    pretty: !config.isProduction && process.stdout.isTTY === true,
  }).child({
    service: 'gateway',
  });
  step = 'setting up';
  const runtime = createGatewayRuntime(config, {
    logger,
    drivers: createDrivers({ telegram: config.telegram }),
  });
  // The hub applies migrations too; both take the same advisory lock, so whoever starts first wins.
  step = 'applying database migrations';
  await runMigrations(config.database.url);
  step = 'starting sessions and the outbox';
  await runtime.start();
  step = 'starting the internal API';

  const app = gatewayApi({ host: runtime.host, token: config.token, logger, version: VERSION });
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    logger.info(
      { port: info.port, advertiseUrl: config.advertiseUrl, version: VERSION },
      'messenger gateway is listening',
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down: releasing sessions');
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    server.close();
    await runtime.stop().catch((err) => logger.error({ err }, 'error during shutdown'));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(() => {
  // A fixed text: errors thrown this early (database, migrations) can quote query parameters,
  // so their own messages are not printed. Configuration problems are reported in full above.
  console.error(`messenger gateway failed while ${step}; check DATABASE_URL and ENCRYPTION_KEY`);
  process.exit(1);
});
