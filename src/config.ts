import { z } from 'zod';
import { BRAND } from './brand.js';
import { IpAllowlist } from './lib/ip-allowlist.js';

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
  /** Public origin of the hub, e.g. https://manyplug.com. Without it, Render's RENDER_EXTERNAL_URL is used. */
  PUBLIC_URL: optionalString,
  RENDER_EXTERNAL_URL: optionalString,
  /**
   * Former public origins (comma separated). Requests to them are redirected to PUBLIC_URL, so old
   * links, bookmarks and AI app settings keep working after a domain change. RENDER_EXTERNAL_URL is
   * added automatically when it differs from PUBLIC_URL.
   */
  LEGACY_PUBLIC_URLS: optionalString,
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
  /**
   * Proxies in front of the hub: `true`/a number of proxies that append to X-Forwarded-For (the
   * client IP is taken that many entries from the right, so a client cannot forge it), `false` for
   * none. Defaults to 2 on Render (Cloudflare + Render's load balancer).
   */
  TRUST_PROXY: optionalString,
  /** A header the platform itself sets to the client IP (e.g. `cf-connecting-ip`); wins over X-Forwarded-For. */
  CLIENT_IP_HEADER: optionalString,
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
  /**
   * Lets AI apps connect to /mcp before signing in: they see what the hub can do, and the first
   * call that needs an account makes the app open the sign-in page. Off by default: apps that
   * detect sign-in by a 401 on the first request would otherwise treat the hub as needing none.
   */
  MCP_ANONYMOUS: bool(false),
  /** Who may create an account on the website: `open` (anyone with Google) or `closed` (existing users only). */
  SIGNUPS: z.enum(['open', 'closed']).default('open'),
  /** "Sign in with Google" OAuth client; falls back to OAUTH_APP_GOOGLE_CLIENT_ID / _SECRET. */
  LOGIN_GOOGLE_CLIENT_ID: optionalString,
  LOGIN_GOOGLE_CLIENT_SECRET: optionalString,
  /** Emails (comma separated) that become hub admins when they sign in, besides ADMIN_EMAIL. */
  ADMIN_EMAILS: optionalString,
  /** Only these IPs / CIDR ranges (comma separated) may open the admin panel; empty = any. */
  ADMIN_ALLOWED_IPS: optionalString,
  /** The admin panel needs a sign-in (with a second factor) at most this many hours ago. */
  ADMIN_SESSION_HOURS: z.coerce.number().int().min(1).max(720).default(8),
  /** Contact address shown on the website and in the legal pages. */
  SUPPORT_EMAIL: optionalString,
  /** Requests per minute one IP address may make to /mcp without signing in. */
  MCP_ANONYMOUS_RATE_LIMIT: z.coerce.number().int().min(1).default(30),
  /** Default size budget of one tool result, in tokens (larger results are trimmed with a note). */
  TOOL_RESULT_MAX_TOKENS: z.coerce.number().int().min(200).default(2000),
  /** How long a successful write is remembered to suppress accidental duplicates (0 disables). */
  IDEMPOTENCY_WINDOW_SECONDS: z.coerce.number().int().min(0).default(300),
  /** The hub's own Telegram bot (from @BotFather) for confirmations; optional. */
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_API_URL: z.string().url().default('https://api.telegram.org'),
  /** How long a call that needs confirmation waits for the answer before returning "pending". */
  CONFIRMATION_WAIT_SECONDS: z.coerce.number().int().min(0).max(110).default(40),
  /** How long the user has to answer a confirmation. */
  CONFIRMATION_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  /** Users must set up a second factor (authenticator app or passkey) before using the hub. */
  REQUIRE_2FA: bool(false),
  /** Background jobs: account health checks, token refresh, later schedules and triggers. */
  JOBS_ENABLED: bool(true),
  /** Token budget for the tool list; above it the hub lists search/call meta tools instead (auto mode). */
  TOOL_LIST_TOKEN_BUDGET: z.coerce.number().int().min(500).default(3000),
  /** Internal URL of the messenger gateway (Render private service), e.g. http://anyconnect-gateway:10000. */
  GATEWAY_URL: optionalString,
  /** Shared secret between the hub and the gateway. */
  GATEWAY_TOKEN: optionalString,
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
  /** Former public hosts (lowercase `host[:port]`); requests to them are redirected to `publicUrl`. */
  legacyHosts: string[];
  /** Whether cookies must be Secure (https public URL). */
  secureCookies: boolean;
  /** How to find the client IP behind proxies (`hops: 0` = use the socket address). */
  trustProxy: TrustProxy;
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
  tools: { maxResultTokens: number; idempotencyWindowMs: number; listTokenBudget: number };
  confirmations: {
    waitMs: number;
    ttlMs: number;
    /** How often approved calls are checked for the end of their undo window. */
    runnerIntervalMs: number;
  };
  telegram: { botToken: string | undefined; apiUrl: string };
  /** Sign-in hardening: whether a second factor is mandatory, and the WebAuthn relying party. */
  auth: {
    requireSecondFactor: boolean;
    /** RP ID = hostname of the public URL; passkeys are bound to it. */
    rpId: string;
    rpName: string;
    /** Expected origin of WebAuthn ceremonies = the public URL. */
    origin: string;
  };
  /** Website accounts: self sign-up, external sign-in providers, admins. */
  site: {
    signups: 'open' | 'closed';
    /** Lower-cased emails promoted to admin at sign-in (ADMIN_EMAIL is always one). */
    adminEmails: string[];
    adminAllowedIps: string[];
    adminSessionMaxAgeMs: number;
    supportEmail: string | undefined;
    /** "Sign in with Google": absent when no Google OAuth client is configured. */
    google: { clientId: string; clientSecret: string | undefined } | undefined;
  };
  /** /mcp before signing in (see MCP_ANONYMOUS). */
  anonymousMcp: { enabled: boolean; perMinute: number };
  /**
   * Hub-wide OAuth apps of service providers, by provider id, from
   * `OAUTH_APP_<PROVIDER>_CLIENT_ID` / `OAUTH_APP_<PROVIDER>_CLIENT_SECRET`
   * (e.g. `OAUTH_APP_GOOGLE_CLIENT_ID`). Users can also add their own apps per workspace.
   */
  oauthApps: Record<string, { clientId: string; clientSecret: string | undefined }>;
  /** Run background jobs (pg-boss) in this process. */
  jobs: { enabled: boolean };
  /** The messenger gateway, when deployed. */
  gateway: { url: string; token: string } | undefined;
}

/** Reads `OAUTH_APP_<PROVIDER>_CLIENT_ID/_SECRET` pairs; the provider id is the lower-cased middle part. */
export function readOAuthApps(source: NodeJS.ProcessEnv): AppConfig['oauthApps'] {
  const apps: AppConfig['oauthApps'] = {};
  for (const [key, value] of Object.entries(source)) {
    const match = key.match(/^OAUTH_APP_([A-Z0-9_]+)_CLIENT_ID$/);
    if (!match || !value?.trim()) continue;
    const secret = source[`OAUTH_APP_${match[1]}_CLIENT_SECRET`]?.trim();
    apps[match[1]!.toLowerCase()] = { clientId: value.trim(), clientSecret: secret || undefined };
  }
  return apps;
}

/**
 * Hub-wide OAuth apps. One Google client can serve both "Sign in with Google" and connecting
 * Gmail, Calendar and Drive (its redirect URIs include /auth/google/callback and /connect/callback),
 * so without `OAUTH_APP_GOOGLE_*` the sign-in client (`LOGIN_GOOGLE_*`) is used for services too.
 */
function hubOAuthApps(env: Env, source: NodeJS.ProcessEnv): AppConfig['oauthApps'] {
  const apps = readOAuthApps(source);
  if (!apps.google && env.LOGIN_GOOGLE_CLIENT_ID && env.LOGIN_GOOGLE_CLIENT_SECRET)
    apps.google = { clientId: env.LOGIN_GOOGLE_CLIENT_ID, clientSecret: env.LOGIN_GOOGLE_CLIENT_SECRET };
  return apps;
}

/** The "Sign in with Google" client: its own variables, else the hub's Google OAuth app. */
function googleLogin(env: Env, source: NodeJS.ProcessEnv): AppConfig['site']['google'] {
  if (env.LOGIN_GOOGLE_CLIENT_ID)
    return { clientId: env.LOGIN_GOOGLE_CLIENT_ID, clientSecret: env.LOGIN_GOOGLE_CLIENT_SECRET };
  const hub = readOAuthApps(source).google;
  return hub ? { clientId: hub.clientId, clientSecret: hub.clientSecret } : undefined;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Hosts of LEGACY_PUBLIC_URLS and of Render's own address, except the canonical one. */
function legacyHosts(publicUrl: string, env: Env): string[] {
  const raw = (env.LEGACY_PUBLIC_URLS ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (env.RENDER_EXTERNAL_URL) raw.push(env.RENDER_EXTERNAL_URL);
  const canonical = new URL(publicUrl).host;
  const hosts = raw.map((value) => {
    try {
      return new URL(normalizePublicUrl(value)).host;
    } catch {
      throw new ConfigError(`LEGACY_PUBLIC_URLS: not an origin: ${value}`);
    }
  });
  return [...new Set(hosts)].filter((host) => host !== canonical);
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

function gatewayConfig(url: string | undefined, token: string | undefined): AppConfig['gateway'] {
  if (!url && !token) return undefined;
  if (!url || !token) throw new ConfigError('GATEWAY_URL and GATEWAY_TOKEN must be set together');
  if (token.length < 32) throw new ConfigError('GATEWAY_TOKEN must be at least 32 characters');
  try {
    new URL(url);
  } catch {
    throw new ConfigError(`GATEWAY_URL is not a valid URL: ${url}`);
  }
  return { url: url.replace(/\/+$/, ''), token };
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

  const onRender = Boolean(source.RENDER) || Boolean(env.RENDER_EXTERNAL_URL);
  const trustProxy: TrustProxy = {
    hops: proxyHops(env.TRUST_PROXY, onRender ? 2 : 0),
    ...(env.CLIENT_IP_HEADER ? { header: env.CLIENT_IP_HEADER.trim().toLowerCase() } : {}),
  };

  return {
    env: env.NODE_ENV,
    isProduction,
    host: env.HOST,
    port: env.PORT,
    publicUrl,
    mcpUrl: `${publicUrl}/mcp`,
    legacyHosts: legacyHosts(publicUrl, env),
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
    anonymousMcp: { enabled: env.MCP_ANONYMOUS, perMinute: env.MCP_ANONYMOUS_RATE_LIMIT },
    site: {
      signups: env.SIGNUPS,
      adminEmails: [
        ...new Set(
          [env.ADMIN_EMAIL, ...(env.ADMIN_EMAILS ?? '').split(',')]
            .map((e) => e?.trim().toLowerCase())
            .filter((e): e is string => Boolean(e)),
        ),
      ],
      adminAllowedIps: adminAllowedIps(env.ADMIN_ALLOWED_IPS),
      adminSessionMaxAgeMs: env.ADMIN_SESSION_HOURS * 3_600_000,
      supportEmail: env.SUPPORT_EMAIL,
      google: googleLogin(env, source),
    },
    tools: {
      maxResultTokens: env.TOOL_RESULT_MAX_TOKENS,
      idempotencyWindowMs: env.IDEMPOTENCY_WINDOW_SECONDS * 1000,
      listTokenBudget: env.TOOL_LIST_TOKEN_BUDGET,
    },
    confirmations: {
      waitMs: env.CONFIRMATION_WAIT_SECONDS * 1000,
      ttlMs: env.CONFIRMATION_TTL_MINUTES * 60_000,
      runnerIntervalMs: 2000,
    },
    telegram: { botToken: env.TELEGRAM_BOT_TOKEN, apiUrl: env.TELEGRAM_API_URL.replace(/\/+$/, '') },
    auth: {
      requireSecondFactor: env.REQUIRE_2FA,
      rpId: new URL(publicUrl).hostname,
      rpName: BRAND.name,
      origin: publicUrl,
    },
    oauthApps: hubOAuthApps(env, source),
    jobs: { enabled: env.JOBS_ENABLED },
    gateway: gatewayConfig(env.GATEWAY_URL, env.GATEWAY_TOKEN),
  };
}

/** ADMIN_ALLOWED_IPS as a list, checked up front (a typo must not silently open or close the panel). */
function adminAllowedIps(value: string | undefined): string[] {
  const entries = (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  try {
    new IpAllowlist(entries);
  } catch (error) {
    throw new Error(`ADMIN_ALLOWED_IPS: ${(error as Error).message}`);
  }
  return entries;
}

export interface TrustProxy {
  /** Proxies that append to X-Forwarded-For; 0 = trust no forwarded header. */
  hops: number;
  /** A header set by the platform with the client IP. */
  header?: string;
}

function proxyHops(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return 1;
  if (['0', 'false', 'no', 'off', ''].includes(v)) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 10)
    throw new ConfigError('TRUST_PROXY must be true, false or the number of proxies (0–10)');
  return n;
}
