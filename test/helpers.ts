import { type AddressInfo, createServer } from 'node:net';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { bootstrap } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import type { BuiltinDeps } from '../src/connectors/index.js';
import type { ConnectorRegistry } from '../src/connectors/registry.js';
import type { OidcLoginProvider } from '../src/core/external-login.js';
import { VaultSecret } from '../src/core/vault-scope.js';
import { runMigrations } from '../src/db/migrate.js';
import type { StageMap } from '../src/hub/executor.js';
import type { safeFetch } from '../src/lib/safe-fetch.js';
import { base32Decode, totp } from '../src/lib/totp.js';
import { createLogger } from '../src/logger.js';
import type { Mailer } from '../src/mail/mailer.js';
import { createServices, type Services } from '../src/services.js';
import type { FakeInternet } from './e2e/fake-internet.js';
import { createDatabaseIfMissing, DEFAULT_TEST_DATABASE_URL, siblingDatabaseUrl } from './setup/databases.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;

export const ADMIN = { email: 'owner@example.com', password: 'correct-horse-battery-staple' };
export const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

/** A second test database next to TEST_DATABASE_URL (e.g. for a second hub), created if missing. */
export async function ensureTestDatabase(suffix: string): Promise<string> {
  const url = siblingDatabaseUrl(TEST_DATABASE_URL, suffix);
  await createDatabaseIfMissing(url, [TEST_DATABASE_URL]);
  return url;
}

/**
 * A free TCP port on localhost, for code that must be given a port number up front. Tests never
 * use fixed ports: two test runs on one machine would collide on them.
 */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Recreates the schema from migrations. Call once per test file. */
export async function resetDatabase(databaseUrl = TEST_DATABASE_URL): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query(
      'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;',
    );
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

export async function truncateAll(services: Services): Promise<void> {
  await services.database.pool.query(`
    TRUNCATE tool_calls, account_oauth, oauth_connect_states, oauth_apps, custom_connectors, accounts,
             api_tokens, oauth_tokens, oauth_authorization_codes, oauth_grants, oauth_clients, web_sessions,
             pending_logins, webauthn_challenges, webauthn_credentials, user_recovery_codes, user_totp,
             login_states, admin_audit_log, limit_grants, subscriptions, user_identities,
             error_groups, job_runs, workspace_members, workspaces, users, analytics_visits,
             analytics_pages, analytics_events, analytics_salts, user_attribution RESTART IDENTITY CASCADE`);
}

export interface TestHub {
  services: Services;
  /** The app itself, so a test can add routes (e.g. one that throws). */
  app: ReturnType<typeof createApp>;
  baseUrl: string;
  mcpUrl: string;
  close(): Promise<void>;
}

/** Starts a real HTTP server on a random port with a fresh service graph. */
export async function startTestHub(
  options: {
    env?: Record<string, string>;
    connectors?: ConnectorRegistry | ((deps: BuiltinDeps) => ConnectorRegistry);
    fetchDocument?: typeof safeFetch;
    seed?: boolean;
    stages?: StageMap;
    /** A fake Telegram Bot API (set TELEGRAM_BOT_TOKEN in `env` too). */
    telegramFetch?: typeof fetch;
    databaseUrl?: string;
    /** External sign-in providers with fake endpoints ("Sign in with Google" tests). */
    loginProviders?: OidcLoginProvider[];
    /**
     * All outbound traffic (connectors, provider OAuth, Google sign-in, client metadata documents)
     * goes to these fake services instead of the network.
     */
    internet?: FakeInternet;
    /** Captures the hub's emails (`MemoryMailer`). */
    mailer?: Mailer;
    /** A fake Sentry (set SENTRY_DSN in `env` too). */
    sentryFetch?: typeof fetch;
  } = {},
): Promise<TestHub> {
  let handler: ((req: Request) => Response | Promise<Response>) | undefined;
  const server = serve({
    fetch: (req) => (handler ? handler(req) : new Response('starting', { status: 503 })),
    hostname: '127.0.0.1',
    port: 0,
  });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: options.databaseUrl ?? TEST_DATABASE_URL,
    DATABASE_POOL_MAX: '4',
    PUBLIC_URL: baseUrl,
    ENCRYPTION_KEY: TEST_KEY,
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    MIGRATE_ON_START: 'false',
    SEED_DEMO_ACCOUNTS: options.seed === false ? 'false' : 'true',
    LOG_LEVEL: 'silent',
    // Test services (fake APIs, a second hub) listen on localhost.
    ALLOW_PRIVATE_NETWORK: 'true',
    JOBS_ENABLED: 'false',
    ...options.env,
  });
  const services = createServices(config, {
    logger: createLogger({ level: 'silent' }),
    ...(options.connectors ? { connectors: options.connectors } : {}),
    ...(options.fetchDocument ? { fetchDocument: options.fetchDocument } : {}),
    ...(options.internet
      ? { network: options.internet.network(), fetchDocument: options.internet.fetchDocument }
      : {}),
    ...(options.stages ? { stages: options.stages } : {}),
    ...(options.telegramFetch ? { telegramFetch: options.telegramFetch } : {}),
    ...(options.loginProviders ? { loginProviders: options.loginProviders } : {}),
    ...(options.mailer ? { mailer: options.mailer } : {}),
    ...(options.sentryFetch ? { sentryFetch: options.sentryFetch } : {}),
  });
  await truncateAll(services);
  await bootstrap(services);
  const app = createApp(services);
  handler = (req) => app.fetch(req);
  return {
    services,
    app,
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await services.close();
    },
  };
}

/** Minimal browser: cookie jar, manual redirects, form posts with an Origin header. */
export class TestBrowser {
  /** Starts as a visitor who picked Russian with the language switch (tests assert Russian texts). */
  private readonly cookies = new Map<string, string>([['ac_lang', 'ru']]);

  /** Headers sent with every request (User-Agent, Accept-Language: analytics tests). */
  readonly headers: Record<string, string> = {};

  /**
   * @param external answers pages on other sites (a provider's sign-in page in the fake internet);
   *   without it they are fetched for real.
   */
  constructor(
    private readonly origin: string,
    private readonly external?: (request: Request) => Response | Promise<Response>,
  ) {}

  async request(
    url: string,
    init: {
      method?: string;
      form?: Record<string, string>;
      json?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...this.headers, ...init.headers };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let body: string | undefined;
    if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers.origin = this.origin;
      body = new URLSearchParams(init.form).toString();
    } else if (init.json !== undefined) {
      // What /assets/webauthn.js sends with fetch().
      headers['content-type'] = 'application/json';
      headers.origin = this.origin;
      body = JSON.stringify(init.json);
    }
    const target = new URL(url, this.origin);
    if (target.origin !== this.origin && this.external) {
      // Another site: no cookies of ours go there (the jar only holds this origin's cookies).
      return this.external(new Request(target, { method: init.method ?? 'GET', redirect: 'manual' }));
    }
    const response = await fetch(target, {
      method: init.method ?? (body !== undefined ? 'POST' : 'GET'),
      headers,
      body,
      redirect: 'manual',
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair!.indexOf('=');
      const name = pair!.slice(0, index);
      const value = pair!.slice(index + 1);
      if (/max-age=0/i.test(cookie) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  /**
   * Follows redirects like a browser, across sites, until a page answers or the next location is
   * one `stopAt` claims (an app's redirect URI). Returns the last response and its URL; `stopped`
   * is the claimed location, not requested.
   */
  async walk(
    start: string | URL,
    stopAt: (url: URL) => boolean = () => false,
    maxHops = 12,
  ): Promise<{ response: Response; url: URL; stopped?: URL }> {
    let url = new URL(start, this.origin);
    for (let hop = 0; hop < maxHops; hop++) {
      const response = await this.request(url.toString());
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || !location) return { response, url };
      const next = new URL(location, url);
      if (stopAt(next)) return { response, url, stopped: next };
      url = next;
    }
    throw new Error(`Too many redirects from ${start.toString()}`);
  }

  /** Every cookie of the jar, e.g. to hand a signed-in session to a real browser. */
  cookieEntries(): [string, string][] {
    return [...this.cookies];
  }

  /** Value of a cookie, by its full name. */
  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  /** This browser's device key for its user's vault (set on the first signed-in page). */
  vaultSecret(): VaultSecret | undefined {
    const [userId, deviceId, secret] = this.cookie('mp_vault')?.split('.') ?? [];
    if (!userId || !deviceId || !secret) return undefined;
    return new VaultSecret(userId, 'device', deviceId, Buffer.from(secret, 'base64url'));
  }

  /**
   * Runs `fn` as code inside one of this browser's requests: with its vault open, so services
   * called directly can use the user's sealed accounts.
   */
  async inVault<T>(services: Services, fn: () => Promise<T>): Promise<T> {
    if (!this.cookie('mp_vault')) await this.request('/app');
    return services.vaultScopes.run(this.vaultSecret(), fn);
  }

  /**
   * Lets this browser open the vault the way a user does: it shows a code on Security, and `owner`
   * (a browser where the vault is open) presses Allow next to the same code.
   */
  async approveFrom(owner: TestBrowser): Promise<void> {
    const mine = await (await this.request('/security')).text();
    const code = mine.match(/<code class="device-code">([^<]+)<\/code>/)?.[1];
    if (!code) throw new Error('This browser shows no vault code (is its vault already open?)');
    const page = await (await owner.request('/security')).text();
    const at = page.indexOf(`<code class="device-code">${code}</code>`);
    const action =
      at < 0 ? undefined : page.slice(at).match(/action="(\/security\/vault\/devices\/[^"]+\/allow)"/)?.[1];
    if (!action) throw new Error(`The owner's browser shows no request with code ${code}`);
    const response = await owner.request(action, { form: { csrf: TestBrowser.hiddenInputs(page).csrf! } });
    if (response.status !== 303) throw new Error(`Allowing the browser failed: ${response.status}`);
  }

  static hiddenInputs(html: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/?>/g)) {
      out[match[1]!] = decodeEntities(match[2]!);
    }
    return out;
  }

  async login(email = ADMIN.email, password = ADMIN.password, next = '/'): Promise<Response> {
    const page = await this.request(`/login?next=${encodeURIComponent(next)}`);
    const hidden = TestBrowser.hiddenInputs(await page.text());
    return this.request('/login', { form: { ...hidden, email, password } });
  }

  /**
   * Walks an authorization URL like a user would: sign in if needed, then press "Allow"
   * (or "Deny"). Returns the final redirect to the client's redirect_uri.
   */
  async authorize(authorizationUrl: string | URL, decision: 'approve' | 'deny' = 'approve'): Promise<URL> {
    let response = await this.request(authorizationUrl.toString());
    if (response.status === 302 && response.headers.get('location')?.startsWith('/login')) {
      const next = new URL(response.headers.get('location')!, this.origin).searchParams.get('next')!;
      const login = await this.login(ADMIN.email, ADMIN.password, next);
      if (login.status !== 303) throw new Error(`login failed with ${login.status}: ${await login.text()}`);
      response = await this.request(login.headers.get('location')!);
    }
    if (response.status !== 200) {
      throw new Error(
        `expected consent page, got ${response.status} ${response.headers.get('location') ?? ''}`,
      );
    }
    const hidden = TestBrowser.hiddenInputs(await response.text());
    const decisionResponse = await this.request('/oauth/authorize', { form: { ...hidden, decision } });
    if (decisionResponse.status !== 303) throw new Error(`consent failed with ${decisionResponse.status}`);
    return new URL(decisionResponse.headers.get('location')!);
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Tool results with third-party content arrive wrapped in ⟦untrusted⟧ markers; returns the inside. */
export function unwrapUntrusted(text: string): string {
  return text.replace(/^⟦untrusted (\w+) source="[^"]*"⟧\n([\s\S]*)\n⟦\/untrusted \1⟧$/, '$2');
}

/**
 * Turns on TOTP for the signed-in user of `browser`; confirming it upgrades the current session
 * (pwd + otp), which the admin panel requires. Returns the TOTP secret.
 */
export async function enableTotp(browser: TestBrowser): Promise<string> {
  const page = await browser.request('/security');
  const { csrf } = TestBrowser.hiddenInputs(await page.text());
  await browser.request('/security/totp/setup', { form: { csrf: csrf! } });
  const setup = await (await browser.request('/security')).text();
  const secret = setup.match(/id="totp-secret"[^>]*value="([A-Z2-7]+)"/)![1]!;
  const confirm = await browser.request('/security/totp/confirm', {
    form: { csrf: csrf!, code: totp(base32Decode(secret), Date.now()) },
  });
  if (confirm.status !== 200) throw new Error(`TOTP confirmation failed with ${confirm.status}`);
  return secret;
}
