import type { Logger } from '../logger.js';
import type { ErrorReporter } from './errors.js';

/**
 * Last-resort handlers: a promise nobody awaited that failed is reported and the process goes on;
 * an exception that escaped everything leaves the process in an unknown state, so it is reported,
 * flushed and the process exits (the platform starts a fresh one).
 */
export function installProcessHandlers(deps: { logger: Logger; errors: ErrorReporter }): () => void {
  const onRejection = (reason: unknown) => {
    deps.errors.capture(reason, { source: 'process', context: { kind: 'unhandledRejection' } });
  };
  const onException = (error: Error) => {
    deps.errors.capture(error, { source: 'process', level: 'fatal', context: { kind: 'uncaughtException' } });
    void deps.errors.flush(2000).finally(() => {
      // pino may buffer: write the fatal line out before exiting.
      deps.logger.flush(() => process.exit(1));
    });
  };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  return () => {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
  };
}
