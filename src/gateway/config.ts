import { hostname } from 'node:os';
import { z } from 'zod';
import { ConfigError } from '../config.js';

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(10000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
  ENCRYPTION_KEY: optionalString,
  ENCRYPTION_KEYS_PREVIOUS: optionalString,
  GATEWAY_TOKEN: optionalString,
  /** URL other services use to reach this instance; defaults to http://<hostname>:<port>. */
  GATEWAY_ADVERTISE_URL: optionalString,
  /** Public origin of the hub (for webhook URLs in shared code); not used for serving. */
  PUBLIC_URL: optionalString,
  GATEWAY_MAX_SESSIONS: z.coerce.number().int().min(1).max(10_000).default(200),
  ALLOW_PRIVATE_NETWORK: z
    .string()
    .optional()
    .transform((v) => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase())),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface GatewayConfig {
  isProduction: boolean;
  host: string;
  port: number;
  database: { url: string; poolMax: number };
  encryption: { key: string | undefined; previousKeys: string[] };
  token: string;
  advertiseUrl: string;
  publicUrl: string;
  maxSessions: number;
  allowPrivateNetwork: boolean;
  logLevel: z.output<typeof EnvSchema>['LOG_LEVEL'];
}

export function loadGatewayConfig(source: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${details}`);
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';
  if (!env.GATEWAY_TOKEN || env.GATEWAY_TOKEN.length < 32) {
    throw new ConfigError('GATEWAY_TOKEN (at least 32 characters, shared with the hub) is required');
  }
  if (isProduction && !env.ENCRYPTION_KEY) throw new ConfigError('ENCRYPTION_KEY is required in production');
  return {
    isProduction,
    host: env.HOST,
    port: env.PORT,
    database: { url: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX },
    encryption: {
      key: env.ENCRYPTION_KEY,
      previousKeys: (env.ENCRYPTION_KEYS_PREVIOUS ?? '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    },
    token: env.GATEWAY_TOKEN,
    advertiseUrl: (env.GATEWAY_ADVERTISE_URL ?? `http://${hostname()}:${env.PORT}`).replace(/\/+$/, ''),
    publicUrl: (env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    maxSessions: env.GATEWAY_MAX_SESSIONS,
    allowPrivateNetwork: env.ALLOW_PRIVATE_NETWORK,
    logLevel: env.LOG_LEVEL,
  };
}
