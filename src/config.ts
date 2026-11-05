import { z } from 'zod';
import type { AnalyticsConfig } from './analytics/index.js';
import { type BillingConfig, BillingConfigError, readBillingConfig } from './billing/config.js';
import { BRAND } from './brand.js';
import { CLIENT_POLICY_IDS } from './hub/client-policies.js';
import { parseKey } from './lib/crypto.js';
import { IpAllowlist } from './lib/ip-allowlist.js';
import type { S3Config } from './lib/s3.js';
import { type MailConfig, MailConfigError, readMailConfig } from './mail/mailer.js';
import { parseSentryDsn } from './ops/sentry.js';

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
  /** Largest request body the hub reads (MCP calls, API, uploads); sign-in and OAuth forms take less. */
  MAX_REQUEST_BODY_MB: z.coerce.number().min(0.1).max(100).default(10),
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
  /** Ownership tokens of Google Search Console and Bing Webmaster Tools (meta tag method). */
  GOOGLE_SITE_VERIFICATION: optionalString,
  BING_SITE_VERIFICATION: optionalString,
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
  /**
   * Also send unexpected errors to Sentry or a Sentry-compatible service (GlitchTip, Bugsink):
   * the project's DSN. Errors are always kept in the built-in tracker (admin panel → Errors).
   */
  SENTRY_DSN: optionalString,
  /** Environment name in Sentry (default: NODE_ENV). */
  SENTRY_ENVIRONMENT: optionalString,
  /** Days an error group is kept after it was last seen. */
  ERROR_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  /**
   * Database backups to S3-compatible storage (Cloudflare R2, Backblaze B2, AWS S3, MinIO): set
   * the endpoint, bucket and keys together. See docs/OPERATIONS.md.
   */
  BACKUP_S3_ENDPOINT: optionalString,
  BACKUP_S3_BUCKET: optionalString,
  /** `auto` for Cloudflare R2. */
  BACKUP_S3_REGION: z.string().default('auto'),
  BACKUP_S3_ACCESS_KEY_ID: optionalString,
  BACKUP_S3_SECRET_ACCESS_KEY: optionalString,
  /** Folder (key prefix) in the bucket. */
  BACKUP_PREFIX: optionalString,
  BACKUP_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  /**
   * Key backups are encrypted with (like ENCRYPTION_KEY: 32 bytes, base64 or hex). Default: derived
   * from ENCRYPTION_KEY. A separate key lets backups be restored after ENCRYPTION_KEY rotation.
   */
  BACKUP_ENCRYPTION_KEY: optionalString,
  /** First-party analytics of the site and the product (admin panel → Analytics, docs/ANALYTICS.md). */
  ANALYTICS: bool(true),
  /** Days visits and daily counters are kept. */
  ANALYTICS_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(400),
  /** Headers with the visitor's country set by a CDN in front of the hub (comma separated). */
  ANALYTICS_COUNTRY_HEADERS: z.string().default('cf-ipcountry,x-vercel-ip-country,cloudfront-viewer-country'),
  /** IP-to-country database (MaxMind format): a file path, or `off`. Default: the bundled one. */
  ANALYTICS_GEOIP_DB: optionalString,
  /** How often buffered page views and events are written, in seconds. */
  ANALYTICS_FLUSH_SECONDS: z.coerce.number().min(0.05).max(300).default(5),
  /** Commit of the running build; set by Render. Shown in the admin panel and sent with errors. */
  RENDER_GIT_COMMIT: optionalString,
  RENDER_INSTANCE_ID: optionalString,
  /**
   * AI app directory rules the hub enforces for clients of those apps (comma separated ids from
   * `src/hub/client-policies.ts`: `claude`, `chatgpt`; `none` for no rules). Default `claude`.
   */
  CLIENT_POLICIES: optionalString,
  /**
   * A sign-in for directory reviewers (Anthropic, OpenAI...): email + password, no second factor,
   * demo accounts connected. Created on start; the password is re-synced if it changes.
   */
  REVIEW_ACCOUNT_EMAIL: optionalString,
  REVIEW_ACCOUNT_PASSWORD: optionalString,
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
  /** Largest request body read, in bytes (`MAX_REQUEST_BODY_MB`). */
  maxRequestBodyBytes: number;
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
    /** Search console ownership tokens, rendered as meta tags on public pages. */
    verification: { google: string | undefined; bing: string | undefined };
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
  /** Payments: the active provider, its keys and prices (see `src/billing/config.ts`). */
  billing: BillingConfig;
  /** The hub's own email (billing notices): provider and sender (see `src/mail/mailer.ts`). */
  mail: MailConfig;
  /** Database backups (see `src/ops/backups.ts`); undefined when no bucket is configured. */
  backups: BackupConfig | undefined;
  /** First-party analytics (see `src/analytics/`). */
  analytics: AnalyticsConfig;
  /** Error tracking and build identity (see `src/ops/`). */
  ops: {
    sentryDsn: string | undefined;
    environment: string;
    errorRetentionDays: number;
    /** Short commit of the running build, when the platform tells us. */
    commit: string | undefined;
    /** Instance name for logs and Sentry (several instances behind one service). */
    instance: string | undefined;
  };
  /** Listing in AI app directories (see `docs/DIRECTORIES.md`). */
  directories: {
    /** Enforced directory rules (ids of `CLIENT_POLICIES` in `src/hub/client-policies.ts`). */
    clientPolicies: string[];
    /** The reviewers' sign-in (REVIEW_ACCOUNT_EMAIL / REVIEW_ACCOUNT_PASSWORD). */
    reviewAccount: { email: string; password: string } | undefined;
    /**
     * Ownership proofs served as plain text at `/.well-known/<name>`, from `WELL_KNOWN_<NAME>`
     * variables (`WELL_KNOWN_MCP_REGISTRY_AUTH` → `/.well-known/mcp-registry-auth`).
     */
    wellKnown: Record<string, string>;
  };
}

/** `/.well-known/` names the hub itself serves; a WELL_KNOWN_* variable cannot replace them. */
const RESERVED_WELL_KNOWN = /^(oauth-|openid-|mcp$|security\.txt$)/;

/** Reads `WELL_KNOWN_<NAME>` variables: `/.well-known/<name>` (lower case, `_` → `-`) serves the value. */
export function readWellKnownFiles(source: NodeJS.ProcessEnv): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const match = key.match(/^WELL_KNOWN_([A-Z0-9_]+)$/);
    if (!match || !value?.trim()) continue;
    const name = match[1]!.toLowerCase().replace(/_/g, '-');
    if (RESERVED_WELL_KNOWN.test(name))
      throw new ConfigError(`${key}: /.well-known/${name} is served by the hub`);
    files[name] = value.trim();
  }
  return files;
}

function clientPolicies(value: string | undefined): string[] {
  const raw = (value ?? 'claude').trim().toLowerCase();
  if (raw === 'none' || raw === '') return [];
  const ids = [
    ...new Set(
      raw
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
  for (const id of ids) {
    if (!CLIENT_POLICY_IDS.includes(id))
      throw new ConfigError(
        `CLIENT_POLICIES: unknown policy "${id}" (known: ${CLIENT_POLICY_IDS.join(', ')}, none)`,
      );
  }
  return ids;
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

export interface BackupConfig {
  storage: S3Config;
  prefix: string;
  retentionDays: number;
  encryptionKey: string | undefined;
}

function backupConfig(env: z.infer<typeof EnvSchema>): BackupConfig | undefined {
  const parts = {
    BACKUP_S3_ENDPOINT: env.BACKUP_S3_ENDPOINT,
    BACKUP_S3_BUCKET: env.BACKUP_S3_BUCKET,
    BACKUP_S3_ACCESS_KEY_ID: env.BACKUP_S3_ACCESS_KEY_ID,
    BACKUP_S3_SECRET_ACCESS_KEY: env.BACKUP_S3_SECRET_ACCESS_KEY,
  };
  const missing = Object.entries(parts).filter(([, value]) => !value);
  if (missing.length === Object.keys(parts).length) return undefined;
  if (missing.length) {
    throw new ConfigError(`Database backups need ${missing.map(([name]) => name).join(', ')} as well`);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(env.BACKUP_S3_ENDPOINT!);
  } catch {
    throw new ConfigError(`BACKUP_S3_ENDPOINT is not a valid URL: ${env.BACKUP_S3_ENDPOINT}`);
  }
  if (env.BACKUP_ENCRYPTION_KEY) {
    try {
      parseKey(env.BACKUP_ENCRYPTION_KEY);
    } catch {
      throw new ConfigError('BACKUP_ENCRYPTION_KEY must be 32 bytes in base64 or hex');
    }
  }
  const prefix = env.BACKUP_PREFIX ?? `${BRAND.slug}/`;
  return {
    storage: {
      endpoint: endpoint.toString().replace(/\/+$/, ''),
      bucket: env.BACKUP_S3_BUCKET!,
      region: env.BACKUP_S3_REGION,
      accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID!,
      secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY!,
    },
    prefix: prefix.endsWith('/') ? prefix : `${prefix}/`,
    retentionDays: env.BACKUP_RETENTION_DAYS,
    encryptionKey: env.BACKUP_ENCRYPTION_KEY,
  };
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

  if (Boolean(env.REVIEW_ACCOUNT_EMAIL) !== Boolean(env.REVIEW_ACCOUNT_PASSWORD)) {
    throw new ConfigError('REVIEW_ACCOUNT_EMAIL and REVIEW_ACCOUNT_PASSWORD must be set together');
  }
  if (env.REVIEW_ACCOUNT_PASSWORD && env.REVIEW_ACCOUNT_PASSWORD.length < 12) {
    throw new ConfigError('REVIEW_ACCOUNT_PASSWORD must be at least 12 characters');
  }
  if (env.REVIEW_ACCOUNT_EMAIL && env.REVIEW_ACCOUNT_EMAIL.toLowerCase() === env.ADMIN_EMAIL?.toLowerCase()) {
    throw new ConfigError('REVIEW_ACCOUNT_EMAIL must differ from ADMIN_EMAIL');
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
    maxRequestBodyBytes: Math.round(env.MAX_REQUEST_BODY_MB * 1024 * 1024),
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
      verification: { google: env.GOOGLE_SITE_VERIFICATION, bing: env.BING_SITE_VERIFICATION },
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
    billing: billingConfig(source, isProduction),
    mail: mailConfig(source, publicUrl),
    backups: backupConfig(env),
    analytics: {
      enabled: env.ANALYTICS,
      retentionDays: env.ANALYTICS_RETENTION_DAYS,
      countryHeaders: env.ANALYTICS_COUNTRY_HEADERS.split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
      geoipDb: env.ANALYTICS_GEOIP_DB?.toLowerCase() === 'off' ? false : env.ANALYTICS_GEOIP_DB,
      flushMs: Math.round(env.ANALYTICS_FLUSH_SECONDS * 1000),
    },
    ops: {
      sentryDsn: sentryDsn(env.SENTRY_DSN),
      environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
      errorRetentionDays: env.ERROR_RETENTION_DAYS,
      commit: env.RENDER_GIT_COMMIT?.slice(0, 7),
      instance: env.RENDER_INSTANCE_ID,
    },
    directories: {
      clientPolicies: clientPolicies(env.CLIENT_POLICIES),
      reviewAccount:
        env.REVIEW_ACCOUNT_EMAIL && env.REVIEW_ACCOUNT_PASSWORD
          ? { email: env.REVIEW_ACCOUNT_EMAIL.toLowerCase(), password: env.REVIEW_ACCOUNT_PASSWORD }
          : undefined,
      wellKnown: readWellKnownFiles(source),
    },
  };
}

/** SENTRY_DSN is checked at start, so a typo shows up in the deploy log instead of losing errors. */
function sentryDsn(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    parseSentryDsn(value);
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
  return value;
}

function billingConfig(source: NodeJS.ProcessEnv, isProduction: boolean): BillingConfig {
  try {
    return readBillingConfig(source, { isProduction });
  } catch (error) {
    if (error instanceof BillingConfigError) throw new ConfigError(error.message);
    throw error;
  }
}

function mailConfig(source: NodeJS.ProcessEnv, publicUrl: string): MailConfig {
  try {
    return readMailConfig(source, { from: `${BRAND.name} <hello@${new URL(publicUrl).hostname}>` });
  } catch (error) {
    if (error instanceof MailConfigError) throw new ConfigError(error.message);
    throw error;
  }
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
