import { bootstrap } from './bootstrap.js';
import { ConfigError, loadConfig } from './config.js';
import { installProcessHandlers } from './ops/process.js';
import { createServices } from './services.js';

/**
 * Background worker without an HTTP server: runs the job queue only. Use it to move jobs off the
 * web instances (set JOBS_ENABLED=false on them); by default the web process runs jobs itself.
 */
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
  installProcessHandlers({ logger: services.logger, errors: services.ops.errors });
  await bootstrap(services);
  await services.jobs.start();
  services.logger.info({ release: services.ops.release }, 'Manyplug worker is running');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    services.logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await services.close().catch((err) => services.logger.error({ err }, 'error during shutdown'));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
