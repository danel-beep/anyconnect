import {
  Client,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountKeyring } from '../src/core/account-keys.js';
import { getDefaultWorkspace } from '../src/core/identity.js';
import { oauthGrants, users, vaultWraps } from '../src/db/schema.js';
import { hashToken, SecretBox } from '../src/lib/crypto.js';
import { createLogger } from '../src/logger.js';
import { ADMIN, resetDatabase, startTestHub, TEST_KEY, TestBrowser, type TestHub } from './helpers.js';

type Stored = Parameters<NonNullable<OAuthClientProvider['saveClientInformation']>>[0];
type Tokens = Parameters<OAuthClientProvider['saveTokens']>[0];

class MemoryOAuthProvider implements OAuthClientProvider {
  client?: Stored;
  savedTokens?: Tokens;
  verifier = '';
  authorizationUrl?: URL;
  readonly redirectUrl = 'http://localhost:7777/callback';
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Vault Test Client',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.client;
  }
  saveClientInformation(info: Stored) {
    this.client = info;
  }
  tokens() {
    return this.savedTokens;
  }
  saveTokens(tokens: Tokens) {
    this.savedTokens = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

async function connect(hub: TestHub, provider: MemoryOAuthProvider, browser: TestBrowser): Promise<Client> {
  if (!provider.savedTokens) {
    const first = new StreamableHTTPClientTransport(new URL(hub.mcpUrl), { authProvider: provider });
    await expect(new Client({ name: 'probe', version: '1.0.0' }).connect(first)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    const callback = await browser.authorize(provider.authorizationUrl!);
    await first.finishAuth(callback.searchParams);
  }
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(hub.mcpUrl), { authProvider: provider }));
  return client;
}

const pendingId = (value: string) => /\/confirm\/(pcl_[0-9a-z]+)/.exec(value)?.[1];

const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n');

describe('sealed accounts (protected by default)', () => {
  let hub: TestHub;
  let userId: string;
  let workspaceId: string;
  const browser = () => new TestBrowser(hub.baseUrl);
  let signedIn: TestBrowser;
  let provider: MemoryOAuthProvider;
  let client: Client;

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({ seed: false, env: { CONFIRMATION_WAIT_SECONDS: '0' } });
    const [owner] = await hub.services.db.select().from(users).where(eq(users.email, ADMIN.email));
    userId = owner!.id;
    workspaceId = (await getDefaultWorkspace(hub.services.db, userId))!.id;
  });

  afterAll(async () => {
    await client?.close();
    await hub.close();
  });

  it('creates the vault the first time the user is seen in a browser, with no extra step', async () => {
    expect(await hub.services.vaults.exists(userId)).toBe(false);
    signedIn = browser();
    await signedIn.login();
    await signedIn.request('/app');
    expect(await hub.services.vaults.exists(userId)).toBe(true);
    expect(signedIn.cookie('mp_vault')).toMatch(new RegExp(`^${userId}\\.dev_`));
    const wraps = await hub.services.db.select().from(vaultWraps).where(eq(vaultWraps.userId, userId));
    expect(wraps.map((w) => w.kind)).toEqual(['device']);
  });

  it('seals new accounts to the vault: the database and ENCRYPTION_KEY together cannot open them', async () => {
    const row = await hub.services.accounts.create(workspaceId, {
      connectorId: 'demo',
      label: 'Sealed',
      credentials: { secret: 'sealed-secret' },
    });
    expect(row.dataKeyEncrypted).toMatch(/^s1\./);

    // What an attacker holding a database copy and the master key could run:
    const secrets = new SecretBox(TEST_KEY);
    const keyring = new AccountKeyring(secrets, secrets);
    expect(() => keyring.decryptCredentials(row, row.credentialsEncrypted!)).toThrow();

    // The hub itself, outside a request that brings the user's secret (admin panel, a job):
    await expect(
      hub.services.accounts.buildContext((await hub.services.connectors.get(workspaceId, 'demo'))!, row, {
        signal: AbortSignal.timeout(5000),
        logger: createLogger({ level: 'silent' }),
      }),
    ).rejects.toMatchObject({ code: 'vault_locked' });
  });

  it('opens for the AI app the user approved, with the token it presents', async () => {
    provider = new MemoryOAuthProvider();
    client = await connect(hub, provider, signedIn);
    const result = await client.callTool({ name: 'demo_account_info', arguments: { account: 'sealed' } });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('sealed');

    // Only hashes of the app's tokens are stored next to the wraps.
    const oauthWraps = await hub.services.db
      .select()
      .from(vaultWraps)
      .where(and(eq(vaultWraps.userId, userId), eq(vaultWraps.kind, 'oauth')));
    expect(oauthWraps.map((w) => w.ref).sort()).toEqual(
      [hashToken(provider.savedTokens!.access_token), hashToken(provider.savedTokens!.refresh_token!)].sort(),
    );
    const codeWraps = await hub.services.db
      .select()
      .from(vaultWraps)
      .where(eq(vaultWraps.kind, 'oauth_code'));
    expect(codeWraps).toHaveLength(0);
  });

  it('keeps working after the app refreshes its tokens', async () => {
    const response = await fetch(`${hub.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: provider.savedTokens!.refresh_token!,
        client_id: provider.client!.client_id,
      }),
    });
    expect(response.status).toBe(200);
    provider.savedTokens = (await response.json()) as Tokens;
    await client.close();
    client = await connect(hub, provider, signedIn);
    const result = await client.callTool({ name: 'demo_account_info', arguments: { account: 'sealed' } });
    expect(result.isError).toBeFalsy();
  });

  it('a held-back call runs after approval with the vault its AI app brought, kept in memory only', async () => {
    await hub.services.admin.updateSecurity(workspaceId, { defaultConfirm: 'always' });
    const ask = () => client.callTool({ name: 'demo_account_info', arguments: { account: 'sealed' } });
    const decide = async (id: string, by: TestBrowser) => {
      const page = await by.request(`/confirm/${id}`);
      const { csrf } = TestBrowser.hiddenInputs(await page.text());
      expect(
        (await by.request(`/confirm/${id}`, { form: { csrf: csrf!, decision: 'approve' } })).status,
      ).toBe(303);
    };
    try {
      const id = pendingId(text(await ask()))!;
      expect(id).toBeDefined();
      // Approved from a browser where the vault is locked: the run uses the vault held from the AI's call.
      const locked = browser();
      await locked.login();
      await decide(id, locked);
      await hub.services.pendingRunner.tick();
      const done = await ask();
      expect(done.isError).toBeFalsy();
      expect(text(done)).toContain('sealed');

      // After a restart the held vault is gone: the run reports a locked vault, and nothing leaks.
      const next = pendingId(text(await ask()))!;
      hub.services.vaultScopes.release(next);
      await decide(next, locked);
      await hub.services.pendingRunner.tick();
      const failed = await ask();
      expect(failed.isError).toBe(true);
      expect(text(failed)).toMatch(/vault/i);
    } finally {
      await hub.services.admin.updateSecurity(workspaceId, { defaultConfirm: 'dangerous' });
      await hub.services.database.pool.query('DELETE FROM pending_calls');
    }
  });

  it('an app without a way into the vault says what to do, and one Allow lets it in for good', async () => {
    // Approved from a browser where the vault is locked: like an app connected before the vault existed.
    const other = browser();
    const otherProvider = new MemoryOAuthProvider();
    let otherClient = await connect(hub, otherProvider, other);
    const ask = () => otherClient.callTool({ name: 'demo_account_info', arguments: { account: 'sealed' } });
    const locked = await ask();
    expect(locked.isError).toBe(true);
    // The AI gets the exact step, with the link and the app's name, not a bare "vault locked".
    expect(text(locked)).toContain(`${hub.baseUrl}/security#vault`);
    expect(text(locked)).toContain('Allow');
    expect(text(locked)).toContain('Vault Test Client');
    // The open browser names the app on every page and on Security, next to Allow.
    expect(await (await signedIn.request('/app')).text()).toContain('Vault Test Client просит открыть');
    const security = await (await signedIn.request('/security')).text();
    const action = security.match(/action="(\/security\/vault\/requests\/oauth\/[^"]+\/allow)"/)?.[1];
    expect(action).toBeDefined();
    // The request holds only public keys: nothing in it opens the vault.
    const [row] = await hub.services.database.pool
      .query("select keys from vault_requests where kind = 'oauth'")
      .then((r) => r.rows as { keys: { ref: string; publicKey: string }[] }[]);
    expect(JSON.stringify(row!.keys)).not.toContain(otherProvider.savedTokens!.access_token);
    const allowed = await signedIn.request(action!, {
      form: { csrf: TestBrowser.hiddenInputs(security).csrf! },
    });
    expect(allowed.status).toBe(303);

    expect((await ask()).isError).toBeFalsy();
    // Its tokens rotate and it keeps the way in: the request covered the refresh token too.
    const refreshed = await fetch(`${hub.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: otherProvider.savedTokens!.refresh_token!,
        client_id: otherProvider.client!.client_id,
      }),
    });
    expect(refreshed.status).toBe(200);
    otherProvider.savedTokens = (await refreshed.json()) as Tokens;
    await otherClient.close();
    otherClient = await connect(hub, otherProvider, other);
    expect((await ask()).isError).toBeFalsy();
    expect(await hub.services.vaults.requests(userId)).not.toContainEqual(
      expect.objectContaining({ kind: 'oauth' }),
    );
    await otherClient.close();
  });

  it('a new browser opens the vault once the signed-in browser allows it, matching codes', async () => {
    const other = browser();
    await other.login();
    const locked = await (await other.request('/security')).text();
    expect(locked).toContain('Закрыт в этом браузере');
    const code = locked.match(/<code class="device-code">([^<]+)<\/code>/)?.[1];
    expect(code).toMatch(/^\d{3} \d{3}$/);
    // The dashboard of the locked browser says what to do; the open one shows the request.
    expect(await (await other.request('/app')).text()).toContain(
      'Защищённые аккаунты закрыты в этом браузере',
    );
    expect(await (await signedIn.request('/app')).text()).toContain('Браузер просит открыть');
    expect(await (await signedIn.request('/security')).text()).toContain(code!);

    // Approving seals the vault key to the new browser's device key, which the server never stored.
    await other.approveFrom(signedIn);
    const device = other.vaultSecret()!;
    const [wrap] = await hub.services.db
      .select()
      .from(vaultWraps)
      .where(and(eq(vaultWraps.userId, userId), eq(vaultWraps.ref, device.ref)));
    expect(wrap!.wrapped).toMatch(/^s1\./);
    expect(wrap!.wrapped).not.toContain(device.secret.toString('base64url'));
    expect(await (await other.request('/security')).text()).toContain('Открыт в этом браузере');

    // An app approved there now opens sealed accounts too.
    const otherClient = await connect(hub, new MemoryOAuthProvider(), other);
    const result = await otherClient.callTool({
      name: 'demo_account_info',
      arguments: { account: 'sealed' },
    });
    expect(result.isError).toBeFalsy();
    await otherClient.close();
  });

  it('a request can be declined, and a locked browser cannot approve anyone', async () => {
    const stranger = browser();
    await stranger.login();
    await stranger.request('/security');
    const thief = browser();
    await thief.login();
    // The locked browser sees no requests and has nothing to approve them with.
    const page = await (await thief.request('/security')).text();
    expect(page).not.toContain('/allow');
    const [request] = (await hub.services.vaults.requests(userId)).filter((r) => r.kind === 'device');
    const forced = await thief.request(`/security/vault/requests/device/${request!.subject}/allow`, {
      form: { csrf: TestBrowser.hiddenInputs(page).csrf! },
    });
    expect(forced.status).toBe(303);
    expect(await hub.services.vaults.hasWrap(userId, 'device', request!.subject)).toBe(false);

    const open = await (await signedIn.request('/security')).text();
    const declined = await signedIn.request(`/security/vault/requests/device/${request!.subject}/deny`, {
      form: { csrf: TestBrowser.hiddenInputs(open).csrf! },
    });
    expect(declined.status).toBe(303);
    expect((await hub.services.vaults.requests(userId)).map((r) => r.subject)).not.toContain(
      request!.subject,
    );
  });

  it('the optional recovery key opens the vault in a browser nobody can approve', async () => {
    const page = await (await signedIn.request('/security')).text();
    const created = await signedIn.request('/security/vault/recovery-key', {
      form: { csrf: TestBrowser.hiddenInputs(page).csrf! },
    });
    expect(created.headers.get('cache-control')).toBe('no-store');
    const recoveryKey = (await created.text()).match(/<code class="recovery-key">([^<]+)<\/code>/)?.[1];
    expect(recoveryKey).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{1,4})+$/);
    expect(await hub.services.vaults.hasRecoveryKey(userId)).toBe(true);

    const fresh = browser();
    await fresh.login();
    const locked = await (await fresh.request('/security')).text();
    const csrf = TestBrowser.hiddenInputs(locked).csrf!;
    await fresh.request('/security/vault/unlock', { form: { csrf, recoveryKey: 'AAAA-BBBB' } });
    expect(await (await fresh.request('/security')).text()).toContain('Этот ключ не открывает ваш сейф');
    await fresh.request('/security/vault/unlock', { form: { csrf, recoveryKey: recoveryKey! } });
    expect(await (await fresh.request('/security')).text()).toContain('Открыт в этом браузере');
    const ctx = await fresh.inVault(hub.services, async () =>
      hub.services.accounts.buildContext(
        (await hub.services.connectors.get(workspaceId, 'demo'))!,
        (await hub.services.accounts.list(workspaceId)).find((a) => a.name === 'sealed')!,
        { signal: AbortSignal.timeout(5000), logger: createLogger({ level: 'silent' }) },
      ),
    );
    expect(ctx.credentials).toEqual({ secret: 'sealed-secret' });
  });

  it('a revoked app loses its way into the vault at once', async () => {
    const [grant] = await hub.services.db
      .select()
      .from(oauthGrants)
      .where(eq(oauthGrants.clientId, provider.client!.client_id));
    await hub.services.oauth.revokeGrantById(grant!.id);
    const left = await hub.services.db
      .select()
      .from(vaultWraps)
      .where(eq(vaultWraps.ref, hashToken(provider.savedTokens!.access_token)));
    expect(left).toHaveLength(0);
  });

  it('a personal token made in the signed-in browser opens the vault too', async () => {
    const page = await signedIn.request('/app/apps');
    const hidden = TestBrowser.hiddenInputs(await page.text());
    const created = await signedIn.request('/app/tokens', {
      form: { csrf: hidden.csrf!, name: 'Script', days: '0' },
    });
    const token = (await created.text()).match(/ac_pat_[\w-]+/)?.[0];
    expect(token).toBeDefined();
    const patClient = new Client({ name: 'pat', version: '1.0.0' });
    await patClient.connect(
      new StreamableHTTPClientTransport(new URL(hub.mcpUrl), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const result = await patClient.callTool({ name: 'demo_account_info', arguments: { account: 'sealed' } });
    expect(result.isError).toBeFalsy();
    await patClient.close();
  });

  it('a personal token made outside a browser asks for access by its name and gets it with Allow', async () => {
    const { token } = await hub.services.apiTokens.create({
      workspaceId,
      userId,
      name: 'Nightly script',
      scopes: ['mcp'],
    });
    const patClient = new Client({ name: 'pat', version: '1.0.0' });
    await patClient.connect(
      new StreamableHTTPClientTransport(new URL(hub.mcpUrl), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const ask = () => patClient.callTool({ name: 'demo_account_info', arguments: { account: 'sealed' } });
    const locked = await ask();
    expect(locked.isError).toBe(true);
    expect(text(locked)).toContain('"Nightly script"');
    const security = await (await signedIn.request('/security')).text();
    expect(security).toContain('Nightly script');
    const action = security.match(/action="(\/security\/vault\/requests\/api_token\/[^"]+\/allow)"/)?.[1];
    await signedIn.request(action!, { form: { csrf: TestBrowser.hiddenInputs(security).csrf! } });
    expect((await ask()).isError).toBeFalsy();
    await patClient.close();
  });
});
