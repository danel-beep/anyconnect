import { type Logger, pino } from 'pino';

export type { Logger };

export function createLogger(options: { level: string; pretty?: boolean }): Logger {
  return pino({
    level: options.level,
    base: { service: 'anyconnect' },
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
      ],
      censor: '[redacted]',
    },
    ...(options.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } }
      : {}),
  });
}
