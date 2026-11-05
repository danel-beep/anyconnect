import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { ConfigError, loadConfig } from './config.js';
import { scheduleMaintenance } from './core/maintenance.js';
import { type EmbeddedGateway, planEmbeddedGateway, startEmbeddedGateway } from './gateway/embedded.js';
import { installProcessHandlers } from './ops/process.js';
import { createServices } from './services.js';

async function main() {
  let config: ReturnType<typeof loadConfig>;
  let embedded: ReturnType<typeof planEmbeddedGateway>;
  try {
    // GATEWAY_EMBEDDED runs the messenger gateway in this process; the hub reaches it on localhost.
    embedded = planEmbeddedGateway(process.env);
    config = loadConfig(
      embedded ? { ...process.env, GATEWAY_URL: embedded.url, GATEWAY_TOKEN: embedded.token } : process.env,
    );
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const services = createServices(config);
  const { logger } = services;
  installProcessHandlers({ logger, errors: services.ops.errors });
  await bootstrap(services);
  const stopMaintenance = scheduleMaintenance(services);
  services.pendingRunner.start();
  if (config.jobs.enabled) await services.jobs.start();
  services.messaging.start();
  let gateway: EmbeddedGateway | undefined;
  if (embedded) gateway = await startEmbeddedGateway(embedded, logger);

  const app = createApp(services);
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    logger.info(
      { port: info.port, publicUrl: config.publicUrl, mcpUrl: config.mcpUrl, release: services.ops.release },
      'Manyplug hub is listening',
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
    await gateway?.stop().catch((err) => logger.error({ err }, 'error stopping the embedded gateway'));
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
