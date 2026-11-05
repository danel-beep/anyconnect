import { type DestinationStream, type LogFn, type Logger, pino } from 'pino';
import { BRAND } from './brand.js';
import { currentContext } from './ops/context.js';
import { scrubError, scrubSecrets } from './ops/scrub.js';

export type { Logger };

export function createLogger(options: {
  level: string;
  pretty?: boolean;
  /** Where lines go instead of stdout (tests); ignored with `pretty`. */
  destination?: DestinationStream;
}): Logger {
  const settings = {
    level: options.level,
    base: { service: BRAND.slug },
    // Errors are logged scrubbed and without what libraries attach to them (see `scrubError`).
    serializers: { err: scrubError },
    hooks: {
      // `logger.error(error)` would take the raw error message as the line's message.
      logMethod(args: Parameters<LogFn>, method: LogFn) {
        const [first, ...rest] = args as unknown[];
        if (!(first instanceof Error)) return method.apply(this, args);
        const message = typeof rest[0] === 'string' ? rest : [scrubSecrets(first.message, 1000)];
        return method.apply(this, [{ err: first }, ...message] as Parameters<LogFn>);
      },
    },
    // Every line logged while handling a request (or a job run) carries its id.
    mixin() {
      const context = currentContext();
      return context ? { requestId: context.requestId } : {};
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.credentials',
        '*.access_token',
        '*.refresh_token',
        '*.client_secret',
        '*.token',
        '*.apiKey',
        '*.api_key',
        '*.secret',
        '*.headers.authorization',
        '*.headers.cookie',
      ],
      censor: '[redacted]',
    },
  };
  if (options.pretty) {
    return pino({
      ...settings,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
    });
  }
  return options.destination ? pino(settings, options.destination) : pino(settings);
}
