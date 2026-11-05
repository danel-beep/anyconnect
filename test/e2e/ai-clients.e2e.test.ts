import { UnauthorizedError } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { translator } from '../../src/web/i18n.js';
import { ADMIN, resetDatabase, startTestHub, TestBrowser, type TestHub } from '../helpers.js';
import { AI_CLIENTS, type AiClientProfile, SimulatedAiClient, serveClientDocuments } from './ai-clients.js';
import { FakeInternet } from './fake-internet.js';
import { FakeGoogle, type GoogleUser } from './fakes/google.js';
import { allow, approveOnWeb, mailboxes, textOf } from './journey.js';

/**
 * Every AI client in `AI_CLIENTS` goes through the same connection, the way the real app would:
 * discovery from the 401, its own way of identifying itself (metadata document or registration,
 * public or confidential client), sign-in and consent in a fresh browser window, the tool list,
 * calls to a connected service (Gmail against a fake Google), the confirmation the client can
 * show (in the chat or through a link), token refresh and disconnection from the dashboard.
 */

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

describe('AI clients connect end to end', () => {
  let hub: TestHub;
  let internet: FakeInternet;
  let google: FakeGoogle;
  let mailbox: GoogleUser;
  let workspaceId: string;
  /** The owner's own browser, signed in once (the dashboard, confirmation pages). */
  let owner: TestBrowser;

  beforeAll(async () => {
    await resetDatabase();
    internet = new FakeInternet();
    google = new FakeGoogle().install(internet);
    serveClientDocuments(internet);
    mailbox = google.addUser({
      email: 'owner@northwind.example',
      hd: 'northwind.example',
      mailbox: mailboxes.work,
    });
    hub = await startTestHub({ internet, env: { ...google.env, CONFIRMATION_WAIT_SECONDS: '0' } });
    workspaceId = (await hub.services.db.query.workspaces.findFirst())!.id;

    // The owner (password account with the demo accounts) connects one Gmail mailbox.
    owner = new TestBrowser(hub.baseUrl, internet.fetch);
    expect((await owner.login()).status).toBe(303);
    google.signedIn = mailbox;
    const { response } = await owner.walk('/connect/gmail?label=Work&name=work');
    expect(response.status).toBe(200);
  });

  afterAll(async () => {
    await hub?.close();
  });

  /** A fresh browser window: the hub's sign-in page (password), then the consent screen. */
  const signInWindow = (profile: AiClientProfile) => async (authorizationUrl: URL) => {
    const browser = new TestBrowser(hub.baseUrl, internet.fetch);
    const { response: login, url } = await browser.walk(authorizationUrl);
    expect(url.pathname).toBe('/login');
    await login.body?.cancel();
    const signedIn = await browser.login(ADMIN.email, ADMIN.password, url.searchParams.get('next')!);
    expect(signedIn.status).toBe(303);
    const { response: consent } = await browser.walk(signedIn.headers.get('location')!);
    expect(consent.status).toBe(200);
    const html = await consent.text();
    consentPages.set(profile.id, html);
    return allow(browser, new Response(html), profile);
  };
  const consentPages = new Map<string, string>();
  // The test browser picked Russian with the language switch.
  const t = translator('ru');

  /** The grant behind the client's current access token, as the hub's token check sees it. */
  const grantOf = async (client: SimulatedAiClient) => {
    const verified = await hub.services.oauth.verifyAccessToken(client.oauth.savedTokens!.access_token);
    return hub.services.db.query.oauthGrants.findFirst({ where: (g, { eq }) => eq(g.id, verified!.grantId) });
  };

  describe.each(AI_CLIENTS.map((profile) => [profile.id, profile] as const))('%s', (_id, profile) => {
    let client: SimulatedAiClient;

    beforeAll(async () => {
      client = new SimulatedAiClient(profile, hub.mcpUrl);
      await client.connect(signInWindow(profile));
    });

    afterAll(async () => {
      await client?.close();
    });

    it('signs in with OAuth the way this client does and is recognised by name', async () => {
      const registered = client.oauth.client!;
      if (profile.identity.kind === 'metadata_document') {
        expect(registered.client_id).toBe(profile.identity.url);
      } else {
        expect(registered.client_id).toMatch(/^cli_/);
        // A confidential client gets a secret and uses it at the token endpoint.
        const confidential = profile.identity.body.token_endpoint_auth_method !== 'none';
        expect(Boolean(registered.client_secret)).toBe(confidential);
      }
      expect(client.oauth.savedTokens?.access_token).toMatch(/^ac_at_/);
      expect(client.oauth.savedTokens?.refresh_token).toMatch(/^ac_rt_/);

      const grant = (await grantOf(client))!;
      const aiClient = await hub.services.aiClients.get(workspaceId, grant.aiClientId!);
      expect(aiClient.name).toBe(profile.expectedName);
    });

    it('tells the user on the consent screen who is asking and how far to trust it', () => {
      const page = consentPages.get(profile.id)!;
      const { consent } = profile;
      expect(page).toContain(
        escapeHtml(
          t('consent.title', {
            client:
              profile.identity.kind === 'registration'
                ? String(profile.identity.body.client_name)
                : String(profile.identity.document.client_name),
          }),
        ),
      );
      expect(page.includes(t('consent.known')), 'known app badge').toBe(consent.knownApp);
      if (consent.verifiedDomain) expect(page).toContain(`<strong>${consent.verifiedDomain}</strong>`);
      expect(page.includes(escapeHtml(t('consent.verifiedDomain'))), 'verified domain').toBe(
        Boolean(consent.verifiedDomain),
      );
      expect(page.includes(escapeHtml(t('consent.loopback'))), 'loopback warning').toBe(
        consent.warning === 'loopback',
      );
      expect(page.includes(escapeHtml(t('consent.unknown'))), 'unknown-site warning').toBe(
        consent.warning === 'unknown',
      );
      // The app is remembered under the name the hub recognised.
      expect(page).toContain(escapeHtml(profile.expectedName));
    });

    it('gets a tool list every client accepts, with the connected services', async () => {
      const { tools } = await client.mcp.listTools();
      const names = tools.map((t) => t.name);
      if (profile.maxTools) expect(tools.length).toBeLessThanOrEqual(profile.maxTools);
      expect(new Set(names).size).toBe(names.length);
      for (const tool of tools) {
        expect(tool.name).toMatch(TOOL_NAME);
        expect(tool.description?.length, tool.name).toBeGreaterThan(10);
        expect(tool.inputSchema.type).toBe('object');
        expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain('"$ref"');
      }
      expect(names).toEqual(expect.arrayContaining(['manyplug_list_accounts', 'manyplug_call_tools']));
      // Everything is reachable: listed directly, or through search and call_tool.
      const reachable = names.includes('gmail_search')
        ? names
        : (await searched(client, 'search my email')).concat(names);
      expect(reachable).toContain('gmail_search');
      expect(client.mcp.getInstructions()).toContain('Gmail');
    });

    it('calls a connected service and gets its data back', async () => {
      const result = await callAnyway(client, 'gmail_search', { query: 'PO-77' });
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(textOf(result)).toContain('Invoice for PO-77');

      const echo = await callAnyway(client, 'demo_echo', { account: 'second', message: profile.id });
      expect(textOf(echo)).toContain(`(second): ${profile.id}`);

      const [latest] = await hub.services.hub.recentToolCalls(workspaceId, { limit: 1 });
      expect(latest!.principalType).toBe('oauth');
      if (profile.callMeta?.['openai/subject']) expect(latest!.aiSubject).toMatch(/^openai:[0-9a-f]{32}$/);
      else expect(latest!.aiSubject ?? null).toBeNull();
    });

    it(
      profile.elicitation
        ? 'asks the user in the chat before sending an email'
        : 'holds an email for the user to confirm through a link',
      async () => {
        const before = mailbox.sent.length;
        const args = { to: ['dana@contoso.example'], subject: `From ${profile.id}`, body: 'Hello!' };
        if (profile.elicitation) {
          client.answers.push('approve');
          const sent = await callAnyway(client, 'gmail_send', args);
          expect(client.questions.at(-1)).toContain('Gmail');
          expect(sent.isError, textOf(sent)).toBeFalsy();
          expect(mailbox.sent).toHaveLength(before + 1);

          // Declined in the chat: never sent.
          client.answers.push('decline');
          const declined = await callAnyway(client, 'gmail_send', { ...args, subject: 'Declined' });
          expect(declined.isError).toBe(true);
          expect(textOf(declined)).toContain('declined');
          expect(mailbox.sent).toHaveLength(before + 1);
          return;
        }
        const held = await callAnyway(client, 'gmail_send', args);
        expect(textOf(held)).toContain('/confirm/pcl_');
        expect(mailbox.sent).toHaveLength(before);
        await approveOnWeb(owner, textOf(held));
        await hub.services.pendingRunner.tick();
        expect(mailbox.sent).toHaveLength(before + 1);
        const delivered = await callAnyway(client, 'gmail_send', args);
        expect(delivered.isError, textOf(delivered)).toBeFalsy();
        expect(mailbox.sent).toHaveLength(before + 1);
      },
    );

    it('refreshes its access token when it expires and keeps working', async () => {
      const old = client.oauth.savedTokens!;
      const grant = (await grantOf(client))!;
      await hub.services.database.pool.query(
        "UPDATE oauth_tokens SET expires_at = now() - interval '1 second' WHERE grant_id = $1 AND type = 'access'",
        [grant.id],
      );
      await client.open();
      const result = await callAnyway(client, 'demo_echo', { account: 'main', message: 'after refresh' });
      expect(textOf(result)).toContain('after refresh');
      expect(client.oauth.savedTokens!.access_token).not.toBe(old.access_token);
      expect(client.oauth.savedTokens!.refresh_token).not.toBe(old.refresh_token);
    });

    it('loses access when the user disconnects it on the dashboard', async () => {
      const grant = (await grantOf(client))!;
      const page = await (await owner.request('/app/apps')).text();
      expect(page).toContain(`/grants/${grant.id}/revoke`);
      const { csrf } = TestBrowser.hiddenInputs(page);
      const revoked = await owner.request(`/grants/${grant.id}/revoke`, { form: { csrf: csrf! } });
      expect(revoked.status).toBe(303);
      await expect(client.open()).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('comes back as the same app with its rules when the user adds it again', async () => {
      // The user had made this app read-only before disconnecting it.
      const before = (await hub.services.aiClients.list(workspaceId)).find(
        (c) => c.name === profile.expectedName,
      )!;
      await hub.services.policies.setScopedRule(
        workspaceId,
        { aiClientId: before.id },
        { access: 'read', confirm: null },
      );

      // Adding it again is a fresh start for the app: new registration (or document fetch), new tokens.
      // The browser is still signed in, so the consent screen opens right away.
      const again = new SimulatedAiClient(profile, hub.mcpUrl);
      await again.connect(async (url) => {
        const { response } = await owner.walk(url);
        expect(response.status).toBe(200);
        return allow(owner, response, profile);
      });
      try {
        const grant = (await grantOf(again))!;
        expect(grant.aiClientId).toBe(before.id);
        const names = await again.toolNames();
        expect(names).toContain('gmail_search');
        expect(names).not.toContain('gmail_send');
      } finally {
        await again.close();
      }
    });
  });

  /** Tools found by `manyplug_search_tools` (clients that only see the discovery set). */
  async function searched(client: SimulatedAiClient, task: string): Promise<string[]> {
    const result = await client.call('manyplug_search_tools', { query: task });
    const data = result.structuredContent as { tools?: { name: string }[] } | undefined;
    return (data?.tools ?? []).map((t) => t.name);
  }

  /** Calls a tool directly when it is listed, otherwise through `manyplug_call_tool`. */
  async function callAnyway(client: SimulatedAiClient, name: string, args: Record<string, unknown>) {
    const listed = (await client.mcp.listTools()).tools.some((t) => t.name === name);
    return listed ? client.call(name, args) : client.call('manyplug_call_tool', { name, arguments: args });
  }
});
