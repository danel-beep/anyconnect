import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findUserByEmail, getDefaultWorkspace } from '../src/core/identity.js';
import type { Principal } from '../src/core/principal.js';
import { oauthClients } from '../src/db/schema.js';
import { ADMIN, resetDatabase, startTestHub, TestBrowser, type TestHub } from './helpers.js';

const REVIEW = { email: 'reviewer@directory.test', password: 'review-password-123' };
const PROOF = 'v=MCPv1; k=ed25519; p=dGVzdC1wdWJsaWMta2V5LXRlc3QtcHVibGljLWtleSE=';

/** What AI app directories fetch from the hub and what their reviewers and users get. */
describe('AI app directories', () => {
  let hub: TestHub;

  beforeAll(async () => {
    await resetDatabase();
    hub = await startTestHub({
      env: {
        REVIEW_ACCOUNT_EMAIL: REVIEW.email,
        REVIEW_ACCOUNT_PASSWORD: REVIEW.password,
        WELL_KNOWN_MCP_REGISTRY_AUTH: PROOF,
        SUPPORT_EMAIL: 'support@hub.example',
        CLIENT_POLICIES: 'claude,chatgpt',
      },
    });
  });
  afterAll(() => hub.close());

  it('serves ownership proofs as plain text, next to the OAuth documents', async () => {
    const proof = await fetch(`${hub.baseUrl}/.well-known/mcp-registry-auth`);
    expect(proof.status).toBe(200);
    expect(proof.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await proof.text()).toBe(PROOF);
    expect((await fetch(`${hub.baseUrl}/.well-known/openai-apps-challenge`)).status).toBe(404);
    const oauth = await fetch(`${hub.baseUrl}/.well-known/oauth-authorization-server`);
    expect(((await oauth.json()) as { issuer: string }).issuer).toBe(hub.baseUrl);
  });

  it('says where to report a vulnerability (security.txt)', async () => {
    const file = await fetch(`${hub.baseUrl}/.well-known/security.txt`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toMatch(/^text\/plain/);
    const text = await file.text();
    expect(text).toContain('Contact: mailto:support@hub.example');
    expect(text).toContain(`Canonical: ${hub.baseUrl}/.well-known/security.txt`);
    expect(text).toContain(`Policy: ${hub.baseUrl}/trust`);
    // Valid for months ahead, and less than the year the standard allows.
    const expires = Date.parse(/^Expires: (.+)$/m.exec(text)![1]!);
    expect(expires - Date.now()).toBeGreaterThan(150 * 86_400_000);
    expect(expires - Date.now()).toBeLessThan(365 * 86_400_000);
  });

  it('serves the server card and the icons', async () => {
    const card = (await (await fetch(`${hub.baseUrl}/.well-known/mcp/server-card.json`)).json()) as any;
    expect(card.serverInfo.name).toBe('manyplug');
    expect(card.serverInfo.icons[0].src).toBe(`${hub.baseUrl}/icon.svg`);
    expect(card.tools.length).toBeGreaterThan(5);
    const png = await fetch(`${hub.baseUrl}/icon-512.png`);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await png.arrayBuffer()).readUInt32BE(16)).toBe(512);
    expect((await fetch(`${hub.baseUrl}/icon-100.png`)).status).toBe(404);
    expect((await fetch(`${hub.baseUrl}/icon.svg`)).headers.get('content-type')).toBe('image/svg+xml');
  });

  it('has a support page linked from every page', async () => {
    const browser = new TestBrowser(hub.baseUrl);
    await browser.request('/prefs/lang?to=en');
    const page = await browser.request('/support');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<h1>Support</h1>');
    expect(html).toContain(`${hub.baseUrl}/mcp`);
    expect(html).toContain('href="/support"');
    const privacy = await (await browser.request('/privacy')).text();
    expect(privacy).toContain('AI apps and your conversations');
    expect(privacy).toContain('Your rights');
  });

  it('creates the reviewers’ sign-in with demo accounts and no plan limits', async () => {
    const user = await findUserByEmail(hub.services.db, REVIEW.email);
    expect(user?.role).toBe('user');
    const workspace = await getDefaultWorkspace(hub.services.db, user!.id);
    const accounts = await hub.services.accounts.list(workspace!.id);
    expect(accounts.map((a) => `${a.connectorId}:${a.name}`).sort()).toEqual(['demo:main', 'demo:second']);
    const browser = new TestBrowser(hub.baseUrl);
    const login = await browser.login(REVIEW.email, REVIEW.password);
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).not.toContain('/login/verify');
  });

  it('gives each AI app the tools its directory accepts', async () => {
    const owner = await findUserByEmail(hub.services.db, ADMIN.email);
    const workspace = await getDefaultWorkspace(hub.services.db, owner!.id);
    const client = async (id: string, redirect: string) => {
      await hub.services.db.insert(oauthClients).values({
        id,
        registrationType: 'dynamic',
        metadata: { client_name: id, redirect_uris: [redirect] } as never,
      });
      const principal: Principal = {
        kind: 'oauth',
        userId: owner!.id,
        workspaceId: workspace!.id,
        scopes: ['mcp'],
        clientId: id,
      };
      return (await hub.services.hub.getCatalog(principal)).tools.map((t) => t.name);
    };
    const claude = await client('claude-test', 'https://claude.ai/api/mcp/auth_callback');
    const chatgpt = await client('chatgpt-test', 'https://chatgpt.com/connector_platform_oauth_redirect');
    const other = await client('other-test', 'https://agent.example.dev/callback');

    expect(other).toEqual(expect.arrayContaining(['demo_fail', 'manyplug_call_tool', 'manyplug_buy_plan']));
    expect(claude).toContain('manyplug_call_tool');
    expect(claude).not.toContain('demo_fail');
    expect(chatgpt).not.toContain('manyplug_call_tool');
    expect(chatgpt).not.toContain('manyplug_buy_plan');
    expect(chatgpt).toContain('demo_echo');
  });
});
