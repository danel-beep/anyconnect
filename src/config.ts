import { z } from 'zod';

/**
 * All runtime configuration comes from environment variables (12-factor).
 * Secrets are never read from files in the repository.
 */

const bool = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return defaultValue;
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
      if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
      ctx.addIssue({ code: 'custom', message: `expected a boolean, got "${value}"` });
      return z.NEVER;
    });

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Public origin of the hub, e.g. https://anyconnect.onrender.com. Render sets RENDER_EXTERNAL_URL. */
  PUBLIC_URL: optionalString,
  RENDER_EXTERNAL_URL: optionalString,
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
  /** 32-byte key (base64 or hex) used to encrypt service credentials at rest. */
  ENCRYPTION_KEY: optionalString,
  /** Previous keys, comma separated. Still used for decryption so keys can be rotated. */
  ENCRYPTION_KEYS_PREVIOUS: optionalString,
  /** Bootstrap owner account. Created on first start; the password is re-synced if it changes. */
  ADMIN_EMAIL: optionalString,
  ADMIN_PASSWORD: optionalString,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Trust X-Forwarded-* headers (set automatically on Render). */
  TRUST_PROXY: optionalString,
  MIGRATE_ON_START: bool(true),
  SEED_DEMO_ACCOUNTS: bool(true),
  OAUTH_DYNAMIC_REGISTRATION: bool(true),
  OAUTH_CLIENT_METADATA_DOCUMENTS: bool(true),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(3600),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(90),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  TOOL_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(120),
  /**
   * Let connectors reach private/loopback addresses (self-hosted services on a LAN, local tests).
   * Off by default: in the cloud it would expose internal services to anyone who can add an account.
   */
  ALLOW_PRIVATE_NETWORK: bool(false),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  isProduction: boolean;
  host: string;
  port: number;
  /** Origin without trailing slash, e.g. https://hub.example.com */
  publicUrl: string;
  /** The MCP endpoint URL; also the OAuth protected resource identifier. */
  mcpUrl: string;
  /** Whether cookies must be Secure (https public URL). */
  secureCookies: boolean;
  trustProxy: boolean;
  database: { url: string; poolMax: number };
  encryption: { key: string | undefined; previousKeys: string[] };
  admin: { email: string; password: string } | undefined;
  logLevel: Env['LOG_LEVEL'];
  migrateOnStart: boolean;
  seedDemoAccounts: boolean;
  oauth: {
    dynamicRegistration: boolean;
    clientMetadataDocuments: boolean;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
  };
  sessionTtlSeconds: number;
  toolTimeoutMs: number;
  /** Connectors may connect to private addresses (see ALLOW_PRIVATE_NETWORK). */
  allowPrivateNetwork: boolean;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function normalizePublicUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`PUBLIC_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError('PUBLIC_URL must use http or https');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigError('PUBLIC_URL must be an origin without a path, e.g. https://hub.example.com');
  }
  return url.origin;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${details}`);
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';

  const publicUrl = normalizePublicUrl(
    env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL ?? `http://localhost:${env.PORT}`,
  );
  if (isProduction && !publicUrl.startsWith('https://')) {
    const host = new URL(publicUrl).hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') {
      throw new ConfigError('PUBLIC_URL must be https in production');
    }
  }

  if (isProduction && !env.ENCRYPTION_KEY) {
    throw new ConfigError(
      'ENCRYPTION_KEY is required in production. Generate one with: npm run cli -- keys:generate',
    );
  }

  if ((env.ADMIN_EMAIL && !env.ADMIN_PASSWORD) || (!env.ADMIN_EMAIL && env.ADMIN_PASSWORD)) {
    throw new ConfigError('ADMIN_EMAIL and ADMIN_PASSWORD must be set together');
  }
  if (env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length < 12 && isProduction) {
    throw new ConfigError('ADMIN_PASSWORD must be at least 12 characters in production');
  }

  const trustProxy =
    env.TRUST_PROXY !== undefined
      ? ['1', 'true', 'yes', 'on'].includes(env.TRUST_PROXY.toLowerCase())
      : Boolean(source.RENDER) || Boolean(env.RENDER_EXTERNAL_URL);

  return {
    env: env.NODE_ENV,
    isProduction,
    host: env.HOST,
    port: env.PORT,
    publicUrl,
    mcpUrl: `${publicUrl}/mcp`,
    secureCookies: publicUrl.startsWith('https://'),
    trustProxy,
    database: { url: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX },
    encryption: {
      key: env.ENCRYPTION_KEY,
      previousKeys: (env.ENCRYPTION_KEYS_PREVIOUS ?? '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    },
    admin:
      env.ADMIN_EMAIL && env.ADMIN_PASSWORD
        ? { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }
        : undefined,
    logLevel: env.LOG_LEVEL,
    migrateOnStart: env.MIGRATE_ON_START,
    seedDemoAccounts: env.SEED_DEMO_ACCOUNTS,
    oauth: {
      dynamicRegistration: env.OAUTH_DYNAMIC_REGISTRATION,
      clientMetadataDocuments: env.OAUTH_CLIENT_METADATA_DOCUMENTS,
      accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: env.REFRESH_TOKEN_TTL_DAYS * 86_400,
    },
    sessionTtlSeconds: env.SESSION_TTL_DAYS * 86_400,
    toolTimeoutMs: env.TOOL_TIMEOUT_SECONDS * 1000,
    allowPrivateNetwork: env.ALLOW_PRIVATE_NETWORK,
  };
}
