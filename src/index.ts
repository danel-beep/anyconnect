import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { ConfigError, loadConfig } from './config.js';
import { scheduleMaintenance } from './core/maintenance.js';
import { createServices } from './services.js';

async function main() {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const services = createServices(config);
  const { logger } = services;
  await bootstrap(services);
  const stopMaintenance = scheduleMaintenance(services.db, logger);

  const app = createApp(services);
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    logger.info(
      { port: info.port, publicUrl: config.publicUrl, mcpUrl: config.mcpUrl, version: services.version },
      'AnyConnect hub is listening',
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    stopMaintenance();
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close();
    await services.close().catch((err) => logger.error({ err }, 'error during shutdown'));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
