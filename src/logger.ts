import { type Logger, pino } from 'pino';
import { BRAND } from './brand.js';
import { currentContext } from './ops/context.js';

export type { Logger };

export function createLogger(options: { level: string; pretty?: boolean }): Logger {
  return pino({
    level: options.level,
    base: { service: BRAND.slug },
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
    ...(options.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } }
      : {}),
  });
}
