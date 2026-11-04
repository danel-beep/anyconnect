import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { bootstrap } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import type { ConnectorRegistry } from '../src/connectors/registry.js';
import type { OidcLoginProvider } from '../src/core/external-login.js';
import { runMigrations } from '../src/db/migrate.js';
import type { StageMap } from '../src/hub/executor.js';
import type { safeFetch } from '../src/lib/safe-fetch.js';
import { createLogger } from '../src/logger.js';
import { createServices, type Services } from '../src/services.js';
import type { FakeInternet } from './e2e/fake-internet.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/manyplug_test';

export const ADMIN = { email: 'owner@example.com', password: 'correct-horse-battery-staple' };
export const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

/** A second test database next to TEST_DATABASE_URL (e.g. for a second hub), created if missing. */
export async function ensureTestDatabase(suffix: string): Promise<string> {
  const url = new URL(TEST_DATABASE_URL);
  const name = `${url.pathname.slice(1)}_${suffix}`;
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [name]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  url.pathname = `/${name}`;
  return url.toString();
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
             workspace_members, workspaces, users RESTART IDENTITY CASCADE`);
}

export interface TestHub {
  services: Services;
  baseUrl: string;
  mcpUrl: string;
  close(): Promise<void>;
}

/** Starts a real HTTP server on a random port with a fresh service graph. */
export async function startTestHub(
  options: {
    env?: Record<string, string>;
    connectors?: ConnectorRegistry;
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
  });
  await truncateAll(services);
  await bootstrap(services);
  const app = createApp(services);
  handler = (req) => app.fetch(req);
  return {
    services,
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
    init: { method?: string; form?: Record<string, string>; json?: unknown } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
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

  /** Value of a cookie, by its full name. */
  cookie(name: string): string | undefined {
    return this.cookies.get(name);
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
